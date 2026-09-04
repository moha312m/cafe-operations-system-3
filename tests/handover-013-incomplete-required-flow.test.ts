// HANDOVER-013 (SH-21 reachability) — reach the incomplete count the way a
// café would.
//
// WHY THIS SUITE EXISTS. SH-20 refuses an acceptance whose required set is
// incomplete; SH-21 lets a manager finish one on the record. Both were
// implemented, both were tested, and neither could be reached by any sequence
// of real actions. The count engine refused to submit a session carrying an
// uncounted line, so an incomplete handover count could not be submitted, so
// it could not be confirmed, so the handover could not be submitted, so the
// acceptance could not be requested. Every existing proof of SH-20's step-5
// refusal and SH-21's override opened the gap by DELETING a `StockCountLine`
// out from under the session — a corruption, and a corruption cannot stand in
// for a workflow.
//
// So this suite builds it the way the café does, and touches nothing directly.
// Twelve critical items are snapshotted at close. Somebody counts nine of
// them. Three shelves are never reached — the stockroom is locked, the boxes
// are behind a delivery, the shift ends. Then:
//
//   1. the count SUBMITS, and says three shelves were not reached
//   2. it CONFIRMS, freezing those three as unreached
//   3. the handover SUBMITS, naming all three in its closing position
//   4. the incoming custodian signs for the nine lines that exist
//   5. an ordinary accept is REFUSED — `REQUIRED_ITEMS_OMITTED`
//   6. and that refusal commits nothing at all
//   7. a manager overrides, on the record, and the handover completes
//
// Every step above goes through the HTTP route a café would use. The only
// direct database access in this file is READING, to assert what happened.
//
// WHAT THE OVERRIDE COSTS, and this is the part worth reading twice. It waives
// the REQUIREMENT TO COUNT. It does not manufacture a count. The three
// unreached items get `SYSTEM_CARRIED` / `verified: false` boundaries — the
// truthful statement that nobody looked — which open no variance case, start
// no span and name nobody. Not one figure is invented for them anywhere in
// the system.

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { db, tag, teardownTaggedCafe } from "./helpers/db";
import { countCafe, countItem, COUNT_PASSWORD, type CountCafe } from "./helpers/count";
import { as, login, requireServer } from "./helpers/http";

const MARKER = tag("HANDOVER013");

type CashCloseLib = typeof import("@/lib/cash-close");
const cashCloseLib = (): Promise<CashCloseLib> => import("@/lib/cash-close");
type CustodyLib = typeof import("@/lib/custody");
const custodyLib = (): Promise<CustodyLib> => import("@/lib/custody");

/** Both handover grants, so the close itself is never the thing refusing. */
const GRANTS_FULL = { handoverSubmit: true, handoverException: true };

let fx: CountCafe;

/**
 * Twelve critical items, so "9 counted, 3 not" is a statement about the shelf.
 *
 * All twelve stay ACTIVE throughout. Deactivating the three would drop them
 * from the boundary as well and would prove nothing about carried evidence.
 */
const ITEM_KEYS = [
  "one", "two", "three", "four", "five", "six",
  "seven", "eight", "nine", "ten", "eleven", "twelve",
] as const;
type ItemKey = (typeof ITEM_KEYS)[number];
const items: Record<ItemKey, { id: string; name: string }> = {} as never;

/** The three shelves nobody reaches. */
const UNREACHED: readonly ItemKey[] = ["ten", "eleven", "twelve"];
/** The one counted shelf that is genuinely short — SH-17 must still see it. */
const SHORT: ItemKey = "three";
const SHORT_BY = 3;

const unreachedIds = () => UNREACHED.map((k) => items[k].id).sort();
const observedIds = () =>
  ITEM_KEYS.filter((k) => !UNREACHED.includes(k)).map((k) => items[k].id).sort();

let incoming: { id: string; email: string };
let handoverReasonId: string;
let stockReasonId: string;

async function configureBranch() {
  await db.cafeSettings.update({
    where: { cafeId: fx.cafeId },
    data: {
      stockCountPolicy: "HYBRID",
      handoverCountType: "CRITICAL",
      periodicFullCountSchedule: "MANUAL_ONLY",
      periodicFullCountWeekday: null,
      varianceBlocksHandover: false,
      varianceHardBlockAmount: null,
      recountRequiredOutsideTolerance: false,
    },
  });
  await db.branch.update({
    where: { id: fx.branchId },
    data: {
      stockCountPolicyOverride: null,
      handoverCountTypeOverride: null,
      periodicFullCountScheduleOverride: null,
      periodicFullCountWeekdayOverride: null,
    },
  });
}

async function restoreItems() {
  for (const key of ITEM_KEYS) {
    await db.inventoryItem.update({
      where: { id: items[key].id },
      data: {
        unit: "KG", isCritical: true, isActive: true, archivedAt: null,
        currentStock: "10", costPerUnit: 450, name: items[key].name,
      },
    });
  }
}

/**
 * Empty the branch of everything a previous case created.
 *
 * Order is dictated by the schema's deliberate `Restrict` keys: evidence must
 * outlive the thing it describes, so acknowledgements and boundaries go before
 * lines, count sessions before the handovers that cite them, and handovers
 * before the custody periods naming who was answerable.
 */
async function resetBranch(branchId: string) {
  await db.handoverStockAcknowledgement.deleteMany({ where: { handover: { branchId } } });
  await db.handoverStockBoundary.deleteMany({ where: { handover: { branchId } } });
  await db.handoverRequiredItem.updateMany({
    where: { handover: { branchId } },
    data: { satisfiedByLineId: null },
  });
  await db.handoverSession.updateMany({
    where: { branchId },
    data: { stockCountSessionId: null, acceptedStockCountSessionId: null },
  });
  await db.shift.updateMany({ where: { branchId }, data: { cashVarianceCaseId: null } });
  await db.stockVarianceSpanCustody.deleteMany({
    where: { span: { varianceCase: { branchId } } },
  });
  await db.stockVarianceSpan.deleteMany({ where: { varianceCase: { branchId } } });
  await db.varianceCase.deleteMany({ where: { branchId } });
  await db.stockCountSession.updateMany({
    where: { branchId },
    data: { lockedByHandoverId: null, handoverId: null, accountabilityContext: "NONE" },
  });
  await db.stockCountRebase.deleteMany({ where: { session: { branchId } } });
  await db.stockCountSession.deleteMany({ where: { branchId } });
  await db.inventoryFreeze.deleteMany({ where: { branchId } });
  await db.openingException.deleteMany({ where: { branchId } });
  await db.handoverSession.deleteMany({ where: { branchId } });
  await db.tenderReconciliation.deleteMany({ where: { branchId } });
  await db.payment.deleteMany({ where: { branchId } });
  await db.inventoryTransaction.deleteMany({ where: { branchId } });
  await db.order.deleteMany({ where: { branchId } });
  await db.shiftCustody.deleteMany({ where: { shift: { branchId } } });
  await db.custodyParticipant.deleteMany({ where: { custodyPeriod: { branchId } } });
  await db.custodyPeriod.updateMany({ where: { branchId }, data: { previousPeriodId: null } });
  await db.custodyPeriod.deleteMany({ where: { branchId } });
  await db.shift.deleteMany({ where: { branchId } });
}

async function openOperationalShift(userId: string, openingCash = 100) {
  const last = await db.shift.aggregate({
    where: { branchId: fx.branchId }, _max: { shiftNumber: true },
  });
  const shift = await db.shift.create({
    data: {
      cafeId: fx.cafeId, branchId: fx.branchId, cashierId: userId,
      shiftNumber: (last._max.shiftNumber ?? 0) + 1,
      openingCashAmount: openingCash, expectedCashAmount: openingCash,
    },
  });
  const { ensureCustodyForShift } = await custodyLib();
  await db.$transaction((tx) =>
    ensureCustodyForShift(tx, {
      cafeId: fx.cafeId, branchId: fx.branchId, shiftId: shift.id,
      userId, openingCashAmount: openingCash,
    }),
  );
  return shift;
}

type Handover = {
  handoverId: string;
  shiftId: string;
  freezeId: string;
  requiredItemIds: string[];
  outgoingStockCustodyId: string | null;
};

/** A branch in exactly the state SH-16 leaves it. */
async function freshHandover(): Promise<Handover> {
  await resetBranch(fx.branchId);
  const shift = await openOperationalShift(fx.cashier.id);
  const { closeShiftWithSettlement } = await cashCloseLib();
  const closed = await closeShiftWithSettlement({
    shiftId: shift.id, actualCash: 100, actorId: fx.cashier.id,
    closedByManager: false, handoverTarget: "SHIFT_TO_SHIFT", grants: GRANTS_FULL,
  });
  if (!closed.handoverId || !closed.freezeId) {
    throw new Error(`close produced no handover (status ${closed.status})`);
  }
  const handover = await db.handoverSession.findUniqueOrThrow({
    where: { id: closed.handoverId },
    select: {
      outgoingStockCustodyId: true,
      requiredItems: { select: { inventoryItemId: true } },
    },
  });
  return {
    handoverId: closed.handoverId,
    shiftId: shift.id,
    freezeId: closed.freezeId,
    requiredItemIds: handover.requiredItems.map((r) => r.inventoryItemId),
    outgoingStockCustodyId: handover.outgoingStockCustodyId,
  };
}

// ───────────────────────────── HTTP drivers ──────────────────────────────
//
// Everything below is the route a café would call. No service is imported to
// drive the flow, and nothing writes to the database to construct a state.

const post = <T = Record<string, unknown>>(email: string, body: unknown) =>
  as<T>(email, "/api/handovers", { method: "POST", body: JSON.stringify(body) });

const startCountHttp = (handoverId: string) =>
  post<{ countSession: { id: string; reused: boolean } }>(
    fx.cashier.email, { action: "start_count", handoverId },
  );

const patchLine = (sessionId: string, lineId: string, countedQuantity: number) =>
  as<{ error?: string }>(fx.manager.email, `/api/stock-counts/${sessionId}/lines/${lineId}`, {
    method: "PATCH", body: JSON.stringify({ countedQuantity }),
  });

const submitCount = (sessionId: string) =>
  as<{ status?: string; within?: number; outside?: number; skippedUnobserved?: number; error?: string }>(
    fx.manager.email, `/api/stock-counts/${sessionId}/submit`, { method: "POST", body: "{}" },
  );

const acceptVariance = (sessionId: string, lineId: string) =>
  as<{ error?: string }>(
    fx.manager.email, `/api/stock-counts/${sessionId}/lines/${lineId}/accept-variance`,
    { method: "POST", body: JSON.stringify({ reasonCodeId: stockReasonId }) },
  );

const confirmCount = (sessionId: string, idempotencyKey: string) =>
  as<{ status?: string; error?: string }>(
    fx.manager.email, `/api/stock-counts/${sessionId}/confirm`,
    { method: "POST", body: JSON.stringify({ idempotencyKey }) },
  );

const submitHandoverHttp = (handoverId: string) =>
  post<{
    status?: string; error?: string;
    position?: { required: { total: number; satisfied: number; missingItemIds: string[]; unlinkedItemIds: string[] } };
  }>(fx.cashier.email, { action: "submit", handoverId });

const ackPost = (handoverId: string, stockCountLineId: string) =>
  as<{ decision?: string; error?: string }>(
    incoming.email, `/api/handovers/${handoverId}/acknowledge`,
    { method: "POST", body: JSON.stringify({ stockCountLineId }) },
  );

const acceptPost = (handoverId: string, idempotencyKey: string) =>
  as<{ status?: string; error?: string; requiredItems?: { satisfied: number; omitted: string[] } }>(
    incoming.email, `/api/handovers/${handoverId}/accept`,
    { method: "POST", body: JSON.stringify({ idempotencyKey }) },
  );

const overridePost = (handoverId: string, body: Record<string, unknown> = {}) =>
  as<{
    status?: string; openingExceptionId?: string; missingItemIds?: string[];
    requiredItems?: { satisfied: number; omitted: string[] };
    boundary?: { written: number; verified: number; carried: number };
    varianceCaseIds?: string[]; spanIds?: string[];
    outgoingShiftStatus?: string; alreadyAccepted?: boolean; error?: string;
  }>(
    fx.manager.email, `/api/handovers/${handoverId}/override-accept`,
    {
      method: "POST",
      body: JSON.stringify({
        idempotencyKey: `${MARKER}-ovr-${handoverId}`,
        reasonCodeId: handoverReasonId,
        note: "الجرد اتأخر — مخزن مقفول والفرع لازم يفتح",
        kind: "MANAGER_ADJUSTMENT",
        ...body,
      }),
    },
  );

// ────────────────────────── the café's own walk ──────────────────────────

/**
 * Count nine of the twelve shelves and leave three untouched.
 *
 * The three are not skipped by any special call — they are simply never
 * PATCHed, which is exactly what happens when nobody gets to that stockroom.
 */
async function countNineOfTwelve(sessionId: string) {
  const lines = await db.stockCountLine.findMany({
    where: { sessionId }, select: { id: true, inventoryItemId: true },
  });
  assert.equal(lines.length, 12, "the count opens one line per required item");

  const unreached = new Set(unreachedIds());
  const shortId = items[SHORT].id;
  for (const line of lines) {
    if (unreached.has(line.inventoryItemId)) continue;
    const figure = line.inventoryItemId === shortId ? 10 - SHORT_BY : 10;
    const r = await patchLine(sessionId, line.id, figure);
    assert.ok(r.status < 300, `capture failed: ${r.text}`);
  }
  return lines;
}

/** Settle whatever tolerance contested, and give every difference a reason. */
async function settleContested(sessionId: string) {
  const contested = await db.stockCountLine.findMany({
    where: { sessionId, disposition: { in: ["OUTSIDE_TOLERANCE", "RECOUNT_REQUIRED"] } },
    select: { id: true },
  });
  for (const line of contested) {
    const r = await acceptVariance(sessionId, line.id);
    assert.ok(r.status < 300, `accept-variance failed: ${r.text}`);
  }
  const forgiven = await db.stockCountLine.findMany({
    where: { sessionId, disposition: "WITHIN_TOLERANCE", reasonCodeId: null },
    select: { id: true, varianceQuantity: true },
  });
  for (const line of forgiven) {
    if (line.varianceQuantity === null || Number(line.varianceQuantity) === 0) continue;
    await db.stockCountLine.update({
      where: { id: line.id }, data: { reasonCodeId: stockReasonId },
    });
  }
}

/** Sign for every line that has a figure. The three gaps have none to sign. */
async function acknowledgeWhatExists(handoverId: string, sessionId: string) {
  const lines = await db.stockCountLine.findMany({
    where: { sessionId, countedQuantity: { not: null } },
    select: { id: true },
  });
  for (const line of lines) {
    const r = await ackPost(handoverId, line.id);
    assert.equal(r.status, 200, `acknowledge failed: ${r.text}`);
  }
  return lines.map((l) => l.id);
}

type Walked = Handover & { sessionId: string; incomingShiftId: string };

/**
 * The whole café-side walk, up to the moment somebody presses Accept.
 *
 * Twelve required, nine counted, three untouched, count submitted and
 * confirmed, handover submitted, incoming shift open and gated, every
 * existing line signed for.
 */
async function walkToTheAcceptance(): Promise<Walked> {
  const h = await freshHandover();
  assert.equal(h.requiredItemIds.length, 12, "twelve items were required at close");

  const started = await startCountHttp(h.handoverId);
  assert.equal(started.status, 200, started.text);
  const sessionId = started.body.countSession.id;

  await countNineOfTwelve(sessionId);

  const submitted = await submitCount(sessionId);
  assert.ok(submitted.status < 300, `count submit failed: ${submitted.text}`);
  assert.equal(submitted.body.skippedUnobserved, 3, "three shelves nobody reached");

  await settleContested(sessionId);

  const confirmed = await confirmCount(sessionId, `${MARKER}-${sessionId}`);
  assert.ok(confirmed.status < 300, `confirm failed: ${confirmed.text}`);

  const handoverSubmitted = await submitHandoverHttp(h.handoverId);
  assert.equal(handoverSubmitted.status, 200, handoverSubmitted.text);

  const incomingShift = await openOperationalShift(incoming.id);
  await acknowledgeWhatExists(h.handoverId, sessionId);

  return { ...h, sessionId, incomingShiftId: incomingShift.id };
}

/** Everything a refused acceptance must leave exactly as it found it. */
async function assertNothingCommitted(h: Walked) {
  const handover = await db.handoverSession.findUniqueOrThrow({
    where: { id: h.handoverId },
  });
  assert.equal(handover.status, "INCOMING_REVIEW", "the handover is where it was");
  assert.equal(handover.acceptedAt, null);
  assert.equal(handover.completedAt, null);
  assert.equal(handover.resolvedTarget, null);
  assert.equal(handover.acceptedStockCountSessionId, null);
  assert.equal(handover.incomingStockCustodyId, null);
  assert.equal(handover.incomingCashCustodyId, null);
  assert.equal(handover.exceptionById, null);
  assert.equal(handover.exceptionAt, null);

  const required = await db.handoverRequiredItem.findMany({
    where: { handoverId: h.handoverId },
  });
  assert.equal(required.length, 12);
  assert.ok(
    required.every((r) => r.omitted === false && r.omissionNote === null),
    "settlement derived omissions inside the transaction and they died with it",
  );
  assert.ok(
    required.every((r) => r.satisfiedByLineId === null),
    "and no satisfaction was committed either",
  );

  // The three gaps are still gaps, and nothing was written to them.
  const gaps = await db.stockCountLine.findMany({
    where: { sessionId: h.sessionId, inventoryItemId: { in: unreachedIds() } },
  });
  assert.equal(gaps.length, 3);
  for (const line of gaps) {
    assert.equal(line.disposition, "PENDING");
    assert.equal(line.countedQuantity, null);
    assert.equal(line.itemVersion, null);
    assert.equal(line.varianceQuantity, null);
  }

  assert.equal(
    await db.openingException.count({ where: { handoverId: h.handoverId } }), 0, "no exception",
  );
  assert.equal(
    await db.handoverStockBoundary.count({ where: { handoverId: h.handoverId } }), 0, "no boundary",
  );
  assert.equal(
    await db.stockCountRebase.count({ where: { sessionId: h.sessionId } }), 0, "no rebase",
  );
  assert.equal(
    await db.varianceCase.count({ where: { stockCountLine: { sessionId: h.sessionId } } }),
    0, "no variance case",
  );
  const session = await db.stockCountSession.findUniqueOrThrow({ where: { id: h.sessionId } });
  assert.equal(session.status, "CONFIRMED", "the count is not locked");
  assert.equal(session.lockedByHandoverId, null);

  const outgoing = await db.shift.findUniqueOrThrow({ where: { id: h.shiftId } });
  assert.equal(outgoing.status, "AWAITING_HANDOVER", "the outgoing shift is not stock-closed");
  const arriving = await db.shift.findUniqueOrThrow({ where: { id: h.incomingShiftId } });
  assert.equal(arriving.custodyGateReason, "AWAITING_CUSTODY_TRANSFER", "still gated");
  const freeze = await db.inventoryFreeze.findUniqueOrThrow({ where: { id: h.freezeId } });
  assert.equal(freeze.releasedAt, null, "the freeze is still on");

  for (const action of ["HANDOVER_ACCEPTED", "HANDOVER_MANAGER_EXCEPTION"]) {
    assert.equal(
      await db.auditLog.count({ where: { entityId: h.handoverId, action } }), 0,
      `no ${action} audit row`,
    );
  }
}

// ──────────────────────────────── fixture ────────────────────────────────

before(async () => {
  await requireServer();
  fx = await countCafe("HANDOVER013");

  for (const key of ITEM_KEYS) {
    const created = await countItem(fx, key, { stock: 10, isCritical: true });
    items[key] = { id: created.id, name: created.name };
  }

  const hash = await bcrypt.hash(COUNT_PASSWORD, 10);
  incoming = await db.user.create({
    data: {
      email: `${fx.marker.toLowerCase()}-incoming@example.invalid`,
      name: `${fx.marker}-incoming`, passwordHash: hash,
      role: "CASHIER", cafeId: fx.cafeId, branchId: fx.branchId,
    },
    select: { id: true, email: true },
  });
  await login(incoming.email, COUNT_PASSWORD);

  handoverReasonId = (await db.reasonCode.create({
    data: {
      cafeId: fx.cafeId, domain: "HANDOVER",
      code: `${MARKER}-HO`, label: "استثناء مدير",
    },
  })).id;
  stockReasonId = (await db.reasonCode.create({
    data: { cafeId: fx.cafeId, domain: "STOCK", code: `${MARKER}-ST`, label: "هالك" },
  })).id;
});

beforeEach(async () => {
  await configureBranch();
  await restoreItems();
});

after(async () => {
  await teardownTaggedCafe(fx?.cafeId, [
    () => resetBranch(fx.branchId),
    () => resetBranch(fx.otherBranchId),
  ], { disconnect: true });
});

// ═════════════════ the walk itself, and what it produced ═════════════════

describe("HANDOVER-013 twelve items, nine counted, three nobody reached", () => {
  test("the whole flow reaches the acceptance through routes alone", async () => {
    const h = await walkToTheAcceptance();

    // 1. Twelve lines exist throughout. Nothing was deleted to make the gap.
    const lines = await db.stockCountLine.findMany({
      where: { sessionId: h.sessionId },
      select: { id: true, inventoryItemId: true, disposition: true, countedQuantity: true },
    });
    assert.equal(lines.length, 12, "twelve lines, start to finish");

    // 2. Three of them are frozen as unobserved.
    const gaps = lines.filter((l) => unreachedIds().includes(l.inventoryItemId));
    assert.equal(gaps.length, 3);
    for (const line of gaps) {
      assert.equal(line.disposition, "PENDING", "in scope, and nobody reached it");
      assert.equal(line.countedQuantity, null, "a NULL is not a zero");
    }
    // And nine carry a real figure.
    assert.equal(lines.filter((l) => l.countedQuantity !== null).length, 9);

    const session = await db.stockCountSession.findUniqueOrThrow({ where: { id: h.sessionId } });
    assert.equal(session.status, "CONFIRMED");
    assert.equal(session.accountabilityContext, "HANDOVER");
    assert.equal(session.handoverId, h.handoverId);

    const handover = await db.handoverSession.findUniqueOrThrow({ where: { id: h.handoverId } });
    assert.equal(handover.status, "INCOMING_REVIEW");

    // Only the nine that exist were signed for; the gaps needed no signature
    // because there is nothing to sign.
    assert.equal(
      await db.handoverStockAcknowledgement.count({ where: { handoverId: h.handoverId } }), 9,
    );
  });

  test("the submitted position names the gap without refusing it", async () => {
    // Re-walked at the submit step so the response body can be read.
    const h = await freshHandover();
    const started = await startCountHttp(h.handoverId);
    assert.equal(started.status, 200, started.text);
    await countNineOfTwelve(started.body.countSession.id);
    assert.ok((await submitCount(started.body.countSession.id)).status < 300);
    await settleContested(started.body.countSession.id);
    assert.ok((await confirmCount(started.body.countSession.id, `${MARKER}-p`)).status < 300);

    const r = await submitHandoverHttp(h.handoverId);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.status, "OUTGOING_SUBMITTED");
    const required = r.body.position!.required;
    assert.equal(required.total, 12);
    assert.equal(required.satisfied, 9);
    assert.deepEqual(
      [...required.missingItemIds].sort(), unreachedIds(),
      "the outgoing hand states exactly which three shelves were not reached",
    );
    assert.deepEqual(required.unlinkedItemIds, [], "and every required item has a line");
  });
});

describe("HANDOVER-013 the ordinary acceptance refuses, and commits nothing", () => {
  test("a normal accept is 409 REQUIRED_ITEMS_OMITTED", async () => {
    const h = await walkToTheAcceptance();

    const r = await acceptPost(h.handoverId, `${MARKER}-acc-${h.handoverId}`);
    assert.equal(r.status, 409, `expected the SH-20 refusal, got ${r.status}: ${r.text}`);
    assert.match(r.body.error ?? "", /ماتعدّتش/);

    // The refusal is a throw inside the acceptance transaction, so the
    // `omitted: true` rows settlement wrote moments earlier never commit.
    await assertNothingCommitted(h);
  });

  test("a refused accept can be repeated, and still commits nothing", async () => {
    const h = await walkToTheAcceptance();
    for (const n of [1, 2, 3]) {
      const r = await acceptPost(h.handoverId, `${MARKER}-acc-${h.handoverId}-${n}`);
      assert.equal(r.status, 409, r.text);
    }
    await assertNothingCommitted(h);
  });
});

describe("HANDOVER-013 the manager finishes it, and the record says what was skipped", () => {
  test("the override completes the handover and names the three", async () => {
    const h = await walkToTheAcceptance();
    assert.equal((await acceptPost(h.handoverId, `${MARKER}-pre-${h.handoverId}`)).status, 409);

    const r = await overridePost(h.handoverId);
    assert.equal(r.status, 200, `override failed: ${r.text}`);
    assert.equal(r.body.status, "COMPLETED");
    assert.deepEqual(
      [...(r.body.missingItemIds ?? [])].sort(), unreachedIds(),
      "the result names exactly the shelves nobody reached",
    );
    assert.equal(r.body.requiredItems?.satisfied, 9);
    assert.equal(r.body.requiredItems?.omitted.length, 3);
    assert.equal(r.body.outgoingShiftStatus, "CLOSED");

    const handover = await db.handoverSession.findUniqueOrThrow({ where: { id: h.handoverId } });
    assert.equal(handover.status, "COMPLETED");
    assert.equal(handover.resolvedTarget, "SHIFT_TO_SHIFT");
    assert.equal(handover.acceptedStockCountSessionId, h.sessionId);
    // Two people: the manager authorised, the arriving cashier received.
    assert.equal(handover.exceptionById, fx.manager.id);
    assert.equal(handover.incomingUserId, incoming.id);
    assert.ok(handover.exceptionAt !== null);
  });

  test("the three omissions are committed exactly once, with the manager's note", async () => {
    const h = await walkToTheAcceptance();
    assert.equal((await overridePost(h.handoverId)).status, 200);

    const required = await db.handoverRequiredItem.findMany({
      where: { handoverId: h.handoverId }, orderBy: { inventoryItemId: "asc" },
    });
    assert.equal(required.length, 12);

    const omitted = required.filter((r) => r.omitted);
    assert.deepEqual(
      omitted.map((r) => r.inventoryItemId).sort(), unreachedIds(),
      "exactly the three, and no others",
    );
    for (const row of omitted) {
      assert.equal(row.satisfiedByLineId, null, "an omission cites no evidence");
      assert.equal(row.omissionNote, "الجرد اتأخر — مخزن مقفول والفرع لازم يفتح");
    }

    const satisfied = required.filter((r) => !r.omitted);
    assert.equal(satisfied.length, 9);
    for (const row of satisfied) {
      assert.ok(row.satisfiedByLineId, "a satisfied item cites the line that observed it");
      assert.equal(row.omissionNote, null, "and carries no note");
    }
  });

  test("the three get carried, unverified boundaries — never a fabricated zero", async () => {
    const h = await walkToTheAcceptance();
    const r = await overridePost(h.handoverId);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.boundary, { written: 12, verified: 9, carried: 3 });

    const boundaries = await db.handoverStockBoundary.findMany({
      where: { handoverId: h.handoverId },
    });
    assert.equal(boundaries.length, 12, "one row per active item, counted or not");

    for (const id of unreachedIds()) {
      const row = boundaries.find((b) => b.inventoryItemId === id)!;
      assert.equal(row.source, "SYSTEM_CARRIED", "nobody looked at this shelf");
      assert.equal(row.verified, false, "and the record says so");
      assert.equal(row.stockCountLineId, null, "citing no evidence, because there is none");
      assert.equal(
        Number(row.quantity), 10,
        "the book figure carried forward — not 0, which would say the shelf was empty",
      );
      const item = await db.inventoryItem.findUniqueOrThrow({ where: { id } });
      assert.equal(
        row.itemVersion, item.ledgerVersion,
        "quantity and cursor come from one locked read, so they describe one instant",
      );
      assert.equal(Number(row.quantity), Number(item.currentStock));
      assert.equal(Number(row.unitCostSnapshot), 450);
    }

    for (const id of observedIds()) {
      const row = boundaries.find((b) => b.inventoryItemId === id)!;
      assert.equal(row.source, "PHYSICAL_COUNT");
      assert.equal(row.verified, true);
      assert.ok(row.stockCountLineId, "an observed boundary cites the line that observed it");
    }
  });

  test("nothing rebases, accuses or costs the three", async () => {
    const h = await walkToTheAcceptance();
    assert.equal((await overridePost(h.handoverId)).status, 200);

    const gapLines = await db.stockCountLine.findMany({
      where: { sessionId: h.sessionId, inventoryItemId: { in: unreachedIds() } },
      select: { id: true },
    });
    const gapLineIds = gapLines.map((l) => l.id);
    assert.equal(gapLineIds.length, 3);

    assert.equal(
      await db.stockCountRebase.count({ where: { lineId: { in: gapLineIds } } }), 0,
      "no rebase: there is no figure to move the shelf to",
    );
    assert.equal(
      await db.varianceCase.count({ where: { stockCountLineId: { in: gapLineIds } } }), 0,
      "no case",
    );
    assert.equal(
      await db.stockVarianceSpan.count({
        where: { inventoryItemId: { in: unreachedIds() } },
      }),
      0, "no span",
    );
    // The shelves themselves are untouched: the override moved no stock.
    for (const id of unreachedIds()) {
      const item = await db.inventoryItem.findUniqueOrThrow({ where: { id } });
      assert.equal(Number(item.currentStock), 10, "an unreached shelf is not rebased");
    }
    // And the lines are still exactly what the count left.
    const after = await db.stockCountLine.findMany({ where: { id: { in: gapLineIds } } });
    for (const line of after) {
      assert.equal(line.disposition, "PENDING");
      assert.equal(line.countedQuantity, null);
      assert.equal(line.effectiveCountedQuantity, null);
      assert.equal(line.varianceQuantity, null);
      assert.equal(line.itemVersion, null);
      assert.equal(line.costImpact, null);
      assert.equal(line.unitCostSnapshot, null);
    }
  });

  test("the nine that were counted keep SH-17 behaviour exactly", async () => {
    const h = await walkToTheAcceptance();
    const r = await overridePost(h.handoverId);
    assert.equal(r.status, 200, r.text);

    // One genuine shortage among the nine, and it is recorded as one — with
    // an attribution and the outgoing custody it belongs to.
    const shortLine = await db.stockCountLine.findFirstOrThrow({
      where: { sessionId: h.sessionId, inventoryItemId: items[SHORT].id },
    });
    assert.equal(Number(shortLine.varianceQuantity), -SHORT_BY);
    const shortCase = await db.varianceCase.findUniqueOrThrow({
      where: { stockCountLineId: shortLine.id },
    });
    assert.equal(Number(shortCase.quantityVariance), -SHORT_BY);
    assert.equal(shortCase.acceptedHandoverId, h.handoverId);
    assert.ok(shortCase.attribution !== null, "SH-17 gave it a verdict");
    assert.deepEqual(r.body.varianceCaseIds, [shortCase.id], "one difference, one case");

    // The eight that matched the book open nothing.
    assert.equal(
      await db.varianceCase.count({ where: { stockCountLine: { sessionId: h.sessionId } } }), 1,
    );

    // The nine were rebased; the shelf now matches what somebody counted.
    const rebased = await db.stockCountRebase.findMany({
      where: { sessionId: h.sessionId }, select: { lineId: true },
    });
    assert.equal(rebased.length, 9, "one rebase per observation, and nine observations");
    const shortItem = await db.inventoryItem.findUniqueOrThrow({ where: { id: items[SHORT].id } });
    assert.equal(Number(shortItem.currentStock), 10 - SHORT_BY);

    // The accepted evidence is immutable now.
    const session = await db.stockCountSession.findUniqueOrThrow({ where: { id: h.sessionId } });
    assert.equal(session.status, "LOCKED");
    assert.equal(session.lockedByHandoverId, h.handoverId);
  });

  test("the exception, the audit and the idempotency are all still SH-21's", async () => {
    const h = await walkToTheAcceptance();
    const first = await overridePost(h.handoverId);
    assert.equal(first.status, 200, first.text);

    // Exactly one OpeningException, authorised by the manager.
    const exceptions = await db.openingException.findMany({
      where: { handoverId: h.handoverId },
    });
    assert.equal(exceptions.length, 1, "exactly once");
    assert.equal(exceptions[0].id, first.body.openingExceptionId);
    assert.equal(exceptions[0].kind, "MANAGER_ADJUSTMENT");
    assert.equal(exceptions[0].authorizedById, fx.manager.id);
    assert.equal(exceptions[0].reasonCodeId, handoverReasonId);
    assert.equal(exceptions[0].note, "الجرد اتأخر — مخزن مقفول والفرع لازم يفتح");

    // Both audit rows, with the right actor on each.
    const manager = await db.auditLog.findFirstOrThrow({
      where: { entityId: h.handoverId, action: "HANDOVER_MANAGER_EXCEPTION" },
    });
    assert.equal(manager.userId, fx.manager.id, "the manager authorised");
    const accepted = await db.auditLog.findFirstOrThrow({
      where: { entityId: h.handoverId, action: "HANDOVER_ACCEPTED" },
    });
    assert.equal(accepted.userId, incoming.id, "the arriving custodian received");

    // A retry under the same key returns the same answer and creates nothing.
    const repeat = await overridePost(h.handoverId);
    assert.equal(repeat.status, 200, repeat.text);
    assert.equal(repeat.body.alreadyAccepted, true);
    assert.equal(repeat.body.openingExceptionId, exceptions[0].id);
    assert.deepEqual([...(repeat.body.missingItemIds ?? [])].sort(), unreachedIds());
    assert.equal(await db.openingException.count({ where: { handoverId: h.handoverId } }), 1);
    assert.equal(
      await db.varianceCase.count({ where: { stockCountLine: { sessionId: h.sessionId } } }), 1,
      "and the shortage is still one investigation, not two",
    );
    assert.equal(await db.stockCountRebase.count({ where: { sessionId: h.sessionId } }), 9);
    const required = await db.handoverRequiredItem.findMany({
      where: { handoverId: h.handoverId, omitted: true },
    });
    assert.equal(required.length, 3, "the omission committed exactly once");
  });

  test("custody moved to the arriving cashier and the freeze was released", async () => {
    const h = await walkToTheAcceptance();
    assert.equal((await overridePost(h.handoverId)).status, 200);

    const handover = await db.handoverSession.findUniqueOrThrow({ where: { id: h.handoverId } });
    assert.ok(handover.incomingStockCustodyId, "stock custody moved");
    assert.ok(handover.incomingCashCustodyId, "cash custody moved");
    assert.notEqual(handover.incomingStockCustodyId, h.outgoingStockCustodyId);

    const arriving = await db.shift.findUniqueOrThrow({ where: { id: h.incomingShiftId } });
    assert.equal(arriving.custodyGateReason, null, "the arriving shift is operational");
    const outgoing = await db.shift.findUniqueOrThrow({ where: { id: h.shiftId } });
    assert.equal(outgoing.status, "CLOSED");
    assert.ok(outgoing.stockClosedAt !== null);
    assert.equal(outgoing.closedById, incoming.id, "the custodian closed it, not the manager");

    const freeze = await db.inventoryFreeze.findUniqueOrThrow({ where: { id: h.freezeId } });
    assert.ok(freeze.releasedAt !== null, "the freeze is lifted");
  });
});
