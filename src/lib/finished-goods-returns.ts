import type { FinishedGoodsReturn, Order, Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type { SessionUser } from "@/lib/auth";
import { ApiError, resolveReadScope } from "@/lib/api";
import { auditInTransaction } from "@/lib/audit";
import { decimal, money, type Numeric } from "@/lib/money";
import { acquireInventorySharedLocks, activeFreezeFor } from "@/lib/inventory-freeze";
import { lockOrders } from "@/lib/transaction-locks";
import { applyStockMutation, lockItemForUpdate } from "@/lib/ledger";

type Tx = Prisma.TransactionClient;
export type FinishedReturnInput = { actorSessionUser: SessionUser; orderItemId: string; inventoryItemId: string; quantity: number; reason: string; idempotencyScope: string; idempotencyKey: string; requestHash: string };
export function returnValuation(quantity: number, originalUnitCost: Numeric | null) {
  return { unitCost: originalUnitCost === null ? null : decimal(originalUnitCost).toNumber(), totalCost: originalUnitCost === null ? null : money(decimal(originalUnitCost).times(quantity)).toNumber(), valuation: originalUnitCost === null ? "UNVALUED" as const : "VALUED" as const };
}

async function originalUsage(tx: Tx, line: { finishedStockTransactionId: string | null; orderId: string; finishedStockItemId: string | null }) {
  if (!line.finishedStockTransactionId) throw new ApiError(409, "الاستهلاك الأصلي غير مسجل؛ المخزون يحتاج إصلاح");
  await tx.$queryRaw`SELECT "id" FROM "InventoryTransaction" WHERE "id"=${line.finishedStockTransactionId} FOR SHARE`;
  const usage = await tx.inventoryTransaction.findUniqueOrThrow({ where: { id: line.finishedStockTransactionId } });
  if (usage.type !== "USAGE" || Number(usage.quantity) >= 0 || usage.orderId !== line.orderId || usage.inventoryItemId !== line.finishedStockItemId) throw new ApiError(409, "حركة الاستهلاك الأصلية غير متطابقة");
  return usage;
}

async function publicReceipt(tx: Tx, row: FinishedGoodsReturn, replayed = false) {
  const movement = row.inventoryTransactionId ? await tx.inventoryTransaction.findUniqueOrThrow({ where: { id: row.inventoryTransactionId } }) : null;
  return { receiptId: row.id, orderItemId: row.orderItemId, quantity: row.quantity, unit: row.unit, inventoryItemId: row.inventoryItemId, receivedAt: row.receivedAt, appliedAt: row.appliedAt, inventoryTransactionId: row.inventoryTransactionId, status: row.appliedAt ? "APPLIED" : "PENDING", valuation: !row.appliedAt ? "PENDING" : movement?.unitCost === null ? "UNVALUED" : "VALUED", replayed };
}

type ReturnLine = Parameters<typeof originalUsage>[1] & { id: string; finishedStockQuantity: number | null; order: Pick<Order, "servedAt" | "servedById" | "servedStockCustodyPeriodId" | "servedShiftId"> };
type ReceiptContext = Pick<FinishedGoodsReturn, "id" | "cafeId" | "branchId" | "orderId" | "orderItemId" | "inventoryItemId" | "unit" | "quantity" | "reason" | "createdById" | "receivedAt" | "idempotencyScope" | "idempotencyKey" | "requestHash" | "deferredFreezeId" | "deferredHandoverId">;
function receiptEvidence(row: ReceiptContext, line: ReturnLine, previousReceivedTotal: number) {
  return { branchId: row.branchId, receiptId: row.id, orderItemId: row.orderItemId, inventoryItemId: row.inventoryItemId, unit: row.unit, receivedById: row.createdById, receivedAt: row.receivedAt.toISOString(), originalServedQuantity: line.finishedStockQuantity, quantity: row.quantity, previousReceivedTotal, reason: row.reason, idempotencyScope: row.idempotencyScope, idempotencyKey: row.idempotencyKey, requestHash: row.requestHash, deferredFreezeId: row.deferredFreezeId, deferredHandoverId: row.deferredHandoverId, servedAt: line.order.servedAt?.toISOString() ?? null, servedById: line.order.servedById, servedCustodyPeriodId: line.order.servedStockCustodyPeriodId, servedShiftId: line.order.servedShiftId };
}
async function postReceiptStock(tx: Tx, row: ReceiptContext, line: ReturnLine, actorId: string, previousReceivedTotal?: number) {
  const usage = await originalUsage(tx, line);
  const valuation = returnValuation(row.quantity, usage.unitCost);
  const movement = await applyStockMutation(tx, { inventoryItemId: row.inventoryItemId, cafeId: row.cafeId, branchId: row.branchId, orderId: row.orderId, type: "RETURN", quantity: row.quantity, unitCost: valuation.unitCost, totalCost: valuation.totalCost, note: `Physical receipt ${row.id}: ${row.reason}`, createdById: actorId,
    // A positive receipt can reduce an existing negative balance. It never consumes stock.
    allowNegative: true,
  });
  const previous = previousReceivedTotal ?? (await tx.finishedGoodsReturn.aggregate({ where: { orderItemId: line.id, id: { not: row.id } }, _sum: { quantity: true } }))._sum.quantity ?? 0;
  await auditInTransaction(tx, { cafeId: row.cafeId, userId: actorId, action: "FINISHED_GOODS_RETURN_POSTED", entity: "Order", entityId: row.orderId, details: { ...receiptEvidence(row, line, previous), originalUsageId: usage.id, originalUsageCustodyPeriodId: usage.custodyPeriodId, originalUsageShiftId: usage.shiftId, returnTransactionId: movement.transactionId, stockBefore: movement.stockBefore, stockAfter: movement.stockAfter, postingCustodyPeriodId: movement.custodyPeriodId, postingShiftId: movement.shiftId, ...valuation } });
  return { appliedAt: new Date(), inventoryTransactionId: movement.transactionId };
}

/** Order lock serializes replay/cumulative allowance; shared branch gate fences thaw. */
export async function recordFinishedGoodsReturn(tx: Tx, input: FinishedReturnInput) {
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.quantity > 999999999 || input.reason.trim().length < 3 || input.reason.trim().length > 500) throw new ApiError(400, "المرتجع يحتاج عدد قطع صحيح وسبب واضح");
  const scope = resolveReadScope(input.actorSessionUser);
  const candidate = await tx.orderItem.findFirst({ where: { id: input.orderItemId, finishedStockItemId: input.inventoryItemId, order: scope }, select: { orderId: true } });
  if (!candidate) throw new ApiError(404, "صنف الطلب مش موجود في نطاقك");
  await lockOrders(tx, [candidate.orderId]);
  const line = await tx.orderItem.findFirst({ where: { id: input.orderItemId, order: scope }, include: { order: true } });
  if (!line || line.order.status !== "SERVED" || line.voidedAt || line.kitchenStatus !== "SERVED" || line.stockModeSnapshot !== "FINISHED_GOOD" || !line.stockAcceptedAt || line.finishedStockItemId !== input.inventoryItemId || line.finishedStockUnit !== "PIECE" || !line.finishedStockQuantity || line.finishedStockCafeId !== line.order.cafeId || line.finishedStockBranchId !== line.order.branchId) throw new ApiError(409, "المرتجع متاح لقطع جاهزة تم تسليمها فعلياً من الطلب الأصلي فقط");
  const previous = await tx.finishedGoodsReturn.findUnique({ where: { idempotencyScope_idempotencyKey: { idempotencyScope: input.idempotencyScope, idempotencyKey: input.idempotencyKey } } });
  if (previous) {
    if (previous.requestHash !== input.requestHash || previous.orderItemId !== line.id || previous.createdById !== input.actorSessionUser.id) throw new ApiError(409, "المفتاح مستخدم لمرتجع مختلف");
    return publicReceipt(tx, previous, true);
  }
  const total = await tx.finishedGoodsReturn.aggregate({ where: { orderItemId: line.id }, _sum: { quantity: true } });
  if ((total._sum.quantity ?? 0) + input.quantity > line.finishedStockQuantity) throw new ApiError(409, "الكمية تتجاوز القطع المتبقية للمرتجع؛ المعلّق محسوب ضمن الحد");
  await acquireInventorySharedLocks(tx, [line.order.branchId]);
  const freeze = await activeFreezeFor(tx, line.order.branchId);
  if (!line.finishedStockTransactionId && !await tx.deferredStockDeduction.findFirst({ where: { orderId: line.orderId, appliedAt: null } })) throw new ApiError(409, "لا يوجد استهلاك أصلي أو تسوية مؤجلة؛ يحتاج إصلاح");
  const data = { id: randomUUID(), receivedAt: new Date(), deferredFreezeId: freeze?.freezeId ?? null, deferredHandoverId: freeze?.handoverId ?? null, cafeId: line.order.cafeId, branchId: line.order.branchId, orderId: line.orderId, orderItemId: line.id, inventoryItemId: input.inventoryItemId, unit: "PIECE" as const, quantity: input.quantity, reason: input.reason.trim(), createdById: input.actorSessionUser.id, idempotencyScope: input.idempotencyScope, idempotencyKey: input.idempotencyKey, requestHash: input.requestHash };
  if (!freeze) await lockItemForUpdate(tx, input.inventoryItemId);
  const posting = freeze ? {} : await postReceiptStock(tx, data, line, input.actorSessionUser.id, total._sum.quantity ?? 0);
  const receipt = await tx.finishedGoodsReturn.create({ data: { ...data, ...posting } });
  if (freeze) await auditInTransaction(tx, { cafeId: data.cafeId, userId: data.createdById, action: "FINISHED_GOODS_RETURN_SEGREGATED", entity: "Order", entityId: data.orderId, details: { ...receiptEvidence(data, line, total._sum.quantity ?? 0), originalUsageId: line.finishedStockTransactionId, valuation: "PENDING", instruction: "HOLD_SEPARATELY_EXCLUDE_SALEABLE_AND_COUNT" } });
  return publicReceipt(tx, receipt);
}

/** Caller holds the revalidated union of Orders and Inventory before release. */
export async function applyPendingFinishedGoodsReturns(tx: Tx, args: { handoverId: string; actorId: string }) {
  const pending = await tx.finishedGoodsReturn.findMany({ where: { deferredHandoverId: args.handoverId, appliedAt: null }, orderBy: [{ receivedAt: "asc" }, { id: "asc" }] });
  for (const row of pending) {
    const line = await tx.orderItem.findUniqueOrThrow({ where: { id: row.orderItemId }, include: { order: true } });
    const posting = await postReceiptStock(tx, row, line, args.actorId);
    await tx.finishedGoodsReturn.update({ where: { id: row.id }, data: posting });
  }
  return { applied: pending.length };
}
