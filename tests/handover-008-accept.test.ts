// HANDOVER-008 — SH-20: the accepted evidence becomes the record.
//
// Acceptance is the milestone's second centre of gravity, and it is one
// transaction from the handover's row lock to the freeze release. A partial
// accept — stock rebased but custody not transferred, a boundary written but
// the arriving shift left gated — would leave the branch in a state no later
// operation could read, so every proof here is about the whole act rather
// than any step of it.
//
// What this suite pins, in the order the transaction performs it:
//
//   * THE GATE. Acceptance is judged against the count in front of it. An
//     acknowledgement belonging to a session a recount superseded can neither
//     satisfy a line of the current session nor block on a stale dispute — the
//     predicate is `line: { sessionId: acceptedSessionId }`, never a count of
//     acknowledgements against a count of lines.
//
//   * THE ORDER. `settleRequiredItems` refuses to write once
//     `acceptedStockCountSessionId` is set, so that column is resolved at step
//     4 and PERSISTED at step 14. Any implementation that persisted it early
//     would throw "final required-item settlement is immutable" on every first
//     acceptance.
//
//   * THE FREEZE. The rebase runs under the freeze that protected the count,
//     with the handover's own token. The freeze is released at step 15, in the
//     same commit — never earlier to make the rebase pass.
//
//   * THE BOUNDARY. One row per active item, counted or carried, and a carried
//     row names nobody.
//
// The rollback and concurrency matrices live in the sibling
// `handover-008b-accept-rollback.test.ts`. The split is by kind of proof, not
// by contract: every contract the roadmap names is pinned here.

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { db, tag, teardownTaggedCafe } from "./helpers/db";
import { countCafe, countItem, COUNT_PASSWORD, type CountCafe } from "./helpers/count";
import { as, login, requireServer } from "./helpers/http";

const MARKER = tag("HANDOVER008");

type HandoverLib = typeof import("@/lib/handover");
const handoverLib = (): Promise<HandoverLib> => import("@/lib/handover");
type CashCloseLib = typeof import("@/lib/cash-close");
const cashCloseLib = (): Promise<CashCloseLib> => import("@/lib/cash-close");
type CustodyLib = typeof import("@/lib/custody");
const custodyLib = (): Promise<CustodyLib> => import("@/lib/custody");

/** Both handover grants, so the close itself is never the thing refusing. */
const GRANTS_FULL = { handoverSubmit: true, handoverException: true };

let fx: CountCafe;
/** A second tenant. Nothing in it may ever be reachable from the first. */
let other: CountCafe;

const ITEM_KEYS = ["alpha", "bravo", "charlie"] as const;
type ItemKey = (typeof ITEM_KEYS)[number];
const items: Record<ItemKey, { id: string; name: string }> = {} as never;

/** The arriving custodian, who accepts. */
let incoming: { id: string; email: string };
/** A cashier of the annex, for cross-branch refusals. */
let annexIncoming: { id: string; email: string };
let otherHandoverId: string;

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
  // Items a case added to the branch are removed rather than left to widen
  // the next case's count scope.
  await db.inventoryItem.deleteMany({
    where: { branchId: fx.branchId, name: { startsWith: `${fx.marker} extra` } },
  });
}

/**
 * Empty the branch of everything a previous case created.
 *
 * Order is dictated by the schema's deliberate `Restrict` keys: evidence must
 * outlive the thing it describes, so acknowledgements and boundaries go
 * before lines, count sessions before the handovers that cite them, and
 * handovers before the custody periods naming who was answerable.
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

async function openOperationalShift(
  cafeId: string, branchId: string, userId: string, openingCash = 100,
) {
  const last = await db.shift.aggregate({
    where: { branchId }, _max: { shiftNumber: true },
  });
  const shift = await db.shift.create({
    data: {
      cafeId, branchId, cashierId: userId,
      shiftNumber: (last._max.shiftNumber ?? 0) + 1,
      openingCashAmount: openingCash, expectedCashAmount: openingCash,
    },
  });
  const { ensureCustodyForShift } = await custodyLib();
  await db.$transaction((tx) =>
    ensureCustodyForShift(tx, {
      cafeId, branchId, shiftId: shift.id, userId, openingCashAmount: openingCash,
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
  outgoingCashCustodyId: string | null;
};

/**
 * A branch in exactly the state SH-16 leaves it: shift AWAITING_HANDOVER with
 * `financiallyClosedAt` set and `stockClosedAt` still null, an open freeze
 * naming the handover, and a DRAFT handover carrying its snapshot.
 */
async function freshHandover(
  cafe: CountCafe = fx,
  branchId: string = fx.branchId,
  target: "SHIFT_TO_SHIFT" | "BRANCH_CUSTODY" = "SHIFT_TO_SHIFT",
): Promise<Handover> {
  await resetBranch(branchId);
  const shift = await openOperationalShift(cafe.cafeId, branchId, cafe.cashier.id);
  const { closeShiftWithSettlement } = await cashCloseLib();
  const closed = await closeShiftWithSettlement({
    shiftId: shift.id, actualCash: 100, actorId: cafe.cashier.id,
    closedByManager: false, handoverTarget: target, grants: GRANTS_FULL,
  });
  if (!closed.handoverId || !closed.freezeId) {
    throw new Error(
      `close produced no handover (status ${closed.status}, issue ${JSON.stringify(closed.handoverConfigIssue)})`,
    );
  }
  const handover = await db.handoverSession.findUniqueOrThrow({
    where: { id: closed.handoverId },
    select: {
      outgoingStockCustodyId: true, outgoingCashCustodyId: true,
      requiredItems: { select: { inventoryItemId: true }, orderBy: { itemNameSnapshot: "asc" } },
    },
  });
  return {
    handoverId: closed.handoverId,
    shiftId: shift.id,
    freezeId: closed.freezeId,
    requiredItemIds: handover.requiredItems.map((r) => r.inventoryItemId),
    outgoingStockCustodyId: handover.outgoingStockCustodyId,
    outgoingCashCustodyId: handover.outgoingCashCustodyId,
  };
}

// ───────────────────────────── HTTP drivers ──────────────────────────────

const post = <T = Record<string, unknown>>(email: string, body: unknown) =>
  as<T>(email, "/api/handovers", { method: "POST", body: JSON.stringify(body) });

const startCountHttp = (handoverId: string, email: string = fx.cashier.email) =>
  post<{ countSession: { id: string; reused: boolean } }>(
    email, { action: "start_count", handoverId },
  );

const patchLine = (email: string, sessionId: string, lineId: string, countedQuantity: number) =>
  as<{ error?: string }>(email, `/api/stock-counts/${sessionId}/lines/${lineId}`, {
    method: "PATCH", body: JSON.stringify({ countedQuantity }),
  });

const submitCount = (email: string, sessionId: string) =>
  as<{ error?: string }>(email, `/api/stock-counts/${sessionId}/submit`, {
    method: "POST", body: "{}",
  });

const acceptVariance = (email: string, sessionId: string, lineId: string, reasonCodeId: string) =>
  as<{ error?: string }>(
    email, `/api/stock-counts/${sessionId}/lines/${lineId}/accept-variance`,
    { method: "POST", body: JSON.stringify({ reasonCodeId }) },
  );

const confirmCount = (email: string, sessionId: string, idempotencyKey: string) =>
  as<{ status?: string; error?: string }>(email, `/api/stock-counts/${sessionId}/confirm`, {
    method: "POST", body: JSON.stringify({ idempotencyKey }),
  });

const submitHandoverHttp = (handoverId: string, email: string = fx.cashier.email) =>
  post<{ status?: string; error?: string }>(email, { action: "submit", handoverId });

const ackPost = (email: string, handoverId: string, body: unknown) =>
  as<{ decision?: string; error?: string }>(
    email, `/api/handovers/${handoverId}/acknowledge`,
    { method: "POST", body: JSON.stringify(body) },
  );

const recountPost = (email: string, handoverId: string, body: unknown) =>
  as<{ supersededSessionId?: string; error?: string }>(
    email, `/api/handovers/${handoverId}/request-recount`,
    { method: "POST", body: JSON.stringify(body) },
  );

// ────────────────────────── count / review walks ─────────────────────────

/**
 * Capture, submit, settle and confirm a session through the real routes, in
 * the one order the disposition state machine permits.
 *
 * `counted` maps item id to figure; anything unnamed is counted exactly at 10.
 */
async function walkTheCount(sessionId: string, counted: Record<string, number> = {}) {
  const lines = await db.stockCountLine.findMany({
    where: { sessionId }, select: { id: true, inventoryItemId: true },
  });
  for (const line of lines) {
    const figure = counted[line.inventoryItemId] ?? 10;
    const r = await patchLine(fx.manager.email, sessionId, line.id, figure);
    assert.ok(r.status < 300, `capture failed: ${r.text}`);
  }
  const submitted = await submitCount(fx.manager.email, sessionId);
  assert.ok(submitted.status < 300, `count submit failed: ${submitted.text}`);

  const unsettled = await db.stockCountLine.findMany({
    where: { sessionId, disposition: { in: ["OUTSIDE_TOLERANCE", "RECOUNT_REQUIRED"] } },
    select: { id: true },
  });
  for (const line of unsettled) {
    const r = await acceptVariance(fx.manager.email, sessionId, line.id, stockReasonId);
    assert.ok(r.status < 300, `accept-variance failed: ${r.text}`);
  }
  return lines.map((l) => l.id);
}

/** A confirmed, bound count and a handover at OUTGOING_SUBMITTED. */
async function reviewedHandover(counted: Record<string, number> = {}) {
  const h = await freshHandover();
  const started = await startCountHttp(h.handoverId);
  assert.equal(started.status, 200, started.text);
  const sessionId = started.body.countSession.id;
  await walkTheCount(sessionId, counted);
  const confirmed = await confirmCount(fx.manager.email, sessionId, `${MARKER}-${sessionId}`);
  assert.ok(confirmed.status < 300, `confirm failed: ${confirmed.text}`);
  const submitted = await submitHandoverHttp(h.handoverId);
  assert.equal(submitted.status, 200, submitted.text);
  return { ...h, sessionId };
}

/** The arriving cashier's shift: OPEN, holding nothing, and gated. */
async function openIncomingShift() {
  const shift = await openOperationalShift(fx.cafeId, fx.branchId, incoming.id);
  const row = await db.shift.findUniqueOrThrow({ where: { id: shift.id } });
  assert.equal(
    row.custodyGateReason, "AWAITING_CUSTODY_TRANSFER",
    "the arriving shift holds nothing until acceptance moves custody",
  );
  return shift;
}

/** Sign for every counted line of a session, with no spot count. */
async function acknowledgeAll(handoverId: string, sessionId: string) {
  const lines = await db.stockCountLine.findMany({
    where: { sessionId, countedQuantity: { not: null } },
    select: { id: true },
  });
  for (const line of lines) {
    const r = await ackPost(incoming.email, handoverId, { stockCountLineId: line.id });
    assert.equal(r.status, 200, `acknowledge failed: ${r.text}`);
  }
  return lines.map((l) => l.id);
}

/** A handover ready for an ordinary acceptance, with its arriving shift. */
async function acceptableHandover(counted: Record<string, number> = {}) {
  const h = await reviewedHandover(counted);
  const incomingShift = await openIncomingShift();
  const lineIds = await acknowledgeAll(h.handoverId, h.sessionId);
  return { ...h, incomingShiftId: incomingShift.id, lineIds };
}

// ─────────────────────────────── service call ────────────────────────────

type AcceptOverrides = Partial<{
  incomingUserId: string;
  incomingShiftId: string | null;
  idempotencyKey: string;
  cafeId: string;
  viewerBranchId: string | null;
}>;

async function accept(handoverId: string, overrides: AcceptOverrides = {}) {
  const { acceptHandover } = await handoverLib();
  return acceptHandover({
    handoverId,
    incomingUserId: overrides.incomingUserId ?? incoming.id,
    incomingShiftId: overrides.incomingShiftId,
    idempotencyKey: overrides.idempotencyKey ?? `${MARKER}-${handoverId}-${Math.random()}`,
    cafeId: overrides.cafeId ?? fx.cafeId,
    viewerBranchId:
      overrides.viewerBranchId === undefined ? fx.branchId : overrides.viewerBranchId,
  });
}

const statusIs = (status: number) => (error: unknown) =>
  (error as { status?: number }).status === status;

// ──────────────────────────────── fixture ────────────────────────────────

before(async () => {
  await requireServer();
  fx = await countCafe("HANDOVER008");
  other = await countCafe("HANDOVER008X");

  for (const key of ITEM_KEYS) {
    const created = await countItem(fx, key, { stock: 10, isCritical: true });
    items[key] = { id: created.id, name: created.name };
  }
  await countItem(fx, "annex", { stock: 8, isCritical: true, branchId: fx.otherBranchId });

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

  annexIncoming = await db.user.create({
    data: {
      email: `${fx.marker.toLowerCase()}-annex@example.invalid`,
      name: `${fx.marker}-annex`, passwordHash: hash,
      role: "CASHIER", cafeId: fx.cafeId, branchId: fx.otherBranchId,
    },
    select: { id: true, email: true },
  });
  await login(annexIncoming.email, COUNT_PASSWORD);

  handoverReasonId = (await db.reasonCode.create({
    data: {
      cafeId: fx.cafeId, domain: "HANDOVER",
      code: `${MARKER}-HO`, label: "خلاف على الجرد",
    },
  })).id;
  stockReasonId = (await db.reasonCode.create({
    data: { cafeId: fx.cafeId, domain: "STOCK", code: `${MARKER}-ST`, label: "هالك" },
  })).id;

  // The foreign tenant needs a live handover of its own, so a cross-café
  // refusal is about tenancy rather than about an id that matches nothing.
  await countItem(other, "foreign", { stock: 4, isCritical: true });
  await db.cafeSettings.update({
    where: { cafeId: other.cafeId },
    data: {
      stockCountPolicy: "HYBRID", handoverCountType: "CRITICAL",
      periodicFullCountSchedule: "MANUAL_ONLY", periodicFullCountWeekday: null,
    },
  });
  otherHandoverId = (await freshHandover(other, other.branchId)).handoverId;
});

beforeEach(async () => {
  await configureBranch();
  await restoreItems();
});

after(async () => {
  // The branch resets run FIRST, as teardown steps: `purgeCafe` cannot remove
  // a custody period a live handover cites, and `CustodyParticipant` carries
  // no `cafeId` for it to reach.
  await teardownTaggedCafe(
    [fx?.cafeId, other?.cafeId].filter((id): id is string => Boolean(id)),
    [
      () => resetBranch(fx.branchId),
      () => resetBranch(fx.otherBranchId),
      () => resetBranch(other.branchId),
      () => resetBranch(other.otherBranchId),
    ],
    { disconnect: true },
  );
});

// ═════════════════════════ T3 · the acceptance gate ══════════════════════

describe("SH-20 acceptance gate", () => {
  test("another café's handover does not confirm it exists", async () => {
    await assert.rejects(
      () => accept(otherHandoverId, { cafeId: fx.cafeId, viewerBranchId: fx.branchId }),
      statusIs(404),
      "a 403 here would tell one café that another's id is real",
    );
  });

  test("another branch's handover is refused, and says so", async () => {
    const h = await acceptableHandover();
    await assert.rejects(
      () => accept(h.handoverId, { viewerBranchId: fx.otherBranchId }),
      statusIs(403),
    );
  });

  test("a handover that is not in review cannot be accepted", async () => {
    const h = await freshHandover();
    await assert.rejects(() => accept(h.handoverId), statusIs(409), "DRAFT is too early");
  });

  test("an ordinary accept refuses a BRANCH_CUSTODY target", async () => {
    // SH-22 owns branch acceptance, including the branch-held successor and
    // the opening verification that discharges it. Ordinary acceptance must
    // not construct either, so it refuses the target outright rather than
    // quietly treating it as a shift-to-shift.
    const h = await freshHandover(fx, fx.branchId, "BRANCH_CUSTODY");
    const started = await startCountHttp(h.handoverId);
    assert.equal(started.status, 200, started.text);
    await walkTheCount(started.body.countSession.id);
    await confirmCount(fx.manager.email, started.body.countSession.id, `${MARKER}-branch`);
    await submitHandoverHttp(h.handoverId);

    await assert.rejects(() => accept(h.handoverId), statusIs(409));

    const after = await db.handoverSession.findUniqueOrThrow({
      where: { id: h.handoverId },
      select: { target: true, resolvedTarget: true, status: true },
    });
    assert.equal(after.target, "BRANCH_CUSTODY", "the immutable intent is untouched");
    assert.equal(after.resolvedTarget, null, "and no resolution was invented");
    assert.notEqual(after.status, "COMPLETED");
  });

  test("a handover with no bound count is refused", async () => {
    const h = await reviewedHandover();
    await openIncomingShift();
    await db.handoverSession.update({
      where: { id: h.handoverId }, data: { stockCountSessionId: null },
    });
    await assert.rejects(() => accept(h.handoverId), statusIs(409));
  });

  test("a bound count that is not CONFIRMED is refused", async () => {
    const h = await reviewedHandover();
    await openIncomingShift();
    await acknowledgeAll(h.handoverId, h.sessionId);
    await db.stockCountSession.update({
      where: { id: h.sessionId }, data: { status: "SUBMITTED" },
    });
    await assert.rejects(() => accept(h.handoverId), statusIs(409));
  });

  test("a count bound to a different handover is refused", async () => {
    // The session stays `accountabilityContext: HANDOVER` — the database's own
    // CHECK requires the context and the binding to agree — and answers to
    // somebody else. A gate that only looked at the context would pass it.
    const h = await acceptableHandover();
    const bystander = await db.handoverSession.create({
      data: {
        cafeId: fx.cafeId, branchId: fx.branchId, outgoingShiftId: h.shiftId,
        outgoingUserId: fx.cashier.id, status: "COMPLETED", completedAt: new Date(),
      },
    });
    await db.stockCountSession.update({
      where: { id: h.sessionId }, data: { handoverId: bystander.id },
    });
    await assert.rejects(
      () => accept(h.handoverId), statusIs(409),
      "a session that answers to another handover is not this one's evidence",
    );
  });

  test("one unacknowledged counted line refuses the acceptance, and writes nothing", async () => {
    const h = await reviewedHandover();
    const incomingShift = await openIncomingShift();
    const lines = await db.stockCountLine.findMany({
      where: { sessionId: h.sessionId }, select: { id: true }, orderBy: { id: "asc" },
    });
    // Every line but the last.
    for (const line of lines.slice(0, -1)) {
      const r = await ackPost(incoming.email, h.handoverId, { stockCountLineId: line.id });
      assert.equal(r.status, 200, r.text);
    }

    await assert.rejects(() => accept(h.handoverId), statusIs(409));

    const session = await db.stockCountSession.findUniqueOrThrow({ where: { id: h.sessionId } });
    assert.equal(session.status, "CONFIRMED", "the evidence was not locked");
    assert.equal(session.lockedByHandoverId, null);
    assert.equal(
      await db.handoverStockBoundary.count({ where: { handoverId: h.handoverId } }), 0,
    );
    assert.equal(await db.stockCountRebase.count({ where: { sessionId: h.sessionId } }), 0);
    const shift = await db.shift.findUniqueOrThrow({ where: { id: incomingShift.id } });
    assert.equal(shift.custodyGateReason, "AWAITING_CUSTODY_TRANSFER");
  });

  test("a DISPUTED line of the current session refuses the acceptance", async () => {
    const h = await reviewedHandover({ [items.alpha.id]: 9 });
    await openIncomingShift();
    const lines = await db.stockCountLine.findMany({
      where: { sessionId: h.sessionId }, select: { id: true, inventoryItemId: true },
    });
    for (const line of lines) {
      const disputing = line.inventoryItemId === items.alpha.id;
      const r = await ackPost(incoming.email, h.handoverId, {
        stockCountLineId: line.id,
        ...(disputing
          ? {
              incomingCountedQuantity: 3,
              disputeReasonCodeId: handoverReasonId,
              disputeNote: "مش متفقين",
            }
          : {}),
      });
      assert.equal(r.status, 200, r.text);
    }

    await assert.rejects(
      () => accept(h.handoverId), statusIs(409),
      "an open disagreement about the count in front of us is not acceptable evidence",
    );
  });

  // ── the amendment: only the CURRENT session's acknowledgements count ──

  test("acknowledgements of a superseded session do not satisfy the replacement", async () => {
    const h = await reviewedHandover({ [items.alpha.id]: 9 });
    const incomingShift = await openIncomingShift();
    const lines = await db.stockCountLine.findMany({
      where: { sessionId: h.sessionId }, select: { id: true, inventoryItemId: true },
    });
    for (const line of lines) {
      const disputing = line.inventoryItemId === items.alpha.id;
      await ackPost(incoming.email, h.handoverId, {
        stockCountLineId: line.id,
        ...(disputing
          ? {
              incomingCountedQuantity: 3,
              disputeReasonCodeId: handoverReasonId, disputeNote: "مش متفقين",
            }
          : {}),
      });
    }
    const recount = await recountPost(incoming.email, h.handoverId, {
      reasonCodeId: handoverReasonId, note: "نعيد",
    });
    assert.equal(recount.status, 200, recount.text);

    // The replacement round: counted, confirmed, submitted — and signed for
    // by nobody.
    const restarted = await startCountHttp(h.handoverId);
    assert.equal(restarted.status, 200, restarted.text);
    const replacementId = restarted.body.countSession.id;
    await walkTheCount(replacementId);
    await confirmCount(fx.manager.email, replacementId, `${MARKER}-replacement`);
    await submitHandoverHttp(h.handoverId);

    assert.ok(
      await db.handoverStockAcknowledgement.count({ where: { handoverId: h.handoverId } }) > 0,
      "the old round's signatures are still on the handover — that is the point",
    );

    await assert.rejects(
      () => accept(h.handoverId, { incomingShiftId: incomingShift.id }), statusIs(409),
      "a signature on a count that was sent back is not a signature on its replacement",
    );
  });

  test("a dispute on a superseded session does not block the replacement", async () => {
    // The mirror, and the more dangerous half: a handover-wide dispute count
    // would leave this acceptance permanently unreachable, because the stale
    // DISPUTED row can never be withdrawn.
    const h = await reviewedHandover({ [items.alpha.id]: 9 });
    const incomingShift = await openIncomingShift();
    const lines = await db.stockCountLine.findMany({
      where: { sessionId: h.sessionId }, select: { id: true, inventoryItemId: true },
    });
    for (const line of lines) {
      const disputing = line.inventoryItemId === items.alpha.id;
      await ackPost(incoming.email, h.handoverId, {
        stockCountLineId: line.id,
        ...(disputing
          ? {
              incomingCountedQuantity: 3,
              disputeReasonCodeId: handoverReasonId, disputeNote: "مش متفقين",
            }
          : {}),
      });
    }
    await recountPost(incoming.email, h.handoverId, {
      reasonCodeId: handoverReasonId, note: "نعيد",
    });

    const restarted = await startCountHttp(h.handoverId);
    const replacementId = restarted.body.countSession.id;
    await walkTheCount(replacementId);
    await confirmCount(fx.manager.email, replacementId, `${MARKER}-replacement-2`);
    await submitHandoverHttp(h.handoverId);
    await acknowledgeAll(h.handoverId, replacementId);

    assert.equal(
      await db.handoverStockAcknowledgement.count({
        where: { handoverId: h.handoverId, decision: "DISPUTED" },
      }),
      1,
      "the stale dispute is still on the handover",
    );

    const result = await accept(h.handoverId, { incomingShiftId: incomingShift.id });
    assert.equal(result.status, "COMPLETED");
    assert.equal(
      result.acceptedStockCountSessionId, replacementId,
      "and the accepted evidence is the round that was actually signed for",
    );
  });

  test("the pointer's session is the evidence, never the newest one", async () => {
    const h = await acceptableHandover();
    // A newer CONFIRMED session bound to the same handover, which the pointer
    // does NOT name. An implementation ordering by timestamp would take it.
    const decoy = await db.stockCountSession.create({
      data: {
        cafeId: fx.cafeId, branchId: fx.branchId, type: "CRITICAL",
        scopeDerivation: "CRITICAL_ONLY", initiatedById: fx.manager.id,
        status: "CONFIRMED", confirmedAt: new Date(),
        accountabilityContext: "HANDOVER", handoverId: h.handoverId,
      },
    });

    const result = await accept(h.handoverId);
    assert.equal(result.acceptedStockCountSessionId, h.sessionId);
    assert.notEqual(result.acceptedStockCountSessionId, decoy.id);
  });

  test("an arriving shift that is not gated for a custody transfer is refused", async () => {
    const h = await reviewedHandover();
    const incomingShift = await openIncomingShift();
    await acknowledgeAll(h.handoverId, h.sessionId);
    await db.shift.update({
      where: { id: incomingShift.id },
      data: { custodyGateReason: null, custodyReadyAt: new Date() },
    });
    await assert.rejects(
      () => accept(h.handoverId, { incomingShiftId: incomingShift.id }), statusIs(409),
      "a shift already holding custody is not the one waiting to receive it",
    );
  });

  test("with no arriving shift at all, there is nobody to hand to", async () => {
    const h = await reviewedHandover();
    await acknowledgeAll(h.handoverId, h.sessionId);
    await assert.rejects(() => accept(h.handoverId), statusIs(409));
  });

  test("a freeze belonging to another handover is refused", async () => {
    const h = await acceptableHandover();
    const bystander = await db.handoverSession.create({
      data: {
        cafeId: fx.cafeId, branchId: fx.branchId, outgoingShiftId: h.shiftId,
        outgoingUserId: fx.cashier.id, status: "COMPLETED", completedAt: new Date(),
      },
    });
    await db.inventoryFreeze.update({
      where: { id: h.freezeId }, data: { handoverId: bystander.id },
    });

    await assert.rejects(
      () => accept(h.handoverId), statusIs(409),
      "acceptance releases the freeze, and may only release its own",
    );
  });

  test("a handover holding no active freeze is refused", async () => {
    const h = await acceptableHandover();
    await db.inventoryFreeze.delete({ where: { id: h.freezeId } });
    await assert.rejects(() => accept(h.handoverId), statusIs(409));
  });
});

// ══════════════ T4 · one accept per handover, and a retry hears it ═══════

/**
 * A handover already carrying a committed acceptance, written directly.
 *
 * The replay path exists to answer a caller whose acceptance COMMITTED and
 * whose response was lost, so what it must read is persisted state — not
 * anything a live acceptance happens to be holding. Building that state by
 * hand is what makes this a test of the reader rather than of the writer; the
 * end-to-end retry is T15's.
 */
async function alreadyCompletedHandover() {
  const h = await acceptableHandover();
  const key = `${MARKER}-committed-${h.handoverId}`;
  // Close first: the branch permits one OPEN period per scope, and the
  // successor cannot exist beside a predecessor that is still open.
  await db.custodyPeriod.update({
    where: { id: h.outgoingStockCustodyId! },
    data: { status: "TRANSFERRED", endedAt: new Date(), acceptedById: incoming.id, acceptedAt: new Date() },
  });
  const incomingStock = await db.custodyPeriod.create({
    data: {
      cafeId: fx.cafeId, branchId: fx.branchId, scope: "STOCK", status: "OPEN",
      holderType: "USER", openedById: incoming.id, responsibleShiftId: h.incomingShiftId,
      previousPeriodId: h.outgoingStockCustodyId,
      participants: { create: [{ userId: incoming.id, role: "PRIMARY" }] },
    },
  });
  await db.handoverStockBoundary.createMany({
    data: (await db.stockCountLine.findMany({
      where: { sessionId: h.sessionId },
      select: { id: true, inventoryItemId: true },
    })).map((line) => ({
      handoverId: h.handoverId, inventoryItemId: line.inventoryItemId,
      source: "PHYSICAL_COUNT" as const, verified: true, quantity: 10,
      itemVersion: BigInt(1), stockCountLineId: line.id,
    })),
  });
  await db.handoverSession.update({
    where: { id: h.handoverId },
    data: {
      status: "COMPLETED", resolvedTarget: "SHIFT_TO_SHIFT",
      acceptedStockCountSessionId: h.sessionId,
      acceptedAt: new Date(), completedAt: new Date(), idempotencyKey: key,
      incomingUserId: incoming.id, incomingShiftId: h.incomingShiftId,
      incomingStockCustodyId: incomingStock.id,
    },
  });
  await db.shift.update({
    where: { id: h.shiftId },
    data: {
      status: "CLOSED", closedAt: new Date(), closedById: incoming.id,
      stockClosedAt: new Date(),
    },
  });
  return { ...h, key, incomingStockCustodyId: incomingStock.id };
}

describe("SH-20 acceptance entry, lock and replay", () => {
  test("an already-accepted handover replays from persisted state", async () => {
    const h = await alreadyCompletedHandover();
    const boundaryCount = await db.handoverStockBoundary.count({
      where: { handoverId: h.handoverId },
    });
    const periodCount = await db.custodyPeriod.count({ where: { branchId: fx.branchId } });

    const replay = await accept(h.handoverId, { idempotencyKey: h.key });

    assert.equal(replay.alreadyAccepted, true, "the retry says it changed nothing");
    assert.equal(replay.status, "COMPLETED");
    assert.equal(replay.handoverTarget, "SHIFT_TO_SHIFT");
    assert.equal(replay.acceptedStockCountSessionId, h.sessionId);
    assert.equal(replay.incomingStockCustodyId, h.incomingStockCustodyId);
    assert.equal(replay.incomingShiftId, h.incomingShiftId);
    assert.equal(replay.outgoingShiftStatus, "CLOSED");
    assert.equal(replay.boundary.written, boundaryCount);
    assert.equal(
      replay.rebase, null,
      "a replay rebased nothing, and says so rather than restating an earlier call's answer",
    );

    // The replay ran no step. If it had, the freeze — released by the real
    // acceptance — would have been released a second time, and the boundary
    // written twice.
    assert.equal(
      await db.handoverStockBoundary.count({ where: { handoverId: h.handoverId } }),
      boundaryCount,
    );
    assert.equal(
      await db.custodyPeriod.count({ where: { branchId: fx.branchId } }), periodCount,
    );
  });

  test("a different key against a completed handover is refused", async () => {
    // A second key would be a claim to a second acceptance of one handover.
    // There is only ever one, and the record already names who performed it.
    const h = await alreadyCompletedHandover();
    await assert.rejects(
      () => accept(h.handoverId, { idempotencyKey: `${MARKER}-other-${h.handoverId}` }),
      statusIs(409),
    );
  });

  test("the replay is refused across café boundaries like everything else", async () => {
    const h = await alreadyCompletedHandover();
    await assert.rejects(
      () => accept(h.handoverId, { idempotencyKey: h.key, cafeId: other.cafeId }),
      statusIs(404),
      "replaying is still reading somebody's record, and tenancy is checked first",
    );
  });
});
