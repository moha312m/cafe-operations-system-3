import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Prisma } from "@prisma/client";
import {
  db, fixture, invoice, drawerPay, expense, http, shift, ledger, locked, blockedOn, waitFor, journal, type Fixture,
} from "./helpers/acc01b-purchase-runtime";
import { protectedTransaction } from "@/lib/protected-transaction";
import { lockShifts } from "@/lib/transaction-locks";
import { recomputeShiftTotals } from "@/lib/shifts";

// A supplier payment and an operating expense spend the same drawer. Under the
// established Shift-then-invoice lock order they must serialize: no cash is
// spent twice, a close sees either all or none of a racing payment, and a
// failed audit takes the payment, the invoice balance and the drawer back.

after(async () => { await db.$disconnect(); });

const holdShift = (fx: Fixture) => (tx: Prisma.TransactionClient) =>
  tx.$queryRaw`SELECT id FROM "Shift" WHERE id = ${fx.shiftId} FOR UPDATE`.then(() => {});

test("a drawer supplier payment of 70 and an expense of 60 cannot both spend 100", { timeout: 120000 }, async () => {
  const fx = await fixture("P009-MIXED", 100);
  const id = await invoice(fx, 100);
  const [payment, payout] = await locked(holdShift(fx), async (release) => {
    const p = drawerPay(fx, id, 70), e = expense(fx, 60);
    await waitFor(() => blockedOn("Shift", 2), "payment and expense queued on the drawer");
    release();
    return Promise.all([p, e]);
  });
  const paymentWon = payment.status === 200, expenseWon = payout.status === 201;
  assert.equal(Number(paymentWon) + Number(expenseWon), 1, JSON.stringify([payment.status, payment.body, payout.status, payout.body]));
  assert.ok([400, 409].includes(paymentWon ? payout.status : payment.status), "the loser is refused, not half-applied");
  const drawer = await shift(fx);
  assert.equal(String(drawer.expectedCashAmount), paymentWon ? "30" : "40");
  assert.ok(Number(drawer.expectedCashAmount) >= 0);
  const state = await ledger(fx, id);
  assert.equal(state.payments.length, paymentWon ? 1 : 0); assert.equal(state.audits, paymentWon ? 1 : 0);
  assert.equal(await db.operatingExpense.count({ where: { cafeId: fx.cafeId } }), expenseWon ? 1 : 0);
  assert.equal(await db.auditLog.count({ where: { cafeId: fx.cafeId, action: "OPERATING_EXPENSE_PAID" } }), expenseWon ? 1 : 0);
  journal("p009-mixed-race", { cafeId: fx.cafeId, winner: paymentWon ? "supplier-payment" : "expense", statuses: [payment.status, payout.status], expected: String(drawer.expectedCashAmount) });
});

test("two drawer payments of 70 and 60 cannot overpay a 100 invoice or deduct twice", { timeout: 120000 }, async () => {
  const fx = await fixture("P009-TWO-PAYMENTS", 500);
  const id = await invoice(fx, 100);
  const results = await locked(holdShift(fx), async (release) => {
    const a = drawerPay(fx, id, 70), b = drawerPay(fx, id, 60);
    await waitFor(() => blockedOn("Shift", 2), "two payments queued on the drawer");
    release();
    return Promise.all([a, b]);
  });
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 400], JSON.stringify(results.map((r) => r.body)));
  const winner = results[0].status === 200 ? 70 : 60;
  const state = await ledger(fx, id);
  assert.equal(state.payments.length, 1); assert.equal(state.audits, 1);
  assert.equal(state.paid, String(winner)); assert.ok(Number(state.paid) <= 100);
  assert.equal(String((await shift(fx)).expectedCashAmount), String(500 - winner));
  journal("p009-two-payments", { cafeId: fx.cafeId, winner, statuses: results.map((r) => r.status) });
});

test("a drawer payment racing the close is either in the closed snapshot or refused; replay never reopens it", { timeout: 120000 }, async () => {
  const fx = await fixture("P009-CLOSE", 100);
  const id = await invoice(fx, 100);
  const key = randomUUID();
  const [payment, close] = await locked(holdShift(fx), async (release) => {
    const p = drawerPay(fx, id, 20, key);
    const c = http(fx.manager, "/api/shifts/" + fx.shiftId + "/close", "POST", { actualCashAmount: 100, reason: "ACC-01B controlled race count" });
    await waitFor(() => blockedOn("Shift", 2), "payment and close queued on the drawer");
    release();
    return Promise.all([p, c]);
  });
  assert.equal(close.status, 200, JSON.stringify(close.body));
  assert.ok([200, 400, 409].includes(payment.status), JSON.stringify(payment.body));
  const snapshot = await shift(fx);
  assert.equal(snapshot.status, "CLOSED");
  const paid = payment.status === 200;
  assert.equal(String(snapshot.expectedCashAmount), paid ? "80" : "100");
  assert.equal(String(snapshot.totalCashPayouts), paid ? "20" : "0");
  assert.equal((await ledger(fx, id)).payments.length, paid ? 1 : 0);
  if (paid) {
    const replay = await drawerPay(fx, id, 20, key);
    assert.equal(replay.status, 200); assert.deepEqual(replay.body, payment.body);
  }
  assert.deepEqual(await shift(fx), snapshot, "the closed snapshot is untouched by replay or later reads");
  journal("p009-payment-vs-close", { cafeId: fx.cafeId, paymentStatus: payment.status, closeStatus: close.status, expected: String(snapshot.expectedCashAmount) });
});

test("recomputing the drawer twice is stable and keeps sales and refunds apart", { timeout: 120000 }, async () => {
  const fx = await fixture("P009-RECOMPUTE", 100);
  const id = await invoice(fx, 100);
  assert.equal((await drawerPay(fx, id, 30)).status, 200);
  assert.equal((await expense(fx, 20)).status, 201);
  const before = await shift(fx);
  const recompute = () => protectedTransaction(async (tx) => { await lockShifts(tx, [fx.shiftId!]); return recomputeShiftTotals(fx.shiftId!, tx); }, { cafeId: fx.cafeId, branchId: fx.branchId });
  const first = await recompute(), second = await recompute();
  for (const r of [first!, second!]) {
    assert.equal(String(r.expectedCashAmount), "50");
    assert.equal(String(r.totalCashPayouts), "30");
    assert.equal(String(r.totalExpensePayouts), "20");
    assert.equal(String(r.totalSales), "0"); assert.equal(String(r.totalRefunds), "0");
  }
  const after = await shift(fx);
  assert.equal(String(after.expectedCashAmount), String(before.expectedCashAmount));
  assert.equal(String(after.totalSales), String(before.totalSales));
  assert.equal(String(after.totalRefunds), String(before.totalRefunds));
});

test("a failed payment audit rolls back the payment, the invoice balance and the drawer; the same key then succeeds once", { timeout: 120000 }, async () => {
  const fx = await fixture("P009-AUDIT", 100);
  const id = await invoice(fx, 100);
  const key = randomUUID();
  const fn = "acc01b_payment_audit_" + randomUUID().replaceAll("-", ""), trigger = fn + "_trg";
  const dir = path.join(process.env.ACC01B_EVIDENCE_DIR ?? "", "fixture-journal");
  const file = path.join(dir, fx.marker + "-" + fn + ".json");
  const record = (phase: string, created: { function: boolean; trigger: boolean }) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ phase, marker: fx.marker, database: "cafe_ops_test_finf5 only", table: "AuditLog", action: "PURCHASE_PAYMENT_RECORDED", entityId: id, catalogObjects: { function: fn, trigger, created }, cleanup: "Drop only the named trigger, then the named function; no CASCADE." }, null, 2));
  };
  record("PLANNED", { function: false, trigger: false });
  let failed!: Awaited<ReturnType<typeof drawerPay>>;
  await db.$executeRawUnsafe(`CREATE FUNCTION ${fn}() RETURNS trigger AS $f$ BEGIN IF NEW."action" = 'PURCHASE_PAYMENT_RECORDED' AND NEW."entityId" = '${id}' THEN RAISE EXCEPTION 'owned ACC-01B payment audit failure'; END IF; RETURN NEW; END; $f$ LANGUAGE plpgsql`);
  record("FUNCTION_CREATED", { function: true, trigger: false });
  try {
    await db.$executeRawUnsafe(`CREATE TRIGGER ${trigger} BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    record("TRIGGER_CREATED", { function: true, trigger: true });
    try { failed = await drawerPay(fx, id, 30, key); } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER ${trigger} ON "AuditLog"`);
      record("TRIGGER_REMOVED", { function: true, trigger: false });
    }
  } finally {
    await db.$executeRawUnsafe(`DROP FUNCTION ${fn}()`);
    record("REMOVED", { function: false, trigger: false });
  }
  assert.equal(failed.status, 500, JSON.stringify(failed.body));
  const rolledBack = await ledger(fx, id);
  assert.equal(rolledBack.payments.length, 0); assert.equal(rolledBack.paid, "0"); assert.equal(rolledBack.audits, 0);
  const drawer = await shift(fx);
  assert.equal(String(drawer.expectedCashAmount), "100"); assert.equal(String(drawer.totalCashPayouts), "0");
  const retry = await drawerPay(fx, id, 30, key);
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  const state = await ledger(fx, id);
  assert.equal(state.payments.length, 1); assert.equal(state.audits, 1); assert.equal(state.paid, "30");
  assert.equal(String((await shift(fx)).expectedCashAmount), "70");
});
