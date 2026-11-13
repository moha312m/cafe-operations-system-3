// SHV2-005 — C1: a dispute entered on the old line-by-line receiving sheet
// reaches the v2 comparison, the manager/owner notifications and the review.
//
// v2 lets a disputed handover complete (Plan: "no signature / dispute /
// required-item / pending-correction refusal"). Before this suite the
// disagreement then lived only in the legacy `HandoverStockAcknowledgement`
// row: the comparison, the notifications and the report never read it. The
// three journeys below are the three ways a legacy dispute exists:
//   1. the incoming employee counts a different figure and refuses it;
//   2. the incoming employee refuses a line without counting it;
//   3. a dispute already on file before this change (written directly).
// Each must be visible to the manager and owner, once, and repeating the
// sheet or the acceptance must not notify twice.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, countItem, COUNT_PASSWORD, type CountCafe } from "./helpers/count";
import { as, login } from "./helpers/http";
import { ensureCustodyForShift } from "@/lib/custody";
import { closeShiftWithSettlement } from "@/lib/cash-close";

const cafes: string[] = [];
after(async () => {
  for (const id of cafes) {
    await db.handoverStockAcknowledgement.deleteMany({ where: { handover: { cafeId: id } } });
    await db.handoverStockBoundary.deleteMany({ where: { handover: { cafeId: id } } });
    await db.handoverRequiredItem.updateMany({ where: { handover: { cafeId: id } }, data: { satisfiedByLineId: null } });
    await db.handoverSession.updateMany({ where: { cafeId: id }, data: { stockCountSessionId: null, acceptedStockCountSessionId: null } });
    await db.stockCountSession.updateMany({ where: { cafeId: id }, data: { handoverId: null, lockedByHandoverId: null, accountabilityContext: "NONE" } });
    await teardownTaggedCafe(id);
  }
  await db.$disconnect();
});

type View = { handover: { count: { sessionId: string; countVersion: string; lines: { id: string; inventoryItem: { name: string } }[] } } };
type ComparisonLine = { inventoryItemId: string; disputed: boolean; incoming: { quantity: string; source: string } | null; raw: string | null };
type StoredComparison = { lines: ComparisonLine[]; disputedCount: number };

async function shift(fx: CountCafe, userId: string, n: number) {
  const s = await db.shift.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, cashierId: userId, shiftNumber: n, openingCashAmount: 100, expectedCashAmount: 100 } });
  await db.$transaction((tx) => ensureCustodyForShift(tx, { cafeId: fx.cafeId, branchId: fx.branchId, shiftId: s.id, userId, openingCashAmount: 100 }));
  return s;
}
const post = <T = Record<string, unknown>>(email: string, path: string, body: unknown) =>
  as<T>(email, path, { method: "POST", body: JSON.stringify(body) });

/** A matching outgoing count, finished, with a receiving cashier on shift and looking at the sheet. */
async function readyForSheet(label: string) {
  const fx = await countCafe(label);
  cafes.push(fx.cafeId);
  await db.cafeSettings.update({ where: { cafeId: fx.cafeId }, data: { stockCountPolicy: "HYBRID", handoverCountType: "CRITICAL", periodicFullCountSchedule: "MANUAL_ONLY", recountRequiredOutsideTolerance: false, varianceBlocksHandover: false } });
  const alpha = await countItem(fx, "Alpha", { stock: 10, isCritical: true });
  const outgoing = await shift(fx, fx.cashier.id, 1);
  const closed = await closeShiftWithSettlement({ shiftId: outgoing.id, actualCash: 100, actorId: fx.cashier.id, closedByManager: false, handoverTarget: "SHIFT_TO_SHIFT", grants: { handoverSubmit: true, handoverException: true } });
  const hid = closed.handoverId!;
  const started = await post<{ countSession: { id: string } }>(fx.cashier.email, "/api/handovers", { action: "start_count", handoverId: hid });
  assert.equal(started.status, 200, started.text);
  const sid = started.body.countSession.id;
  const line = await db.stockCountLine.findFirstOrThrow({ where: { sessionId: sid } });
  const counted = await as(fx.cashier.email, `/api/stock-counts/${sid}/lines/${line.id}`, { method: "PATCH", body: JSON.stringify({ countedQuantity: 10, expectedCountedAt: null }) });
  assert.equal(counted.status, 200, counted.text);
  const finished = await post<{ status: string }>(fx.cashier.email, "/api/handovers", { action: "finish_outgoing", handoverId: hid });
  assert.equal(finished.status, 200, finished.text);
  assert.equal(finished.body.status, "OUTGOING_SUBMITTED");
  const passwordHash = (await db.user.findUniqueOrThrow({ where: { id: fx.cashier.id } })).passwordHash;
  const incoming = await db.user.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, email: `incoming-${fx.marker.toLowerCase()}@example.invalid`, name: "Synthetic incoming", role: "CASHIER", passwordHash } });
  await login(incoming.email, COUNT_PASSWORD);
  await shift(fx, incoming.id, 2);
  const view = await as<View>(incoming.email, `/api/handovers/${hid}`);
  assert.equal(view.status, 200, view.text);
  const reason = await db.reasonCode.create({ data: { cafeId: fx.cafeId, domain: "HANDOVER", code: "SHELF_SHORT", label: "Shelf does not match" } });
  return { fx, hid, sid, lineId: line.id, alphaId: alpha.id, incoming, count: view.body.handover.count, reasonId: reason.id };
}

/** What the manager and owner can see about this handover. */
async function assertDisputeVisible(r: Awaited<ReturnType<typeof readyForSheet>>, expectIncoming: string | null) {
  const stored = await db.stockHandoverComparison.findMany({ where: { handoverId: r.hid }, orderBy: { computedAt: "desc" } });
  assert.ok(stored.length >= 1, "the dispute produced a recorded comparison");
  const latest = stored[0].lines as unknown as StoredComparison;
  assert.equal(latest.disputedCount, 1, "the recorded comparison counts the dispute");
  const alpha = latest.lines.find((l) => l.inventoryItemId === r.alphaId);
  assert.ok(alpha, "the disputed item is on the comparison");
  assert.equal(alpha.disputed, true);
  if (expectIncoming === null) assert.equal(alpha.incoming, null, "a refusal without a count is never a zero");
  else {
    assert.equal(alpha.incoming?.quantity, expectIncoming);
    assert.equal(alpha.incoming?.source, "LEGACY_SHEET");
  }

  const notes = await db.notification.findMany({ where: { handoverId: r.hid, kind: "STOCK_HANDOVER_DISCREPANCY" } });
  const recipients = notes.map((n) => n.recipientId);
  assert.ok(recipients.includes(r.fx.owner.id), "the owner is notified");
  assert.ok(recipients.includes(r.fx.manager.id), "the branch manager is notified");
  assert.ok(!recipients.includes(r.incoming.id) && !recipients.includes(r.fx.cashier.id), "neither employee is a recipient");
  assert.equal(new Set(recipients).size, recipients.length, "one notification per recipient");

  const review = await db.stockHandoverReview.findUnique({ where: { handoverId: r.hid } });
  assert.ok(review, "the dispute opened a review");
  assert.equal(review.status, "OPEN");

  const list = await as<{ rows: { handoverId: string; disputedCount: number; result: string }[] }>(r.fx.owner.email, `/api/stock-handover-reports?branchId=${r.fx.branchId}`);
  assert.equal(list.status, 200, list.text);
  const row = list.body.rows.find((x) => x.handoverId === r.hid);
  assert.ok(row, "the handover is in the report");
  assert.equal(row.disputedCount, 1);
  assert.equal(row.result, "UNEXPLAINED", "a dispute is never reported as matching");
  const detail = await as<{ comparison: { disputedCount: number; lines: ComparisonLine[] } }>(r.fx.owner.email, `/api/stock-handover-reports/${r.hid}`);
  assert.equal(detail.status, 200, detail.text);
  assert.equal(detail.body.comparison.disputedCount, 1);
  assert.equal(detail.body.comparison.lines.find((l) => l.inventoryItemId === r.alphaId)?.disputed, true);
  return notes.length;
}

async function acceptTwice(r: Awaited<ReturnType<typeof readyForSheet>>) {
  const body = { idempotencyKey: crypto.randomUUID(), countedOpeningCash: 100 };
  const first = await post<{ status: string }>(r.incoming.email, `/api/handovers/${r.hid}/accept`, body);
  assert.equal(first.status, 200, first.text);
  assert.equal(first.body.status, "COMPLETED", "v2: a dispute does not block the handover");
  const again = await post<{ status: string }>(r.incoming.email, `/api/handovers/${r.hid}/accept`, body);
  assert.equal(again.status, 200, again.text);
}

test("a refused different count on the sheet reaches the comparison, the notifications and the review", async () => {
  const r = await readyForSheet("SHV2C1QTY");
  const body = { countSessionId: r.sid, countVersion: r.count.countVersion, idempotencyKey: crypto.randomUUID(),
    lines: r.count.lines.map((l) => ({ stockCountLineId: l.id, incomingCountedQuantity: 8, disputeReasonCodeId: r.reasonId, refuse: true })) };
  const signed = await post<{ lines: { decision: string }[] }>(r.incoming.email, `/api/handovers/${r.hid}/acknowledge`, body);
  assert.equal(signed.status, 200, signed.text);
  assert.equal(signed.body.lines[0].decision, "DISPUTED");
  // Visible before anyone accepts: the manager hears about it when it is entered.
  const before = await assertDisputeVisible(r, "8.000");
  const replay = await post(r.incoming.email, `/api/handovers/${r.hid}/acknowledge`, body);
  assert.equal(replay.status, 200, replay.text);
  await acceptTwice(r);
  assert.equal(await assertDisputeVisible(r, "8.000"), before, "repeating the sheet or the acceptance notifies nobody twice");
  assert.equal(Number((await db.inventoryItem.findUniqueOrThrow({ where: { id: r.alphaId } })).currentStock), 10, "a dispute is not a posting");
});

test("a refusal without a count is still a dispute the manager sees", async () => {
  const r = await readyForSheet("SHV2C1REF");
  const body = { countSessionId: r.sid, countVersion: r.count.countVersion, idempotencyKey: crypto.randomUUID(),
    lines: r.count.lines.map((l) => ({ stockCountLineId: l.id, incomingCountedQuantity: null, disputeReasonCodeId: r.reasonId, refuse: true })) };
  const signed = await post<{ lines: { decision: string }[] }>(r.incoming.email, `/api/handovers/${r.hid}/acknowledge`, body);
  assert.equal(signed.status, 200, signed.text);
  assert.equal(signed.body.lines[0].decision, "DISPUTED");
  await acceptTwice(r);
  await assertDisputeVisible(r, null);
});

test("a dispute already on file before this change is not dropped at acceptance", async () => {
  const r = await readyForSheet("SHV2C1OLD");
  // Written the way the sheet wrote it before v2 read disputes: no comparison, no notification.
  await db.handoverStockAcknowledgement.create({ data: {
    handoverId: r.hid, stockCountLineId: r.lineId, acknowledgedById: r.incoming.id, acknowledgedAt: new Date(),
    incomingCountedQuantity: 7, handedOverQuantity: 10, varianceQuantity: -3, decision: "DISPUTED", disputeReasonCodeId: r.reasonId, disputeNote: "legacy",
  } });
  await db.handoverSession.update({ where: { id: r.hid }, data: { status: "INCOMING_REVIEW", reviewedAt: new Date() } });
  assert.equal(await db.notification.count({ where: { handoverId: r.hid, kind: "STOCK_HANDOVER_DISCREPANCY" } }), 0, "precondition: nobody was told");
  await acceptTwice(r);
  await assertDisputeVisible(r, "7.000");
});
