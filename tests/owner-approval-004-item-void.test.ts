import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, type CountCafe } from "./helpers/count";
import { as } from "./helpers/http";
import { dateStrInTz } from "@/lib/date-range";

let fx: CountCafe;
let orderId = "";
let firstItemId = "";
let secondItemId = "";
before(async () => {
  fx = await countCafe("OWNERAPPROVAL004");
  await db.ownerActionSettings.create({ data: { cafeId: fx.cafeId, ownerId: fx.owner.id } });
  const order = await db.order.create({ data: {
    cafeId: fx.cafeId, branchId: fx.branchId, orderNumber: 84001, status: "CONFIRMED",
    subtotal: 100, total: 100, paidAmount: 0, remainingAmount: 100, paymentStatus: "UNPAID",
    taxRateSnapshot: 0, serviceRateSnapshot: 0,
  } });
  orderId = order.id;
  firstItemId = (await db.orderItem.create({ data: {
    orderId, productName: "Espresso", unitPrice: 40, quantity: 1, lineTotal: 40,
  } })).id;
  secondItemId = (await db.orderItem.create({ data: {
    orderId, productName: "Cake", unitPrice: 60, quantity: 1, lineTotal: 60,
  } })).id;
});
after(async () => { if (fx) await teardownTaggedCafe(fx.cafeId); await db.$disconnect(); });

async function requestAndAccept(orderId: string, itemId: string) {
  const request = await as<{ request: { id: string } }>(fx.manager.email, "/api/owner-action-requests", {
    method: "POST", body: JSON.stringify({ action: "VOID_ORDER_ITEM", orderId, orderItemId: itemId, reason: "Correct the order item", idempotencyKey: crypto.randomUUID() }),
  });
  assert.equal(request.status, 201, request.text);
  const decision = await as(fx.owner.email, `/api/owner-action-requests/${request.body.request.id}/decision`, {
    method: "POST", body: JSON.stringify({ decision: "ACCEPT" }),
  });
  assert.equal(decision.status, 200, decision.text);
  return request.body.request.id;
}

test("approved void preserves the saved row and recalculates the unpaid order", async () => {
  const request = await as<{ request: { id: string; status: string } }>(fx.manager.email, "/api/owner-action-requests", {
    method: "POST", body: JSON.stringify({
      action: "VOID_ORDER_ITEM", orderId, orderItemId: firstItemId,
      reason: "Customer removed the espresso", idempotencyKey: crypto.randomUUID(),
    }),
  });
  assert.equal(request.status, 201, request.text);
  assert.equal(request.body.request.status, "PENDING");
  assert.equal(Number((await db.order.findUniqueOrThrow({ where: { id: orderId } })).total), 100);

  const decision = await as<{ status: string }>(fx.owner.email, "/api/owner-action-requests/" + request.body.request.id + "/decision", {
    method: "POST", body: JSON.stringify({ decision: "ACCEPT" }),
  });
  assert.equal(decision.status, 200, decision.text);
  const execution = await as<{ status: string; result: { total: number } }>(fx.manager.email, "/api/owner-action-requests/" + request.body.request.id + "/execute", {
    method: "POST", body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
  });
  assert.equal(execution.status, 200, execution.text);
  assert.equal(execution.body.status, "EXECUTED");
  const item = await db.orderItem.findUniqueOrThrow({ where: { id: firstItemId } });
  assert.ok(item.voidedAt);
  assert.equal(item.voidedById, fx.manager.id);
  assert.equal(item.voidApprovalRequestId, request.body.request.id);
  assert.equal(item.voidReason, "Customer removed the espresso");
  assert.equal(await db.orderItem.count({ where: { id: firstItemId } }), 1);
  const order = await db.order.findUniqueOrThrow({ where: { id: orderId } });
  assert.equal(Number(order.subtotal), 60);
  assert.equal(Number(order.total), 60);
  assert.equal(Number(order.remainingAmount), 60);
  assert.equal(await db.orderItem.count({ where: { id: secondItemId, voidedAt: null } }), 1);
});

test("approved void cannot remove the final active item or an item from a paid order", async () => {
  const lastOrder = await db.order.create({ data: {
    cafeId: fx.cafeId, branchId: fx.branchId, orderNumber: 84002, status: "CONFIRMED",
    subtotal: 25, total: 25, paidAmount: 0, remainingAmount: 25, paymentStatus: "UNPAID",
    taxRateSnapshot: 0, serviceRateSnapshot: 0,
  } });
  const lastItem = await db.orderItem.create({ data: { orderId: lastOrder.id, productName: "Only item", unitPrice: 25, quantity: 1, lineTotal: 25 } });
  const lastRequest = await requestAndAccept(lastOrder.id, lastItem.id);
  const lastResult = await as(fx.manager.email, `/api/owner-action-requests/${lastRequest}/execute`, {
    method: "POST", body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
  });
  assert.equal(lastResult.status, 409, lastResult.text);
  assert.equal((await db.orderItem.findUniqueOrThrow({ where: { id: lastItem.id } })).voidedAt, null);

  const paidOrder = await db.order.create({ data: {
    cafeId: fx.cafeId, branchId: fx.branchId, orderNumber: 84003, status: "CONFIRMED",
    subtotal: 25, total: 25, paidAmount: 25, remainingAmount: 0, paymentStatus: "PAID",
    taxRateSnapshot: 0, serviceRateSnapshot: 0,
  } });
  const paidItem = await db.orderItem.create({ data: { orderId: paidOrder.id, productName: "Paid item", unitPrice: 25, quantity: 1, lineTotal: 25 } });
  await db.payment.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, orderId: paidOrder.id, amount: 25, method: "CARD", receivedById: fx.manager.id } });
  const paidRequest = await requestAndAccept(paidOrder.id, paidItem.id);
  const paidResult = await as(fx.manager.email, `/api/owner-action-requests/${paidRequest}/execute`, {
    method: "POST", body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
  });
  assert.equal(paidResult.status, 409, paidResult.text);
  assert.equal((await db.orderItem.findUniqueOrThrow({ where: { id: paidItem.id } })).voidedAt, null);
  assert.equal(Number((await db.order.findUniqueOrThrow({ where: { id: paidOrder.id } })).paidAmount), 25);
});

test("employee action report returns requester, approver, executor, reason, and date filters", async () => {
  const order = await db.order.create({ data: {
    cafeId: fx.cafeId, branchId: fx.branchId, orderNumber: 84004, status: "CONFIRMED",
    subtotal: 30, total: 30, paidAmount: 0, remainingAmount: 30, paymentStatus: "UNPAID",
    taxRateSnapshot: 0, serviceRateSnapshot: 0,
  } });
  const request = await as<{ request: { id: string } }>(fx.manager.email, "/api/owner-action-requests", {
    method: "POST", body: JSON.stringify({ action: "CANCEL_ORDER", orderId: order.id, reason: "Customer asked to cancel", idempotencyKey: crypto.randomUUID() }),
  });
  assert.equal(request.status, 201, request.text);
  const day = dateStrInTz(new Date());
  const report = await as<{ requests: { id: string; requester: { id: string }; owner: { id: string }; reason: string; order: { orderNumber: number } | null }[] }>(
    fx.owner.email, `/api/reports/employee-actions?from=${day}&to=${day}`
  );
  assert.equal(report.status, 200, report.text);
  const row = report.body.requests.find((candidate) => candidate.id === request.body.request.id);
  assert.ok(row);
  assert.equal(row.requester.id, fx.manager.id);
  assert.equal(row.owner.id, fx.owner.id);
  assert.equal(row.reason, "Customer asked to cancel");
  assert.equal(row.order?.orderNumber, 84004);
});
