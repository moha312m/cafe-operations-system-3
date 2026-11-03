import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  db, fixture, invoice, pay, drawerPay, http, shift, ledger, journal, type Fixture,
} from "./helpers/acc01b-purchase-runtime";
import { db as appDb } from "@/lib/db";
import { addDays, dateStrInTz, zonedDayStart } from "@/lib/date-range";
import { trialBalance } from "@/lib/accounting/ledger";
import { projectShadowLedger } from "@/lib/accounting/shadow-projection";
import { supplierPosition, inventoryReconciliation } from "@/lib/accounting/subledgers";

// ACC-01B supplemental: purchases, supplier payments and stock in the shadow
// books of one isolated synthetic ACC01B-VERIFY café, reconciled against the
// supplier and stock subledgers. Adapted from accounting-003 so it decides no
// open policy: the up-front payment goes through the keyed payments route, the
// cancelled invoice was never paid, and no chart account is deleted. Every
// fixture, payment, journal entry and projection issue is retained.

after(async () => { await db.$disconnect(); await appDb.$disconnect(); });

/** A new stock item of this café at zero stock, so its cost comes only from this scenario. */
async function freshItem(fx: Fixture, name: string) {
  const item = await db.inventoryItem.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, name: fx.marker + " " + name, unit: "KG", costPerUnit: 0, currentStock: "0" } });
  journal("verify-item", { cafeId: fx.cafeId, itemId: item.id, name: item.name });
  return item.id;
}
async function draft(fx: Fixture, itemId: string, quantity: number, unitCost: number, extra: Record<string, unknown> = {}) {
  const r = await http<{ id: string }>(fx.owner, "/api/purchases", "POST", { branchId: fx.branchId, items: [{ inventoryItemId: itemId, quantity, unitCost }], ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.id;
}
async function confirm(fx: Fixture, id: string) {
  const r = await http(fx.owner, "/api/purchases/" + id + "/confirm", "POST", {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
}
async function paid(fx: Fixture, id: string, amount: number, method: string, fundingSource?: string) {
  const r = await pay(fx.owner, id, { amount, method, ...(fundingSource ? { fundingSource } : {}) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}
async function move(fx: Fixture, itemId: string, body: Record<string, unknown>) {
  const r = await http(fx.owner, "/api/inventory/" + itemId + "/movement", "POST", body);
  assert.equal(r.status, 200, JSON.stringify(r.body));
}
const windowFor = (fromDate: string, toDate: string) => ({ from: zonedDayStart(fromDate), to: zonedDayStart(addDays(toDate, 1)) });

test("B1: purchases, payments and stock reconcile to the payables, advances and inventory subledgers", { timeout: 180000 }, async () => {
  const startDate = dateStrInTz(new Date());
  const fx = await fixture("VERIFY-ACC", 100);
  const milk = await freshItem(fx, "milk"), eggs = await freshItem(fx, "eggs");

  // A: 10 x 12 = 120, discount 20, tax 14 -> 114. SAFE 30 while still a draft,
  // then BANK 50 and DRAWER 20 after confirmation: paid 100, remaining 14.
  const a = await draft(fx, milk, 10, 12, { discountAmount: 20, taxAmount: 14 });
  const aDraft = await db.purchaseInvoice.findUniqueOrThrow({ where: { id: a } });
  assert.deepEqual([aDraft.subtotalAmount, aDraft.discountAmount, aDraft.taxAmount, aDraft.totalAmount].map(String), ["120", "20", "14", "114"]);
  await paid(fx, a, 30, "CASH", "SAFE");
  await confirm(fx, a);
  await paid(fx, a, 50, "BANK_TRANSFER", "BANK");
  const drawer = await drawerPay(fx, a, 20);
  assert.equal(drawer.status, 200, JSON.stringify(drawer.body));
  // B: a draft of 15, paid 15 from the safe, never confirmed.
  const b = await draft(fx, milk, 1, 15);
  await paid(fx, b, 15, "CASH", "SAFE");
  // C: 40 on another fresh item, confirmed, then cancelled while UNPAID.
  const c = await draft(fx, eggs, 1, 40);
  await confirm(fx, c);
  const cancelled = await http(fx.owner, "/api/purchases/" + c + "/cancel", "POST", {});
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  // Stock: one milk wasted at the item's cost, one adjusted with no cost.
  assert.equal(String((await db.inventoryItem.findUniqueOrThrow({ where: { id: milk } })).costPerUnit), "12", "weighted cost from the only receipt");
  await move(fx, milk, { type: "WASTE", quantity: 1 });
  await move(fx, milk, { type: "ADJUSTMENT", quantity: 1 });

  const sources = {
    invoices: await db.purchaseInvoice.findMany({ where: { cafeId: fx.cafeId }, select: { id: true, invoiceNumber: true, status: true, confirmedAt: true, cancelledAt: true, subtotalAmount: true, discountAmount: true, taxAmount: true, totalAmount: true, paidAmount: true, remainingAmount: true, paymentStatus: true }, orderBy: { createdAt: "asc" } }),
    payments: await db.purchasePayment.findMany({ where: { cafeId: fx.cafeId }, select: { id: true, purchaseInvoiceId: true, amount: true, method: true, fundingSource: true, shiftId: true, paidAt: true }, orderBy: { paidAt: "asc" } }),
    stock: await db.inventoryTransaction.findMany({ where: { cafeId: fx.cafeId }, select: { id: true, inventoryItemId: true, type: true, quantity: true, unitCost: true, totalCost: true, createdAt: true }, orderBy: { createdAt: "asc" } }),
    audits: await db.auditLog.findMany({ where: { cafeId: fx.cafeId, action: { startsWith: "PURCHASE_" } }, select: { id: true, action: true, entityId: true }, orderBy: { createdAt: "asc" } }),
  };
  journal("verify-b1-sources", { cafeId: fx.cafeId, shiftId: fx.shiftId, scenario: { a, b, c }, items: { milk, eggs }, ...sources });

  const endDate = dateStrInTz(new Date());
  const { from, to } = windowFor(startDate, endDate);
  const first = await projectShadowLedger({ cafeId: fx.cafeId, from, to, openMissingPeriods: true });
  const entriesAfterFirst = await db.journalEntry.count({ where: { cafeId: fx.cafeId } });
  const again = await projectShadowLedger({ cafeId: fx.cafeId, from, to, openMissingPeriods: true });
  const entriesAfterSecond = await db.journalEntry.count({ where: { cafeId: fx.cafeId } });
  const tb = await trialBalance({ cafeId: fx.cafeId });
  const suppliers = await supplierPosition({ cafeId: fx.cafeId, asOf: endDate });
  const stock = await inventoryReconciliation({ cafeId: fx.cafeId, asOf: endDate });
  const openShift = await shift(fx);
  const issues = await db.accountingProjectionIssue.findMany({ where: { cafeId: fx.cafeId }, select: { id: true, sourceKey: true, sourceType: true, sourceId: true, kind: true, severity: true, reason: true, resolvedAt: true } });
  // Record every actual figure before asserting, so a discrepancy is evidence, not a lost run.
  journal("verify-b1-actuals", {
    cafeId: fx.cafeId, window: { startDate, endDate, from, to }, first, again, entriesAfterFirst, entriesAfterSecond,
    trialBalance: { balanced: tb.balanced, totalDebit: tb.totalDebit, totalCredit: tb.totalCredit, accounts: tb.accounts.map((r) => ({ code: r.code, systemKey: r.systemKey, debit: r.debit, credit: r.credit, balance: r.balance })) },
    supplierPosition: suppliers, inventoryReconciliation: stock, issues,
    drawer: { shiftId: openShift.id, status: openShift.status, opening: String(openShift.openingCashAmount), expected: String(openShift.expectedCashAmount), payouts: String(openShift.totalCashPayouts) },
  });

  const adjustment = sources.stock.find((s) => s.type === "ADJUSTMENT")!;
  assert.equal(adjustment.totalCost, null, "the adjustment carries no cost");
  assert.deepEqual(first.exceptions.map((e) => [e.sourceType, e.sourceId, e.reason]), [["STOCK_MOVEMENT", adjustment.id, "حركة مخزون من غير تكلفة"]], "the uncosted movement is an exception, not a guessed value");
  assert.deepEqual(first.warnings, []);
  assert.deepEqual(first.bySource, { SUPPLIER_PAYMENT: 4, STOCK_MOVEMENT: 3, PURCHASE_INVOICE: 2, PURCHASE_CANCEL: 1 });
  assert.equal(first.posted, 10);
  assert.equal(again.posted, 0, "re-running posts nothing twice");
  assert.equal(again.replayed, first.posted);
  assert.equal(entriesAfterSecond, entriesAfterFirst); assert.equal(entriesAfterFirst, 10);
  assert.deepEqual(again.exceptions.map((e) => e.sourceId), [adjustment.id], "still visible on the second run");
  assert.deepEqual(issues.map((i) => [i.sourceId, i.kind, i.severity, i.resolvedAt]), [[adjustment.id, "UNPOSTABLE", "BLOCKING", null]]);
  assert.equal(tb.balanced, true);

  const g = (code: string) => tb.accounts.find((r) => r.code === code)?.balance ?? 0;
  assert.equal(g("1170"), 14, "purchase tax");
  assert.equal(g("5110"), 20, "purchase discount");
  assert.deepEqual({ safe: g("1120"), bank: g("1130"), drawer: g("1110") }, { safe: -45, bank: -50, drawer: -20 }, "each payment left from its own source");
  assert.equal(g("2100"), suppliers.payable, "payables control = open supplier items");
  assert.equal(suppliers.payable, 14);
  assert.deepEqual(suppliers.items.map((i) => [i.invoiceId, i.open]), [[a, 14]]);
  assert.equal(suppliers.byBucket["0-30"], 14);
  assert.equal(g("1300"), suppliers.advanceTotal, "supplier advances control = advances subledger");
  assert.equal(suppliers.advanceTotal, 15);
  assert.deepEqual(suppliers.advances.map((x) => [x.invoiceId, x.amount]), [[b, 15]]);
  assert.equal(g("2110"), 40, "goods received not invoiced keeps the cancelled invoice's retained stock");
  assert.deepEqual({ gl: stock.glInventory, ledger: stock.ledgerValue, unposted: stock.unposted, uncosted: stock.uncostedRows }, { gl: 148, ledger: 148, unposted: 0, uncosted: 1 });

  const drawerPayments = sources.payments.filter((p) => p.fundingSource === "DRAWER");
  assert.deepEqual(drawerPayments.map((p) => [String(p.amount), p.shiftId]), [["20", fx.shiftId]], "exactly one 20 drawer payment");
  assert.deepEqual([String(openShift.expectedCashAmount), String(openShift.totalCashPayouts), openShift.status], ["80", "20", "OPEN"]);
  const state = await ledger(fx, a);
  assert.deepEqual([state.paid, state.remaining, state.status], ["100", "14", "PARTIAL"]);
});

test("B2: legacy payments with no funding source stay projector exceptions; no funding journal is guessed", { timeout: 120000 }, async () => {
  const startDate = dateStrInTz(new Date());
  const fx = await fixture("VERIFY-LEGACY", null);
  const id = await invoice(fx, 30, false);
  await paid(fx, id, 10, "CASH");
  await paid(fx, id, 5, "CARD");
  const payments = await db.purchasePayment.findMany({ where: { purchaseInvoiceId: id }, select: { id: true, amount: true, method: true, fundingSource: true, shiftId: true } });
  assert.deepEqual(payments.map((p) => [p.method, p.fundingSource, p.shiftId]).sort(), [["CARD", null, null], ["CASH", null, null]]);
  const { from, to } = windowFor(startDate, dateStrInTz(new Date()));
  const report = await projectShadowLedger({ cafeId: fx.cafeId, from, to, openMissingPeriods: true });
  const supplierEntries = await db.journalEntry.count({ where: { cafeId: fx.cafeId, sourceType: "SUPPLIER_PAYMENT" } });
  journal("verify-b2-legacy", { cafeId: fx.cafeId, invoiceId: id, payments, report, supplierEntries });
  assert.deepEqual(report.exceptions.map((e) => e.sourceId).sort(), payments.map((p) => p.id).sort(), "a card method is not proof the money left a known bank account");
  for (const e of report.exceptions) { assert.equal(e.sourceType, "SUPPLIER_PAYMENT"); assert.match(e.reason, /مصدرها مش متسجل/); }
  assert.equal(supplierEntries, 0);
  assert.equal(report.posted, 0);
});
