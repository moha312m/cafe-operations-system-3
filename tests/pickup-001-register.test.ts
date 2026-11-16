import assert from "node:assert/strict";
import { test } from "node:test";

const pickup = () => import("../src/lib/register-pickup");

test("pickup excludes table service, delivery, unapproved QR, and finished orders", async () => {
  const { isRegisterPickup } = await pickup();
  const ready = { type: "TAKEAWAY", status: "READY", tableSessionId: null, tableNumber: null, source: "CASHIER_POS", approvalStatus: "NOT_REQUIRED", paymentStatus: "PARTIAL" };
  assert.equal(isRegisterPickup(ready), true);
  for (const fields of [{ type: "DELIVERY" }, { type: "DINE_IN" }, { tableSessionId: "table" }, { tableNumber: "4" }, { source: "QR_MENU", approvalStatus: "PENDING_APPROVAL" }, { source: "QR_MENU", approvalStatus: "REJECTED" }, { status: "SERVED" }, { paymentStatus: "REFUNDED" }]) {
    assert.equal(isRegisterPickup({ ...ready, ...fields }), false, JSON.stringify(fields));
  }
  assert.equal(isRegisterPickup({ ...ready, source: "QR_MENU", approvalStatus: "APPROVED" }), true);
  assert.equal(isRegisterPickup({ ...ready, source: "QR_MENU", approvalStatus: "NOT_REQUIRED" }), true);
});

test("a settled ready order offers only handoff; a partial collection never offers handoff alone", async () => {
  const { pickupAction } = await pickup();
  assert.equal(pickupAction({ paymentStatus: "PAID", remainingAmount: "0.00" }, { collect: false, serve: true }), "handoff");
  assert.equal(pickupAction({ paymentStatus: "PAID", remainingAmount: "0.00" }, { collect: true, serve: false }), null);
  assert.equal(pickupAction({ paymentStatus: "PARTIAL", remainingAmount: "18.01" }, { collect: true, serve: true }), "collect-and-handoff");
  assert.equal(pickupAction({ paymentStatus: "PARTIAL", remainingAmount: "18.01" }, { collect: true, serve: false }), "collect");
  assert.equal(pickupAction({ paymentStatus: "PARTIAL", remainingAmount: "18.01" }, { collect: false, serve: true }), null);
  assert.equal(pickupAction({ paymentStatus: "PENDING_COLLECTION", remainingAmount: "0.00" }, { collect: false, serve: true }), "handoff");
  assert.equal(pickupAction({ paymentStatus: "REFUNDED", remainingAmount: "0.00" }, { collect: true, serve: true }), null);
});

test("pickup search matches Arabic or Latin order numbers exactly without losing name search", async () => {
  const { pickupSearchFilter } = await pickup();
  assert.deepEqual(pickupSearchFilter(" #١٢٣ "), { orderNumber: 123 });
  assert.deepEqual(pickupSearchFilter("123"), { orderNumber: 123 });
  assert.deepEqual(pickupSearchFilter(" ليلى "), { OR: [
    { customerName: { contains: "ليلى", mode: "insensitive" } },
    { customer: { is: { name: { contains: "ليلى", mode: "insensitive" } } } },
  ] });
  assert.deepEqual(pickupSearchFilter(" "), {});
});

test("after an uncertain payment, replay uses the original body and key before any handoff", async () => {
  const { resolvePickupCollection } = await pickup();
  const attempt = { key: "original-idempotency-key", body: { orderId: "branch-a-order", amount: 18.01, method: "CASH" }, handoff: true };
  const calls: unknown[] = [];
  const outcome = await resolvePickupCollection(attempt, {
    pay: async (original) => { calls.push(original); return { payments: [{ id: "payment-a" }], remainingAmount: "0.00" }; },
    handoff: async (id) => { calls.push(id); throw Error("custody refused"); },
    read: async (id) => { calls.push(["read", id]); return { status: "READY", paymentStatus: "PAID", remainingAmount: "0.00" }; },
  });
  assert.deepEqual(calls, [attempt, "branch-a-order", ["read", "branch-a-order"]]);
  assert.equal(outcome.kind, "paid-awaiting-handoff");
  assert.equal(outcome.paymentId, "payment-a");
});

test("partial collection and an unresolved write failure never send handoff", async () => {
  const { resolvePickupCollection } = await pickup();
  const attempt = { key: "original-idempotency-key", body: { orderId: "order-a" }, handoff: true };
  const ports = {
    read: async () => ({ status: "READY", paymentStatus: "PARTIAL", remainingAmount: "10.00" }),
    handoff: async () => { assert.fail("unexpected handoff"); },
  };
  assert.equal((await resolvePickupCollection(attempt, { ...ports, pay: async () => ({ payments: [{ id: "payment" }], remainingAmount: "10.00" }) })).kind, "collected");
  await assert.rejects(resolvePickupCollection(attempt, { ...ports, pay: async () => { throw Error("response lost"); } }), /response lost/);
});

test("recovery is user scoped and keeps different branch order IDs even when numbers repeat", async () => {
  const { listPickupAttempts, pickupAttemptStorageKey } = await pickup();
  const rows = new Map<string, string>();
  function save(userId: string, orderId: string, branchId: string) {
    rows.set(pickupAttemptStorageKey(userId, orderId), JSON.stringify({
      key: `attempt-for-${orderId}`, body: { orderId, amount: 18.01, pickupExpectedRemaining: "18.01" },
      handoff: true, reference: { branchId, orderNumber: 23 },
    }));
  }
  save("a", "one", "branch-a");
  save("a", "two", "branch-b");
  save("b", "three", "branch-a");
  const storage = { length: rows.size, key: (index: number) => [...rows.keys()][index] ?? null, getItem: (key: string) => rows.get(key) ?? null };
  assert.deepEqual(listPickupAttempts(storage, "a").map(x => [x.body.orderId, x.reference?.branchId, x.reference?.orderNumber]),
    [["one", "branch-a", 23], ["two", "branch-b", 23]]);
});
