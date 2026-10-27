import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, type CountCafe } from "./helpers/count";
import { as } from "./helpers/http";

let fx: CountCafe;
let paidOrderId = "";
let paidPaymentId = "";
let cancelOrderId = "";
let executePaymentId = "";
let cancelRequestId = "";
let orderRefundRequestId = "";

before(async () => {
  fx = await countCafe("OWNERAPPROVAL003");
  await db.ownerActionSettings.create({ data: { cafeId: fx.cafeId, ownerId: fx.owner.id } });
  const paidOrder = await db.order.create({ data: {
    cafeId: fx.cafeId, branchId: fx.branchId, orderNumber: 83001, status: "CONFIRMED",
    subtotal: 100, total: 100, paidAmount: 100, remainingAmount: 0, paymentStatus: "PAID",
  } });
  paidOrderId = paidOrder.id;
  const payment = await db.payment.create({ data: {
    cafeId: fx.cafeId, branchId: fx.branchId, orderId: paidOrder.id, amount: 100,
    method: "CARD", receivedById: fx.cashier.id,
  } });
  paidPaymentId = payment.id;
  const cancelOrder = await db.order.create({ data: {
    cafeId: fx.cafeId, branchId: fx.branchId, orderNumber: 83002, status: "CONFIRMED",
    subtotal: 60, total: 60, paidAmount: 0, remainingAmount: 60, paymentStatus: "UNPAID",
  } });
  cancelOrderId = cancelOrder.id;
  const executeOrder = await db.order.create({ data: {
    cafeId: fx.cafeId, branchId: fx.branchId, orderNumber: 83003, status: "CONFIRMED",
    subtotal: 80, total: 80, paidAmount: 80, remainingAmount: 0, paymentStatus: "PAID",
  } });
  const executePayment = await db.payment.create({ data: {
    cafeId: fx.cafeId, branchId: fx.branchId, orderId: executeOrder.id, amount: 80,
    method: "CARD", receivedById: fx.cashier.id,
  } });
  executePaymentId = executePayment.id;
});
after(async () => { if (fx) await teardownTaggedCafe(fx.cafeId); await db.$disconnect(); });

test("legacy refund and cancellation routes create approval requests without changing money or order state", async () => {
  const orderRefund = await as<{ request: { id: string; status: string } }>(fx.manager.email, "/api/orders/" + paidOrderId + "/refund", {
    method: "POST", body: JSON.stringify({ reason: "Customer requested a refund" }),
  });
  assert.equal(orderRefund.status, 202, orderRefund.text);
  assert.equal(orderRefund.body.request.status, "PENDING");
  orderRefundRequestId = orderRefund.body.request.id;

  const paymentRefund = await as<{ request: { id: string; status: string } }>(fx.manager.email, "/api/payments/" + paidPaymentId + "/refund", {
    method: "POST", body: JSON.stringify({ reason: "Customer requested a refund" }),
  });
  assert.equal(paymentRefund.status, 202, paymentRefund.text);
  assert.equal(paymentRefund.body.request.status, "PENDING");

  const cancel = await as<{ request: { id: string; status: string } }>(fx.manager.email, "/api/orders/" + cancelOrderId + "/status", {
    method: "PATCH", body: JSON.stringify({ status: "CANCELLED", reason: "Customer changed the order" }),
  });
  assert.equal(cancel.status, 202, cancel.text);
  assert.equal(cancel.body.request.status, "PENDING");
  cancelRequestId = cancel.body.request.id;

  assert.equal(await db.payment.count({ where: { cafeId: fx.cafeId, type: "REFUND" } }), 0);
  assert.equal((await db.payment.findUniqueOrThrow({ where: { id: paidPaymentId } })).status, "PAID");
  assert.equal((await db.order.findUniqueOrThrow({ where: { id: cancelOrderId } })).status, "CONFIRMED");
});
test("approved payment refund executes once with the employee as the actor", async () => {
  const request = await as<{ request: { id: string } }>(fx.manager.email, "/api/owner-action-requests", {
    method: "POST", body: JSON.stringify({
      action: "REFUND_PAYMENT", paymentId: executePaymentId, reason: "Card refund approved", idempotencyKey: crypto.randomUUID(),
    }),
  });
  assert.equal(request.status, 201, request.text);
  const decision = await as<{ status: string }>(fx.owner.email, "/api/owner-action-requests/" + request.body.request.id + "/decision", {
    method: "POST", body: JSON.stringify({ decision: "ACCEPT" }),
  });
  assert.equal(decision.status, 200, decision.text);
  assert.equal(decision.body.status, "APPROVED");

  const idempotencyKey = crypto.randomUUID();
  const execution = await as<{ status: string; alreadyExecuted: boolean }>(fx.manager.email, "/api/owner-action-requests/" + request.body.request.id + "/execute", {
    method: "POST", body: JSON.stringify({ idempotencyKey }),
  });
  assert.equal(execution.status, 200, execution.text);
  assert.equal(execution.body.status, "EXECUTED");
  assert.equal(execution.body.alreadyExecuted, false);
  assert.equal(await db.payment.count({ where: { reversalOfPaymentId: executePaymentId, type: "REFUND" } }), 1);
  const executed = await db.ownerActionRequest.findUniqueOrThrow({ where: { id: request.body.request.id } });
  assert.equal(executed.status, "EXECUTED");
  assert.equal(executed.executorId, fx.manager.id);

  const retry = await as<{ status: string; alreadyExecuted: boolean }>(fx.manager.email, "/api/owner-action-requests/" + request.body.request.id + "/execute", {
    method: "POST", body: JSON.stringify({ idempotencyKey }),
  });
  assert.equal(retry.status, 200, retry.text);
  assert.equal(retry.body.status, "EXECUTED");
  assert.equal(retry.body.alreadyExecuted, true);
  assert.equal(await db.payment.count({ where: { reversalOfPaymentId: executePaymentId, type: "REFUND" } }), 1);
});
test("approved full refund and cancellation execute atomically under the requesting employee", async () => {
  const refundDecision = await as<{ status: string }>(fx.owner.email, "/api/owner-action-requests/" + orderRefundRequestId + "/decision", {
    method: "POST", body: JSON.stringify({ decision: "ACCEPT" }),
  });
  assert.equal(refundDecision.status, 200, refundDecision.text);
  assert.equal(refundDecision.body.status, "APPROVED");
  const refundExecution = await as<{ status: string; alreadyExecuted: boolean }>(fx.manager.email, "/api/owner-action-requests/" + orderRefundRequestId + "/execute", {
    method: "POST", body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
  });
  assert.equal(refundExecution.status, 200, refundExecution.text);
  assert.equal(refundExecution.body.status, "EXECUTED");
  assert.equal(await db.payment.count({ where: { orderId: paidOrderId, type: "REFUND" } }), 1);
  assert.equal((await db.order.findUniqueOrThrow({ where: { id: paidOrderId } })).paymentStatus, "REFUNDED");

  const cancelDecision = await as<{ status: string }>(fx.owner.email, "/api/owner-action-requests/" + cancelRequestId + "/decision", {
    method: "POST", body: JSON.stringify({ decision: "ACCEPT" }),
  });
  assert.equal(cancelDecision.status, 200, cancelDecision.text);
  const cancelExecution = await as<{ status: string }>(fx.manager.email, "/api/owner-action-requests/" + cancelRequestId + "/execute", {
    method: "POST", body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
  });
  assert.equal(cancelExecution.status, 200, cancelExecution.text);
  assert.equal(cancelExecution.body.status, "EXECUTED");
  assert.equal((await db.order.findUniqueOrThrow({ where: { id: cancelOrderId } })).status, "CANCELLED");
});