import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, type CountCafe, COUNT_PASSWORD } from "./helpers/count";
import { as } from "./helpers/http";

let fx: CountCafe;
const paymentIds: string[] = [];
before(async () => {
  fx = await countCafe("OWNERAPPROVAL002");
  await db.ownerActionSettings.create({ data: { cafeId: fx.cafeId, ownerId: fx.owner.id } });
  for (const orderNumber of [82001, 82002, 82003]) {
    const order = await db.order.create({ data: {
      cafeId: fx.cafeId, branchId: fx.branchId, orderNumber, status: "CONFIRMED",
      subtotal: 100, total: 100, paidAmount: 100, remainingAmount: 0, paymentStatus: "PAID",
    } });
    const payment = await db.payment.create({ data: {
      cafeId: fx.cafeId, branchId: fx.branchId, orderId: order.id, amount: 100,
      method: "CASH", receivedById: fx.cashier.id,
    } });
    paymentIds.push(payment.id);
  }
});
after(async () => { if (fx) await teardownTaggedCafe(fx.cafeId); await db.$disconnect(); });

test("selected owner configures a reauthenticated passcode; staff approval is scoped, rate limited, and audit-safe", async () => {
  const initial = await as(fx.owner.email, "/api/cafe/owner-action-settings");
  assert.equal(initial.status, 200, initial.text);
  assert.match(initial.text, /passcodeConfigured/);
  assert.doesNotMatch(initial.text, /passcodeHash|passwordHash/i);
  assert.equal((initial.body as { passcodeConfigured: boolean }).passcodeConfigured, false);

  const badPassword = await as(fx.owner.email, "/api/cafe/owner-action-settings", {
    method: "POST", body: JSON.stringify({ currentPassword: "wrong-password", passcode: "001234" }),
  });
  assert.equal(badPassword.status, 401, badPassword.text);

  const staffChange = await as(fx.manager.email, "/api/cafe/owner-action-settings", {
    method: "POST", body: JSON.stringify({ currentPassword: COUNT_PASSWORD, passcode: "001234" }),
  });
  assert.equal(staffChange.status, 403, staffChange.text);


  const configured = await as(fx.owner.email, "/api/cafe/owner-action-settings", {
    method: "POST", body: JSON.stringify({ currentPassword: COUNT_PASSWORD, passcode: "001234" }),
  });
  assert.equal(configured.status, 200, configured.text);
  assert.doesNotMatch(configured.text, /001234|passcodeHash|passwordHash/i);
  const stored = await db.ownerPasscode.findUniqueOrThrow({ where: { cafeId: fx.cafeId } });
  assert.notEqual(stored.passcodeHash, "001234");
  assert.equal(await (await import("bcryptjs")).default.compare("001234", stored.passcodeHash), true);
  const modeChange = await as(fx.owner.email, "/api/cafe/owner-action-settings", {
    method: "PATCH", body: JSON.stringify({ refundMode: "OWNER_PASSCODE", currentPassword: COUNT_PASSWORD }),
  });
  assert.equal(modeChange.status, 200, modeChange.text);
  assert.equal((modeChange.body as { refundMode: string }).refundMode, "OWNER_PASSCODE");

  async function requestFor(paymentId: string, email = fx.manager.email) {
    const response = await as<{ request: { id: string; status: string } }>(email, "/api/owner-action-requests", {
      method: "POST", body: JSON.stringify({ action: "REFUND_PAYMENT", paymentId, reason: "Customer return request", idempotencyKey: crypto.randomUUID() }),
    });
    assert.equal(response.status, 201, response.text);
    assert.equal(response.body.request.status, "PENDING");
    return response.body.request.id;
  }

  const approvedId = await requestFor(paymentIds[0]);
  const wrong = await as(fx.manager.email, "/api/owner-action-requests/" + approvedId + "/passcode", {
    method: "POST", body: JSON.stringify({ passcode: "999999" }),
  });
  assert.equal(wrong.status, 401, wrong.text);
  assert.doesNotMatch(wrong.text, /999999|001234|passcodeHash/i);
  assert.equal(await db.ownerPasscodeAttempt.count({ where: { cafeId: fx.cafeId, requesterId: fx.manager.id, success: false } }), 1);
  const accepted = await as<{ status: string }>(fx.manager.email, "/api/owner-action-requests/" + approvedId + "/passcode", {
    method: "POST", body: JSON.stringify({ passcode: "001234" }),
  });
  assert.equal(accepted.status, 200, accepted.text);
  assert.equal(accepted.body.status, "APPROVED");
  const approved = await db.ownerActionRequest.findUniqueOrThrow({ where: { id: approvedId } });
  assert.equal(approved.decisionMethod, "OWNER_PASSCODE");
  assert.equal(approved.decidedById, fx.owner.id);
  assert.equal(approved.credentialVersion, stored.version);
  assert.equal(await db.payment.count({ where: { id: paymentIds[0], type: "REFUND" } }), 0);

  const lockedId = await requestFor(paymentIds[1], fx.cashier.email);
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await as(fx.cashier.email, "/api/owner-action-requests/" + lockedId + "/passcode", {
      method: "POST", body: JSON.stringify({ passcode: "999999" }),
    });
    assert.equal(result.status, 401, result.text);
    assert.doesNotMatch(result.text, /999999|001234|passcodeHash/i);
  }
  const locked = await as(fx.cashier.email, "/api/owner-action-requests/" + lockedId + "/passcode", {
    method: "POST", body: JSON.stringify({ passcode: "999999" }),
  });
  assert.equal(locked.status, 429, locked.text);
  const attempts = await db.ownerPasscodeAttempt.findMany({ where: { cafeId: fx.cafeId, requesterId: fx.cashier.id } });
  assert.equal(attempts.filter((row) => !row.success).length, 5);
  const rotationId = await requestFor(paymentIds[2]);
  const rotationApproval = await as(fx.manager.email, "/api/owner-action-requests/" + rotationId + "/passcode", {
    method: "POST", body: JSON.stringify({ passcode: "001234" }),
  });
  assert.equal(rotationApproval.status, 200, rotationApproval.text);
  const rotated = await as(fx.owner.email, "/api/cafe/owner-action-settings", {
    method: "POST", body: JSON.stringify({ currentPassword: COUNT_PASSWORD, passcode: "004321" }),
  });
  assert.equal(rotated.status, 200, rotated.text);
  assert.equal((await db.ownerActionRequest.findUniqueOrThrow({ where: { id: rotationId } })).status, "STALE");
  const serialized = JSON.stringify(await db.ownerActionEvent.findMany({ where: { cafeId: fx.cafeId } }));
  assert.doesNotMatch(serialized, /001234|999999/);
});