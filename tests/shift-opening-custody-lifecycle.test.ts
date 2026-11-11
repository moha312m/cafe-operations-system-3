import { after, test } from "node:test";
import assert from "node:assert/strict";
import { countCafe, countItem, type CountActor, type CountCafe } from "./helpers/count";
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

async function fixture() {
  const fx = await countCafe("SHIFTOPEN");
  cafes.push(fx.cafeId);
  await db.cafeSettings.update({
    where: { cafeId: fx.cafeId },
    data: { stockCountPolicy: "HYBRID", handoverCountType: "FULL" },
  });
  await countItem(fx, "Shelf", { stock: 10, isCritical: true });
  return fx;
}

function post<T>(actor: CountActor, url: string, body: unknown) {
  return as<T>(actor.email, url, { method: "POST", body: JSON.stringify(body) });
}

function open(fx: CountCafe, actor: CountActor, openingCashAmount = 1000) {
  return post<{ shift: { id: string; custodyGateReason: string | null }; alreadyOpen?: boolean }>(
    actor, "/api/shifts", { branchId: fx.branchId, openingCashAmount },
  );
}

function close(actor: CountActor, shiftId: string, handoverTarget?: string) {
  return post<{ handover: { handoverId: string } }>(
    actor, `/api/shifts/${shiftId}/close`, { actualCashAmount: 1000, handoverTarget },
  );
}

async function openCustody(fx: CountCafe) {
  return db.custodyPeriod.findMany({
    where: { branchId: fx.branchId, status: "OPEN" },
    orderBy: { scope: "asc" },
  });
}

async function countShelf(actor: CountActor, countSessionId: string) {
  const line = await db.stockCountLine.findFirstOrThrow({ where: { sessionId: countSessionId } });
  const counted = await as(actor.email, `/api/stock-counts/${countSessionId}/lines/${line.id}`, {
    method: "PATCH", body: JSON.stringify({ countedQuantity: 10, expectedCountedAt: null }),
  });
  assert.equal(counted.status, 200, counted.text);
  const submitted = await post(actor, `/api/stock-counts/${countSessionId}/submit`, {});
  assert.equal(submitted.status, 200, submitted.text);
}

test("a night close into branch custody waits while a colleague still trades on the shelf", async () => {
  const fx = await fixture();
  const outgoing = await open(fx, fx.manager);
  assert.equal(outgoing.status, 201, outgoing.text);
  const colleague = await open(fx, fx.cashier);
  assert.equal(colleague.status, 201, colleague.text);
  const before = await openCustody(fx);

  // Branch custody means nobody holds the shelf; a colleague selling from it
  // is somebody. Refused before any write, so the close can be retried.
  const closed = await close(fx.manager, outgoing.body.shift.id, "BRANCH_CUSTODY");
  assert.equal(closed.status, 409, closed.text);
  assert.match(closed.text, /شيفت تاني لسه شغال/);
  assert.deepEqual(await openCustody(fx), before);
  assert.equal((await db.shift.findUniqueOrThrow({ where: { id: outgoing.body.shift.id } })).status, "OPEN");
  assert.equal(await db.handoverSession.count({ where: { branchId: fx.branchId } }), 0);
});

test("manager approval, cancel and release refuse without a reason and note", async () => {
  const fx = await fixture();
  const outgoing = await open(fx, fx.manager);
  assert.equal(outgoing.status, 201, outgoing.text);
  const closed = await close(fx.manager, outgoing.body.shift.id, "BRANCH_CUSTODY");
  assert.equal(closed.status, 200, closed.text);
  const handoverId = closed.body.handover.handoverId;
  for (const url of [`/api/handovers/${handoverId}/approve`, `/api/handovers/${handoverId}/cancel`, `/api/branches/${fx.branchId}/inventory-freeze/release`]) {
    const refused = await post(fx.owner, url, {});
    assert.equal(refused.status, 400, `${url}: ${refused.text}`);
  }
  // The custodian may never end their own handover, whatever keys they hold.
  const reason = await db.reasonCode.create({ data: { cafeId: fx.cafeId, domain: "HANDOVER", code: "S1_SELF", label: "Self" } });
  const self = await post(fx.manager, `/api/handovers/${handoverId}/cancel`, { reasonCodeId: reason.id, note: "leaving" });
  assert.equal(self.status, 403, self.text);
  assert.equal((await db.handoverSession.findUniqueOrThrow({ where: { id: handoverId } })).status, "DRAFT");
});

test("an owner ends an unfinished night handover into branch custody, carried and on the record", async () => {
  const fx = await fixture();
  const outgoing = await open(fx, fx.manager);
  assert.equal(outgoing.status, 201, outgoing.text);
  const closed = await close(fx.manager, outgoing.body.shift.id, "BRANCH_CUSTODY");
  assert.equal(closed.status, 200, closed.text);
  const handoverId = closed.body.handover.handoverId;
  const reason = await db.reasonCode.create({ data: { cafeId: fx.cafeId, domain: "HANDOVER", code: "S1_END", label: "Left" } });
  const ended = await post<{ branchCustodyPeriodId: string; boundaryLines: number }>(
    fx.owner, `/api/handovers/${handoverId}/cancel`, { reasonCodeId: reason.id, note: "Outgoing left before counting" },
  );
  assert.equal(ended.status, 200, ended.text);
  const handover = await db.handoverSession.findUniqueOrThrow({ where: { id: handoverId } });
  assert.equal(handover.status, "COMPLETED");
  assert.equal(handover.resolvedTarget, "BRANCH_CUSTODY");
  assert.equal(handover.incomingUserId, null);
  assert.equal(handover.exceptionReason, "Outgoing left before counting");
  // The shelf is carried, not counted: every boundary row is unverified.
  const boundary = await db.handoverStockBoundary.findMany({ where: { handoverId } });
  assert.ok(boundary.length > 0);
  assert.ok(boundary.every((row) => !row.verified && row.source === "SYSTEM_CARRIED"));
  // The stock was transferred to the branch, not rewritten in place.
  const branchStock = await db.custodyPeriod.findUniqueOrThrow({ where: { id: ended.body.branchCustodyPeriodId } });
  assert.equal(branchStock.holderType, "BRANCH");
  assert.equal(branchStock.previousPeriodId, handover.outgoingStockCustodyId);
  assert.equal((await db.custodyPeriod.findUniqueOrThrow({ where: { id: handover.outgoingStockCustodyId! } })).status, "TRANSFERRED");
  assert.equal(await db.openingException.count({ where: { handoverId, kind: "NO_INCOMING" } }), 1);
  assert.equal(await db.auditLog.count({ where: { entityId: handoverId, action: "HANDOVER_CANCELLED" } }), 1);
  // The morning opens onto the opening verification.
  const next = await open(fx, fx.cashier);
  assert.equal(next.status, 201, next.text);
  assert.equal(next.body.shift.custodyGateReason, "AWAITING_OPENING_VERIFICATION");
});

test("a night handover returned for recount still gates the next shift", async () => {
  const fx = await fixture();
  const outgoing = await open(fx, fx.manager);
  assert.equal(outgoing.status, 201, outgoing.text);
  const closed = await close(fx.manager, outgoing.body.shift.id, "BRANCH_CUSTODY");
  assert.equal(closed.status, 200, closed.text);
  const handoverId = closed.body.handover.handoverId;
  const started = await post<{ countSession: { id: string } }>(
    fx.manager, "/api/handovers", { action: "start_count", handoverId },
  );
  assert.equal(started.status, 200, started.text);
  await countShelf(fx.manager, started.body.countSession.id);
  const submitted = await post(fx.manager, "/api/handovers", { action: "submit", handoverId });
  assert.equal(submitted.status, 200, submitted.text);
  const receiver = await open(fx, fx.cashier);
  assert.equal(receiver.status, 201, receiver.text);
  assert.equal(receiver.body.shift.custodyGateReason, "AWAITING_CUSTODY_TRANSFER");
  const activeUrl = `/api/shifts/active?branchId=${fx.branchId}`;
  const review = await as<{ pendingShift: { pendingHandover: { id: string } } }>(fx.cashier.email, activeUrl);
  assert.equal(review.body.pendingShift.pendingHandover.id, handoverId);
  assert.equal((await as(fx.cashier.email, `/api/handovers/${handoverId}`)).status, 200);
  const reason = await db.reasonCode.create({
    data: { cafeId: fx.cafeId, domain: "HANDOVER", code: "SHIFT_OPEN_RECOUNT", label: "Recount" },
  });
  const returned = await post(fx.owner, `/api/handovers/${handoverId}/request-recount`, {
    reasonCodeId: reason.id, note: "Recount",
  });
  assert.equal(returned.status, 200, returned.text);
  const before = await openCustody(fx);
  const next = await open(fx, fx.owner);
  assert.equal(next.status, 201, next.text);
  assert.equal(next.body.shift.custodyGateReason, "AWAITING_CUSTODY_TRANSFER");
  assert.deepEqual(await openCustody(fx), before);
  const recount = await as<{ pendingShift: { pendingHandover: null } }>(fx.cashier.email, activeUrl);
  assert.equal(recount.body.pendingShift.pendingHandover, null, "only the outgoing user can read the returned draft");
});

test("concurrent retries carry a settled drawer into the new shift only once", async () => {
  const fx = await fixture();
  await db.cafeSettings.update({ where: { cafeId: fx.cafeId }, data: { stockCountPolicy: "NO_SHIFT_COUNT" } });
  const outgoing = await open(fx, fx.manager);
  assert.equal(outgoing.status, 201, outgoing.text);
  const closed = await post(fx.manager, `/api/shifts/${outgoing.body.shift.id}/close`, {
    actualCashAmount: 1000, drawerDisposition: "RETAIN_ALL",
  });
  assert.equal(closed.status, 200, closed.text);
  const results = await Promise.all([open(fx, fx.cashier, 100), open(fx, fx.cashier, 200)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 201], results.map((r) => r.text).join("\n"));
  const incoming = await db.shift.findUniqueOrThrow({ where: { id: results[0].body.shift.id } });
  assert.equal(incoming.openingCashAmount.toString(), "1000");
  assert.equal(incoming.id, results[1].body.shift.id);
  assert.equal(await db.auditLog.count({ where: { cafeId: fx.cafeId, action: "HANDOVER_DIRECT_CASH_OPENING" } }), 1);
});

test("an orphaned employee stock custody passes to the branch on the record, and the opener verifies it", async () => {
  const fx = await fixture();
  // Historical fixture: stock held by somebody with no open shift, and no drawer.
  const orphan = await db.custodyPeriod.create({ data: {
    cafeId: fx.cafeId, branchId: fx.branchId, scope: "STOCK",
    participants: { create: { userId: fx.manager.id, role: "PRIMARY" } },
  } });
  const opened = await open(fx, fx.cashier);
  assert.equal(opened.status, 201, opened.text);
  assert.equal(opened.body.shift.custodyGateReason, "AWAITING_OPENING_VERIFICATION");
  // Transferred, never rewritten: the holder stays on the closed period.
  const old = await db.custodyPeriod.findUniqueOrThrow({ where: { id: orphan.id }, include: { participants: true } });
  assert.equal(old.status, "TRANSFERRED");
  assert.equal(old.holderType, "USER");
  assert.deepEqual(old.participants.map((p) => p.userId), [fx.manager.id]);
  const successor = await db.custodyPeriod.findFirstOrThrow({ where: { previousPeriodId: orphan.id } });
  assert.equal(successor.holderType, "BRANCH");
  assert.equal(await db.auditLog.count({ where: { entityId: orphan.id, action: "SHIFT_CUSTODY_RECONCILED" } }), 1);
});

test("one-sided custody stays blocked and the personal shift stays empty", async () => {
  for (const scope of ["CASH"] as const) {
    const fx = await fixture();
    // Historical fixture only. The lifecycle regressions above use the HTTP writers.
    await db.custodyPeriod.create({ data: {
      cafeId: fx.cafeId, branchId: fx.branchId, scope,
      participants: { create: { userId: fx.manager.id, role: "PRIMARY" } },
    } });
    const before = await openCustody(fx);
    const blocker = { code: scope === "CASH" ? "CASH_WITHOUT_STOCK" : "STOCK_WITHOUT_CASH" } as const;
    const attempts = await Promise.all([open(fx, fx.cashier), open(fx, fx.cashier)]);
    for (const result of attempts) {
      assert.equal(result.status, 409, result.text);
      assert.deepEqual(JSON.parse(result.text).openingBlocker, blocker);
    }
    const active = await as(fx.cashier.email, `/api/shifts/active?branchId=${fx.branchId}`);
    assert.equal(active.status, 200, active.text);
    assert.equal(active.body.shift, null);
    assert.equal(active.body.pendingShift, null);
    assert.deepEqual(active.body.openingBlocker, blocker);
    const personal = await as<{ handovers: unknown[] }>(fx.cashier.email, `/api/handovers?branchId=${fx.branchId}`);
    assert.equal(personal.status, 200, personal.text);
    assert.deepEqual(personal.body.handovers, []);
    assert.equal(await db.shift.count({ where: { branchId: fx.branchId } }), 0);
    assert.equal(await db.openingCashReceipt.count({ where: { branchId: fx.branchId } }), 0);
    assert.deepEqual(await openCustody(fx), before);
  }
});

type ListedShift = {
  id: string;
  openedAt: string;
  openedBy: { id: string; name: string } | null;
  waitingFor: string[];
};

test("open-shift oversight preserves opening evidence, visibility, and retry safety", async () => {
  const fx = await fixture();
  const requests = await Promise.all([open(fx, fx.cashier), open(fx, fx.cashier, 2000)]);
  assert.deepEqual(requests.map((r) => r.status).sort(), [200, 201], requests.map((r) => r.text).join("\n"));
  const shiftId = requests[0].body.shift.id;
  assert.equal(requests[1].body.shift.id, shiftId);
  const first = await db.shift.findUniqueOrThrow({ where: { id: shiftId } });
  assert.equal(await db.shift.count({ where: { branchId: fx.branchId } }), 1);
  assert.equal(await db.shiftCustody.count({ where: { shiftId } }), 2);
  assert.equal(await db.custodyPeriod.count({ where: { branchId: fx.branchId } }), 2);
  assert.equal(await db.inventoryTransaction.count({ where: { branchId: fx.branchId } }), 0);
  const drawer = await db.custodyPeriod.findFirstOrThrow({ where: { branchId: fx.branchId, scope: "CASH" } });
  assert.equal(drawer.openingCashAmount?.toString(), first.openingCashAmount.toString());
  assert.equal(await db.auditLog.count({ where: { entityId: shiftId, action: "SHIFT_OPENED" } }), 1);

  const second = await open(fx, fx.manager);
  assert.equal(second.status, 201, second.text);
  const older = await db.shift.create({ data: {
    cafeId: fx.cafeId, branchId: fx.branchId, cashierId: fx.owner.id, shiftNumber: 3,
    custodyGateReason: "AWAITING_CUSTODY_TRANSFER",
  } });
  const query = `/api/shifts?status=OPEN&branchId=${fx.branchId}`;
  for (const viewer of [fx.manager, fx.owner]) {
    const listing = await as<{ shifts: ListedShift[] }>(viewer.email, query);
    assert.equal(listing.status, 200, listing.text);
    assert.equal(listing.body.shifts.length, 3);
    const byId = new Map(listing.body.shifts.map((s) => [s.id, s]));
    assert.deepEqual(byId.get(shiftId)?.openedBy, { id: fx.cashier.id, name: fx.cashier.name });
    assert.deepEqual(byId.get(second.body.shift.id)?.openedBy, { id: fx.manager.id, name: fx.manager.name });
    assert.equal(byId.get(shiftId)?.openedAt, first.openedAt.toISOString());
    assert.deepEqual(byId.get(shiftId)?.waitingFor, []);
    assert.equal(byId.get(older.id)?.openedBy, null);
    assert.deepEqual(byId.get(older.id)?.waitingFor, ["CUSTODY_TRANSFER"]);
    assert.deepEqual((await as<{ shifts: ListedShift[] }>(viewer.email, query)).body.shifts, listing.body.shifts);
  }
  const cashier = await as<{ shifts: ListedShift[] }>(fx.cashier.email, query);
  assert.deepEqual(cashier.body.shifts.map((s) => s.id), [shiftId]);
  const active = await as<{ shift: ListedShift }>(fx.cashier.email, `/api/shifts/active?branchId=${fx.branchId}`);
  assert.equal(active.body.shift.id, shiftId);
  assert.deepEqual(active.body.shift.openedBy, { id: fx.cashier.id, name: fx.cashier.name });
  const owner = await as<{ shift: null; pendingShift: ListedShift }>(fx.owner.email, `/api/shifts/active?branchId=${fx.branchId}`);
  assert.equal(owner.body.shift, null);
  assert.equal(owner.body.pendingShift.id, older.id);
  assert.equal(owner.body.pendingShift.openedBy, null);
  const annex = await as<{ shifts: ListedShift[] }>(fx.owner.email, `/api/shifts?status=OPEN&branchId=${fx.otherBranchId}`);
  assert.deepEqual(annex.body.shifts, []);
});

async function handoverReason(fx: CountCafe, code: string) {
  return db.reasonCode.create({ data: { cafeId: fx.cafeId, domain: "HANDOVER", code, label: code } });
}

test("manager approval finishes a night handover through branch custody, never as the receiver", async () => {
  const fx = await fixture();
  const outgoing = await open(fx, fx.manager);
  assert.equal(outgoing.status, 201, outgoing.text);
  const closed = await close(fx.manager, outgoing.body.shift.id, "BRANCH_CUSTODY");
  assert.equal(closed.status, 200, closed.text);
  const handoverId = closed.body.handover.handoverId;
  const started = await post<{ countSession: { id: string } }>(fx.manager, "/api/handovers", { action: "start_count", handoverId });
  assert.equal(started.status, 200, started.text);

  // An unfinished count is not the manager's to finish.
  const reason = await handoverReason(fx, "S1_APPROVE");
  const early = await post(fx.owner, `/api/handovers/${handoverId}/approve`, { reasonCodeId: reason.id, note: "Outgoing left" });
  assert.equal(early.status, 409, early.text);

  await countShelf(fx.manager, started.body.countSession.id);
  const approved = await post<{ path: string; submittedByManager: boolean }>(
    fx.owner, `/api/handovers/${handoverId}/approve`, { reasonCodeId: reason.id, note: "Outgoing left before submitting" },
  );
  assert.equal(approved.status, 200, approved.text);
  assert.equal(approved.body.path, "BRANCH_CUSTODY");
  assert.equal(approved.body.submittedByManager, true);
  const handover = await db.handoverSession.findUniqueOrThrow({ where: { id: handoverId } });
  assert.equal(handover.status, "COMPLETED");
  assert.equal(handover.resolvedTarget, "BRANCH_CUSTODY");
  assert.equal(handover.incomingUserId, null, "the approving manager is never recorded as the receiver");
  assert.equal(handover.acceptedStockCountSessionId, started.body.countSession.id);
  assert.ok((await db.handoverStockBoundary.count({ where: { handoverId, verified: true } })) > 0);
  const next = await open(fx, fx.cashier);
  assert.equal(next.status, 201, next.text);
  assert.equal(next.body.shift.custodyGateReason, "AWAITING_OPENING_VERIFICATION");

  // A retry replays rather than claiming a second acceptance.
  const again = await post<{ alreadyApproved: boolean }>(fx.owner, `/api/handovers/${handoverId}/approve`, { reasonCodeId: reason.id, note: "retry" });
  assert.equal(again.status, 200, again.text);
  assert.equal(again.body.alreadyApproved, true);
});

test("re-syncing the expected figure is refused on a handover count and for non-owners", async () => {
  const fx = await fixture();
  const outgoing = await open(fx, fx.manager);
  assert.equal(outgoing.status, 201, outgoing.text);
  const closed = await close(fx.manager, outgoing.body.shift.id, "BRANCH_CUSTODY");
  assert.equal(closed.status, 200, closed.text);
  const started = await post<{ countSession: { id: string } }>(fx.manager, "/api/handovers", { action: "start_count", handoverId: closed.body.handover.handoverId });
  assert.equal(started.status, 200, started.text);
  const url = `/api/stock-counts/${started.body.countSession.id}/re-sync`;
  assert.equal((await post(fx.manager, url, {})).status, 403);
  const owner = await post(fx.owner, url, {});
  assert.equal(owner.status, 409, owner.text);
  assert.equal(await db.auditLog.count({ where: { entityId: started.body.countSession.id, action: "STOCK_COUNT_RESYNCED" } }), 0);
});

test("an approved correction on a system-validated handover count no longer strands the handover", async () => {
  const fx = await fixture();
  const outgoing = await open(fx, fx.manager);
  assert.equal(outgoing.status, 201, outgoing.text);
  const closed = await close(fx.manager, outgoing.body.shift.id, "BRANCH_CUSTODY");
  assert.equal(closed.status, 200, closed.text);
  const handoverId = closed.body.handover.handoverId;
  const started = await post<{ countSession: { id: string } }>(fx.manager, "/api/handovers", { action: "start_count", handoverId });
  assert.equal(started.status, 200, started.text);
  const sessionId = started.body.countSession.id;
  await countShelf(fx.manager, sessionId);
  assert.equal((await db.stockCountSession.findUniqueOrThrow({ where: { id: sessionId } })).status, "CONFIRMED");

  const line = await db.stockCountLine.findFirstOrThrow({ where: { sessionId } });
  const stockReason = await db.reasonCode.create({ data: { cafeId: fx.cafeId, domain: "STOCK", code: "S1_FIX", label: "Miscount" } });
  const requested = await post<{ correctionId: string }>(fx.manager, `/api/stock-counts/${sessionId}/lines/${line.id}/correction`, {
    newCountedQuantity: 9, reasonCodeId: stockReason.id,
  });
  assert.equal(requested.status, 201, requested.text);
  const approved = await post(fx.owner, `/api/corrections/${requested.body.correctionId}/approve`, {});
  assert.equal(approved.status, 200, approved.text);

  // Before the fix every door answered 409 "دليل الجرد اتغير بعد تسجيله".
  const finished = await post<{ status: string; recordedDifferences: number }>(fx.manager, "/api/handovers", { action: "finish_outgoing", handoverId });
  assert.equal(finished.status, 200, finished.text);
  assert.equal(finished.body.status, "OUTGOING_SUBMITTED");
  assert.equal(finished.body.recordedDifferences, 1);
  assert.equal(await db.auditLog.count({ where: { entityId: sessionId, action: "COUNT_OUTGOING_DECLARED" } }), 1);
});
