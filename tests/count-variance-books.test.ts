// COUNT-VARIANCE-BOOKS: a count difference is a financial event.
//
// A confirmed count that finds 2 kg missing must lower the shelf AND book a
// loss: Dr هالك وفروقات مخزون / Cr المخزون at the line's cost, and a surplus
// the reverse. Before this, the COUNT_REBASE movement carried no cost, the
// books refused it as "a movement without a cost", and the P&L never saw a
// single count difference. An ordinary count also had no way to reach the
// shelf at all: nothing called the rebase outside a handover.
//
// The variances workbook reads the same figures, so the file and the books
// agree on what the counts cost.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, countItem, type CountCafe } from "./helpers/count";
import { as, jarFor, requireServer, BASE } from "./helpers/http";
import { addDays, dateStrInTz, zonedDayStart } from "@/lib/date-range";
import { closePeriod, openPeriod, reverseEntry, trialBalance } from "@/lib/accounting/ledger";
import { ensureAccountingEntity } from "@/lib/accounting/chart";
import { applyStockMutation } from "@/lib/ledger";
import { projectShadowLedger } from "@/lib/accounting/shadow-projection";
import { getExecutivePnl } from "@/lib/accounting/pnl";
import { inventoryReconciliation } from "@/lib/accounting/subledgers";
import { loadVarianceSheet, varianceSheetTotals, varianceSheetXlsx, type VarianceSheetLine } from "@/lib/reports/stock-variance-sheet";

after(async () => { await db.$disconnect(); });

const today = () => dateStrInTz(new Date());
const span = (date: string) => ({ from: zonedDayStart(date), to: zonedDayStart(addDays(date, 1)) });
async function gl(cafeId: string) {
  const rows = new Map((await trialBalance({ cafeId })).accounts.map((r) => [r.code, r.balance]));
  return (code: string) => rows.get(code) ?? 0;
}

type Counted = { itemId: string; counted: number; snapshot: number | null };

/** A confirmed ordinary count, as the confirm path leaves it: every line judged. */
async function confirmedCount(fx: CountCafe, lines: Counted[], extra: { status?: "CONFIRMED" | "SUBMITTED"; handoverId?: string } = {}) {
  const create = [];
  for (const l of lines) {
    const item = await db.inventoryItem.findUniqueOrThrow({ where: { id: l.itemId } });
    const expected = Number(item.currentStock);
    create.push({
      inventoryItemId: l.itemId, unit: item.unit,
      expectedQuantity: expected, countedQuantity: l.counted, effectiveCountedQuantity: l.counted,
      varianceQuantity: Math.round((l.counted - expected) * 1000) / 1000,
      itemVersion: item.ledgerVersion, countedAt: new Date(), counterId: fx.cashier.id,
      disposition: "VARIANCE_CONFIRMED" as const,
      unitCostSnapshot: l.snapshot, unitCostSource: l.snapshot === null ? null : "INVENTORY_ITEM_COST_PER_UNIT", unitCostCapturedAt: l.snapshot === null ? null : new Date(),
    });
  }
  return db.stockCountSession.create({
    data: {
      cafeId: fx.cafeId, branchId: fx.branchId, type: "FULL", scopeDerivation: "ALL_ELIGIBLE",
      initiatedById: fx.manager.id, confirmedById: fx.manager.id,
      status: extra.status ?? "CONFIRMED", confirmedAt: new Date(),
      ...(extra.handoverId ? { accountabilityContext: "HANDOVER" as const, handoverId: extra.handoverId } : {}),
      lines: { create },
    },
    include: { lines: true },
  });
}

const apply = (fx: CountCafe, id: string, email = fx.manager.email) => as<{ itemsApplied: number; alreadyApplied: boolean; error?: string }>(email, `/api/stock-counts/${id}/apply-to-stock`, { method: "POST", body: "{}" });

test("a shortage and a surplus reach the books and the P&L at the line's cost, once", { timeout: 60000 }, async () => {
  await requireServer();
  const fx = await countCafe("CVB-FLOW");
  try {
    const milk = await countItem(fx, "milk", { stock: 10, costPerUnit: 50 });
    const sugar = await countItem(fx, "sugar", { stock: 5, costPerUnit: 20 });
    const count = await confirmedCount(fx, [{ itemId: milk.id, counted: 8, snapshot: 50 }, { itemId: sugar.id, counted: 8, snapshot: 20 }]);

    const first = await apply(fx, count.id);
    assert.equal(first.status, 200, first.text);
    assert.equal(first.body.itemsApplied, 2);
    const again = await apply(fx, count.id);
    assert.equal(again.status, 200, again.text);
    assert.equal(again.body.alreadyApplied, true, "a second press moves nothing");

    assert.equal(Number((await db.inventoryItem.findUniqueOrThrow({ where: { id: milk.id } })).currentStock), 8);
    assert.equal(Number((await db.inventoryItem.findUniqueOrThrow({ where: { id: sugar.id } })).currentStock), 8);
    const moves = await db.inventoryTransaction.findMany({ where: { cafeId: fx.cafeId, type: "COUNT_REBASE" }, orderBy: { quantity: "asc" } });
    assert.deepEqual(moves.map((m) => [Number(m.quantity), Number(m.unitCost), Number(m.totalCost)]), [[-2, 50, 100], [3, 20, 60]]);

    const date = today();
    const report = await projectShadowLedger({ cafeId: fx.cafeId, ...span(date), openMissingPeriods: true });
    assert.deepEqual(report.exceptions, []);
    const balance = await gl(fx.cafeId);
    assert.equal(balance("5200"), 40, "loss 100 less surplus 60 on هالك وفروقات مخزون");
    assert.equal(balance("1200"), -40, "the inventory control account falls by the same 40");

    const pnl = await getExecutivePnl({ cafeId: fx.cafeId, from: date, to: date });
    assert.equal(pnl.kpis.variances, 40);
    assert.equal(pnl.kpis.netProfit, -40, "the count difference is the whole bottom line here");

    const sheet = await loadVarianceSheet({ cafeId: fx.cafeId, branchId: fx.branchId, from: date, to: date });
    assert.equal(sheet.counts, 1);
    assert.deepEqual(sheet.lines.map((l) => [l.difference, l.value, l.posted]).sort((a, b) => Number(a[0]) - Number(b[0])), [[-2, -100, true], [3, 60, true]]);
    assert.deepEqual(varianceSheetTotals(sheet), { shortageItems: 1, surplusItems: 1, shortageValue: -100, surplusValue: 60, net: -40, unvalued: 0, notPosted: 0 });

    const file = await fetch(`${BASE}/api/stock-counts/variances/export?from=${date}&to=${date}`, { headers: { cookie: jarFor(fx.manager.email) } });
    assert.equal(file.status, 200);
    assert.match(file.headers.get("content-type") ?? "", /spreadsheetml/);
    assert.match(decodeURIComponent(file.headers.get("content-disposition") ?? ""), /فروقات-الجرد_/);
    const bytes = Buffer.from(await file.arrayBuffer());
    assert.equal(bytes.subarray(0, 2).toString(), "PK", "an xlsx is a zip");
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});

test("apply-to-stock is refused for unconfirmed and handover counts and without the confirm key", { timeout: 60000 }, async () => {
  await requireServer();
  const fx = await countCafe("CVB-REFUSE");
  try {
    const milk = await countItem(fx, "milk", { stock: 10, costPerUnit: 50 });
    const submitted = await confirmedCount(fx, [{ itemId: milk.id, counted: 9, snapshot: 50 }], { status: "SUBMITTED" });
    const last = await db.shift.aggregate({ where: { branchId: fx.branchId }, _max: { shiftNumber: true } });
    const shift = await db.shift.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, cashierId: fx.cashier.id, shiftNumber: (last._max.shiftNumber ?? 0) + 1, openingCashAmount: 0, expectedCashAmount: 0 } });
    const session = await db.handoverSession.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, outgoingShiftId: shift.id, outgoingUserId: fx.cashier.id } });
    const handover = await confirmedCount(fx, [{ itemId: milk.id, counted: 9, snapshot: 50 }], { handoverId: session.id });
    const ordinary = await confirmedCount(fx, [{ itemId: milk.id, counted: 9, snapshot: 50 }]);

    assert.equal((await apply(fx, submitted.id)).status, 409);
    const handoverRefusal = await apply(fx, handover.id);
    assert.equal(handoverRefusal.status, 409);
    assert.match(handoverRefusal.body.error ?? "", /مراجعة فروق جرد التسليم/);
    assert.equal((await apply(fx, ordinary.id, fx.cashier.email)).status, 403, "counting is not signing off the shelf");
    assert.equal((await apply(fx, ordinary.id, fx.waiter.email)).status, 403);
    assert.equal((await as(fx.waiter.email, "/api/stock-counts/variances/export")).status, 403);
    assert.equal(await db.inventoryTransaction.count({ where: { cafeId: fx.cafeId, type: "COUNT_REBASE" } }), 0, "nothing moved");

    // Only confirmed counts are in the file: an expected figure is hidden until then.
    const sheet = await loadVarianceSheet({ cafeId: fx.cafeId, branchId: fx.branchId, from: today(), to: today() });
    assert.equal(sheet.counts, 2, "the confirmed ordinary and handover counts; the submitted one is not read");
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});

test("the variance workbook guides each count and separates stock application from journal posting", () => {
  const date = "2026-11-11";
  const line: VarianceSheetLine = {
    confirmedAt: zonedDayStart(date), branch: "Main", count: "Count", context: "جرد عادي",
    item: "Milk", itemId: "milk", unit: "KG", expected: 4, counted: 3, difference: -1,
    unitCost: 30, value: -30, status: "فرق معتمد", reason: null, note: null, counter: null, posted: false,
  };
  const workbook = XLSX.read(varianceSheetXlsx({
    from: date, to: date, branch: "Main", currency: "EGP", counts: 3,
    lines: [
      line,
      { ...line, count: "Handover", context: "جرد تسليم" },
      { ...line, count: "Opening", context: "جرد فتح فرع" },
      { ...line, count: "Historical", posted: true },
    ],
  }), { type: "buffer" });
  const details = XLSX.utils.sheet_to_json<Record<string, string>>(workbook.Sheets["الفروقات"]);
  assert.match(details[0]["الخطوة التالية"], /تطبيق الفروقات على المخزون/);
  assert.match(details[1]["الخطوة التالية"], /مراجعة التسليم/);
  assert.doesNotMatch(details[1]["الخطوة التالية"], /تطبيق الفروقات/);
  assert.match(details[2]["الخطوة التالية"], /التحقق الافتتاحي/);
  assert.equal(details[3]["اتسجل في المخزون"], "نعم");
  assert.match(details[3]["الخطوة التالية"], /راجع قيود اليومية/);
  const summary = XLSX.utils.sheet_to_json<Array<string | number>>(workbook.Sheets["الملخص"], { header: 1 });
  assert.equal(summary.find(([label]) => label === "صافي قيمة الفروقات (EGP)")?.[1], -120);
  assert.match(String(summary.find(([label]) => label === "ملحوظة")?.[1]), /لا يؤكد الترحيل للحسابات/);
});

/** A fixture in an earlier business period, as the old writer left it. */
async function legacyRebase(fx: CountCafe, itemId: string, quantity: number, snapshot: number | null, date: string) {
  const count = await confirmedCount(fx, [{ itemId, counted: 4 + quantity, snapshot }]);
  return db.$transaction(async (tx) => {
    const movement = await applyStockMutation(tx, {
      inventoryItemId: itemId, type: "COUNT_REBASE", quantity, cafeId: fx.cafeId,
      branchId: fx.branchId, createdById: fx.manager.id, note: `COUNT_REBASE session=${count.id}`,
    });
    // The fixture writer uses today's timestamp. Move this fixture to the period under test.
    await tx.inventoryTransaction.update({ where: { id: movement.transactionId }, data: { createdAt: zonedDayStart(date) } });
    await tx.stockCountRebase.create({
      data: {
        sessionId: count.id, lineId: count.lines[0].id, inventoryItemId: itemId,
        countedQuantity: movement.stockAfter, stockBefore: movement.stockBefore,
        replayedDelta: 0, replayedMovementCount: 0, stockAfter: movement.stockAfter,
        rebaseItemVersion: movement.itemVersion, ledgerTransactionId: movement.transactionId, rebasedById: fx.manager.id,
      },
    });
    return movement.transactionId;
  });
}

test("default P&L sync holds past cost-less rebases even when count cost evidence exists", { timeout: 60000 }, async () => {
  await requireServer();
  const fx = await countCafe("CVB-HELD");
  try {
    const date = addDays(today(), -2);
    const eggs = await countItem(fx, "eggs", { stock: 4, costPerUnit: 100 });
    const movementId = await legacyRebase(fx, eggs.id, -1, 30, date);
    await db.$transaction(async (tx) => {
      await ensureAccountingEntity(tx, fx.cafeId);
      await openPeriod(tx, { cafeId: fx.cafeId, startsOn: date, endsOn: date });
    });

    const response = await as<{ kpis: { variances: number; netProfit: number } }>(
      fx.owner.email, `/api/accounting/pnl?from=${date}&to=${date}&branchId=${fx.branchId}`,
    );
    assert.equal(response.status, 200, response.text);
    assert.equal(response.body.kpis.variances, 0);
    assert.equal(response.body.kpis.netProfit, 0);
    const source = { cafeId: fx.cafeId, sourceKey: `stock:${movementId}` };
    assert.equal(await db.journalEntry.count({ where: source }), 0);
    assert.equal(await db.accountingProjectionIssue.count({ where: { ...source, kind: "UNPOSTABLE", resolvedAt: null } }), 1);
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});

test("open-period diagnostics use the historical snapshot once and keep a missing cost explicit", { timeout: 60000 }, async () => {
  await requireServer();
  const fx = await countCafe("CVB-LEGACY");
  try {
    const date = addDays(today(), -2);
    const eggs = await countItem(fx, "eggs", { stock: 4, costPerUnit: 100 });
    const salt = await countItem(fx, "salt", { stock: 4, costPerUnit: 0 });
    const legacyId = await legacyRebase(fx, eggs.id, -1, 30, date);
    const unvaluedId = await legacyRebase(fx, salt.id, -2, null, date);
    const originalMovement = await db.inventoryTransaction.findUniqueOrThrow({ where: { id: legacyId } });
    const diagnostic = { cafeId: fx.cafeId, ...span(date), openMissingPeriods: true, valueLegacyCountRebases: true } as const;

    const report = await projectShadowLedger(diagnostic);
    assert.equal(report.posted, 1);
    assert.deepEqual(report.exceptions.map((e) => [e.sourceId, e.reason]), [[unvaluedId, "فرق جرد من غير تكلفة — الصنف ماكانش له تكلفة وقت الجرد"]]);
    const replay = await projectShadowLedger(diagnostic);
    assert.equal(replay.posted, 0);
    assert.equal(replay.replayed, 1);
    const balance = await gl(fx.cafeId);
    assert.equal(balance("5200"), 30, "the loss uses the captured 30 even though today's cost is 100");
    assert.equal(balance("1200"), -30);

    const pnl = await getExecutivePnl({ cafeId: fx.cafeId, from: date, to: date, branchId: fx.branchId });
    assert.equal(pnl.sections.variances.lines.find((line) => line.systemKey === "INVENTORY_LOSS")?.amount, 30);
    assert.equal(pnl.kpis.operatingProfit, 0);
    assert.equal(pnl.kpis.netProfit, -30);
    const reconciliation = await inventoryReconciliation({ cafeId: fx.cafeId, asOf: date, branchId: fx.branchId });
    assert.equal(reconciliation.glInventory, -30);
    assert.equal(reconciliation.ledgerValue, 0);
    assert.equal(reconciliation.uncostedRows, 2, "the diagnostic does not rewrite either stock movement");

    const sheet = await loadVarianceSheet({ cafeId: fx.cafeId, branchId: fx.branchId, from: today(), to: today() });
    assert.equal(varianceSheetTotals(sheet).unvalued, 1, "the salt line is listed as unvalued, not as zero");

    const entry = await db.journalEntry.findFirstOrThrow({ where: { cafeId: fx.cafeId, sourceKey: `stock:${legacyId}` } });
    const originalLines = await db.journalLine.findMany({ where: { entryId: entry.id }, orderBy: { id: "asc" } });
    const reversal = await db.$transaction((tx) => reverseEntry(tx, { cafeId: fx.cafeId, entryId: entry.id, entryDate: date, actorId: fx.owner.id }));
    const repeatedReversal = await db.$transaction((tx) => reverseEntry(tx, { cafeId: fx.cafeId, entryId: entry.id, entryDate: date, actorId: fx.owner.id }));
    assert.equal(repeatedReversal.replayed, true);
    assert.equal(repeatedReversal.entry.id, reversal.entry.id);
    assert.equal(reversal.entry.reversalOfId, entry.id);
    assert.equal(reversal.entry.createdById, fx.owner.id);
    assert.deepEqual(await db.journalLine.findMany({ where: { entryId: entry.id }, orderBy: { id: "asc" } }), originalLines);
    assert.deepEqual(await db.inventoryTransaction.findUniqueOrThrow({ where: { id: legacyId } }), originalMovement);
    assert.equal((await gl(fx.cafeId))("5200"), 0);
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});

test("closed-period diagnostics report a late legacy event without changing its P&L", { timeout: 60000 }, async () => {
  await requireServer();
  const fx = await countCafe("CVB-CLOSED");
  try {
    const date = addDays(today(), -2);
    const eggs = await countItem(fx, "eggs", { stock: 4, costPerUnit: 100 });
    const movementId = await legacyRebase(fx, eggs.id, -1, 30, date);
    await db.$transaction(async (tx) => {
      await ensureAccountingEntity(tx, fx.cafeId);
      const period = await openPeriod(tx, { cafeId: fx.cafeId, startsOn: date, endsOn: date });
      await closePeriod(tx, { cafeId: fx.cafeId, periodId: period.id, actorId: fx.owner.id });
    });
    const scope = { cafeId: fx.cafeId, sourceKey: `stock:${movementId}` };
    const pnlArgs = { cafeId: fx.cafeId, from: date, to: date, branchId: fx.branchId };
    const before = await getExecutivePnl(pnlArgs);
    const diagnostic = { cafeId: fx.cafeId, ...span(date), openMissingPeriods: true, valueLegacyCountRebases: true } as const;
    const report = await projectShadowLedger(diagnostic);
    assert.equal(report.posted, 0);
    assert.equal(report.exceptions.length, 1);
    assert.equal(report.exceptions[0].sourceKey, scope.sourceKey);
    assert.equal(await db.accountingProjectionIssue.count({ where: { ...scope, kind: "LATE_EVENT", resolvedAt: null } }), 1);
    assert.equal(await db.journalEntry.count({ where: scope }), 0);
    assert.deepEqual((await getExecutivePnl(pnlArgs)).sections.variances, before.sections.variances);
    assert.equal((await getExecutivePnl(pnlArgs)).kpis.netProfit, before.kpis.netProfit);
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});
