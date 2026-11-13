// SHV2-004 — A10: an owner-approved correction on a system-validated handover
// count is still declared when the outgoing employee finishes, and the
// acceptance writes the stock snapshot from it.
//
// v2 (8b18d1a) re-submitted the outgoing count at finish only from DRAFT or
// IN_PROGRESS. A correction request moves a system-validated count back to
// SUBMITTED, so after approval the finish skipped it: the difference was never
// declared, the count stayed unconfirmed and the acceptance carried the shelf
// with no verified figure. This suite pins the corrected path end to end, and
// that repeating each step adds nothing.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { countCafe, countItem, type CountActor } from "./helpers/count";
import { db, teardownTaggedCafe } from "./helpers/db";
import { as } from "./helpers/http";

const cafes: string[] = [];
after(async () => {
  for (const cafeId of cafes) {
    await teardownTaggedCafe(cafeId, [
      () => db.handoverRequiredItem.updateMany({ where: { handover: { cafeId } }, data: { satisfiedByLineId: null } }),
      () => db.handoverSession.updateMany({ where: { cafeId }, data: { stockCountSessionId: null, acceptedStockCountSessionId: null } }),
      () => db.stockCountSession.updateMany({ where: { cafeId }, data: { handoverId: null, lockedByHandoverId: null, accountabilityContext: "NONE" } }),
    ]);
  }
  await db.$disconnect();
});

function post<T>(actor: CountActor, url: string, body: unknown) {
  return as<T>(actor.email, url, { method: "POST", body: JSON.stringify(body) });
}

test("an approved correction is declared at finish, once, and the acceptance snapshots it", async () => {
  const fx = await countCafe("SHV2A10");
  cafes.push(fx.cafeId);
  await db.cafeSettings.update({ where: { cafeId: fx.cafeId }, data: { stockCountPolicy: "HYBRID", handoverCountType: "FULL" } });
  const item = await countItem(fx, "Shelf", { stock: 10, isCritical: true });

  const opened = await post<{ shift: { id: string } }>(fx.manager, "/api/shifts", { branchId: fx.branchId, openingCashAmount: 1000 });
  assert.equal(opened.status, 201, opened.text);
  const closed = await post<{ handover: { handoverId: string } }>(fx.manager, `/api/shifts/${opened.body.shift.id}/close`, { actualCashAmount: 1000, handoverTarget: "BRANCH_CUSTODY" });
  assert.equal(closed.status, 200, closed.text);
  const handoverId = closed.body.handover.handoverId;

  const started = await post<{ countSession: { id: string } }>(fx.manager, "/api/handovers", { action: "start_count", handoverId });
  assert.equal(started.status, 200, started.text);
  const sessionId = started.body.countSession.id;
  const line = await db.stockCountLine.findFirstOrThrow({ where: { sessionId } });
  const counted = await as(fx.manager.email, `/api/stock-counts/${sessionId}/lines/${line.id}`, {
    method: "PATCH", body: JSON.stringify({ countedQuantity: 10, expectedCountedAt: null }),
  });
  assert.equal(counted.status, 200, counted.text);
  const submitted = await post<{ status: string; systemValidated: boolean }>(fx.manager, `/api/stock-counts/${sessionId}/submit`, {});
  assert.equal(submitted.status, 200, submitted.text);
  assert.equal(submitted.body.status, "CONFIRMED");
  assert.equal(submitted.body.systemValidated, true);

  // The shelf really held 9: the manager asks, the owner approves.
  const reason = await db.reasonCode.create({ data: { cafeId: fx.cafeId, domain: "STOCK", code: "A10_FIX", label: "Miscount" } });
  const requested = await post<{ correctionId: string }>(fx.manager, `/api/stock-counts/${sessionId}/lines/${line.id}/correction`, {
    newCountedQuantity: 9, reasonCodeId: reason.id,
  });
  assert.equal(requested.status, 201, requested.text);
  const approved = await post(fx.owner, `/api/corrections/${requested.body.correctionId}/approve`, {});
  assert.equal(approved.status, 200, approved.text);
  assert.equal((await db.stockCountSession.findUniqueOrThrow({ where: { id: sessionId } })).status, "SUBMITTED",
    "precondition: the correction moved the validated count back to SUBMITTED");

  // Two presses of "finish" at once (double tap, two devices).
  const [first, second] = await Promise.all([
    post<{ status: string; recordedDifferences: number; alreadySubmitted?: boolean }>(fx.manager, "/api/handovers", { action: "finish_outgoing", handoverId }),
    post<{ status: string; recordedDifferences: number; alreadySubmitted?: boolean }>(fx.manager, "/api/handovers", { action: "finish_outgoing", handoverId }),
  ]);
  for (const r of [first, second]) {
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.status, "OUTGOING_SUBMITTED");
    assert.equal(r.body.recordedDifferences, 1, "the corrected difference is declared, and a replay says so too");
    assert.equal((r.body as { systemValidated?: boolean }).systemValidated, false, "a corrected count is a declaration, not a system match");
  }
  assert.equal([first, second].filter((r) => r.body.alreadySubmitted === true).length, 1, "exactly one press did the submission");

  const session = await db.stockCountSession.findUniqueOrThrow({ where: { id: sessionId } });
  assert.equal(session.status, "CONFIRMED");
  assert.equal(session.confirmedById, null, "a declaration, not a manager confirmation");
  const declaredLine = await db.stockCountLine.findUniqueOrThrow({ where: { id: line.id } });
  assert.equal(Number(declaredLine.effectiveCountedQuantity), 9, "the approved figure is the one in force");
  const declarations = await db.auditLog.findMany({ where: { entityId: sessionId, action: "COUNT_OUTGOING_DECLARED" } });
  assert.equal(declarations.length, 1);
  const declared = declarations[0].details as { differenceLines?: number; observations?: { lineId: string; quantity: string }[] };
  assert.equal(declared.differenceLines, 1);
  assert.deepEqual(declared.observations?.map((o) => [o.lineId, Number(o.quantity)]), [[line.id, 9]], "the declaration names the corrected figure");
  assert.equal(await db.auditLog.count({ where: { entityId: handoverId, action: "HANDOVER_SUBMITTED" } }), 1);

  // A third press later is a replay, not a second declaration.
  const third = await post<{ status: string; recordedDifferences: number; alreadySubmitted: boolean }>(fx.manager, "/api/handovers", { action: "finish_outgoing", handoverId });
  assert.equal(third.status, 200, third.text);
  assert.equal(third.body.alreadySubmitted, true);
  assert.equal(third.body.recordedDifferences, 1);
  assert.equal(await db.auditLog.count({ where: { entityId: sessionId, action: "COUNT_OUTGOING_DECLARED" } }), 1);

  // The acceptance writes its stock snapshot from the declared count, once.
  const key = crypto.randomUUID();
  const accepted = await post<{ status: string }>(fx.owner, `/api/handovers/${handoverId}/to-branch-custody`, { idempotencyKey: key });
  assert.equal(accepted.status, 200, accepted.text);
  const replayed = await post<{ status: string }>(fx.owner, `/api/handovers/${handoverId}/to-branch-custody`, { idempotencyKey: key });
  assert.equal(replayed.status, 200, replayed.text);

  const handover = await db.handoverSession.findUniqueOrThrow({ where: { id: handoverId } });
  assert.equal(handover.status, "COMPLETED");
  assert.equal(handover.acceptedStockCountSessionId, sessionId, "the snapshot names the declared count");
  const boundary = await db.handoverStockBoundary.findMany({ where: { handoverId } });
  assert.equal(boundary.length, await db.inventoryItem.count({ where: { branchId: fx.branchId, isActive: true, archivedAt: null } }), "one snapshot row per item, no duplicates");
  const shelf = boundary.find((row) => row.inventoryItemId === item.id);
  assert.ok(shelf, "the counted item is in the snapshot");
  assert.equal(shelf.verified, true);
  assert.equal((await db.stockCountSession.findUniqueOrThrow({ where: { id: sessionId } })).lockedByHandoverId, handoverId, "the accepted count is locked");
  assert.equal(await db.auditLog.count({ where: { entityId: sessionId, action: "COUNT_OUTGOING_DECLARED" } }), 1);
});
