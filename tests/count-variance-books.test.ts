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
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, countItem, type CountCafe } from "./helpers/count";
import { as, jarFor, requireServer, BASE } from "./helpers/http";
import { addDays, dateStrInTz, zonedDayStart } from "@/lib/date-range";
import { trialBalance } from "@/lib/accounting/ledger";
import { applyStockMutation } from "@/lib/ledger";
import { projectShadowLedger } from "@/lib/accounting/shadow-projection";
import { getExecutivePnl } from "@/lib/accounting/pnl";
import { loadVarianceSheet, varianceSheetTotals } from "@/lib/reports/stock-variance-sheet";

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
    assert.equal((await apply(fx, handover.id)).status, 409);
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

test("an older cost-less count rebase is valued from its line's captured cost; with none it stays an exception", { timeout: 60000 }, async () => {
  await requireServer();
  const fx = await countCafe("CVB-LEGACY");
  try {
    const eggs = await countItem(fx, "eggs", { stock: 4, costPerUnit: 0 });
    const salt = await countItem(fx, "salt", { stock: 4, costPerUnit: 0 });
    // As the old writer left it: the movement and its rebase row, no cost on the movement.
    const legacy = await confirmedCount(fx, [{ itemId: eggs.id, counted: 3, snapshot: 30 }]);
    const moved = await db.$transaction((tx) => applyStockMutation(tx, { inventoryItemId: eggs.id, type: "COUNT_REBASE", quantity: -1, cafeId: fx.cafeId, branchId: fx.branchId, createdById: fx.manager.id, note: `COUNT_REBASE session=${legacy.id}`, allowNegative: true }));
    await db.stockCountRebase.create({ data: { sessionId: legacy.id, lineId: legacy.lines[0].id, inventoryItemId: eggs.id, countedQuantity: 3, stockBefore: 4, replayedDelta: 0, replayedMovementCount: 0, stockAfter: 3, rebaseItemVersion: moved.itemVersion, ledgerTransactionId: moved.transactionId, rebasedById: fx.manager.id } });
    // An item that had no cost when counted and has none now.
    const unvalued = await confirmedCount(fx, [{ itemId: salt.id, counted: 2, snapshot: null }]);
    assert.equal((await apply(fx, unvalued.id)).status, 200);

    const report = await projectShadowLedger({ cafeId: fx.cafeId, ...span(today()), openMissingPeriods: true });
    assert.deepEqual(report.exceptions.map((e) => e.reason), ["فرق جرد من غير تكلفة — الصنف ماكانش له تكلفة وقت الجرد"]);
    assert.equal((await gl(fx.cafeId))("5200"), 30, "1 egg at the 30 captured when it was counted");

    const sheet = await loadVarianceSheet({ cafeId: fx.cafeId, branchId: fx.branchId, from: today(), to: today() });
    assert.equal(varianceSheetTotals(sheet).unvalued, 1, "the salt line is listed as unvalued, not as zero");
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});
