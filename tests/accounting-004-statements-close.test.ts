// ACCOUNTING-004: statements computed from the journal prove themselves,
// opening balances post once and visibly, and a period closes only when its
// checklist has nothing blocking.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, countItem, COUNT_PASSWORD, type CountCafe } from "./helpers/count";
import { as, login, requireServer } from "./helpers/http";
import { addDays, dateStrInTz, zonedDayStart } from "@/lib/date-range";
import { ensureAccountingEntity } from "@/lib/accounting/chart";
import { openPeriod, postEntry, type PostingLine } from "@/lib/accounting/ledger";
import { incomeStatement, balanceSheet, cashFlow, postOpeningBalances } from "@/lib/accounting/statements";
import { closeChecklist, closeCheckedPeriod } from "@/lib/accounting/close-checklist";
import { projectShadowLedger } from "@/lib/accounting/shadow-projection";

after(async () => { await db.$disconnect(); });

const dr = (key: string, amount: number, branchId?: string): PostingLine => ({ account: { key }, debit: amount, branchId: branchId ?? null });
const cr = (key: string, amount: number, branchId?: string): PostingLine => ({ account: { key }, credit: amount, branchId: branchId ?? null });
const post = (fx: CountCafe, entryDate: string, sourceType: string, sourceKey: string, lines: PostingLine[]) =>
  db.$transaction(tx => postEntry(tx, { cafeId: fx.cafeId, entryDate, description: sourceType, sourceType, sourceKey, lines }));
const amounts = (lines: { name: string; amount: number }[]) => Object.fromEntries(lines.map(l => [l.name, l.amount]));

test("income statement, balance sheet and cash flow agree and prove themselves", { timeout: 30000 }, async () => {
  await requireServer();
  const fx = await countCafe("ACC004STATEMENTS");
  try {
    await db.$transaction(tx => ensureAccountingEntity(tx, fx.cafeId));
    await db.$transaction(tx => openPeriod(tx, { cafeId: fx.cafeId, startsOn: "2026-09-01", endsOn: "2026-09-30" }));
    const opening = await db.$transaction(tx => postOpeningBalances(tx, { cafeId: fx.cafeId, asOf: "2026-09-01",
      lines: [dr("CASH_DRAWER", 500), dr("CASH_SAFE", 1000), dr("BANK", 5000), dr("INVENTORY", 300), cr("ACCOUNTS_PAYABLE", 200)] }));
    assert.equal(opening.offset, 6600, "the difference goes to opening-balance equity, and is reported");
    const b = fx.branchId;
    await post(fx, "2026-09-10", "SALE", "sale:1", [dr("CUSTOMER_RECEIVABLE", 114, b), dr("SALES_DISCOUNTS", 10, b), cr("SALES", 100, b), cr("SERVICE_REVENUE", 10, b), cr("SALES_TAX_PAYABLE", 14, b)]);
    await post(fx, "2026-09-10", "COLLECTION", "payment:1", [dr("CASH_DRAWER", 114, b), cr("CUSTOMER_RECEIVABLE", 114, b)]);
    await post(fx, "2026-09-10", "STOCK_MOVEMENT", "stock:1", [dr("COST_OF_SALES", 40, b), cr("INVENTORY", 40, b)]);
    await post(fx, "2026-09-12", "SUPPLIER_PAYMENT", "supplier-payment:1", [dr("ACCOUNTS_PAYABLE", 150), cr("BANK", 150)]);
    await post(fx, "2026-09-12", "CASH_TO_SAFE", "cash-to-safe:1", [dr("CASH_SAFE", 300, b), cr("CASH_DRAWER", 300, b)]);
    await post(fx, "2026-09-15", "REFUND", "payment:2", [dr("SALES_RETURNS", 20, b), cr("CASH_DRAWER", 20, b)]);
    await post(fx, "2026-09-20", "CASH_VARIANCE", "cash-variance:1", [dr("CASH_OVER_SHORT", 5, b), cr("CASH_DRAWER", 5, b)]);

    const pl = await incomeStatement({ cafeId: fx.cafeId, from: "2026-09-01", to: "2026-09-30" });
    assert.deepEqual(amounts(pl.revenue), { "المبيعات": 100, "إيراد الخدمة": 10, "خصومات المبيعات": -10, "مرتجعات المبيعات": -20 });
    assert.deepEqual({ net: pl.netRevenue, gross: pl.grossProfit, expenses: pl.otherExpenses, income: pl.netIncome }, { net: 80, gross: 40, expenses: 5, income: 35 });

    const bs = await balanceSheet({ cafeId: fx.cafeId, asOf: "2026-09-30" });
    assert.equal(bs.balanced, true);
    assert.deepEqual({ assets: bs.totalAssets, liabilities: bs.totalLiabilities, equity: bs.totalEquity, earnings: bs.earningsToDate }, { assets: 6699, liabilities: 64, equity: 6600, earnings: 35 });
    assert.equal(bs.earningsToDate, pl.netIncome, "earnings on the balance sheet = the income statement");

    const cf = await cashFlow({ cafeId: fx.cafeId, from: "2026-09-01", to: "2026-09-30" });
    assert.equal(cf.balanced, true);
    assert.deepEqual({ opening: cf.opening, net: cf.netChange, closing: cf.closing }, { opening: 6500, net: -61, closing: 6439 });
    assert.deepEqual(Object.fromEntries(cf.flows.map(f => [f.label, f.amount])), { "مقبوضات من العملاء": 114, "مدفوعات للموردين": -150, "مرتجعات للعملاء": -20, "فروقات الكاش": -5 }, "drawer to safe is not a flow");

    const branch = await incomeStatement({ cafeId: fx.cafeId, from: "2026-09-01", to: "2026-09-30", branchId: b });
    assert.equal(branch.netIncome, 35, "every P&L line carried the branch");
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});

test("opening balances post once, visibly, and only before anything else", { timeout: 30000 }, async () => {
  await requireServer();
  const fx = await countCafe("ACC004OPENING");
  try {
    await db.$transaction(tx => ensureAccountingEntity(tx, fx.cafeId));
    await db.$transaction(tx => openPeriod(tx, { cafeId: fx.cafeId, startsOn: "2026-09-01", endsOn: "2026-09-30" }));
    const lines = [dr("CASH_SAFE", 1000), cr("OWNER_CAPITAL", 1000)];
    const first = await db.$transaction(tx => postOpeningBalances(tx, { cafeId: fx.cafeId, asOf: "2026-09-05", lines }));
    assert.equal(first.offset, 0);
    const replay = await db.$transaction(tx => postOpeningBalances(tx, { cafeId: fx.cafeId, asOf: "2026-09-05", lines }));
    assert.equal(replay.replayed, true);
    await assert.rejects(db.$transaction(tx => postOpeningBalances(tx, { cafeId: fx.cafeId, asOf: "2026-09-05", lines: [dr("CASH_SAFE", 900), cr("OWNER_CAPITAL", 900)] })), /بقيد مختلف/);

    const other = await countCafe("ACC004OPENLATE");
    try {
      await db.$transaction(tx => ensureAccountingEntity(tx, other.cafeId));
      await db.$transaction(tx => openPeriod(tx, { cafeId: other.cafeId, startsOn: "2026-09-01", endsOn: "2026-09-30" }));
      await post(other, "2026-09-02", "SALE", "sale:early", [dr("CUSTOMER_RECEIVABLE", 10), cr("SALES", 10)]);
      await assert.rejects(db.$transaction(tx => postOpeningBalances(tx, { cafeId: other.cafeId, asOf: "2026-09-05", lines })), /قبل تاريخ الأرصدة الافتتاحية/);
    } finally {
      await teardownTaggedCafe(other.cafeId);
    }
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});

test("a period closes only when its checklist has nothing blocking", { timeout: 60000 }, async () => {
  await requireServer();
  const fx = await countCafe("ACC004CLOSE");
  try {
    await login(fx.owner.email, COUNT_PASSWORD);
    const date = addDays(dateStrInTz(new Date()), -1);
    const when = new Date(zonedDayStart(date).getTime() + 12 * 3600_000);
    const order = await db.order.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, orderNumber: 1, type: "TAKEAWAY", status: "SERVED", source: "CASHIER_POS", createdById: fx.cashier.id, createdAt: when, subtotal: 40, total: 40, paidAmount: 40, remainingAmount: 0, paymentStatus: "PAID" } });
    await db.payment.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, orderId: order.id, cashierId: fx.cashier.id, receivedById: fx.cashier.id, amount: 40, method: "CASH", type: "COLLECTION", status: "PAID", createdAt: when, paidAt: when } });

    await db.$transaction(tx => ensureAccountingEntity(tx, fx.cafeId));
    const period = await db.$transaction(tx => openPeriod(tx, { cafeId: fx.cafeId, startsOn: date, endsOn: date }));
    const before = await closeChecklist({ cafeId: fx.cafeId, periodId: period.id });
    assert.equal(before.canClose, false);
    assert.equal(before.items.find(i => i.key === "all-posted")!.status, "blocking", "nothing projected yet");
    await assert.rejects(closeCheckedPeriod({ cafeId: fx.cafeId, periodId: period.id, actorId: fx.owner.id }), /مينفعش تقفل الفترة/);
    assert.equal((await db.accountingPeriod.findUniqueOrThrow({ where: { id: period.id } })).status, "OPEN");

    const span = { from: zonedDayStart(date), to: zonedDayStart(addDays(date, 1)) };
    await projectShadowLedger({ cafeId: fx.cafeId, ...span });
    const ready = await closeChecklist({ cafeId: fx.cafeId, periodId: period.id });
    assert.deepEqual(ready.items.filter(i => i.status === "blocking"), []);
    assert.equal(ready.canClose, true);
    await closeCheckedPeriod({ cafeId: fx.cafeId, periodId: period.id, actorId: fx.owner.id });
    assert.equal((await db.accountingPeriod.findUniqueOrThrow({ where: { id: period.id } })).status, "CLOSED");

    // An uncosted stock movement in a later period blocks that period's close.
    const today = dateStrInTz(new Date());
    const next = await db.$transaction(tx => openPeriod(tx, { cafeId: fx.cafeId, startsOn: today, endsOn: today }));
    const milk = await countItem(fx, "milk", { stock: 5 });
    assert.equal((await as(fx.owner.email, `/api/inventory/${milk.id}/movement`, { method: "POST", body: JSON.stringify({ type: "ADJUSTMENT", quantity: 1 }) })).status, 200);
    await projectShadowLedger({ cafeId: fx.cafeId, from: zonedDayStart(today), to: zonedDayStart(addDays(today, 1)) });
    const blocked = await closeChecklist({ cafeId: fx.cafeId, periodId: next.id });
    assert.deepEqual(blocked.items.filter(i => i.status === "blocking").map(i => i.key).sort(), ["inventory", "no-exceptions"]);
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});
