import type { Prisma } from "@prisma/client";
import { audit, auditInTransaction } from "@/lib/audit";
import { round3 } from "@/lib/costing";
import { decimal, money } from "@/lib/money";
import { applyStockMutation, lockItemForUpdate, MissingInventoryItemError, type StockAttributionSnapshot } from "@/lib/ledger";
import { allowsKnownShortage } from "@/lib/inventory-policy";
import { acquireInventorySharedLocks } from "@/lib/inventory-freeze";
import { planOrderConsumption, type ConsumptionBoundary } from "@/lib/sale-consumption";
type Tx = Prisma.TransactionClient;
export class StockError extends Error {}
type Options = { boundary?: ConsumptionBoundary; forceAllowNegative?: boolean };

async function prepareStockForOrder(tx: Tx, orderId: string, options: Options = {}) {
  const boundary = options.boundary ?? "SERVE";
  const order = await tx.order.findUnique({ where: { id: orderId } });
  if (!order) throw new StockError("الطلب مش موجود");
  if (options.forceAllowNegative && boundary !== "DEFERRED") throw new StockError("الرصيد السالب الإجباري مسموح لتسوية الخدمة المؤجلة فقط");
  if (boundary === "DEFERRED" && (order.status !== "SERVED" || !await tx.deferredStockDeduction.findFirst({ where: { orderId, appliedAt: null } }))) throw new StockError("تسوية مؤجلة بدون دليل خدمة مؤجلة");
  const plan = await planOrderConsumption(tx, orderId, boundary);
  return { order, plan, boundary };
}

export async function stockItemIdsForOrders(tx: Tx, orderIds: string[], options: Options = {}) {
  const plans = await Promise.all(orderIds.map(id => prepareStockForOrder(tx, id, options)));
  return [...new Set(plans.flatMap(p => p.plan.demands.map(d => d.inventoryItemId)))].sort();
}
export async function lockStockForOrders(tx: Tx, orderIds: string[], options: Options = {}) {
  const plans = await Promise.all(orderIds.map(id => prepareStockForOrder(tx, id, options)));
  await acquireInventorySharedLocks(tx, [...new Set(plans.map(p => p.plan.branchId))]);
  const ids = [...new Set(plans.flatMap(p => p.plan.demands.map(d => d.inventoryItemId)))].sort();
  for (const id of ids) await lockItemForUpdate(tx, id).catch(error => { if (error instanceof MissingInventoryItemError) return null; throw error; });
}

export async function deductStockForOrder(tx: Tx, orderId: string, userId: string | null, attribution?: StockAttributionSnapshot, options: Options = {}) {
  const { order, plan, boundary } = await prepareStockForOrder(tx, orderId, options);
  const deducted: { name: string; quantity: number }[] = [];
  const shortages: { inventoryItemId: string; available: number; required: number; stockAfter: number }[] = [];
  await acquireInventorySharedLocks(tx, [plan.branchId]);
  // Acquire the whole sorted union before any writer or linkage trigger runs.
  const locked = new Map<string, Awaited<ReturnType<typeof lockItemForUpdate>>>();
  for (const demand of plan.demands) {
    try { locked.set(demand.inventoryItemId, await lockItemForUpdate(tx, demand.inventoryItemId)); }
    catch (error) { if (error instanceof MissingInventoryItemError && !demand.finishedAllocations.length) continue; throw error; }
  }
  for (const demand of plan.demands) {
    const item = locked.get(demand.inventoryItemId);
    if (!item) continue;
    if (item.unit !== demand.unit) throw new StockError("وحدة مخزون الطلب تغيرت");
    const after = round3(item.currentStock - demand.quantity);
    const allowNegative = boundary === "DEFERRED" || (!demand.finishedAllocations.length && allowsKnownShortage(order.inventoryEnforcementMode));
    if (after < 0 && !allowNegative) throw new StockError(`لا توجد كمية كافية من «${demand.name}» (المتاح ${item.currentStock}، المطلوب ${demand.quantity})`);
    if (after < 0 && boundary === "DEFERRED") shortages.push({ inventoryItemId: demand.inventoryItemId, available: item.currentStock, required: demand.quantity, stockAfter: after });
    const movement = await applyStockMutation(tx, {
      inventoryItemId: demand.inventoryItemId, cafeId: plan.cafeId, branchId: plan.branchId, orderId, type: "USAGE", quantity: -demand.quantity,
      unitCost: item.costPerUnitExact.toNumber(), totalCost: money(decimal(demand.quantity).times(item.costPerUnitExact)).toNumber(),
      note: `خصم تلقائي بسبب الطلب رقم ${order.orderNumber}`, createdById: userId, attribution, allowNegative,
    });
    for (const allocation of demand.finishedAllocations) await tx.orderItem.update({ where: { id: allocation.orderItemId }, data: { finishedStockDeductedAt: new Date(), finishedStockTransactionId: movement.transactionId } });
    deducted.push({ name: demand.name, quantity: demand.quantity });
  }
  if (plan.processRecipes) await tx.order.update({ where: { id: orderId }, data: { stockDeductedAt: new Date() } });
  if (shortages.length) await auditInTransaction(tx, { cafeId: plan.cafeId, userId, action: "DEFERRED_FINISHED_STOCK_SHORTAGE", entity: "Order", entityId: orderId, details: { branchId: plan.branchId, shortages, boundary, savedInventoryEnforcementMode: order.inventoryEnforcementMode, deferredSettlementException: true, servedAt: order.servedAt?.toISOString() ?? null, servedById: order.servedById, servedCustodyPeriodId: order.servedStockCustodyPeriodId, servedShiftId: order.servedShiftId, postingCustodyPeriodId: attribution?.custodyPeriodId ?? null, postingShiftId: attribution?.shiftId ?? null } });
  return { deducted, productsWithoutRecipe: plan.productsWithoutRecipe, configurationsWithIncompleteRecipe: plan.configurationsWithIncompleteRecipe, shortages };
}

// Post-transaction audit writes (called after commit).
export async function auditDeduction(
  cafeId: string,
  branchId: string,
  userId: string | null,
  orderId: string,
  orderNumber: number,
  result: {
    deducted: { name: string; quantity: number }[];
    productsWithoutRecipe: string[];
    configurationsWithIncompleteRecipe?: { label: string; issues: string[] }[];
  },
  client?: Tx
) {
  const writeAudit = (entry: Parameters<typeof audit>[0]) => client ? auditInTransaction(client, entry) : audit(entry);
  if (result.deducted.length > 0) {
    await writeAudit({
      cafeId,
      userId,
      action: "STOCK_DEDUCTED_FOR_ORDER",
      entity: "Order",
      entityId: orderId,
      details: { orderNumber, branchId, deducted: result.deducted },
    });
  }
  for (const name of result.productsWithoutRecipe) {
    await writeAudit({
      cafeId,
      userId,
      action: "PRODUCT_WITHOUT_RECIPE_SERVED",
      entity: "Order",
      entityId: orderId,
      details: { orderNumber, productName: name },
    });
  }
  // Recorded separately from a missing recipe: this one DID deduct, so the
  // distinction a reconciliation needs is not "was there a recipe" but "was
  // the figure it produced complete".
  for (const c of result.configurationsWithIncompleteRecipe ?? []) {
    await writeAudit({
      cafeId,
      userId,
      action: "PRODUCT_WITH_INCOMPLETE_RECIPE_SERVED",
      entity: "Order",
      entityId: orderId,
      details: { orderNumber, branchId, productName: c.label, issues: c.issues },
    });
  }
}
