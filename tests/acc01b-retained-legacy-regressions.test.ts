import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import {
  db, fixture, invoice, pay, drawerPay, http, shift, ledger, locked, blockedOn, waitFor, journal,
} from "./helpers/acc01b-purchase-runtime";

// ACC-01B supplemental: the legacy purchase-002/003 assertions no new suite
// already establishes, re-made on retained ACC01B-VERIFY fixtures. Nothing is
// purged; after() only disconnects. The original suites stay NOT RUN.

after(async () => { await db.$disconnect(); });

const safe = (amount: number) => ({ amount, method: "CASH", fundingSource: "SAFE" });
const auditsOf = (cafeId: string, invoiceId: string) => db.auditLog.findMany({
  where: { cafeId, action: "PURCHASE_PAYMENT_RECORDED", entityId: invoiceId }, orderBy: { createdAt: "asc" },
});

test("A1: ten drawer payments of 30 on a 100 invoice stop at 90, with one audit each and one 90 drawer deduction", { timeout: 180000 }, async () => {
  const fx = await fixture("VERIFY-BURST", 500);
  const id = await invoice(fx, 100);
  // Compile the route with a request every version refuses before writing.
  assert.equal((await drawerPay(fx, id, 0)).status, 400);
  const before = await shift(fx);
  const keys = Array.from({ length: 10 }, () => randomUUID());
  let observedWaiters = 0;
  const watching = (async () => {
    for (let n = 0; n < 100 && observedWaiters < 2; n++) {
      if (await blockedOn("PurchaseInvoice", 1) || await blockedOn("Shift", 1)) observedWaiters++;
      await new Promise((r) => setTimeout(r, 10));
    }
  })();
  const responses = await Promise.all(keys.map((key) => drawerPay(fx, id, 30, key)));
  await watching;
  const statuses = responses.map((r) => r.status);
  journal("verify-a1-burst", { cafeId: fx.cafeId, invoiceId: id, statuses, bodies: responses.map((r) => r.body), lockWaitSamples: observedWaiters });
  assert.equal(statuses.filter((s) => s === 200).length, 3, JSON.stringify(responses.map((r) => [r.status, r.body])));
  assert.ok(statuses.every((s) => [200, 400, 409].includes(s)), "refusals are explicit 400/409, never a server error: " + statuses.join(","));
  const state = await ledger(fx, id);
  assert.equal(state.payments.length, 3);
  assert.deepEqual(state.payments.map((p) => [String(p.amount), p.fundingSource, p.shiftId, p.method]), Array(3).fill(["30", "DRAWER", fx.shiftId, "CASH"]));
  assert.equal(new Set(state.payments.map((p) => p.id)).size, 3, "no duplicated source row");
  assert.equal(state.paid, "90"); assert.equal(state.remaining, "10"); assert.equal(state.status, "PARTIAL");
  const audits = await auditsOf(fx.cafeId, id);
  assert.equal(audits.length, 3);
  assert.deepEqual(audits.map((a) => (a.details as { paymentId: string }).paymentId).sort(), state.payments.map((p) => p.id).sort(), "each audit names its own payment");
  for (const a of audits) {
    const d = a.details as { amount: number; fundingSource: string; shiftId: string };
    assert.deepEqual([d.amount, d.fundingSource, d.shiftId], [30, "DRAWER", fx.shiftId]);
  }
  const drawer = await shift(fx);
  assert.equal(String(before.expectedCashAmount), "500");
  assert.equal(String(drawer.expectedCashAmount), "410", "one 90 deduction in total");
  assert.equal(String(drawer.totalCashPayouts), "90");
  assert.equal(String(drawer.totalCashSales), "0", "a payout is not negative sales");
  journal("verify-a1-result", { cafeId: fx.cafeId, invoiceId: id, paymentIds: state.payments.map((p) => p.id), auditIds: audits.map((a) => a.id), shiftId: fx.shiftId, expected: String(drawer.expectedCashAmount), payouts: String(drawer.totalCashPayouts) });
});

test("A2: a payment of 40 and a discount edit of 20 queued on a held DRAFT invoice both apply: total 80, paid 40, remaining 40", { timeout: 120000 }, async () => {
  const fx = await fixture("VERIFY-EDIT", null);
  const id = await invoice(fx, 100, false);
  assert.equal((await pay(fx.owner, id, safe(0))).status, 400);
  assert.equal((await http(fx.owner, "/api/purchases/" + id, "PATCH", { discountAmount: -1 })).status, 400);
  const holdInvoice = (tx: Prisma.TransactionClient) => tx.$queryRaw`SELECT id FROM "PurchaseInvoice" WHERE id = ${id} FOR UPDATE`.then(() => {});
  const [payment, edit] = await locked(holdInvoice, async (release) => {
    const p = pay(fx.owner, id, safe(40)), e = http(fx.owner, "/api/purchases/" + id, "PATCH", { discountAmount: 20 });
    await waitFor(() => blockedOn("PurchaseInvoice", 2), "payment and edit queued on the invoice", 15000);
    release();
    return Promise.all([p, e]);
  });
  journal("verify-a2-edit-race", { cafeId: fx.cafeId, invoiceId: id, statuses: [payment.status, edit.status], bodies: [payment.body, edit.body] });
  assert.equal(payment.status, 200, JSON.stringify(payment.body));
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  const inv = await db.purchaseInvoice.findUniqueOrThrow({ where: { id } });
  const state = await ledger(fx, id);
  assert.equal(inv.status, "DRAFT");
  assert.equal(String(inv.totalAmount), "80");
  assert.equal(state.paid, "40"); assert.equal(state.remaining, "40"); assert.equal(state.status, "PARTIAL");
  assert.equal(state.payments.reduce((sum, p) => sum + Number(p.amount), 0), 40, "payment records sum to the stored paid amount");
  assert.equal(state.payments.length, 1); assert.equal(state.audits, 1);
  journal("verify-a2-result", { cafeId: fx.cafeId, invoiceId: id, paymentIds: state.payments.map((p) => p.id), total: String(inv.totalAmount), paid: state.paid, remaining: state.remaining });
});

test("A3: a valid payment without an Idempotency-Key is refused with 400 and changes nothing", { timeout: 120000 }, async () => {
  const fx = await fixture("VERIFY-NOKEY", null);
  const id = await invoice(fx, 100);
  const before = await ledger(fx, id);
  const inv = await db.purchaseInvoice.findUniqueOrThrow({ where: { id } });
  const r = await http(fx.owner, "/api/purchases/" + id + "/payments", "POST", safe(10));
  journal("verify-a3-missing-key", { cafeId: fx.cafeId, invoiceId: id, status: r.status, body: r.body });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(String((r.body as { error?: string }).error), /[؀-ۿ]/, "clear Arabic refusal");
  const afterState = await ledger(fx, id);
  assert.equal(afterState.payments.length, before.payments.length); assert.equal(afterState.payments.length, 0);
  assert.equal(afterState.audits, 0);
  assert.deepEqual([afterState.paid, afterState.remaining, afterState.status], [before.paid, before.remaining, before.status]);
  assert.deepEqual(await db.purchaseInvoice.findUniqueOrThrow({ where: { id } }), inv, "invoice row unchanged");
});

test("A4: the database refuses funding/shift/method contradictions; nothing commits", { timeout: 120000 }, async () => {
  const fx = await fixture("VERIFY-CHECK", 100);
  const id = await invoice(fx, 100);
  const [constraint] = await db.$queryRaw<{ name: string; definition: string }[]>`SELECT conname AS name, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = '"PurchasePayment"'::regclass AND conname = 'PurchasePayment_funding_check'`;
  assert.ok(constraint, "funding check exists");
  const base = { cafeId: fx.cafeId, branchId: fx.branchId, purchaseInvoiceId: id, amount: 1 };
  const outcomes: { label: string; rejected: boolean; message: string }[] = [];
  for (const [label, data] of [
    ["drawer without a shift", { ...base, method: "CASH", fundingSource: "DRAWER" }],
    ["a shift on a safe payment", { ...base, method: "CASH", fundingSource: "SAFE", shiftId: fx.shiftId! }],
    ["a safe paying by card", { ...base, method: "CARD", fundingSource: "SAFE" }],
    ["a bank paying cash", { ...base, method: "CASH", fundingSource: "BANK" }],
  ] as const) {
    let message = "";
    await assert.rejects(
      db.$transaction(async (tx) => { await tx.purchasePayment.create({ data: data as Prisma.PurchasePaymentUncheckedCreateInput }); }),
      (error: Error) => { message = error.message; return /PurchasePayment_funding_check|23514|check constraint/i.test(message); },
      label,
    );
    outcomes.push({ label, rejected: true, message: message.split("\n").filter(Boolean).slice(-1)[0] ?? "" });
  }
  journal("verify-a4-check", { cafeId: fx.cafeId, invoiceId: id, constraint, outcomes });
  const state = await ledger(fx, id);
  assert.equal(state.payments.length, 0, "no rejected insert committed");
  assert.equal(await db.purchasePayment.count({ where: { cafeId: fx.cafeId } }), 0);
  assert.equal(state.paid, "0"); assert.equal(state.audits, 0);
  assert.equal(String((await shift(fx)).expectedCashAmount), "100");
});

test("A5: a drawer payment above the drawer and a drawer payment at creation are refused with no effect", { timeout: 120000 }, async () => {
  const fx = await fixture("VERIFY-DRAWER-LIMIT", 100);
  const id = await invoice(fx, 300);
  const over = await drawerPay(fx, id, 150);
  assert.equal(over.status, 400, "more than the drawer holds: " + JSON.stringify(over.body));
  const created = await http(fx.owner, "/api/purchases", "POST", { branchId: fx.branchId, items: [{ inventoryItemId: fx.itemId, quantity: 1, unitCost: 10 }], payment: { amount: 10, method: "CASH", fundingSource: "DRAWER" } });
  assert.equal(created.status, 400, "a drawer payment is never recorded on invoice creation: " + JSON.stringify(created.body));
  journal("verify-a5-drawer-limit", { cafeId: fx.cafeId, invoiceId: id, statuses: [over.status, created.status], bodies: [over.body, created.body] });
  assert.equal(await db.purchasePayment.count({ where: { cafeId: fx.cafeId } }), 0);
  assert.equal(await db.purchaseInvoice.count({ where: { cafeId: fx.cafeId } }), 1, "the refused creation wrote no invoice");
  const drawer = await shift(fx);
  assert.equal(String(drawer.expectedCashAmount), "100"); assert.equal(String(drawer.totalCashPayouts), "0");
});
