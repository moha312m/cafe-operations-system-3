// ACCOUNTING-002: shadow posting turns one day of operations into balanced
// books that agree with the existing reports, posts each event once however
// often it runs, and lists every event it could not post.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, type CountCafe } from "./helpers/count";
import { requireServer } from "./helpers/http";
import { addDays, dateStrInTz, zonedDayStart } from "@/lib/date-range";
import { periodFinancials } from "@/lib/reporting";
import { recognizedSales, contributionTotals } from "@/lib/sales-recognition";
import { ensureAccountingEntity } from "@/lib/accounting/chart";
import { openPeriod, closePeriod, trialBalance } from "@/lib/accounting/ledger";
import { projectShadowLedger } from "@/lib/accounting/shadow-projection";

after(async () => { await db.$disconnect(); });

type Bill = { subtotal: number; discountAmount?: number; serviceChargeAmount?: number; taxAmount?: number; total: number };
let sequence = 0;
const at = (date: string, hour: number) => new Date(zonedDayStart(date).getTime() + hour * 3600_000);
const window = (date: string) => ({ gte: zonedDayStart(date), lt: zonedDayStart(addDays(date, 1)) });

async function order(fx: CountCafe, when: Date, bill: Bill, status: "SERVED" | "CANCELLED" = "SERVED") {
  sequence += 1;
  return db.order.create({ data: {
    cafeId: fx.cafeId, branchId: fx.branchId, orderNumber: 7000 + sequence, type: "TAKEAWAY", status, source: "CASHIER_POS",
    createdById: fx.cashier.id, createdAt: when, subtotal: bill.subtotal, discountAmount: bill.discountAmount ?? 0,
    serviceChargeAmount: bill.serviceChargeAmount ?? 0, taxAmount: bill.taxAmount ?? 0, total: bill.total,
    paidAmount: 0, remainingAmount: 0, paymentStatus: "PAID",
  } });
}

function payment(fx: CountCafe, orderId: string, when: Date, amount: number, method: "CASH" | "CARD" | "WALLET" | "MIXED", type: "COLLECTION" | "REFUND" = "COLLECTION", amendmentId?: string) {
  return db.payment.create({ data: {
    cafeId: fx.cafeId, branchId: fx.branchId, orderId, cashierId: fx.cashier.id, receivedById: fx.cashier.id,
    amount, method, type, status: "PAID", createdAt: when, paidAt: when, amendmentId: amendmentId ?? null,
  } });
}

const asBill = (b: Bill) => ({ status: "SERVED", subtotal: b.subtotal.toFixed(2), discountAmount: (b.discountAmount ?? 0).toFixed(2), serviceChargeAmount: (b.serviceChargeAmount ?? 0).toFixed(2), taxAmount: (b.taxAmount ?? 0).toFixed(2), total: b.total.toFixed(2), items: [] });

async function oneDay(fx: CountCafe, date: string) {
  // A: served with discount, service and tax; paid cash; later re-priced down.
  const served: Bill = { subtotal: 100, discountAmount: 10, serviceChargeAmount: 9, taxAmount: 13.86, total: 112.86 };
  const revised: Bill = { subtotal: 90, discountAmount: 10, serviceChargeAmount: 8, taxAmount: 12.32, total: 100.32 };
  const a = await order(fx, at(date, 12), revised); // the order row carries the latest bill
  await payment(fx, a.id, at(date, 12), 112.86, "CASH");
  await db.orderRevision.create({ data: {
    orderId: a.id, number: 1, amendmentId: randomUUID(), cafeId: fx.cafeId, branchId: fx.branchId, actorId: fx.manager.id, reason: "تعديل",
    before: asBill(served), after: { ...asBill(revised), status: "SERVED" }, oldTotal: 112.86, newTotal: 100.32, discountDelta: 0, recognizedDelta: -12.54, createdAt: at(date, 13),
  } });
  // B: served, paid by card, part refunded with no amendment (a sales return).
  const b = await order(fx, at(date, 14), { subtotal: 50, total: 50 });
  await payment(fx, b.id, at(date, 14), 50, "CARD");
  await payment(fx, b.id, at(date, 15), 20, "CARD", "REFUND");
  // C: prepaid then cancelled before serving: money in and out, no sale.
  const c = await order(fx, at(date, 16), { subtotal: 30, total: 30 }, "CANCELLED");
  await payment(fx, c.id, at(date, 16), 30, "CASH");
  await payment(fx, c.id, at(date, 16.5), 30, "CASH", "REFUND");
  // A shift closed 5 short; night cash: 200 to the safe, 40 brought back.
  const last = await db.shift.aggregate({ where: { branchId: fx.branchId }, _max: { shiftNumber: true } });
  const shift = await db.shift.create({ data: {
    cafeId: fx.cafeId, branchId: fx.branchId, cashierId: fx.cashier.id, shiftNumber: (last._max.shiftNumber ?? 0) + 1, status: "CLOSED",
    openedAt: at(date, 8), closedAt: at(date, 20), financiallyClosedAt: at(date, 20), openingCashAmount: 0, expectedCashAmount: 112.86, actualCashAmount: 107.86, cashDifference: -5,
  } });
  const handover = await db.handoverSession.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, outgoingShiftId: shift.id, outgoingUserId: fx.cashier.id } });
  const storage = await db.cashStorage.create({ data: {
    cafeId: fx.cafeId, branchId: fx.branchId, outgoingShiftId: shift.id, handoverId: handover.id, closingAmount: 300, leftInDrawer: 100, toTreasury: 200,
    drawerLabel: "درج 1", declaredById: fx.owner.id, declaredAt: at(date, 21),
  } });
  await db.cashStorageMovement.create({ data: { cafeId: fx.cafeId, storageId: storage.id, amount: 40, actorId: fx.owner.id, reason: "فكة", createdAt: at(date, 22) } });
  return { b };
}

// Account code -> balance; an account with no lines reads as zero.
const balances = async (cafeId: string) => {
  const rows = new Map((await trialBalance({ cafeId })).accounts.map(r => [r.code, r.balance]));
  return new Proxy({} as Record<string, number>, { get: (_, code: string) => rows.get(code) ?? 0 });
};

test("a day of operations posts once, balances, and agrees with the reports", { timeout: 60000 }, async () => {
  await requireServer();
  const fx = await countCafe("ACC002DAY");
  try {
    const date = addDays(dateStrInTz(new Date()), -3);
    const { b } = await oneDay(fx, date);
    const span = window(date);
    const first = await projectShadowLedger({ cafeId: fx.cafeId, from: span.gte, to: span.lt, openMissingPeriods: true });
    assert.deepEqual(first.exceptions, []);
    assert.equal(first.posted, 11, JSON.stringify(first.bySource));
    const again = await projectShadowLedger({ cafeId: fx.cafeId, from: span.gte, to: span.lt, openMissingPeriods: true });
    assert.deepEqual({ posted: again.posted, replayed: again.replayed, exceptions: again.exceptions.length }, { posted: 0, replayed: 11, exceptions: 0 }, "re-running posts nothing twice");
    assert.equal(await db.journalEntry.count({ where: { cafeId: fx.cafeId } }), 11);

    const tb = await trialBalance({ cafeId: fx.cafeId });
    assert.equal(tb.balanced, true);
    const gl = await balances(fx.cafeId);
    const components = contributionTotals(await recognizedSales({ cafeId: fx.cafeId, period: span }));
    assert.deepEqual(
      { sales: gl["4100"], discounts: gl["4300"], service: gl["4200"], tax: gl["2200"] },
      { sales: components.gross, discounts: components.discounts, service: components.service, tax: components.tax },
      "sales components match the sales recognition the reports use",
    );
    const financials = await periodFinancials({ cafeId: fx.cafeId, period: span });
    const glNetSales = Math.round((gl["4100"] - gl["4300"] + gl["4200"] + gl["2200"] - gl["4400"]) * 100) / 100;
    assert.equal(glNetSales, financials.netSales, "net sales match the daily report");
    assert.equal(gl["4400"], financials.salesRefunds, "sales returns match the report's sales refunds");
    // Add back the shortage taken out of the drawer and the cash moved to the safe.
    const tenderMovement = Math.round((gl["1110"] + gl["1140"] + gl["1150"] + gl["5300"] + gl["1120"]) * 100) / 100;
    assert.equal(tenderMovement, financials.netMoneyMovement, "money in minus money out matches, before variance and safe moves");
    assert.deepEqual({ receivable: gl["1160"], safe: gl["1120"], overShort: gl["5300"], card: gl["1140"] }, { receivable: -12.54, safe: 160, overShort: 5, card: 30 });

    // A source edited after posting is surfaced, not re-posted or merged.
    await db.order.update({ where: { id: b.id }, data: { subtotal: 55, total: 55 } });
    const drifted = await projectShadowLedger({ cafeId: fx.cafeId, from: span.gte, to: span.lt });
    assert.deepEqual(drifted.exceptions.map(e => [e.sourceKey, e.reason]), [[`sale:${b.id}`, "المصدر اتغير بعد ما اترحّل — محتاج مراجعة"]]);
    assert.equal(await db.journalEntry.count({ where: { cafeId: fx.cafeId } }), 11);
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});

test("events the books cannot take are listed, and the rest still post", { timeout: 30000 }, async () => {
  await requireServer();
  const fx = await countCafe("ACC002EXCEPT");
  try {
    const date = addDays(dateStrInTz(new Date()), -2);
    const d = await order(fx, at(date, 12), { subtotal: 20, total: 20 });
    const mixed = await payment(fx, d.id, at(date, 12), 20, "MIXED");
    const broken = await order(fx, at(date, 13), { subtotal: 10, total: 15 });
    const span = window(date);
    const report = await projectShadowLedger({ cafeId: fx.cafeId, from: span.gte, to: span.lt, openMissingPeriods: true });
    assert.deepEqual(report.exceptions.map(e => e.sourceKey).sort(), [`payment:${mixed.id}`, `sale:${broken.id}`].sort());
    assert.match(report.exceptions.find(e => e.sourceId === mixed.id)!.reason, /MIXED/);
    assert.match(report.exceptions.find(e => e.sourceId === broken.id)!.reason, /مكونات الفاتورة/);
    assert.equal(report.posted, 1, "the sound sale still posts");
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});

test("a closed period takes nothing, and says so", { timeout: 30000 }, async () => {
  await requireServer();
  const fx = await countCafe("ACC002CLOSED");
  try {
    const date = addDays(dateStrInTz(new Date()), -1);
    await db.$transaction(tx => ensureAccountingEntity(tx, fx.cafeId));
    const period = await db.$transaction(tx => openPeriod(tx, { cafeId: fx.cafeId, startsOn: date, endsOn: date }));
    await db.$transaction(tx => closePeriod(tx, { cafeId: fx.cafeId, periodId: period.id, actorId: fx.owner.id }));
    await order(fx, at(date, 12), { subtotal: 25, total: 25 });
    const span = window(date);
    const report = await projectShadowLedger({ cafeId: fx.cafeId, from: span.gte, to: span.lt, openMissingPeriods: true });
    assert.equal(report.posted, 0);
    assert.equal(report.exceptions.length, 1);
    assert.match(report.exceptions[0].reason, /مقفولة/);
    assert.equal(await db.journalEntry.count({ where: { cafeId: fx.cafeId } }), 0);
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});
