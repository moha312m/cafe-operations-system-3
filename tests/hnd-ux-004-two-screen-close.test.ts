// HND-UX-004 — the two-screen outgoing close, money every shift and materials
// on the owner's schedule, with HND-UX-003's record-and-continue stock rule.
//
// What these tests hold the implementation to, in the owner's words:
//   • money first, every shift; the drawer count includes the opening float
//     and the system computes sales — declarations create no sales;
//   • card and wallet differences are separate, never netted;
//   • a difference is recorded and the close continues — no reason stage,
//     no manager — and nothing fabricates a match or a signature;
//   • materials only when due; "not due" is recorded, not a zero count;
//   • a committed money step is never settled twice, and screen 2 resumes;
//   • a receiver may accept a different quantity; that quantity becomes the
//     new balance, so the same shortage is not found again at the next close;
//   • an explicit refusal is still a refusal.

import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, countItem, COUNT_PASSWORD, type CountCafe } from "./helpers/count";
import { as, login } from "./helpers/http";
import { ensureCustodyForShift } from "@/lib/custody";
import { closeShiftWithSettlement } from "@/lib/cash-close";
import { recomputeShiftTotals } from "@/lib/shifts";
import { decideMaterialsCount, periodCutoffInstant, type MaterialsSchedule } from "@/lib/materials-schedule";
import { parseAmount } from "@/lib/close-amount";
import { updateBranchHandoverConfig } from "@/lib/handover-config";

const cafes: string[] = [];
after(async () => {
  for (const id of cafes) {
    await db.handoverStockAcknowledgement.deleteMany({ where: { handover: { cafeId: id } } });
    await db.handoverStockBoundary.deleteMany({ where: { handover: { cafeId: id } } });
    await db.handoverRequiredItem.updateMany({ where: { handover: { cafeId: id } }, data: { satisfiedByLineId: null } });
    await db.shiftMaterialsDecision.deleteMany({ where: { cafeId: id } });
    await db.handoverSession.updateMany({ where: { cafeId: id }, data: { stockCountSessionId: null, acceptedStockCountSessionId: null } });
    await db.stockCountSession.updateMany({ where: { cafeId: id }, data: { handoverId: null, lockedByHandoverId: null, accountabilityContext: "NONE" } });
    await db.stockCountRebase.deleteMany({ where: { session: { cafeId: id } } });
    await db.stockVarianceSpanCustody.deleteMany({ where: { span: { varianceCase: { cafeId: id } } } });
    await db.stockVarianceSpan.deleteMany({ where: { varianceCase: { cafeId: id } } });
    await db.varianceCase.deleteMany({ where: { cafeId: id } });
    await db.stockCountSession.deleteMany({ where: { cafeId: id } });
    await db.inventoryFreeze.deleteMany({ where: { cafeId: id } });
    await db.handoverSession.deleteMany({ where: { cafeId: id } });
    await teardownTaggedCafe(id);
  }
  await db.$disconnect();
});

async function post<T = Record<string, unknown>>(email: string, path: string, body: unknown) {
  const r = await as<T>(email, path, { method: "POST", body: JSON.stringify(body) });
  assert.equal(r.status, 200, `${path}: ${r.text}`);
  return r.body;
}
async function openShift(fx: CountCafe, userId: string, n: number, opening: number) {
  const s = await db.shift.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, cashierId: userId, shiftNumber: n, openingCashAmount: opening, expectedCashAmount: opening } });
  await db.$transaction((tx) => ensureCustodyForShift(tx, { cafeId: fx.cafeId, branchId: fx.branchId, shiftId: s.id, userId, openingCashAmount: opening }));
  return s;
}
/** Sales through real Payment rows; expected figures come from the repository's own aggregate. */
async function sell(fx: CountCafe, shiftId: string, userId: string, n: number, pays: Partial<Record<"CASH" | "CARD" | "WALLET", number>>) {
  const total = Object.values(pays).reduce((s, v) => s + (v ?? 0), 0);
  const order = await db.order.create({ data: {
    cafeId: fx.cafeId, branchId: fx.branchId, orderNumber: n, type: "TAKEAWAY", status: "SERVED", source: "CASHIER_POS",
    customerName: `${fx.marker}-o${n}`, subtotal: total, taxAmount: 0, discountAmount: 0, serviceChargeAmount: 0, total, remainingAmount: 0,
    paymentStatus: "PAID", createdById: userId,
  } });
  for (const [method, amount] of Object.entries(pays)) {
    await db.payment.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, orderId: order.id, shiftId, cashierId: userId, receivedById: userId, amount: amount!, method: method as "CASH", type: "COLLECTION", status: "PAID" } });
  }
  return recomputeShiftTotals(shiftId);
}
async function incomingUser(fx: CountCafe, suffix: string) {
  const hash = (await db.user.findUniqueOrThrow({ where: { id: fx.cashier.id } })).passwordHash;
  const u = await db.user.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, email: `${suffix}-${fx.marker.toLowerCase()}@example.invalid`, name: `Synthetic ${suffix}`, role: "CASHIER", passwordHash: hash } });
  await login(u.email, COUNT_PASSWORD);
  return u;
}
async function handoverPolicy(fx: CountCafe) {
  await db.cafeSettings.update({ where: { cafeId: fx.cafeId }, data: { stockCountPolicy: "HYBRID", handoverCountType: "CRITICAL", periodicFullCountSchedule: "MANUAL_ONLY", recountRequiredOutsideTolerance: false, varianceBlocksHandover: false } });
}

describe("pure rules", () => {
  test("blank is not zero; invalid amounts are refused, not coerced", () => {
    assert.equal(parseAmount("", false), null);
    assert.equal(parseAmount("   ", false), null);
    assert.equal(parseAmount("0", false), 0);
    assert.equal(parseAmount("1600", false), 1600);
    assert.equal(parseAmount("12.345", false), null);
    assert.equal(parseAmount("-20", false), null);
    assert.equal(parseAmount("-20", true), -20);
    assert.equal(parseAmount("abc", true), null);
  });

  const daily: MaterialsSchedule = { cadence: "DAILY", weekday: null, cutoff: "22:00", since: new Date("2026-10-01T00:00:00Z"), timezone: "Africa/Cairo" };
  test("daily: before the cutoff nothing new is owed; at/after it the day is claimed once", () => {
    // 2026-10-30 21:00 Cairo (UTC+3 in this period is not assumed: use the helper).
    const cutoff = periodCutoffInstant("2026-10-30", "22:00", "Africa/Cairo");
    const before = new Date(cutoff.getTime() - 60_000);
    const atCutoff = new Date(cutoff.getTime());
    const b = decideMaterialsCount({ at: before, schedule: daily, lastClaimedPeriod: "2026-10-29" });
    assert.equal(b.due, false); assert.equal(b.reason, "NOT_DUE"); assert.equal(b.nextDueAt?.getTime(), cutoff.getTime());
    const a = decideMaterialsCount({ at: atCutoff, schedule: daily, lastClaimedPeriod: "2026-10-29" });
    assert.deepEqual([a.due, a.periodFrom, a.periodTo], [true, "2026-10-30", "2026-10-30"]);
    const again = decideMaterialsCount({ at: new Date(cutoff.getTime() + 3_600_000), schedule: daily, lastClaimedPeriod: "2026-10-30" });
    assert.equal(again.due, false, "a claimed day is not counted twice");
  });
  test("daily: a missed day stays owed and one later count covers both periods", () => {
    const at = new Date(periodCutoffInstant("2026-10-30", "22:00", "Africa/Cairo").getTime() + 1000);
    const d = decideMaterialsCount({ at, schedule: daily, lastClaimedPeriod: "2026-10-28" });
    assert.deepEqual([d.due, d.periodFrom, d.periodTo], [true, "2026-10-29", "2026-10-30"]);
    // Missed and the next close happens the following morning, before that day's cutoff.
    const morning = new Date(periodCutoffInstant("2026-10-31", "10:00", "Africa/Cairo").getTime());
    const m = decideMaterialsCount({ at: morning, schedule: daily, lastClaimedPeriod: "2026-10-29" });
    assert.deepEqual([m.due, m.periodFrom, m.periodTo], [true, "2026-10-30", "2026-10-30"]);
  });
  test("a cutoff before 03:00 belongs to the business day that started the morning before", () => {
    const late: MaterialsSchedule = { ...daily, cutoff: "01:30" };
    const cutoff = periodCutoffInstant("2026-10-30", "01:30", "Africa/Cairo");
    assert.equal(new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(cutoff), "2026-10-31");
    const d = decideMaterialsCount({ at: new Date(cutoff.getTime() + 1000), schedule: late, lastClaimedPeriod: "2026-10-29" });
    assert.deepEqual([d.due, d.periodTo], [true, "2026-10-30"]);
  });
  test("weekly: only the chosen weekday's cutoff makes a count due", () => {
    // 2026-10-30 is a Friday (5).
    const weekly: MaterialsSchedule = { cadence: "WEEKLY", weekday: 5, cutoff: "22:00", since: new Date("2026-10-01T00:00:00Z"), timezone: "Africa/Cairo" };
    const thursday = new Date(periodCutoffInstant("2026-10-29", "23:00", "Africa/Cairo").getTime());
    const t = decideMaterialsCount({ at: thursday, schedule: weekly, lastClaimedPeriod: "2026-10-23" });
    assert.equal(t.due, false);
    assert.equal(t.nextDueAt?.getTime(), periodCutoffInstant("2026-10-30", "22:00", "Africa/Cairo").getTime());
    const friday = new Date(periodCutoffInstant("2026-10-30", "22:00", "Africa/Cairo").getTime() + 1000);
    const f = decideMaterialsCount({ at: friday, schedule: weekly, lastClaimedPeriod: "2026-10-23" });
    assert.deepEqual([f.due, f.periodFrom, f.periodTo], [true, "2026-10-30", "2026-10-30"]);
  });
  test("a schedule owes nothing from before it existed; every-shift is always due", () => {
    const since = new Date(periodCutoffInstant("2026-10-30", "22:00", "Africa/Cairo").getTime() + 60_000);
    const d = decideMaterialsCount({ at: new Date(since.getTime() + 60_000), schedule: { ...daily, since }, lastClaimedPeriod: null });
    assert.equal(d.due, false, "set after today's cutoff: the first period owed is tomorrow");
    const e = decideMaterialsCount({ at: new Date(), schedule: { cadence: "EVERY_SHIFT", weekday: null, cutoff: null, since: null, timezone: "Africa/Cairo" }, lastClaimedPeriod: "x" });
    assert.deepEqual([e.due, e.reason], [true, "EVERY_SHIFT"]);
  });
});

test("every shift: money then materials, both with differences, no manager; receiving difference becomes the balance", async () => {
  const fx = await countCafe("HNDUX4ES"); cafes.push(fx.cafeId);
  await handoverPolicy(fx);
  const alpha = await countItem(fx, "Alpha", { stock: 10, isCritical: true });
  const beta = await countItem(fx, "Beta", { stock: 5, isCritical: true });
  await countItem(fx, "Gamma not selected", { stock: 3, isCritical: false });

  const outgoing = await openShift(fx, fx.cashier.id, 1, 600);
  const fresh = await sell(fx, outgoing.id, fx.cashier.id, 4001, { CASH: 1000, CARD: 500, WALLET: 200 });
  assert.equal(Number(fresh!.expectedCashAmount), 1600, "opening 600 + net cash sales 1000");
  const paymentsBefore = await db.payment.count({ where: { shiftId: outgoing.id } });
  const ordersBefore = await db.order.count({ where: { cafeId: fx.cafeId } });

  // Screen 1 state, blind: no expected figure for a cashier.
  const flow1 = await as<{ stage: string; shift: Record<string, unknown>; materials: { duePreview: boolean } }>(fx.cashier.email, `/api/shifts/close-flow?branchId=${fx.branchId}`);
  assert.equal(flow1.status, 200, flow1.text);
  assert.equal(flow1.body.stage, "MONEY");
  assert.equal(flow1.body.materials.duePreview, true);
  for (const hidden of ["expectedCashAmount", "totalCashSales", "totalCardSales", "totalWalletSales"]) assert.ok(!(hidden in flow1.body.shift), `${hidden} must stay hidden`);
  assert.equal(flow1.body.shift.cardSettlementRequired, true);

  // Blank cash is refused by the schema, never read as 0.
  const blank = await as(fx.cashier.email, `/api/shifts/${outgoing.id}/close`, { method: "POST", body: JSON.stringify({ actualCardAmount: 480, actualWalletAmount: 220, handoverTarget: "SHIFT_TO_SHIFT" }) });
  assert.equal(blank.status, 400, blank.text);

  // Money: cash exact, card -20, wallet +20, no reasons, no manager.
  const closed = await post<{ handover: { required: boolean; handoverId: string }; materials: { due: boolean; reason: string } }>(fx.cashier.email, `/api/shifts/${outgoing.id}/close`,
    { actualCashAmount: 1600, actualCardAmount: 480, actualWalletAmount: 220, handoverTarget: "SHIFT_TO_SHIFT" });
  assert.equal(closed.handover.required, true);
  assert.deepEqual([closed.materials.due, closed.materials.reason], [true, "EVERY_SHIFT"]);
  const settled = await db.shift.findUniqueOrThrow({ where: { id: outgoing.id }, include: { tenderReconciliations: true } });
  assert.equal(settled.status, "AWAITING_HANDOVER");
  assert.equal(Number(settled.cashDifference), 0);
  const tender = Object.fromEntries(settled.tenderReconciliations.map((t) => [t.method, t]));
  assert.deepEqual([Number(tender.CARD.expectedAmount), Number(tender.CARD.actualAmount), Number(tender.CARD.varianceAmount), tender.CARD.reasonNote], [500, 480, -20, null]);
  assert.deepEqual([Number(tender.WALLET.expectedAmount), Number(tender.WALLET.actualAmount), Number(tender.WALLET.varianceAmount), tender.WALLET.reasonNote], [200, 220, 20, null]);
  // Each channel's difference is its own open case: recorded for later review, never netted.
  assert.equal(await db.varianceCase.count({ where: { cafeId: fx.cafeId, shiftId: outgoing.id, type: "TENDER", status: "OPEN" } }), 2);
  assert.equal(await db.varianceCase.count({ where: { cafeId: fx.cafeId, shiftId: outgoing.id, type: "CASH" } }), 0, "an exact drawer opens no case");
  assert.equal(await db.payment.count({ where: { shiftId: outgoing.id } }), paymentsBefore, "declarations create no payments");
  assert.equal(await db.order.count({ where: { cafeId: fx.cafeId } }), ordersBefore, "declarations create no orders");

  // A second close (double click, lost response) settles nothing again.
  const again = await as(fx.cashier.email, `/api/shifts/${outgoing.id}/close`, { method: "POST", body: JSON.stringify({ actualCashAmount: 1, handoverTarget: "SHIFT_TO_SHIFT" }) });
  assert.equal(again.status, 400);
  assert.equal(await db.tenderReconciliation.count({ where: { shiftId: outgoing.id } }), 2);
  assert.equal(Number((await db.shift.findUniqueOrThrow({ where: { id: outgoing.id } })).actualCashAmount), 1600);

  // Refresh: the server resumes at materials.
  const flow2 = await as<{ stage: string; handover: { id: string } }>(fx.cashier.email, `/api/shifts/close-flow?branchId=${fx.branchId}`);
  assert.equal(flow2.body.stage, "MATERIALS");
  const hid = closed.handover.handoverId;
  assert.equal(flow2.body.handover.id, hid);

  // Screen 2: only the owner-selected items, blind.
  const start = await post<{ countSession: { id: string } }>(fx.cashier.email, "/api/handovers", { action: "start_count", handoverId: hid });
  const sid = start.countSession.id;
  const detail = await as<{ session: { lines: { id: string; inventoryItemId: string; expectedQuantity?: unknown }[] } }>(fx.cashier.email, `/api/stock-counts/${sid}`);
  assert.deepEqual(detail.body.session.lines.map((l) => l.inventoryItemId).sort(), [alpha.id, beta.id].sort());
  assert.ok(detail.body.session.lines.every((l) => !("expectedQuantity" in l)));
  const lineOf = (itemId: string) => detail.body.session.lines.find((l) => l.inventoryItemId === itemId)!.id;
  const save = (itemId: string, q: number) => as(fx.cashier.email, `/api/stock-counts/${sid}/lines/${lineOf(itemId)}`, { method: "PATCH", body: JSON.stringify({ countedQuantity: q, expectedCountedAt: null }) });

  assert.equal((await save(alpha.id, 9)).status, 200);
  // Missing evidence still fails clearly, by item name.
  const incomplete = await as<{ missingItems: string[] }>(fx.cashier.email, "/api/handovers", { method: "POST", body: JSON.stringify({ action: "finish_outgoing", handoverId: hid }) });
  assert.equal(incomplete.status, 409, incomplete.text);
  assert.deepEqual(incomplete.body.missingItems, [`${fx.marker} Beta`]);
  assert.equal((await db.handoverSession.findUniqueOrThrow({ where: { id: hid } })).status, "DRAFT");

  assert.equal((await save(beta.id, 6)).status, 200);
  const finished = await post<{ status: string; recordedDifferences: number; systemValidated: boolean; alreadySubmitted: boolean }>(fx.cashier.email, "/api/handovers", { action: "finish_outgoing", handoverId: hid, note: "علبة مفتوحة" });
  assert.deepEqual([finished.status, finished.recordedDifferences, finished.systemValidated, finished.alreadySubmitted], ["OUTGOING_SUBMITTED", 2, false, false]);
  const replay = await post<{ alreadySubmitted: boolean }>(fx.cashier.email, "/api/handovers", { action: "finish_outgoing", handoverId: hid });
  assert.equal(replay.alreadySubmitted, true);
  assert.equal(await db.auditLog.count({ where: { entity: "HandoverSession", entityId: hid, action: "HANDOVER_SUBMITTED" } }), 1);

  const session = await db.stockCountSession.findUniqueOrThrow({ where: { id: sid }, include: { lines: true } });
  assert.equal(session.status, "CONFIRMED");
  assert.equal(session.confirmedById, null, "no manager signature is invented");
  assert.equal(await db.auditLog.count({ where: { entity: "StockCountSession", entityId: sid, action: "COUNT_SYSTEM_VALIDATED" } }), 0, "a difference is never a match");
  assert.equal(await db.auditLog.count({ where: { entity: "StockCountSession", entityId: sid, action: "COUNT_OUTGOING_DECLARED" } }), 1);
  assert.ok(session.lines.every((l) => l.disposition !== "VARIANCE_CONFIRMED"));
  assert.deepEqual(session.lines.map((l) => Number(l.varianceQuantity)).sort(), [-1, 1]);
  const handover = await db.handoverSession.findUniqueOrThrow({ where: { id: hid }, include: { materialsDecision: true } });
  assert.equal(handover.outgoingNote, "علبة مفتوحة");
  assert.ok(handover.materialsDecision?.satisfiedAt);
  assert.equal((await as<{ stage: string }>(fx.cashier.email, `/api/shifts/close-flow?branchId=${fx.branchId}`)).body.stage, "DONE");

  // Owner report: per-method money and materials, explicit zero is 0, receiving pending.
  const report = await as<{ report: { cash: { difference: number }; tenders: { method: string; variance: number }[] }; materials: { handover: { status: string; evidence: string }; lines: { name: string; difference: number; receiving: unknown }[] } }>(fx.manager.email, `/api/shifts/${outgoing.id}/report`);
  assert.equal(report.status, 200, report.text);
  assert.equal(report.body.report.cash.difference, 0);
  assert.deepEqual(report.body.report.tenders.map((t) => [t.method, t.variance]), [["CARD", -20], ["WALLET", 20]]);
  assert.deepEqual([report.body.materials.handover.status, report.body.materials.handover.evidence], ["OUTGOING_SUBMITTED", "OUTGOING_DECLARED"]);
  assert.deepEqual(report.body.materials.lines.map((l) => [l.name, l.difference, l.receiving]), [[`${fx.marker} Alpha`, -1, null], [`${fx.marker} Beta`, 1, null]]);
  const blocked = await as(fx.cashier.email, `/api/shifts/${outgoing.id}/report`);
  assert.equal(blocked.status, 403, "a cashier cannot read the oversight report");

  // Receiving on the same device under the incoming employee's own login:
  // Alpha counted 8 against 9 handed over is ACCEPTED with -1 recorded; Beta
  // is received without an independent count.
  const incoming = await incomingUser(fx, "incoming");
  await openShift(fx, incoming.id, 2, 0);
  const view = await as<{ handover: { count: { sessionId: string; countVersion: string; outgoingDeclared: boolean; lines: { id: string; inventoryItemId: string }[] } } }>(incoming.email, `/api/handovers/${hid}`);
  assert.equal(view.status, 200, view.text);
  assert.equal(view.body.handover.count.outgoingDeclared, true);
  const decisions = view.body.handover.count.lines.map((l) => ({ stockCountLineId: l.id, incomingCountedQuantity: l.inventoryItemId === alpha.id ? 8 : null }));
  const signed = await post<{ lines: { stockCountLineId: string; decision: string; varianceQuantity: number | null }[] }>(incoming.email, `/api/handovers/${hid}/acknowledge`,
    { countSessionId: sid, countVersion: view.body.handover.count.countVersion, lines: decisions, idempotencyKey: crypto.randomUUID() });
  assert.ok(signed.lines.every((l) => l.decision === "ACCEPTED"), "a different quantity alone is not a dispute");
  assert.deepEqual(signed.lines.map((l) => l.varianceQuantity).sort(), [-1, null].sort());
  // A -20 cash receipt difference also records and continues with no reason/note.
  const receiptKey = crypto.randomUUID();
  const receiptBody = { idempotencyKey: receiptKey, countedOpeningCash: 1580 };
  const accepted = await post<{ status: string }>(incoming.email, `/api/handovers/${hid}/accept`, receiptBody);
  assert.equal(accepted.status, "COMPLETED");
  assert.equal((await post<{ status: string }>(incoming.email, `/api/handovers/${hid}/accept`, receiptBody)).status, "COMPLETED");
  assert.equal(await db.varianceCase.count({ where: { acceptedHandoverId: hid, type: "OPENING_EXCEPTION" } }), 1, "receipt retry must not duplicate the cash difference");
  const receivedCash = await db.handoverSession.findUniqueOrThrow({ where: { id: hid } });
  assert.deepEqual([Number(receivedCash.proposedOpeningCash), Number(receivedCash.countedOpeningCash), Number(receivedCash.cashVarianceAmount)], [1600, 1580, -20]);
  assert.equal(Number((await db.inventoryItem.findUniqueOrThrow({ where: { id: alpha.id } })).currentStock), 8, "the receiver's accepted count is the new balance");
  assert.equal(Number((await db.inventoryItem.findUniqueOrThrow({ where: { id: beta.id } })).currentStock), 6, "no independent count: the outgoing declaration stands");
  assert.equal(await db.inventoryFreeze.count({ where: { handoverId: hid, releasedAt: null } }), 0);

  // The next close by the receiver counts what they received: it matches,
  // so the shortage recorded at receipt is not found against them again.
  const incomingShift = await db.shift.findFirstOrThrow({ where: { cashierId: incoming.id, status: "OPEN" } });
  assert.deepEqual([Number(incomingShift.openingCashAmount), Number(incomingShift.expectedCashAmount)], [1580, 1580]);
  const next = await post<{ handover: { handoverId: string } }>(incoming.email, `/api/shifts/${incomingShift.id}/close`, { actualCashAmount: 1580, handoverTarget: "SHIFT_TO_SHIFT" });
  assert.equal(Number((await db.shift.findUniqueOrThrow({ where: { id: incomingShift.id } })).cashDifference), 0, "the previous cash receipt shortage must not be found again");
  const hid2 = next.handover.handoverId;
  const sid2 = (await post<{ countSession: { id: string } }>(incoming.email, "/api/handovers", { action: "start_count", handoverId: hid2 })).countSession.id;
  const lines2 = (await as<{ session: { lines: { id: string; inventoryItemId: string }[] } }>(incoming.email, `/api/stock-counts/${sid2}`)).body.session.lines;
  for (const l of lines2) assert.equal((await as(incoming.email, `/api/stock-counts/${sid2}/lines/${l.id}`, { method: "PATCH", body: JSON.stringify({ countedQuantity: l.inventoryItemId === alpha.id ? 8 : 6, expectedCountedAt: null }) })).status, 200);
  const done2 = await post<{ systemValidated: boolean; recordedDifferences: number }>(incoming.email, "/api/handovers", { action: "finish_outgoing", handoverId: hid2 });
  assert.deepEqual([done2.systemValidated, done2.recordedDifferences], [true, 0]);
});

test("explicit refusal is still a dispute that blocks completion", async () => {
  const fx = await countCafe("HNDUX4RF"); cafes.push(fx.cafeId);
  await handoverPolicy(fx);
  await countItem(fx, "Alpha", { stock: 10, isCritical: true });
  const s = await openShift(fx, fx.cashier.id, 1, 100);
  const closed = await closeShiftWithSettlement({ shiftId: s.id, actualCash: 100, actorId: fx.cashier.id, closedByManager: false, handoverTarget: "SHIFT_TO_SHIFT", grants: { handoverSubmit: true, handoverException: false } });
  const hid = closed.handoverId!;
  const sid = (await post<{ countSession: { id: string } }>(fx.cashier.email, "/api/handovers", { action: "start_count", handoverId: hid })).countSession.id;
  const line = (await as<{ session: { lines: { id: string }[] } }>(fx.cashier.email, `/api/stock-counts/${sid}`)).body.session.lines[0];
  await as(fx.cashier.email, `/api/stock-counts/${sid}/lines/${line.id}`, { method: "PATCH", body: JSON.stringify({ countedQuantity: 10, expectedCountedAt: null }) });
  const done = await post<{ systemValidated: boolean }>(fx.cashier.email, "/api/handovers", { action: "finish_outgoing", handoverId: hid });
  assert.equal(done.systemValidated, true);
  const incoming = await incomingUser(fx, "refuser");
  await openShift(fx, incoming.id, 2, 0);
  const view = await as<{ handover: { count: { countVersion: string } } }>(incoming.email, `/api/handovers/${hid}`);
  const noReason = await as(incoming.email, `/api/handovers/${hid}/acknowledge`, { method: "POST", body: JSON.stringify({ countSessionId: sid, countVersion: view.body.handover.count.countVersion, lines: [{ stockCountLineId: line.id, incomingCountedQuantity: 7, refuse: true }], idempotencyKey: crypto.randomUUID() }) });
  assert.equal(noReason.status, 400, "a refusal must say why");
  const reason = await db.reasonCode.create({ data: { cafeId: fx.cafeId, domain: "HANDOVER", code: "REFUSE", label: "Synthetic refusal" } });
  const refused = await post<{ lines: { decision: string }[] }>(incoming.email, `/api/handovers/${hid}/acknowledge`, { countSessionId: sid, countVersion: view.body.handover.count.countVersion, lines: [{ stockCountLineId: line.id, incomingCountedQuantity: 7, refuse: true, disputeReasonCodeId: reason.id }], idempotencyKey: crypto.randomUUID() });
  assert.equal(refused.lines[0].decision, "DISPUTED");
  const blocked = await as(incoming.email, `/api/handovers/${hid}/accept`, { method: "POST", body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), countedOpeningCash: 100 }) });
  assert.equal(blocked.status, 409, blocked.text);
});

test("an explicit refusal is never recorded as acceptance, even of a matching quantity or without a count", async () => {
  const fx = await countCafe("HNDUX4RM"); cafes.push(fx.cafeId);
  await handoverPolicy(fx);
  const alpha = await countItem(fx, "Alpha", { stock: 10, isCritical: true });
  const beta = await countItem(fx, "Beta", { stock: 4, isCritical: true });
  const gamma = await countItem(fx, "Gamma", { stock: 2, isCritical: true });
  const book: Record<string, number> = { [alpha.id]: 10, [beta.id]: 4, [gamma.id]: 2 };
  const s = await openShift(fx, fx.cashier.id, 1, 100);
  const closed = await closeShiftWithSettlement({ shiftId: s.id, actualCash: 100, actorId: fx.cashier.id, closedByManager: false, handoverTarget: "SHIFT_TO_SHIFT", grants: { handoverSubmit: true, handoverException: false } });
  const hid = closed.handoverId!;
  const sid = (await post<{ countSession: { id: string } }>(fx.cashier.email, "/api/handovers", { action: "start_count", handoverId: hid })).countSession.id;
  const lines = (await as<{ session: { lines: { id: string; inventoryItemId: string }[] } }>(fx.cashier.email, `/api/stock-counts/${sid}`)).body.session.lines;
  for (const l of lines) await as(fx.cashier.email, `/api/stock-counts/${sid}/lines/${l.id}`, { method: "PATCH", body: JSON.stringify({ countedQuantity: book[l.inventoryItemId], expectedCountedAt: null }) });
  assert.equal((await post<{ systemValidated: boolean }>(fx.cashier.email, "/api/handovers", { action: "finish_outgoing", handoverId: hid })).systemValidated, true);
  const incoming = await incomingUser(fx, "rm");
  await openShift(fx, incoming.id, 2, 0);
  const view = await as<{ handover: { count: { countVersion: string } } }>(incoming.email, `/api/handovers/${hid}`);
  const reason = await db.reasonCode.create({ data: { cafeId: fx.cafeId, domain: "HANDOVER", code: "REFUSE", label: "Synthetic refusal" } });
  const [l1, l2, l3] = lines;
  const signed = await post<{ lines: { stockCountLineId: string; decision: string; varianceQuantity: number | null }[] }>(incoming.email, `/api/handovers/${hid}/acknowledge`, {
    countSessionId: sid, countVersion: view.body.handover.count.countVersion, idempotencyKey: crypto.randomUUID(),
    lines: [
      // Matching quantity, explicitly refused: a refusal.
      { stockCountLineId: l1.id, incomingCountedQuantity: book[l1.inventoryItemId], refuse: true, disputeReasonCodeId: reason.id },
      // No independent count, explicitly refused: a refusal with no figure.
      { stockCountLineId: l2.id, incomingCountedQuantity: null, refuse: true, disputeReasonCodeId: reason.id },
      // Matching quantity, not refused: accepted.
      { stockCountLineId: l3.id, incomingCountedQuantity: book[l3.inventoryItemId] },
    ],
  });
  const by = new Map(signed.lines.map((l) => [l.stockCountLineId, l]));
  assert.equal(by.get(l1.id)!.decision, "DISPUTED");
  assert.equal(by.get(l1.id)!.varianceQuantity, 0);
  assert.equal(by.get(l2.id)!.decision, "DISPUTED");
  assert.equal(by.get(l2.id)!.varianceQuantity, null);
  assert.equal(by.get(l3.id)!.decision, "ACCEPTED");
  const rows = await db.handoverStockAcknowledgement.findMany({ where: { handoverId: hid } });
  assert.equal(rows.filter((r) => r.decision === "ACCEPTED").length, 1, "no acceptance signature for the refused lines");
  const blocked = await as(incoming.email, `/api/handovers/${hid}/accept`, { method: "POST", body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), countedOpeningCash: 100 }) });
  assert.equal(blocked.status, 409, "a refusal still blocks completion");
});

test("branch custody: a non-due weekly night closes without a count; the grant still applies; a due full count still counts", async () => {
  const fx = await countCafe("HNDUX4BC"); cafes.push(fx.cafeId);
  await handoverPolicy(fx);
  await countItem(fx, "Alpha", { stock: 10, isCritical: true });
  // Weekly on a day that is not today's business day, starting now: nothing owed tonight.
  const today = new Date(new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date()) + "T00:00:00Z").getUTCDay();
  await db.branch.update({ where: { id: fx.branchId }, data: { materialsCountCadence: "WEEKLY", materialsCountWeekday: (today + 3) % 7, materialsCountCutoff: "22:00", materialsScheduleSince: new Date() } });

  const s1 = await openShift(fx, fx.cashier.id, 1, 100);
  const noGrant = await as(fx.cashier.email, `/api/shifts/${s1.id}/close`, { method: "POST", body: JSON.stringify({ actualCashAmount: 100, handoverTarget: "BRANCH_CUSTODY" }) });
  assert.equal(noGrant.status, 403, "ending custody for the night still takes the exception grant");
  assert.equal((await db.shift.findUniqueOrThrow({ where: { id: s1.id } })).status, "OPEN");

  const night = await as<{ handover: { required: boolean }; materials: { due: boolean; reason: string } }>(fx.manager.email, `/api/shifts/${s1.id}/close`, { method: "POST", body: JSON.stringify({ actualCashAmount: 100, handoverTarget: "BRANCH_CUSTODY" }) });
  assert.equal(night.status, 200, night.text);
  assert.deepEqual([night.body.handover.required, night.body.materials.due, night.body.materials.reason], [false, false, "NOT_DUE"]);
  const row = await db.shift.findUniqueOrThrow({ where: { id: s1.id } });
  assert.equal(row.status, "CLOSED");
  assert.equal(await db.handoverSession.count({ where: { outgoingShiftId: s1.id } }), 0, "no count is invented");
  assert.equal(await db.inventoryFreeze.count({ where: { cafeId: fx.cafeId, releasedAt: null } }), 0, "no freeze left behind");
  const audit = await db.auditLog.findFirstOrThrow({ where: { entity: "Shift", entityId: s1.id, action: "SHIFT_CLOSED" } });
  assert.equal((audit.details as { requestedHandoverTarget?: string }).requestedHandoverTarget, "BRANCH_CUSTODY");
  // The next opener starts operational, not waiting on a count nobody owes.
  const s2 = await openShift(fx, fx.cashier.id, 2, 100);
  assert.equal((await db.shift.findUniqueOrThrow({ where: { id: s2.id } })).custodyGateReason, null);

  // A separately scheduled FULL count is its own trigger.
  await db.cafeSettings.update({ where: { cafeId: fx.cafeId }, data: { periodicFullCountSchedule: "DAILY_LAST_HANDOVER" } });
  const full = await closeShiftWithSettlement({ shiftId: s2.id, actualCash: 100, actorId: fx.manager.id, closedByManager: true, handoverTarget: "BRANCH_CUSTODY", grants: { handoverSubmit: true, handoverException: true } });
  assert.deepEqual([full.materials?.due, full.materials?.reason, full.status], [true, "FULL_COUNT_DUE", "AWAITING_HANDOVER"]);
  assert.equal((await db.handoverSession.findUniqueOrThrow({ where: { id: full.handoverId! } })).stockMode, "FULL");

  // Overnight drawer storage needs the branch-custody handover, so it counts (decision level).
  const { resolveMaterialsDecision } = await import("@/lib/materials-schedule");
  const d = await db.$transaction((tx) => resolveMaterialsDecision(tx, { branchId: fx.branchId, at: new Date(), fullCountDue: false, branchCustodyNeedsHandover: true }));
  assert.deepEqual([d.due, d.reason], [true, "BRANCH_CUSTODY"]);
});

test("daily schedule: one claim per period under concurrent closes, not-due closes without a freeze, schedule edits do not move a started scope", async () => {
  const fx = await countCafe("HNDUX4DY"); cafes.push(fx.cafeId);
  await handoverPolicy(fx);
  await countItem(fx, "Alpha", { stock: 10, isCritical: true });
  // Cutoff 03:00 is the business-day start, so today's period is always
  // claimable now; the schedule existed two days ago, so two earlier days are
  // still owed and the one count must cover all of them.
  await db.branch.update({ where: { id: fx.branchId }, data: { materialsCountCadence: "DAILY", materialsCountCutoff: "03:00", materialsScheduleSince: new Date(Date.now() - 2 * 86_400_000) } });
  const second = await incomingUser(fx, "second");
  const a = await openShift(fx, fx.cashier.id, 1, 100);
  const b = await openShift(fx, second.id, 2, 100);
  const close = (shiftId: string, actorId: string) => closeShiftWithSettlement({ shiftId, actualCash: 100, actorId, closedByManager: false, handoverTarget: "SHIFT_TO_SHIFT", grants: { handoverSubmit: true, handoverException: false } });
  const results = await Promise.all([close(a.id, fx.cashier.id), close(b.id, second.id)]);
  const due = results.filter((r) => r.materials?.due);
  const notDue = results.filter((r) => r.materials && !r.materials.due);
  assert.equal(due.length, 1, "exactly one close claims the owed period");
  assert.equal(notDue.length, 1);
  assert.ok(due[0].materials!.periodFrom! < due[0].materials!.periodTo!, "missed days are covered by the one count, not dropped");
  assert.equal(due[0].status, "AWAITING_HANDOVER");
  assert.equal(notDue[0].status, "CLOSED");
  assert.equal(notDue[0].handoverId, null);
  assert.ok(notDue[0].materials!.nextDueAt, "not due records when it next is");
  const decisions = await db.shiftMaterialsDecision.findMany({ where: { branchId: fx.branchId }, orderBy: { decidedAt: "asc" } });
  assert.equal(decisions.length, 2);
  assert.equal(decisions.filter((d) => d.periodTo !== null).length, 1);
  assert.equal(await db.inventoryFreeze.count({ where: { cafeId: fx.cafeId, releasedAt: null } }), 1, "only the counted handover holds a freeze");

  // Changing the schedule while that count is open does not move its scope.
  const hid = due[0].handoverId!;
  const before = await db.handoverRequiredItem.findMany({ where: { handoverId: hid }, select: { inventoryItemId: true } });
  await updateBranchHandoverConfig({ cafeId: fx.cafeId, branchId: fx.branchId, actorId: fx.owner.id, patch: { materials: { cadence: "WEEKLY", weekday: 1, cutoff: "22:00" } } });
  assert.deepEqual(await db.handoverRequiredItem.findMany({ where: { handoverId: hid }, select: { inventoryItemId: true } }), before);
  const decision = await db.shiftMaterialsDecision.findUniqueOrThrow({ where: { handoverId: hid } });
  assert.equal(decision.cadence, "DAILY", "the decision keeps the configuration it was made under");
  const branch = await db.branch.findUniqueOrThrow({ where: { id: fx.branchId } });
  assert.equal(branch.materialsCountCadence, "WEEKLY");
  assert.ok(branch.materialsScheduleSince && branch.materialsScheduleSince > decision.decidedAt, "a new cadence starts owing from its own start");
});
