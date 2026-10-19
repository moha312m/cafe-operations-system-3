import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { db, assertTestDatabase } from "./db";
import { countCafe, type CountCafe } from "./count";
import { as, requireServer } from "./http";
import { readResaleHandoff } from "../../scripts/resale-acceptance-guard.mjs";
import { ensureCustodyForShift } from "@/lib/custody";
import { protectedTransaction } from "@/lib/protected-transaction";
import { applyStockMutation } from "@/lib/ledger";
import { finalizeOrderConsumption, provisionalConsumption } from "@/lib/sale-consumption";
import { lockOrders } from "@/lib/transaction-locks";
import type { OrderStatus } from "@prisma/client";

export const post = (email: string, endpoint: string, body: unknown, key = randomUUID(), method = "POST") =>
  as(email, endpoint, { method, body: JSON.stringify(body), headers: { "Idempotency-Key": key } });
export function ok(response: { status: number; text: string }) { assert.ok(response.status >= 200 && response.status < 300, response.text); }

export async function newResaleCafe(label: string) {
  readResaleHandoff();
  assert.equal(process.env.RESALE_ACCEPTANCE_PREFLIGHT_VERIFIED, "1", "Use the clone-only preflight runner");
  assert.ok(process.env.RESALE_ACCEPTANCE_JOURNAL_DIR, "Scoped ownership journal required before creating fixtures");
  await assertTestDatabase(); await requireServer();
  const fx = await countCafe("RESALE-" + label);
  await journalOwnedCafe(fx, "REGISTERED_BEFORE_ACTIVATION");
  await db.cafeSettings.update({ where: { cafeId: fx.cafeId }, data: {
    finishedGoodsSalesEnabled: true, inventoryEnabled: true, kitchenScreenEnabled: true, carryOpenOrdersOnHandover: true,
    stockCountPolicy: "HYBRID", handoverCountType: "CRITICAL", periodicFullCountSchedule: "MANUAL_ONLY",
    varianceBlocksHandover: false, dineInServingPolicy: "ALLOW_BEFORE_PAYMENT", takeawayServingPolicy: "ALLOW_BEFORE_PAYMENT",
  } });
  await db.qrOrderApprovalSettings.upsert({ where: { branchId: fx.branchId }, create: { cafeId: fx.cafeId, branchId: fx.branchId, enabled: true, approvalMode: "ANY_AUTHORIZED_USER", allowApproverToEditOrder: true }, update: { enabled: true, approvalMode: "ANY_AUTHORIZED_USER", allowApproverToEditOrder: true } });
  const category = await db.menuCategory.create({ data: { cafeId: fx.cafeId, name: fx.marker } });
  const stock = await db.inventoryItem.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, name: fx.marker + " pieces", unit: "PIECE", costPerUnit: 2.5, isCritical: true } });
  const replacement = await db.inventoryItem.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, name: fx.marker + " replacement", unit: "PIECE", costPerUnit: 9 } });
  const preparedStock = await db.inventoryItem.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, name: fx.marker + " ingredient", unit: "KG", costPerUnit: 100, isCritical: true } });
  const finished = await db.product.create({ data: { cafeId: fx.cafeId, categoryId: category.id, name: fx.marker + " finished", basePrice: 10, stockMode: "FINISHED_GOOD", showInCustomerMenu: true } });
  await db.productStockBinding.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, productId: finished.id, inventoryItemId: stock.id, unit: "PIECE" } });
  const prepared = await db.product.create({ data: { cafeId: fx.cafeId, categoryId: category.id, name: fx.marker + " prepared", basePrice: 20 } });
  await db.recipe.create({ data: { cafeId: fx.cafeId, productId: prepared.id, items: { create: { inventoryItemId: preparedStock.id, quantity: 200, unit: "GRAM" } } } });
  for (const [item, quantity] of [[stock, 30], [replacement, 30], [preparedStock, 10]] as const) {
    await protectedTransaction(tx => applyStockMutation(tx, { cafeId: fx.cafeId, branchId: fx.branchId, inventoryItemId: item.id, type: "PURCHASE", quantity, unitCost: Number(item.costPerUnit), totalCost: quantity * Number(item.costPerUnit), createdById: fx.owner.id, note: fx.marker + " owned fixture receipt" }), { cafeId: fx.cafeId, branchId: fx.branchId });
  }
  const live = { fx, category, stock, replacement, preparedStock, finished, prepared };
  await journal(live, "FIXTURE_CREATED");
  return live;
}
export type ResaleLive = Awaited<ReturnType<typeof newResaleCafe>>;

export async function openShift(fx: CountCafe, userId = fx.cashier.id) {
  const last = await db.shift.aggregate({ where: { branchId: fx.branchId }, _max: { shiftNumber: true } });
  const shift = await db.shift.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, cashierId: userId, shiftNumber: (last._max.shiftNumber ?? 0) + 1, openingCashAmount: 100, expectedCashAmount: 100 } });
  await db.$transaction(tx => ensureCustodyForShift(tx, { cafeId: fx.cafeId, branchId: fx.branchId, shiftId: shift.id, userId, openingCashAmount: 100 }));
  return shift;
}

export async function acceptedOrder(live: ResaleLive, status: OrderStatus = "READY", quantities: { finished: number; prepared: number; finishedLineQuantities?: number[] } = { finished: 3, prepared: 0 }) {
  const { fx } = live;
  const number = (await db.order.aggregate({ where: { branchId: fx.branchId }, _max: { orderNumber: true } }))._max.orderNumber ?? 0;
  return protectedTransaction(async tx => {
  const order = await tx.order.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, orderNumber: number + 1, type: "DINE_IN", source: "CASHIER_POS", status, subtotal: quantities.finished * 10 + quantities.prepared * 20, total: quantities.finished * 10 + quantities.prepared * 20, remainingAmount: quantities.finished * 10 + quantities.prepared * 20, createdById: fx.cashier.id,
    items: { create: [
      ...(quantities.finished ? (quantities.finishedLineQuantities ?? [quantities.finished]).map(quantity => ({ ...provisionalConsumption(live.finished, null), productId: live.finished.id, productName: live.finished.name, quantity, unitPrice: 10, lineTotal: quantity * 10, kitchenStatus: status === "READY" ? "READY" as const : "NEW" as const })) : []),
      ...(quantities.prepared ? [{ ...provisionalConsumption(live.prepared, null), productId: live.prepared.id, productName: live.prepared.name, quantity: quantities.prepared, unitPrice: 20, lineTotal: quantities.prepared * 20, kitchenStatus: status === "READY" ? "READY" as const : "NEW" as const }] : []),
    ] } }, include: { items: true } });
  await lockOrders(tx, [order.id]); await finalizeOrderConsumption(tx, order.id, new Date());
  return tx.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } });
  }, { cafeId: fx.cafeId, branchId: fx.branchId });
}
export async function serve(live: ResaleLive, orderId: string) {
  const response = await post(live.fx.owner.email, `/api/orders/${orderId}/status`, { status: "SERVED" }, randomUUID(), "PATCH"); ok(response); return response;
}
export async function physicalReturn(live: ResaleLive, lineId: string, quantity: number, key = randomUUID(), email = live.fx.owner.email) {
  return post(email, `/api/inventory/${live.stock.id}/movement`, { type: "RETURN", orderItemId: lineId, quantity, note: live.fx.marker + " physical receipt" }, key);
}
export async function balance(itemId: string) { return Number((await db.inventoryItem.findUniqueOrThrow({ where: { id: itemId } })).currentStock); }

/** Retain immutable feature history. Disable only this suite's new-sales flag. */
export async function retain(live: ResaleLive) {
  await db.cafeSettings.update({ where: { cafeId: live.fx.cafeId }, data: { finishedGoodsSalesEnabled: false } });
  await journal(live, "RETAINED_GATE_OFF");
}
export async function journal(live: ResaleLive, phase: string) {
  return journalOwnedCafe(live.fx, phase);
}
export async function journalOwnedCafe(fx: CountCafe, phase: string) {
  const out = process.env.RESALE_ACCEPTANCE_JOURNAL_DIR;
  if (!out) throw new Error("Scoped acceptance journal directory required");
  const scope = { cafeId: fx.cafeId };
  const movements = await db.inventoryTransaction.findMany({ where: scope, select: { id: true, inventoryItemId: true, orderId: true, type: true, quantity: true, unitCost: true, totalCost: true, custodyPeriodId: true, shiftId: true } });
  const receipts = await db.finishedGoodsReturn.findMany({ where: scope, select: { id: true, orderId: true, orderItemId: true, quantity: true, appliedAt: true, inventoryTransactionId: true, deferredHandoverId: true } });
  const outstanding = await db.order.findMany({ where: { ...scope, status: { notIn: ["CANCELLED"] }, items: { some: { stockModeSnapshot: "FINISHED_GOOD", finishedStockDeductedAt: null, voidedAt: null } } }, select: { id: true, status: true, items: { where: { stockModeSnapshot: "FINISHED_GOOD", finishedStockDeductedAt: null, voidedAt: null }, select: { id: true, stockAcceptedAt: true, finishedStockQuantity: true } } } });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, fx.marker + ".json"), JSON.stringify({ phase, marker: fx.marker, cafeId: fx.cafeId, branchId: fx.branchId, movements, receipts, outstanding, cleanup: "Retain immutable history. New-sales flag disabled at suite completion; no delete/reset/reseed. Outstanding accepted orders remain eligible only for feature-aware settlement." }, (_, value) => typeof value === "bigint" ? value.toString() : value, 2));
}
