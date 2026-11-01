import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, type CountCafe } from "./helpers/count";
import { as } from "./helpers/http";

let fx: CountCafe, unconfigured: CountCafe;
let paymentId: string, changedPaymentId: string, rejectedPaymentId: string, expiredPaymentId: string;
before(async () => {
  fx = await countCafe("OWNERAPPROVAL001");
  unconfigured = await countCafe("OWNERAPPROVAL001-UNCONFIGURED");
  await db.ownerActionSettings.create({ data: { cafeId: fx.cafeId, ownerId: fx.owner.id } });
  async function makePayment(cafe: CountCafe, orderNumber: number) {
    const order = await db.order.create({ data: {
      cafeId: cafe.cafeId, branchId: cafe.branchId, orderNumber, status: "CONFIRMED",
      subtotal: 100, total: 100, paidAmount: 100, remainingAmount: 0, paymentStatus: "PAID",
    } });
    return db.payment.create({ data: { cafeId: cafe.cafeId, branchId: cafe.branchId, orderId: order.id, amount: 100, method: "CASH", receivedById: cafe.cashier.id } });
  }
  paymentId = (await makePayment(fx, 81001)).id;
  changedPaymentId = (await makePayment(fx, 81002)).id;
  rejectedPaymentId = (await makePayment(fx, 81004)).id;
  expiredPaymentId = (await makePayment(fx, 81005)).id;
  await makePayment(unconfigured, 81003);
});
after(async () => { if (fx) await teardownTaggedCafe(fx.cafeId); if (unconfigured) await teardownTaggedCafe(unconfigured.cafeId); await db.$disconnect(); });

test("a refund request waits for selected owner approval and changes no money", async () => {
  const idempotencyKey = crypto.randomUUID();
  const response = await as<{ request: { id: string; status: string; amount: number } }>(fx.manager.email, "/api/owner-action-requests", {
    method: "POST",
    body: JSON.stringify({ action: "REFUND_PAYMENT", paymentId, reason: "Customer returned the drink", idempotencyKey }),
  });
  assert.equal(response.status, 201, response.text);
  assert.equal(response.body.request.status, "PENDING");
  assert.equal(response.body.request.amount, 100);
  const retry = await as<{ request: { id: string } }>(fx.manager.email, "/api/owner-action-requests", {
    method: "POST", body: JSON.stringify({ action: "REFUND_PAYMENT", paymentId, reason: "Customer returned the drink", idempotencyKey }),
  });
  assert.equal(retry.status, 201, retry.text);
  assert.equal(retry.body.request.id, response.body.request.id);
  const changedRetry = await as(fx.manager.email, "/api/owner-action-requests", {
    method: "POST", body: JSON.stringify({ action: "REFUND_PAYMENT", paymentId, reason: "Different reason", idempotencyKey }),
  });
  assert.equal(changedRetry.status, 409, changedRetry.text);
  const managerDecision = await as(fx.manager.email, "/api/owner-action-requests/" + response.body.request.id + "/decision", { method: "POST", body: JSON.stringify({ decision: "ACCEPT" }) });
  assert.equal(managerDecision.status, 403, managerDecision.text);
  const ownerDecision = await as<{ status: string }>(fx.owner.email, "/api/owner-action-requests/" + response.body.request.id + "/decision", { method: "POST", body: JSON.stringify({ decision: "ACCEPT" }) });
  assert.equal(ownerDecision.status, 200, ownerDecision.text);
  assert.equal(ownerDecision.body.status, "APPROVED");
  const payments = await db.payment.findMany({ where: { order: { cafeId: fx.cafeId } }, orderBy: { createdAt: "asc" } });
  assert.equal(payments.filter((payment) => payment.type === "REFUND").length, 0);
  assert.equal(payments.find((payment) => payment.id === paymentId)?.status, "PAID");
});

test("owner decision marks changed payment snapshots stale and missing configuration fails closed", async () => {
  const pending = await as<{ request: { id: string } }>(fx.manager.email, "/api/owner-action-requests", {
    method: "POST", body: JSON.stringify({ action: "REFUND_PAYMENT", paymentId: changedPaymentId, reason: "Price correction requested", idempotencyKey: crypto.randomUUID() }),
  });
  assert.equal(pending.status, 201, pending.text);
  await db.payment.update({ where: { id: changedPaymentId }, data: { amount: 101 } });
  const decision = await as<{ status: string }>(fx.owner.email, "/api/owner-action-requests/" + pending.body.request.id + "/decision", { method: "POST", body: JSON.stringify({ decision: "ACCEPT" }) });
  assert.equal(decision.status, 200, decision.text);
  assert.equal(decision.body.status, "STALE");

  const otherPayment = await db.payment.findFirstOrThrow({ where: { cafeId: unconfigured.cafeId, type: "COLLECTION" } });
  const missingSettings = await as(unconfigured.manager.email, "/api/owner-action-requests", {
    method: "POST", body: JSON.stringify({ action: "REFUND_PAYMENT", paymentId: otherPayment.id, reason: "Customer returned the drink", idempotencyKey: crypto.randomUUID() }),
  });
  assert.equal(missingSettings.status, 409, missingSettings.text);
  assert.equal(await db.ownerActionRequest.count({ where: { cafeId: unconfigured.cafeId } }), 0);

  const foreignTarget = await as(unconfigured.manager.email, "/api/owner-action-requests", {
    method: "POST", body: JSON.stringify({ action: "REFUND_PAYMENT", paymentId, reason: "Cross-cafe attempt", idempotencyKey: crypto.randomUUID() }),
  });
  assert.equal(foreignTarget.status, 404, foreignTarget.text);
});

test("selected owner can reject a request and expires requests past the decision deadline", async () => {
  const rejected = await as<{ request: { id: string } }>(fx.manager.email, "/api/owner-action-requests", {
    method: "POST", body: JSON.stringify({ action: "REFUND_PAYMENT", paymentId: rejectedPaymentId, reason: "Customer changed their mind", idempotencyKey: crypto.randomUUID() }),
  });
  assert.equal(rejected.status, 201, rejected.text);
  const rejectedDecision = await as<{ status: string }>(fx.owner.email, "/api/owner-action-requests/" + rejected.body.request.id + "/decision", { method: "POST", body: JSON.stringify({ decision: "REJECT", note: "Return condition was not met" }) });
  assert.equal(rejectedDecision.status, 200, rejectedDecision.text);
  assert.equal(rejectedDecision.body.status, "REJECTED");

  const expired = await as<{ request: { id: string } }>(fx.manager.email, "/api/owner-action-requests", {
    method: "POST", body: JSON.stringify({ action: "REFUND_PAYMENT", paymentId: expiredPaymentId, reason: "Old request", idempotencyKey: crypto.randomUUID() }),
  });
  assert.equal(expired.status, 201, expired.text);
  await db.ownerActionRequest.update({ where: { id: expired.body.request.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  const expiredDecision = await as<{ status: string }>(fx.owner.email, "/api/owner-action-requests/" + expired.body.request.id + "/decision", { method: "POST", body: JSON.stringify({ decision: "ACCEPT" }) });
  assert.equal(expiredDecision.status, 200, expiredDecision.text);
  assert.equal(expiredDecision.body.status, "EXPIRED");
  assert.equal(await db.payment.count({ where: { cafeId: fx.cafeId, type: "REFUND" } }), 0);
});

test("decision audit failure rolls the request state and event back together", async () => {
  const pending = await as<{ request: { id: string } }>(fx.manager.email, "/api/owner-action-requests", {
    method: "POST", body: JSON.stringify({ action: "REFUND_PAYMENT", paymentId: expiredPaymentId, reason: "Audit rollback proof", idempotencyKey: crypto.randomUUID() }),
  });
  assert.equal(pending.status, 201, pending.text);
  const suffix = String(process.pid);
  const trigger = "ph1_owner_action_audit_fail_" + suffix;
  const fn = "ph1_owner_action_audit_fail_fn_" + suffix;
  await db.$executeRawUnsafe('CREATE FUNCTION "' + fn + '"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."action" = \'OWNER_ACTION_APPROVED\' THEN RAISE EXCEPTION \'forced owner approval audit failure\'; END IF; RETURN NEW; END $$');
  await db.$executeRawUnsafe('CREATE TRIGGER "' + trigger + '" BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION "' + fn + '"()');
  try {
    const failed = await as(fx.owner.email, "/api/owner-action-requests/" + pending.body.request.id + "/decision", { method: "POST", body: JSON.stringify({ decision: "ACCEPT" }) });
    assert.equal(failed.status, 500, failed.text);
    const request = await db.ownerActionRequest.findUniqueOrThrow({ where: { id: pending.body.request.id } });
    assert.equal(request.status, "PENDING");
    assert.equal(await db.ownerActionEvent.count({ where: { requestId: request.id, event: "APPROVED" } }), 0);
  } finally {
    await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS "' + trigger + '" ON "AuditLog"');
    await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS "' + fn + '"()');
  }
});
