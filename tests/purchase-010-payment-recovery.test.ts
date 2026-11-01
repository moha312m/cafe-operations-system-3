import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, fixture, invoice, pay, drawerPay, http, shift, ledger, journal } from "./helpers/acc01b-purchase-runtime";

// Supplier payments are keyed so an uncertain attempt can be recovered without
// paying twice. Recovery must keep working after the drawer closes or the
// invoice is settled, and must still respect who may see the invoice.

after(async () => { await db.$disconnect(); });

const bodyOf = (amount: number, extra: Record<string, unknown> = {}) => ({ amount, method: "CASH", fundingSource: "SAFE", ...extra });

test("same key and body records one payment and one audit; the retry replays the saved response", { timeout: 120000 }, async () => {
  const fx = await fixture("P010-REPLAY", null);
  const id = await invoice(fx, 100);
  const key = randomUUID();
  const first = await pay(fx.manager, id, bodyOf(40), key);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const again = await pay(fx.manager, id, bodyOf(40), key);
  assert.equal(again.status, 200);
  assert.equal(again.headers.get("Idempotency-Replayed"), "true");
  assert.deepEqual(again.body, first.body);
  const state = await ledger(fx, id);
  assert.equal(state.payments.length, 1); assert.equal(state.audits, 1); assert.equal(state.paid, "40");
  const changed = await pay(fx.manager, id, bodyOf(41), key);
  assert.equal(changed.status, 409, JSON.stringify(changed.body));
  assert.equal((await ledger(fx, id)).payments.length, 1, "a changed body under the same key records nothing");
  journal("p010-replay", { cafeId: fx.cafeId, invoiceId: id, statuses: [first.status, again.status, changed.status] });
});

test("amounts beyond two decimals, capacity, non-numbers and incompatible sources are refused before any write", { timeout: 120000 }, async () => {
  const fx = await fixture("P010-INPUT", 100);
  const id = await invoice(fx, 100);
  const before = await shift(fx);
  for (const body of [bodyOf(1.005), bodyOf(0.001), bodyOf(10000000000), bodyOf(0), bodyOf(-1), { ...bodyOf(5), amount: "5" },
    { amount: 5, method: "CARD", fundingSource: "DRAWER" }, { amount: 5, method: "CASH", fundingSource: "BANK" }]) {
    const r = await pay(fx.manager, id, body);
    assert.equal(r.status, 400, JSON.stringify(body) + " -> " + JSON.stringify(r.body));
    assert.match(String(r.body.error), /[؀-ۿ]/, "clear Arabic refusal");
  }
  const state = await ledger(fx, id);
  assert.equal(state.payments.length, 0); assert.equal(state.audits, 0); assert.equal(state.paid, "0");
  assert.equal(String((await shift(fx)).expectedCashAmount), String(before.expectedCashAmount));
});

test("non-drawer and legacy unspecified payments leave the drawer untouched", { timeout: 120000 }, async () => {
  const fx = await fixture("P010-SOURCES", 100);
  const id = await invoice(fx, 100);
  for (const body of [bodyOf(10), { amount: 10, method: "BANK_TRANSFER", fundingSource: "BANK" }, { amount: 10, method: "CASH" }]) {
    const r = await pay(fx.manager, id, body);
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const state = await ledger(fx, id);
  assert.deepEqual(state.payments.map((p) => [p.fundingSource, p.shiftId]), [["SAFE", null], ["BANK", null], [null, null]], "legacy source stays unspecified, never guessed");
  const drawer = await shift(fx);
  assert.equal(String(drawer.expectedCashAmount), "100"); assert.equal(String(drawer.totalCashPayouts), "0");
});

test("other café, other branch and revoked payers are refused, including on replay of a completed key", { timeout: 120000 }, async () => {
  const fx = await fixture("P010-ACCESS", null);
  const outsider = await fixture("P010-OUTSIDER", null);
  const id = await invoice(fx, 100);
  const key = randomUUID();
  const done = await pay(fx.clerk, id, bodyOf(25), key);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  for (const [who, actor] of [["other café owner", outsider.owner], ["annex manager", fx.annexManager]] as const) {
    const fresh = await pay(actor, id, bodyOf(5));
    assert.ok([403, 404].includes(fresh.status), who + ": " + JSON.stringify(fresh.body));
    const replay = await pay(actor, id, bodyOf(25), key);
    assert.ok([403, 404].includes(replay.status), who + " replay: " + JSON.stringify(replay.body));
  }
  const revoked = await http(fx.owner, "/api/users/" + fx.clerk.id + "/permissions", "PUT", { overrides: [{ key: "expenses.view", allowed: true }, { key: "expenses.manage", allowed: true }, { key: "purchases.record_payment", allowed: false }] });
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  const afterRevoke = await pay(fx.clerk, id, bodyOf(25), key);
  assert.equal(afterRevoke.status, 403, "revocation still denies the cached result: " + JSON.stringify(afterRevoke.body));
  const state = await ledger(fx, id);
  assert.equal(state.payments.length, 1); assert.equal(state.audits, 1); assert.equal(state.paid, "25");
});

test("a completed drawer payment recovers after the drawer closes, without reopening or changing the closed snapshot", { timeout: 120000 }, async () => {
  const fx = await fixture("P010-AFTER-CLOSE", 100);
  const id = await invoice(fx, 100);
  const key = randomUUID();
  const paid = await drawerPay(fx, id, 30, key);
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  const closed = await http(fx.manager, "/api/shifts/" + fx.shiftId + "/close", "POST", { actualCashAmount: 70 });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  const snapshot = await shift(fx);
  assert.equal(snapshot.status, "CLOSED"); assert.equal(String(snapshot.expectedCashAmount), "70"); assert.equal(String(snapshot.totalCashPayouts), "30");
  const replay = await drawerPay(fx, id, 30, key);
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.headers.get("Idempotency-Replayed"), "true");
  assert.deepEqual(replay.body, paid.body);
  const fresh = await drawerPay(fx, id, 10);
  assert.equal(fresh.status, 400, "a new drawer payment needs an open drawer: " + JSON.stringify(fresh.body));
  assert.deepEqual(await shift(fx), snapshot, "closed snapshot unchanged");
  const state = await ledger(fx, id);
  assert.equal(state.payments.length, 1); assert.equal(state.audits, 1);
});

test("a completed payment recovers after the invoice is fully settled; a new payment is refused", { timeout: 120000 }, async () => {
  const fx = await fixture("P010-SETTLED", null);
  const id = await invoice(fx, 100);
  const key = randomUUID();
  const settled = await pay(fx.manager, id, bodyOf(100), key);
  assert.equal(settled.status, 200, JSON.stringify(settled.body));
  assert.equal(settled.body.paymentStatus, "PAID");
  const replay = await pay(fx.manager, id, bodyOf(100), key);
  assert.equal(replay.status, 200); assert.deepEqual(replay.body, settled.body);
  const fresh = await pay(fx.manager, id, bodyOf(1));
  assert.equal(fresh.status, 400, JSON.stringify(fresh.body));
  const state = await ledger(fx, id);
  assert.equal(state.payments.length, 1); assert.equal(state.remaining, "0");
});
