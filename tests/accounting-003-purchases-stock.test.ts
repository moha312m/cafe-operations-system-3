// ACCOUNTING-003: purchases, supplier payments and stock movements reach the
// shadow books, and the payables, advances and inventory control accounts
// each reconcile to their subledger as of the day.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, countItem, COUNT_PASSWORD, type CountCafe } from "./helpers/count";
import { as, login, requireServer } from "./helpers/http";
import { addDays, dateStrInTz, zonedDayStart } from "@/lib/date-range";
import { ensureAccountingEntity } from "@/lib/accounting/chart";
import { trialBalance } from "@/lib/accounting/ledger";
import { projectShadowLedger } from "@/lib/accounting/shadow-projection";
import { supplierPosition, inventoryReconciliation } from "@/lib/accounting/subledgers";

after(async () => { await db.$disconnect(); });

async function invoice(fx: CountCafe, itemId: string, quantity: number, unitCost: number, extra: Record<string, unknown> = {}) {
  const r = await as<{ id: string }>(fx.owner.email, "/api/purchases", { method: "POST", body: JSON.stringify({ branchId: fx.branchId, items: [{ inventoryItemId: itemId, quantity, unitCost }], ...extra }) });
  assert.equal(r.status, 201, r.text);
  return r.body.id;
}
const confirm = async (fx: CountCafe, id: string) => assert.equal((await as(fx.owner.email, `/api/purchases/${id}/confirm`, { method: "POST", body: "{}" })).status, 200);
async function pay(fx: CountCafe, id: string, amount: number, method: string, fundingSource: string) {
  const r = await as(fx.owner.email, `/api/purchases/${id}/payments`, { method: "POST", headers: { "Idempotency-Key": randomUUID() }, body: JSON.stringify({ amount, method, fundingSource }) });
  assert.equal(r.status, 200, r.text);
}
async function move(fx: CountCafe, itemId: string, body: Record<string, unknown>) {
  const r = await as(fx.owner.email, `/api/inventory/${itemId}/movement`, { method: "POST", body: JSON.stringify(body) });
  assert.equal(r.status, 200, r.text);
}
const today = () => dateStrInTz(new Date());
const span = (date: string) => ({ from: zonedDayStart(date), to: zonedDayStart(addDays(date, 1)) });
async function gl(cafeId: string, to?: string) {
  const rows = new Map((await trialBalance({ cafeId, to })).accounts.map(r => [r.code, r.balance]));
  return (code: string) => rows.get(code) ?? 0;
}

test("purchases, payments and stock reconcile to their subledgers", { timeout: 60000 }, async () => {
  await requireServer();
  const fx = await countCafe("ACC003FLOW");
  try {
    await login(fx.owner.email, COUNT_PASSWORD);
    const milk = await countItem(fx, "milk"), eggs = await countItem(fx, "eggs");
    const last = await db.shift.aggregate({ where: { branchId: fx.branchId }, _max: { shiftNumber: true } });
    await db.shift.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, cashierId: fx.owner.id, shiftNumber: (last._max.shiftNumber ?? 0) + 1, openingCashAmount: 100, expectedCashAmount: 100 } });

    // A: 10 x 12 = 120, discount 20, tax 14 → 114. 30 from the safe up front,
    // then 50 by bank and 20 from the drawer after confirmation.
    const a = await invoice(fx, milk.id, 10, 12, { discountAmount: 20, taxAmount: 14, payment: { amount: 30, method: "CASH", fundingSource: "SAFE" } });
    await confirm(fx, a);
    await pay(fx, a, 50, "BANK_TRANSFER", "BANK");
    await pay(fx, a, 20, "CASH", "DRAWER");
    // B: a draft paid 15 from the safe and never confirmed.
    const b = await invoice(fx, milk.id, 1, 15);
    await pay(fx, b, 15, "CASH", "SAFE");
    // C: 40, paid 10 before and 5 after confirmation, then cancelled.
    const c = await invoice(fx, eggs.id, 1, 40);
    await pay(fx, c, 10, "BANK_TRANSFER", "BANK");
    await confirm(fx, c);
    await pay(fx, c, 5, "BANK_TRANSFER", "BANK");
    assert.equal((await as(fx.owner.email, `/api/purchases/${c}/cancel`, { method: "POST", body: "{}" })).status, 200);
    // Stock: one milk wasted (valued at average cost), one adjusted with no cost.
    await move(fx, milk.id, { type: "WASTE", quantity: 1 });
    await move(fx, milk.id, { type: "ADJUSTMENT", quantity: 1 });

    const date = today(), { from, to } = span(date);
    const first = await projectShadowLedger({ cafeId: fx.cafeId, from, to, openMissingPeriods: true });
    assert.deepEqual(first.exceptions.map(e => [e.sourceType, e.reason]), [["STOCK_MOVEMENT", "حركة مخزون من غير تكلفة"]]);
    const again = await projectShadowLedger({ cafeId: fx.cafeId, from, to, openMissingPeriods: true });
    assert.equal(again.posted, 0, "re-running posts nothing twice");
    assert.equal((await trialBalance({ cafeId: fx.cafeId })).balanced, true);

    const g = await gl(fx.cafeId);
    assert.equal(g("2110"), 40, "goods received not invoiced shows the cancelled invoice's stock");
    assert.equal(g("1170"), 14, "purchase tax");
    assert.equal(g("5110"), 20, "purchase discount");
    assert.deepEqual({ safe: g("1120"), bank: g("1130"), drawer: g("1110") }, { safe: -45, bank: -65, drawer: -20 }, "each payment left from its own source");

    const suppliers = await supplierPosition({ cafeId: fx.cafeId, asOf: date });
    assert.equal(g("2100"), suppliers.payable, "payables control = open supplier items");
    assert.equal(suppliers.payable, 9);
    assert.deepEqual(suppliers.items.map(i => [i.invoiceId, i.open]).sort(), [[a, 14], [c, -5]].sort());
    assert.equal(g("1300"), suppliers.advanceTotal, "supplier advances control = advances subledger");
    assert.equal(suppliers.advanceTotal, 25);
    assert.equal(suppliers.byBucket["0-30"], 14);

    const stock = await inventoryReconciliation({ cafeId: fx.cafeId, asOf: date });
    assert.deepEqual({ gl: stock.glInventory, ledger: stock.ledgerValue, unposted: stock.unposted, uncosted: stock.uncostedRows }, { gl: 148, ledger: 148, unposted: 0, uncosted: 1 });
    assert.equal(Number((await db.shift.findFirstOrThrow({ where: { cafeId: fx.cafeId, status: "OPEN" } })).expectedCashAmount), 80, "the drawer payment also left the shift's expected cash");
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});

test("a legacy cash payment with no source is an exception, and the chart backfills new accounts", { timeout: 30000 }, async () => {
  await requireServer();
  const fx = await countCafe("ACC003LEGACY");
  try {
    await login(fx.owner.email, COUNT_PASSWORD);
    const milk = await countItem(fx, "milk");
    const id = await invoice(fx, milk.id, 1, 30);
    const legacy = await db.purchasePayment.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, purchaseInvoiceId: id, amount: 10, method: "CASH" } });
    const card = await db.purchasePayment.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, purchaseInvoiceId: id, amount: 5, method: "CARD" } });
    const entity = await db.$transaction(tx => ensureAccountingEntity(tx, fx.cafeId));
    await db.accountingAccount.deleteMany({ where: { entityId: entity.id, code: "1210" } }); // books made before F7
    await db.$transaction(tx => ensureAccountingEntity(tx, fx.cafeId));
    assert.equal(await db.accountingAccount.count({ where: { entityId: entity.id, systemKey: "INVENTORY_IN_TRANSIT" } }), 1);

    const { from, to } = span(today());
    const report = await projectShadowLedger({ cafeId: fx.cafeId, from, to, openMissingPeriods: true });
    assert.deepEqual(report.exceptions.map(e => e.sourceId), [legacy.id]);
    assert.match(report.exceptions[0].reason, /مصدرها مش متسجل/);
    const posted = await db.journalEntry.findFirstOrThrow({ where: { cafeId: fx.cafeId, sourceKey: `supplier-payment:${card.id}` }, include: { lines: { include: { account: true } } } });
    assert.deepEqual(posted.lines.map(l => [l.account.systemKey, Number(l.debit), Number(l.credit)]).sort(), [["BANK", 0, 5], ["SUPPLIER_ADVANCES", 5, 0]].sort(), "a legacy non-cash payment is a bank payment toward an advance");
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});
