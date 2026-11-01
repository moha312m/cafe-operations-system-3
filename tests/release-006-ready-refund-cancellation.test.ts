// Regression: owner-approved cancellation may finish a fully refunded READY
// order, but may not erase an unpaid, outstanding, or already served sale.
// All money changes use collection and approved-refund HTTP APIs.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, openShift, teardownTaggedCafe } from "./helpers/db";
import { countCafe, type CountCafe } from "./helpers/count";
import { as, requireServer } from "./helpers/http";
import { ensureCustodyForShift } from "@/lib/custody";

let fx: CountCafe;
let productId: string;
let nextNumber = 6000;
before(async () => {
  await requireServer();
  fx = await countCafe("REL006");
  await db.ownerActionSettings.create({ data: { cafeId: fx.cafeId, ownerId: fx.owner.id } });
  const category = await db.menuCategory.create({ data: { cafeId: fx.cafeId, name: fx.marker + " cancellation controls" } });
  const product = await db.product.create({ data: { cafeId: fx.cafeId, categoryId: category.id, name: fx.marker + " drink", basePrice: 30 } });
  productId = product.id;
  await db.recipe.create({ data: { cafeId: fx.cafeId, productId, notApplicable: true, notApplicableReason: "Cancellation fixture has no tracked stock" } });
  const shift = await openShift({ cafeId: fx.cafeId, branchId: fx.branchId, productId, unitPrice: 30 }, fx.manager.id, 100);
  await db.$transaction(tx => ensureCustodyForShift(tx, { cafeId: fx.cafeId, branchId: fx.branchId, shiftId: shift.id, userId: fx.manager.id, openingCashAmount: 100 }));
});
after(async () => {
  if (fx) await teardownTaggedCafe(fx.cafeId);
  await db.$disconnect();
});

const post = <T = Record<string, unknown>>(email: string, path: string, body: unknown) => as<T>(email, path, {
  method: "POST", headers: { "Idempotency-Key": randomUUID() }, body: JSON.stringify(body),
});
async function readyOrder() {
  // Initial synthetic state only: no payment or settlement history is seeded.
  return db.order.create({ data: {
    cafeId: fx.cafeId, branchId: fx.branchId, orderNumber: nextNumber++,
    type: "TAKEAWAY", source: "CASHIER_POS", status: "READY", createdById: fx.manager.id,
    subtotal: 30, total: 30, paidAmount: 0, remainingAmount: 30, paymentStatus: "UNPAID",
    items: { create: { productId, productName: fx.marker + " drink", quantity: 1, unitPrice: 30, lineTotal: 30, kitchenStatus: "READY" } },
  } });
}
async function collect(orderId: string, amount = 30, mixed = false) {
  const response = await post(fx.manager.email, "/api/payments", mixed
    ? { orderId, splits: [{ method: "CASH", amount: 10 }, { method: "CARD", amount: 20 }] }
    : { orderId, amount, method: "CASH" });
  assert.equal(response.status, 201, response.text);
}
function request(action: "CANCEL_ORDER" | "REFUND_ORDER" | "REFUND_PAYMENT", orderId: string, paymentId?: string) {
  return post<{ request: { id: string; status: string } }>(fx.manager.email, "/api/owner-action-requests", {
    action, orderId, ...(paymentId ? { paymentId } : {}), reason: fx.marker + " owner-approved recovery", idempotencyKey: randomUUID(),
  });
}
async function approve(action: "CANCEL_ORDER" | "REFUND_ORDER" | "REFUND_PAYMENT", orderId: string, paymentId?: string) {
  const pending = await request(action, orderId, paymentId);
  assert.equal(pending.status, 201, pending.text);
  const decision = await post<{ status: string }>(fx.owner.email, `/api/owner-action-requests/${pending.body.request.id}/decision`, { decision: "ACCEPT" });
  assert.equal(decision.status, 200, decision.text);
  assert.equal(decision.body.status, "APPROVED");
  return pending.body.request.id;
}
function execute(requestId: string, key = randomUUID()) {
  return post<{ status: string; alreadyExecuted: boolean }>(fx.manager.email, `/api/owner-action-requests/${requestId}/execute`, { idempotencyKey: key });
}
async function refund(orderId: string, paymentId?: string) {
  const requestId = await approve(paymentId ? "REFUND_PAYMENT" : "REFUND_ORDER", orderId, paymentId);
  const response = await execute(requestId);
  assert.equal(response.status, 200, response.text);
  assert.equal(response.body.status, "EXECUTED");
}
async function businessState(orderId: string) {
  return {
    order: await db.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true, paymentStatus: true, paidAmount: true, remainingAmount: true, completedAt: true } }),
    payments: await db.payment.findMany({ where: { orderId }, orderBy: { id: "asc" } }),
    movements: await db.inventoryTransaction.count({ where: { orderId } }),
  };
}

test("a fully refunded READY order cancels only after owner approval, preserves all reversals, and replays once", async () => {
  const order = await readyOrder();
  await collect(order.id, 30, true);
  await refund(order.id);
  const refunded = await businessState(order.id);
  assert.equal(refunded.order.status, "READY");
  assert.equal(refunded.order.paymentStatus, "REFUNDED");
  assert.equal(Number(refunded.order.paidAmount), 0);
  assert.equal(Number(refunded.order.remainingAmount), 0);
  const collections = refunded.payments.filter(row => row.type === "COLLECTION");
  const reversals = refunded.payments.filter(row => row.type === "REFUND");
  assert.equal(collections.length, 2);
  assert.equal(reversals.length, 2);
  for (const collection of collections) {
    const reversal = reversals.find(row => row.reversalOfPaymentId === collection.id);
    assert.ok(reversal, "every collection has its actual reversal");
    assert.equal(reversal.status, "PAID");
    assert.equal(Number(reversal.amount), Number(collection.amount));
  }
  const pending = await as<{ request: { id: string; status: string } }>(fx.manager.email, "/api/orders/" + order.id + "/status", {
    method: "PATCH", body: JSON.stringify({ status: "CANCELLED", reason: fx.marker + " refunded READY recovery" }),
  });
  assert.equal(pending.status, 202, pending.text);
  const key = randomUUID();
  assert.equal((await execute(pending.body.request.id, key)).status, 409, "a request alone is not authority");
  const decision = await post(fx.owner.email, `/api/owner-action-requests/${pending.body.request.id}/decision`, { decision: "ACCEPT" });
  assert.equal(decision.status, 200, decision.text);
  const cancelled = await execute(pending.body.request.id, key);
  assert.equal(cancelled.status, 200, cancelled.text);
  assert.equal(cancelled.body.status, "EXECUTED");
  const replay = await execute(pending.body.request.id, key);
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.body.alreadyExecuted, true);
  const after = await businessState(order.id);
  assert.equal(after.order.status, "CANCELLED");
  assert.equal(after.order.paymentStatus, "REFUNDED");
  assert.equal(Number(after.order.paidAmount), 0);
  assert.equal(Number(after.order.remainingAmount), 0);
  assert.deepEqual(after.payments, refunded.payments, "cancellation creates or edits no money rows");
  assert.equal(after.movements, refunded.movements, "cancellation does not restore stock");
  assert.equal(await db.orderItem.count({ where: { orderId: order.id, kitchenStatus: { not: "CANCELLED" } } }), 0);
  assert.equal(await db.auditLog.count({ where: { cafeId: fx.cafeId, entityId: order.id, action: "ORDER_CANCELLED" } }), 1);
});

for (const amount of [30, 10]) test(`${amount === 30 ? "paid" : "partially paid"} READY orders cannot be requested for cancellation`, async () => {
  const order = await readyOrder();
  await collect(order.id, amount);
  const before = await businessState(order.id);
  const response = await request("CANCEL_ORDER", order.id);
  assert.equal(response.status, 409, response.text);
  assert.match(response.text, /Refund outstanding collections/);
  assert.deepEqual(await businessState(order.id), before);
});

test("an unpaid READY order remains blocked even with owner approval", async () => {
  const order = await readyOrder();
  const before = await businessState(order.id);
  const requestId = await approve("CANCEL_ORDER", order.id);
  const response = await execute(requestId);
  assert.equal(response.status, 409, response.text);
  assert.match(response.text, /Order can no longer be cancelled/);
  assert.deepEqual(await businessState(order.id), before);
});

test("reversing only one collection cannot qualify a READY order for cancellation", async () => {
  const order = await readyOrder();
  await collect(order.id, 30, true);
  const collection = await db.payment.findFirstOrThrow({ where: { orderId: order.id, type: "COLLECTION", method: "CASH" } });
  await refund(order.id, collection.id);
  const before = await businessState(order.id);
  assert.equal(before.payments.filter(row => row.type === "REFUND").length, 1);
  assert.equal(Number(before.order.paidAmount), 20);
  const response = await request("CANCEL_ORDER", order.id);
  assert.equal(response.status, 409, response.text);
  assert.match(response.text, /Refund outstanding collections/);
  assert.deepEqual(await businessState(order.id), before);
});

test("a SERVED order remains uncancellable after a full approved refund", async () => {
  const order = await readyOrder();
  await collect(order.id);
  const served = await as(fx.manager.email, `/api/orders/${order.id}/status`, { method: "PATCH", body: JSON.stringify({ status: "SERVED" }) });
  assert.equal(served.status, 200, served.text);
  await refund(order.id);
  const before = await businessState(order.id);
  assert.equal(before.order.status, "SERVED");
  assert.equal(before.order.paymentStatus, "REFUNDED");
  const requestId = await approve("CANCEL_ORDER", order.id);
  const response = await execute(requestId);
  assert.equal(response.status, 409, response.text);
  assert.match(response.text, /Order can no longer be cancelled/);
  assert.deepEqual(await businessState(order.id), before);
});

test("revoked request permission still denies a fully refunded READY cancellation", async () => {
  const order = await readyOrder();
  await collect(order.id);
  await refund(order.id);
  const before = await businessState(order.id);
  const requestsBefore = await db.ownerActionRequest.count({ where: { cafeId: fx.cafeId } });
  await db.userPermissionOverride.create({ data: { userId: fx.manager.id, permissionKey: "orders.request_owner_action", allowed: false } });
  try {
    const response = await request("CANCEL_ORDER", order.id);
    assert.equal(response.status, 403, response.text);
    assert.equal(await db.ownerActionRequest.count({ where: { cafeId: fx.cafeId } }), requestsBefore);
    assert.deepEqual(await businessState(order.id), before);
  } finally {
    await db.userPermissionOverride.delete({ where: { userId_permissionKey: { userId: fx.manager.id, permissionKey: "orders.request_owner_action" } } });
  }
});
