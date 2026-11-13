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
import { db, tag, teardownTaggedCafe, purgeOrderTracesFor } from "./helpers/db";
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
  // v2 (C1/C2 era): a sheet dispute opens a review row, which must go before its handover.
  await db.stockHandoverReview.deleteMany({ where: { branchId } });
  await db.handoverSession.deleteMany({ where: { branchId } });
  await db.tenderReconciliation.deleteMany({ where: { branchId } });
  await db.payment.deleteMany({ where: { branchId } });
  await db.inventoryTransaction.deleteMany({ where: { branchId } });
  await purgeOrderTracesFor({ branchId }); await db.order.deleteMany({ where: { branchId } });
  await db.shiftCustody.deleteMany({ where: { shift: { branchId } } });
  await db.custodyParticipant.deleteMany({ where: { custodyPeriod: { branchId } } });
  await db.custodyPeriod.updateMany({ where: { branchId }, data: { previousPeriodId: null } });
  await db.custodyPeriod.deleteMany({ where: { branchId } });
  await db.shift.deleteMany({ where: { branchId } });
  // Items a case added are removed only once every row that cites them is
  // gone — a boundary or a ledger row would otherwise pin them.
  await db.inventoryItem.deleteMany({
    where: { branchId, name: { contains: " extra " } },
  });
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
  freezeId: string | null;
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
  if (!closed.handoverId) {
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
async function walkTheCount(
  sessionId: string,
  counted: Record<string, number> = {},
  skip: readonly ItemKey[] = [],
) {
  const skipIds = new Set(skip.map((k) => items[k].id));
  const lines = await db.stockCountLine.findMany({
    where: { sessionId }, select: { id: true, inventoryItemId: true },
  });
  for (const line of lines) {
    // Never PATCHed — what happens when nobody reaches that shelf.
    if (skipIds.has(line.inventoryItemId)) continue;
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

  // A difference the tolerance FORGAVE is settled already, but the handover
  // still refuses to be submitted while any non-zero variance has no stated
  // reason. Stating it is the capture step's job, and this is the fixture
  // standing in for it.
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
  return lines.map((l) => l.id);
}

/** A confirmed, bound count and a handover at OUTGOING_SUBMITTED. */
async function reviewedHandover(
  counted: Record<string, number> = {},
  skip: readonly ItemKey[] = [],
) {
  const h = await freshHandover();
  const started = await startCountHttp(h.handoverId);
  assert.equal(started.status, 200, started.text);
  const sessionId = started.body.countSession.id;
  await walkTheCount(sessionId, counted, skip);
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
async function acceptableHandover(
  counted: Record<string, number> = {},
  skip: readonly ItemKey[] = [],
) {
  const h = await reviewedHandover(counted, skip);
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

  test("v2: a handover with no bound count is accepted, and the missing count is reported", async () => {
  // Stock handover v2 (owner decision 2026-11-12): a missing outgoing count is
    // reported to the manager and owner, never a reason to keep the next shift waiting.
    const h = await reviewedHandover();
    await openIncomingShift();
    await db.handoverSession.update({
      where: { id: h.handoverId }, data: { stockCountSessionId: null },
    });
    const result = await accept(h.handoverId);
    assert.equal(result.status, "COMPLETED");
    assert.equal(result.acceptedStockCountSessionId, null);
    assert.ok(
      await db.notification.count({ where: { handoverId: h.handoverId, kind: "STOCK_HANDOVER_MISSING_COUNT" } }) > 0,
      "the missing outgoing count is reported",
    );
  });

  test("v2: a bound count that is not CONFIRMED is accepted and recorded as it stands", async () => {
    const h = await reviewedHandover();
    await openIncomingShift();
    await acknowledgeAll(h.handoverId, h.sessionId);
    await db.stockCountSession.update({
      where: { id: h.sessionId }, data: { status: "SUBMITTED" },
    });
    const result = await accept(h.handoverId);
    assert.equal(result.status, "COMPLETED");
    assert.equal(result.acceptedStockCountSessionId, null, "an unconfirmed count is not presented as accepted evidence");
    const session = await db.stockCountSession.findUniqueOrThrow({ where: { id: h.sessionId } });
    assert.equal(session.status, "SUBMITTED", "and it is left exactly as it was");
    assert.equal(session.lockedByHandoverId, null);
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

  test("v2: an unacknowledged counted line no longer refuses; nothing is rebased", async () => {
    const h = await reviewedHandover();
    const incomingShift = await openIncomingShift();
    const lines = await db.stockCountLine.findMany({
      where: { sessionId: h.sessionId }, select: { id: true }, orderBy: { id: "asc" },
    });
    for (const line of lines.slice(0, -1)) {
      const r = await ackPost(incoming.email, h.handoverId, { stockCountLineId: line.id });
      assert.equal(r.status, 200, r.text);
    }

    const result = await accept(h.handoverId);
    assert.equal(result.status, "COMPLETED");
    assert.equal(result.rebase, null);
    assert.equal(await db.stockCountRebase.count({ where: { sessionId: h.sessionId } }), 0, "no count becomes the balance");
    const shift = await db.shift.findUniqueOrThrow({ where: { id: incomingShift.id } });
    assert.equal(shift.custodyGateReason, null, "the arriving shift may sell");
  });

  test("v2: a DISPUTED line is recorded, not a refusal", async () => {
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

    const result = await accept(h.handoverId);
    assert.equal(result.status, "COMPLETED");
    assert.equal(
      await db.handoverStockAcknowledgement.count({ where: { handoverId: h.handoverId, decision: "DISPUTED" } }), 1,
      "the disagreement stays on record for the review",
    );
  });

  test("v2: a replacement round signed by nobody is still received", async () => {
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

    const restarted = await startCountHttp(h.handoverId);
    assert.equal(restarted.status, 200, restarted.text);
    const replacementId = restarted.body.countSession.id;
    await walkTheCount(replacementId);
    await confirmCount(fx.manager.email, replacementId, `${MARKER}-replacement`);
    await submitHandoverHttp(h.handoverId);

    const result = await accept(h.handoverId, { incomingShiftId: incomingShift.id });
    assert.equal(result.status, "COMPLETED");
    assert.equal(result.acceptedStockCountSessionId, replacementId, "the evidence recorded is the current round");
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

  test("a legacy freeze belonging to another (unresolved) handover is still refused", async () => {
    // Stock handover v2 (owner decision 2026-11-12): no new freeze is taken, but a
    // freeze left by a handover created before the change is not this one's to
    // release. (The database allows one LIVE handover per branch, and a completed
    // one's freeze heals itself, so the other owner is an unresolved exception.)
    const h = await acceptableHandover();
    const bystander = await db.handoverSession.create({
      data: {
        cafeId: fx.cafeId, branchId: fx.branchId, outgoingShiftId: h.shiftId,
        outgoingUserId: fx.cashier.id, status: "MANAGER_EXCEPTION",
        exceptionById: fx.manager.id, exceptionReason: "legacy fixture", exceptionAt: new Date(),
      },
    });
    const legacy = await db.inventoryFreeze.create({
      data: { cafeId: fx.cafeId, branchId: fx.branchId, handoverId: bystander.id, startedById: fx.manager.id },
    });
    try {
      await assert.rejects(
        () => accept(h.handoverId), statusIs(409),
        "acceptance may only release its own freeze",
      );
    } finally {
      await db.inventoryFreeze.delete({ where: { id: legacy.id } });
      await db.handoverSession.delete({ where: { id: bystander.id } });
    }
  });

  test("v2: a handover holding no freeze is accepted — that is the normal case now", async () => {
    const h = await acceptableHandover();
    assert.equal(h.freezeId, null);
    const result = await accept(h.handoverId);
    assert.equal(result.status, "COMPLETED");
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

/** A non-critical item of this branch: in the shelf, out of a CRITICAL count. */
async function extraItem(stock = 7) {
  return countItem(fx, `extra ${Math.random().toString(36).slice(2, 8)}`, {
    stock, isCritical: false,
  });
}

// ═════════════ T5 · what was asked for must be counted ═══════════════════

describe("SH-20 required-item settlement", () => {
  test("every required item is paired with the line that satisfied it", async () => {
    const h = await acceptableHandover();
    const result = await accept(h.handoverId);

    const required = await db.handoverRequiredItem.findMany({
      where: { handoverId: h.handoverId },
    });
    assert.ok(required.length > 0, "the fixture has something to require");
    for (const item of required) {
      assert.ok(item.satisfiedByLineId, `${item.itemNameSnapshot} was not paired`);
      assert.equal(item.omitted, false);
      assert.equal(
        item.omissionNote, null,
        "SH-20 never writes an omission note — that is SH-21's authorisation evidence",
      );
    }
    assert.equal(result.requiredItems.satisfied, required.length);
    assert.deepEqual(result.requiredItems.omitted, []);

    // The pairing is against the ACCEPTED session, not any sibling of it.
    const lineIds = new Set(
      (await db.stockCountLine.findMany({
        where: { sessionId: h.sessionId }, select: { id: true },
      })).map((l) => l.id),
    );
    for (const item of required) {
      assert.ok(lineIds.has(item.satisfiedByLineId!), "paired outside the accepted session");
    }
  });

  test("v2: a required item nobody counted is recorded as omitted — the acceptance completes", async () => {
    // Stock handover v2 (owner decision 2026-11-12): a gap in the count is
    // reported for the review, never a reason to keep the next shift waiting.
    const h = await acceptableHandover({}, ["charlie"]);
    const line = await db.stockCountLine.findFirstOrThrow({
      where: { sessionId: h.sessionId, inventoryItemId: items.charlie.id },
    });
    assert.equal(line.disposition, "PENDING");
    assert.equal(line.countedQuantity, null, "a NULL is not a zero");

    const result = await accept(h.handoverId);
    assert.equal(result.status, "COMPLETED");

    const required = await db.handoverRequiredItem.findMany({ where: { handoverId: h.handoverId } });
    assert.equal(required.length, 3);
    const charlie = required.find((r) => r.inventoryItemId === items.charlie.id)!;
    assert.equal(charlie.omitted, true, "the gap is recorded, by name");
    assert.equal(charlie.satisfiedByLineId, null);
    assert.equal(charlie.omissionNote, null, "nobody invented a reason for it");
    for (const item of required.filter((r) => r.inventoryItemId !== items.charlie.id)) {
      assert.ok(item.satisfiedByLineId, "the counted items still pair with their lines");
    }
    assert.equal(await db.stockCountRebase.count({ where: { sessionId: h.sessionId } }), 0, "and nothing was rebased");
  });

  test("v2: a required item whose line was DELETED underneath it is recorded omitted, not silently satisfied", async () => {
    // AN INTEGRITY TEST. A required item with no line at all means a row went
    // missing. It must never read as satisfied; v2 records it as omitted so the
    // review sees it, instead of refusing the shift change.
    const h = await acceptableHandover();
    const orphaned = await db.stockCountLine.findFirstOrThrow({
      where: { sessionId: h.sessionId, inventoryItemId: items.charlie.id },
      select: { id: true, inventoryItemId: true },
    });
    await db.handoverStockAcknowledgement.deleteMany({ where: { stockCountLineId: orphaned.id } });
    await db.stockCountLine.delete({ where: { id: orphaned.id } });

    const result = await accept(h.handoverId);
    assert.equal(result.status, "COMPLETED");
    const charlie = await db.handoverRequiredItem.findFirstOrThrow({
      where: { handoverId: h.handoverId, inventoryItemId: items.charlie.id },
    });
    assert.equal(charlie.satisfiedByLineId, null);
    assert.equal(charlie.omitted, true);
  });

  test("the snapshot survives a rename and an archive between count and accept", async () => {
    const h = await acceptableHandover();
    const before = await db.handoverRequiredItem.findMany({
      where: { handoverId: h.handoverId },
      orderBy: { inventoryItemId: "asc" },
    });

    await db.inventoryItem.update({
      where: { id: items.bravo.id },
      data: { name: `${fx.marker} renamed bravo`, isActive: false, archivedAt: new Date() },
    });

    await accept(h.handoverId);

    const after = await db.handoverRequiredItem.findMany({
      where: { handoverId: h.handoverId },
      orderBy: { inventoryItemId: "asc" },
    });
    for (const [index, row] of after.entries()) {
      assert.equal(
        row.itemNameSnapshot, before[index].itemNameSnapshot,
        "the snapshot names the item the handover was planned with, not today's name",
      );
      assert.equal(row.unitSnapshot, before[index].unitSnapshot);
      assert.equal(row.isCriticalSnapshot, before[index].isCriticalSnapshot);
      assert.ok(row.satisfiedByLineId, "and the pairing still resolves");
    }
  });

  test("the accepted-session pointer is not persisted before settlement runs", async () => {
    // RULING R-A, asserted through the outcome it protects. Had step 4
    // persisted `acceptedStockCountSessionId`, `settleRequiredItems` would
    // have taken its immutability branch — every `satisfiedByLineId` is NULL
    // on a first accept, so the desired state is not already exact — and
    // thrown "final required-item settlement is immutable". A first accept
    // that completes with every pairing written is only reachable in the
    // resolve-then-persist order.
    const h = await acceptableHandover();
    const result = await accept(h.handoverId);
    assert.equal(result.status, "COMPLETED");
    assert.equal(
      await db.handoverRequiredItem.count({
        where: { handoverId: h.handoverId, satisfiedByLineId: null },
      }),
      0,
    );
    const handover = await db.handoverSession.findUniqueOrThrow({
      where: { id: h.handoverId },
    });
    assert.equal(handover.acceptedStockCountSessionId, h.sessionId);
  });
});

// ═══════════ T6 · the shelf is rebased under the freeze ══════════════════

describe("stock handover v2: the acceptance posts no stock", () => {
  // Owner decision 2026-11-12: a handover count is a record. Neither the
  // outgoing figure nor the receiver's count becomes the balance; a
  // difference is corrected only through the authorised adjustment process.
  test("the accepted session is NOT rebased; the balance and ledger are untouched", async () => {
    const h = await acceptableHandover({ [items.alpha.id]: 9 });
    const before = await db.inventoryItem.findUniqueOrThrow({ where: { id: items.alpha.id } });

    const result = await accept(h.handoverId);
    assert.equal(result.status, "COMPLETED");
    assert.equal(result.rebase, null);

    const after = await db.inventoryItem.findUniqueOrThrow({ where: { id: items.alpha.id } });
    assert.equal(Number(after.currentStock), Number(before.currentStock), "the counted 9 did not become the balance");
    assert.equal(after.ledgerVersion, before.ledgerVersion, "no ledger row was written");
    assert.equal(await db.inventoryTransaction.count({ where: { inventoryItemId: items.alpha.id, type: "COUNT_REBASE" } }), 0);
    assert.equal(await db.stockCountRebase.count({ where: { sessionId: h.sessionId } }), 0);
  });

  test("a movement after the count neither refuses the acceptance nor is undone by it", async () => {
    const h = await acceptableHandover({ [items.alpha.id]: 9 });
    const before = Number((await db.inventoryItem.findUniqueOrThrow({ where: { id: items.alpha.id } })).currentStock);
    const { applyStockMutation } = await import("@/lib/ledger");
    await db.$transaction((tx) =>
      applyStockMutation(tx, {
        inventoryItemId: items.alpha.id, type: "USAGE", quantity: -0.25,
        cafeId: fx.cafeId, branchId: fx.branchId, createdById: fx.cashier.id,
      }),
    );
    const result = await accept(h.handoverId);
    assert.equal(result.status, "COMPLETED");
    const after = Number((await db.inventoryItem.findUniqueOrThrow({ where: { id: items.alpha.id } })).currentStock);
    assert.equal(after, before - 0.25, "only the recorded sale moved the shelf");
  });

  test("no freeze was taken for the handover at any point", async () => {
    const h = await acceptableHandover({ [items.alpha.id]: 9 });
    await accept(h.handoverId);
    assert.equal(await db.inventoryFreeze.count({ where: { handoverId: h.handoverId } }), 0);
  });

  test("a superseded round and its replacement both stay records; neither becomes the shelf", async () => {
    const h = await reviewedHandover({ [items.alpha.id]: 9 });
    const incomingShift = await openIncomingShift();
    const before = Number((await db.inventoryItem.findUniqueOrThrow({ where: { id: items.alpha.id } })).currentStock);
    const lines = await db.stockCountLine.findMany({
      where: { sessionId: h.sessionId }, select: { id: true, inventoryItemId: true },
    });
    for (const line of lines) {
      await ackPost(incoming.email, h.handoverId, {
        stockCountLineId: line.id,
        ...(line.inventoryItemId === items.alpha.id
          ? { incomingCountedQuantity: 3, disputeReasonCodeId: handoverReasonId, disputeNote: "مش متفقين" }
          : {}),
      });
    }
    await recountPost(incoming.email, h.handoverId, { reasonCodeId: handoverReasonId, note: "نعيد" });
    const restarted = await startCountHttp(h.handoverId);
    const replacementId = restarted.body.countSession.id;
    await walkTheCount(replacementId, { [items.alpha.id]: 8 });
    await confirmCount(fx.manager.email, replacementId, `${MARKER}-rebase-replacement`);
    await submitHandoverHttp(h.handoverId);
    await acknowledgeAll(h.handoverId, replacementId);

    await accept(h.handoverId, { incomingShiftId: incomingShift.id });

    assert.equal(await db.stockCountRebase.count({ where: { sessionId: { in: [h.sessionId, replacementId] } } }), 0);
    const alpha = await db.inventoryItem.findUniqueOrThrow({ where: { id: items.alpha.id } });
    assert.equal(Number(alpha.currentStock), before, "the book balance stands; the counts are compared, not posted");
  });
});

// ═══════════════ T7 · the closing position, written whole ════════════════

describe("SH-20 stock boundary", () => {
  test("every active item gets a row — counted verified, uncounted carried", async () => {
    const h = await acceptableHandover({ [items.alpha.id]: 9 });
    // Added after the count was planned and taken, and non-critical, so it is
    // in neither the required snapshot nor the CRITICAL scope. The boundary
    // still has to describe it: the closing position is the whole shelf.
    const extra = await extraItem(7);

    const result = await accept(h.handoverId);

    const rows = await db.handoverStockBoundary.findMany({
      where: { handoverId: h.handoverId },
    });
    const byItem = new Map(rows.map((r) => [r.inventoryItemId, r]));
    assert.equal(rows.length, 4, "three counted criticals and one carried extra");
    assert.deepEqual(result.boundary, { written: 4, verified: 3, carried: 1 });

    const alpha = byItem.get(items.alpha.id)!;
    assert.equal(alpha.source, "PHYSICAL_COUNT");
    assert.equal(alpha.verified, true);
    assert.ok(alpha.stockCountLineId, "a verified row cites the line that verified it");
    assert.equal(
      Number(alpha.quantity), 9,
      "the position is taken after the rebase, so it is what the shelf now holds",
    );

    const carried = byItem.get(extra.id)!;
    assert.equal(carried.source, "SYSTEM_CARRIED");
    assert.equal(carried.verified, false);
    assert.equal(
      carried.stockCountLineId, null,
      "nobody counted it, so no line is cited as if somebody had",
    );
    assert.equal(Number(carried.quantity), 7);
  });

  test("an archived item produces no boundary row", async () => {
    const h = await acceptableHandover();
    await db.inventoryItem.update({
      where: { id: items.bravo.id },
      data: { isActive: false, archivedAt: new Date() },
    });

    await accept(h.handoverId);

    assert.equal(
      await db.handoverStockBoundary.count({
        where: { handoverId: h.handoverId, inventoryItemId: items.bravo.id },
      }),
      0,
      "the closing position describes the shelf as it is, not as it was",
    );
  });

  test("the unit cost on a verified row is the count's, not today's", async () => {
    const h = await acceptableHandover();
    const line = await db.stockCountLine.findFirstOrThrow({
      where: { sessionId: h.sessionId, inventoryItemId: items.alpha.id },
    });
    // The shelf is repriced between the count and the acceptance. The
    // boundary must still cost what was counted at what it cost then.
    await db.inventoryItem.update({
      where: { id: items.alpha.id }, data: { costPerUnit: 9999 },
    });

    await accept(h.handoverId);

    const row = await db.handoverStockBoundary.findFirstOrThrow({
      where: { handoverId: h.handoverId, inventoryItemId: items.alpha.id },
    });
    assert.equal(
      row.unitCostSnapshot === null ? null : Number(row.unitCostSnapshot),
      line.unitCostSnapshot === null ? null : Number(line.unitCostSnapshot),
    );
    assert.equal(row.unitCostSource, line.unitCostSource);
    assert.notEqual(Number(row.unitCostSnapshot ?? 0), 9999);
  });
});

// ══════════ T8 · the accepted evidence can no longer be recounted ════════

describe("SH-20 accepted count lock", () => {
  test("the accepted session is LOCKED and names the handover that locked it", async () => {
    const h = await acceptableHandover();
    await accept(h.handoverId);

    const session = await db.stockCountSession.findUniqueOrThrow({
      where: { id: h.sessionId },
    });
    assert.equal(session.status, "LOCKED");
    assert.equal(session.lockedByHandoverId, h.handoverId);
    assert.ok(session.lockedAt);
    assert.equal(
      await db.auditLog.count({
        where: { cafeId: fx.cafeId, action: "COUNT_LOCKED", entityId: h.sessionId },
      }),
      1,
    );
  });

  test("a superseded session is left CONFIRMED and unlocked", async () => {
    const h = await reviewedHandover({ [items.alpha.id]: 9 });
    const incomingShift = await openIncomingShift();
    const lines = await db.stockCountLine.findMany({
      where: { sessionId: h.sessionId }, select: { id: true, inventoryItemId: true },
    });
    for (const line of lines) {
      await ackPost(incoming.email, h.handoverId, {
        stockCountLineId: line.id,
        ...(line.inventoryItemId === items.alpha.id
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
    await confirmCount(fx.manager.email, replacementId, `${MARKER}-lock-replacement`);
    await submitHandoverHttp(h.handoverId);
    await acknowledgeAll(h.handoverId, replacementId);

    await accept(h.handoverId, { incomingShiftId: incomingShift.id });

    const superseded = await db.stockCountSession.findUniqueOrThrow({
      where: { id: h.sessionId },
    });
    assert.equal(superseded.status, "CONFIRMED", "history stays readable");
    assert.equal(superseded.lockedByHandoverId, null);
    const accepted = await db.stockCountSession.findUniqueOrThrow({
      where: { id: replacementId },
    });
    assert.equal(accepted.status, "LOCKED");
    assert.equal(accepted.lockedByHandoverId, h.handoverId);
  });

  test("a locked session refuses a further capture", async () => {
    const h = await acceptableHandover();
    await accept(h.handoverId);
    const line = await db.stockCountLine.findFirstOrThrow({
      where: { sessionId: h.sessionId }, select: { id: true },
    });
    const r = await patchLine(fx.manager.email, h.sessionId, line.id, 5);
    assert.ok(r.status >= 400, `a locked count accepted a capture: ${r.text}`);
  });
});

// ════════ T9 · every difference gets a case, and none names the wrong person ═

describe("stock handover v2: differences are reported, never auto-charged", () => {
  // Owner decision 2026-11-12: no automatic stock variance case naming an
  // employee. The difference stays on the count line and on the boundary; the
  // two-count comparison and its manager review carry the accountability.
  test("a non-zero difference opens no automatic stock case and names nobody", async () => {
    const h = await acceptableHandover({ [items.alpha.id]: 9 });
    const result = await accept(h.handoverId);
    assert.deepEqual(result.varianceCaseIds, []);
    assert.equal(await db.varianceCase.count({ where: { acceptedHandoverId: h.handoverId, type: "STOCK" } }), 0);
    const line = await db.stockCountLine.findFirstOrThrow({ where: { sessionId: h.sessionId, inventoryItemId: items.alpha.id } });
    assert.equal(Number(line.varianceQuantity), -1, "the observed difference is still on record");
  });

  test("a carried item creates no case and no blame", async () => {
    const h = await acceptableHandover();
    const extra = await extraItem(7);
    await accept(h.handoverId);

    assert.equal(
      await db.varianceCase.count({
        where: { acceptedHandoverId: h.handoverId, stockCountLine: { inventoryItemId: extra.id } },
      }),
      0,
      "an unverified boundary opens no case and names nobody",
    );
    const boundary = await db.handoverStockBoundary.findFirstOrThrow({
      where: { handoverId: h.handoverId, inventoryItemId: extra.id },
    });
    assert.equal(boundary.verified, false);
  });

  test("a very large difference interrupts nothing", async () => {
    const h = await acceptableHandover({ [items.alpha.id]: 0 });
    const result = await accept(h.handoverId);
    assert.equal(result.status, "COMPLETED");
    assert.equal(result.outgoingShiftStatus, "CLOSED");
    assert.ok(result.incomingStockCustodyId);
    const shift = await db.shift.findUniqueOrThrow({ where: { id: h.incomingShiftId } });
    assert.equal(shift.custodyGateReason, null, "and the arriving shift may sell");
    assert.deepEqual(result.varianceCaseIds, []);
    assert.deepEqual(result.spanIds, []);
  });

  test("a superseded session's differences produce no cases", async () => {
    const h = await reviewedHandover({ [items.alpha.id]: 2 });
    const incomingShift = await openIncomingShift();
    const lines = await db.stockCountLine.findMany({
      where: { sessionId: h.sessionId }, select: { id: true, inventoryItemId: true },
    });
    for (const line of lines) {
      await ackPost(incoming.email, h.handoverId, {
        stockCountLineId: line.id,
        ...(line.inventoryItemId === items.alpha.id
          ? {
              incomingCountedQuantity: 9,
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
    await confirmCount(fx.manager.email, replacementId, `${MARKER}-var-replacement`);
    await submitHandoverHttp(h.handoverId);
    await acknowledgeAll(h.handoverId, replacementId);

    const result = await accept(h.handoverId, { incomingShiftId: incomingShift.id });

    assert.deepEqual(
      result.varianceCaseIds, [],
      "the replacement counted exactly, so there is nothing to investigate",
    );
    assert.equal(
      await db.varianceCase.count({ where: { stockCountLine: { sessionId: h.sessionId } } }),
      0,
      "and the round that was sent back opened none either",
    );
  });
});

// ═══ T10 · custody moves and the arriving shift may sell, as one fact ════

describe("SH-20 target resolution, custody transfer and the incoming gate", () => {
  test("STOCK custody moves, with acceptance on the predecessor and responsibility on the successor", async () => {
    const h = await acceptableHandover();
    const result = await accept(h.handoverId);

    const predecessor = await db.custodyPeriod.findUniqueOrThrow({
      where: { id: h.outgoingStockCustodyId! },
    });
    assert.equal(predecessor.status, "TRANSFERRED");
    assert.ok(predecessor.endedAt);
    assert.equal(predecessor.acceptedById, incoming.id);
    assert.ok(predecessor.acceptedAt);

    const successor = await db.custodyPeriod.findUniqueOrThrow({
      where: { id: result.incomingStockCustodyId! },
      include: { participants: true },
    });
    assert.equal(successor.status, "OPEN");
    assert.equal(successor.holderType, "USER");
    assert.equal(successor.responsibleShiftId, h.incomingShiftId);
    assert.equal(successor.previousPeriodId, h.outgoingStockCustodyId);
    assert.deepEqual(successor.participants.map((p) => p.userId), [incoming.id]);
    assert.equal(successor.openedById, incoming.id);
  });

  test("CASH custody moves too, at the figure the close counted", async () => {
    const h = await acceptableHandover();
    const outgoingShift = await db.shift.findUniqueOrThrow({ where: { id: h.shiftId } });
    const result = await accept(h.handoverId);

    assert.ok(h.outgoingCashCustodyId, "SHIFT_TO_SHIFT leaves the drawer open for this");
    assert.ok(result.incomingCashCustodyId);
    const predecessor = await db.custodyPeriod.findUniqueOrThrow({
      where: { id: h.outgoingCashCustodyId! },
    });
    assert.equal(predecessor.status, "TRANSFERRED");
    assert.equal(predecessor.acceptedById, incoming.id);
    assert.equal(
      Number(predecessor.closingCashAmount), Number(outgoingShift.actualCashAmount),
      "the drawer closes at what was counted, not at what was expected",
    );
    const successor = await db.custodyPeriod.findUniqueOrThrow({
      where: { id: result.incomingCashCustodyId! },
    });
    assert.equal(Number(successor.openingCashAmount), Number(outgoingShift.actualCashAmount));
    assert.equal(
      successor.responsibleShiftId, null,
      "responsibility for stock movement is a stock concept; a drawer has no shelf",
    );
  });

  test("the handover records who took the room", async () => {
    const h = await acceptableHandover();
    const result = await accept(h.handoverId);

    const row = await db.handoverSession.findUniqueOrThrow({ where: { id: h.handoverId } });
    assert.equal(row.incomingStockCustodyId, result.incomingStockCustodyId);
    assert.equal(row.incomingCashCustodyId, result.incomingCashCustodyId);
    assert.equal(row.incomingShiftId, h.incomingShiftId);
    assert.equal(row.incomingUserId, incoming.id);
  });

  test("the arriving shift becomes operational in the same commit as the transfer", async () => {
    const h = await acceptableHandover();
    await accept(h.handoverId);

    const shift = await db.shift.findUniqueOrThrow({ where: { id: h.incomingShiftId } });
    assert.equal(shift.custodyGateReason, null);
    assert.ok(shift.custodyReadyAt);
    // There is no observable instant between the two: both were written by
    // one transaction, so committed state can only show neither or both.
    const successor = await db.custodyPeriod.findFirstOrThrow({
      where: { branchId: fx.branchId, scope: "STOCK", status: "OPEN" },
    });
    assert.equal(successor.responsibleShiftId, shift.id);
  });

  test("the immutable target is untouched, and the resolution equals it", async () => {
    const h = await acceptableHandover();
    const before = await db.handoverSession.findUniqueOrThrow({ where: { id: h.handoverId } });
    const result = await accept(h.handoverId);
    const after = await db.handoverSession.findUniqueOrThrow({ where: { id: h.handoverId } });

    assert.equal(after.target, before.target, "the original intent is never rewritten");
    assert.equal(after.target, "SHIFT_TO_SHIFT");
    assert.equal(after.resolvedTarget, "SHIFT_TO_SHIFT");
    assert.equal(result.handoverTarget, "SHIFT_TO_SHIFT");
  });

  test("a legacy shift's absent readiness evidence is left absent", async () => {
    // A shift closed before custody existed truthfully has no answer for
    // either column, and NULL there means "not recorded" rather than "not
    // ready". Acceptance updates exactly the arriving shift it resolved, so a
    // legacy pair elsewhere on the branch must come through untouched — a
    // backfill here would invent a readiness nobody established.
    const h = await acceptableHandover();
    const legacy = await db.shift.create({
      data: {
        cafeId: fx.cafeId, branchId: fx.branchId, cashierId: fx.cashier.id,
        shiftNumber: 990001, openingCashAmount: 0, expectedCashAmount: 0,
        status: "CLOSED", closedAt: new Date(),
        custodyGateReason: null, custodyReadyAt: null,
      },
    });

    await accept(h.handoverId);

    const after = await db.shift.findUniqueOrThrow({ where: { id: legacy.id } });
    assert.equal(after.custodyGateReason, null);
    assert.equal(after.custodyReadyAt, null, "still not recorded, not retroactively ready");
    assert.equal(after.status, "CLOSED");
    assert.equal(after.stockClosedAt, null);
  });

  test("a sale on the arriving shift is attributed to it", async () => {
    const h = await acceptableHandover();
    const result = await accept(h.handoverId);

    const { applyStockMutation } = await import("@/lib/ledger");
    const mutation = await db.$transaction((tx) =>
      applyStockMutation(tx, {
        inventoryItemId: items.alpha.id, type: "USAGE", quantity: -1,
        cafeId: fx.cafeId, branchId: fx.branchId, createdById: incoming.id,
      }),
    );
    const txn = await db.inventoryTransaction.findUniqueOrThrow({
      where: { id: mutation.transactionId },
    });
    assert.equal(txn.custodyPeriodId, result.incomingStockCustodyId);
    assert.equal(
      txn.shiftId, h.incomingShiftId,
      "the shelf that changed hands answers to the shift that took it",
    );
  });

  test("no BRANCH-held custody is constructible from ordinary acceptance", async () => {
    const h = await acceptableHandover();
    await accept(h.handoverId);
    assert.equal(
      await db.custodyPeriod.count({ where: { branchId: fx.branchId, holderType: "BRANCH" } }),
      0,
      "SH-22 owns the branch holder, and this route cannot reach it",
    );
  });
});

// ══════ T11 · the outgoing shift closes when the shelf has changed hands ══

describe("SH-20 outgoing shift finalization", () => {
  test("AWAITING_HANDOVER becomes CLOSED, with the stock timestamp and the acceptor", async () => {
    const h = await acceptableHandover();
    const before = await db.shift.findUniqueOrThrow({ where: { id: h.shiftId } });
    assert.equal(before.status, "AWAITING_HANDOVER");
    assert.equal(before.stockClosedAt, null);

    const result = await accept(h.handoverId);
    assert.equal(result.outgoingShiftStatus, "CLOSED");

    const after = await db.shift.findUniqueOrThrow({ where: { id: h.shiftId } });
    assert.equal(after.status, "CLOSED");
    assert.ok(after.stockClosedAt, "when the shelf became a fact");
    assert.ok(after.closedAt);
    assert.equal(
      after.closedById, incoming.id,
      "who accepted the count and discharged the custodian — not the cashier who held it",
    );
  });

  test("no cash-close figure is recomputed by the acceptance", async () => {
    const h = await acceptableHandover();
    const before = await db.shift.findUniqueOrThrow({ where: { id: h.shiftId } });
    await accept(h.handoverId);
    const after = await db.shift.findUniqueOrThrow({ where: { id: h.shiftId } });

    const financial = [
      "openingCashAmount", "expectedCashAmount", "actualCashAmount", "cashDifference",
      "cashWithinTolerance", "cashToleranceAmount", "cashReasonCodeId", "cashReasonNote",
      "cashVarianceCaseId", "totalSales", "totalCashSales", "totalCardSales",
      "totalWalletSales", "totalRefunds", "totalDiscounts", "orderCount",
      "financiallyClosedAt", "handoverRequired",
    ] as const;
    for (const key of financial) {
      assert.equal(
        String(before[key]), String(after[key]),
        `${key} was rewritten by an acceptance that has no business recomputing it`,
      );
    }
  });

  test("a shift that is not awaiting a handover is not this acceptance's to close", async () => {
    const { finalizeOutgoingShift } = await handoverLib();
    const h = await acceptableHandover();
    await db.shift.update({ where: { id: h.shiftId }, data: { status: "OPEN" } });
    await assert.rejects(
      () =>
        db.$transaction((tx) =>
          finalizeOutgoingShift(tx, {
            outgoingShiftId: h.shiftId, closedById: incoming.id, at: new Date(),
          }),
        ),
      statusIs(409),
    );
  });
});

// ═══ T12 · the record is completed and the shelf unfrozen in one breath ══

describe("SH-20 completion, freeze release and audit", () => {
  test("the completion writes every final field at once", async () => {
    const h = await acceptableHandover();
    const key = `${MARKER}-complete-${h.handoverId}`;
    const result = await accept(h.handoverId, { idempotencyKey: key });

    const row = await db.handoverSession.findUniqueOrThrow({ where: { id: h.handoverId } });
    assert.equal(row.status, "COMPLETED");
    assert.equal(row.acceptedStockCountSessionId, h.sessionId);
    assert.ok(row.acceptedAt);
    assert.ok(row.completedAt);
    assert.equal(row.resolvedTarget, "SHIFT_TO_SHIFT");
    assert.equal(row.idempotencyKey, key);
    assert.equal(result.acceptedStockCountSessionId, h.sessionId);
  });

  test("the accepted pointer is the resolved session, whatever the current pointer says later", async () => {
    const h = await acceptableHandover();
    await accept(h.handoverId);
    const row = await db.handoverSession.findUniqueOrThrow({ where: { id: h.handoverId } });
    assert.equal(row.acceptedStockCountSessionId, h.sessionId);
    assert.equal(
      row.stockCountSessionId, h.sessionId,
      "the two agree here, and only the accepted one is the record",
    );
  });

  test("v2: an acceptance creates no freeze", async () => {
    const h = await acceptableHandover();
    await accept(h.handoverId);
    assert.equal(await db.inventoryFreeze.count({ where: { handoverId: h.handoverId } }), 0);
  });

  test("a LEGACY freeze of this handover (taken before v2) is released, says who, and the exclusive lock is granted", async () => {
    // Handovers opened before the owner decision may still hold a freeze; the
    // acceptance releases it through the same audited path as before.
    const h = await acceptableHandover({ [items.alpha.id]: 9 });
    const legacy = await db.inventoryFreeze.create({
      data: { cafeId: fx.cafeId, branchId: fx.branchId, handoverId: h.handoverId, startedById: fx.manager.id },
    });
    const result = await accept(h.handoverId);
    assert.equal(result.status, "COMPLETED");
    const freeze = await db.inventoryFreeze.findUniqueOrThrow({ where: { id: legacy.id } });
    assert.ok(freeze.releasedAt);
    assert.equal(freeze.releasedById, incoming.id);
    assert.equal(
      await db.auditLog.count({ where: { cafeId: fx.cafeId, action: "INVENTORY_FREEZE_RELEASED", entityId: freeze.id } }),
      1,
    );
  });

  test("one audit row carries the whole shape", async () => {
    const h = await acceptableHandover({ [items.alpha.id]: 9 });
    const extra = await extraItem(7);
    const result = await accept(h.handoverId);

    const rows = await db.auditLog.findMany({
      where: {
        cafeId: fx.cafeId, action: "HANDOVER_ACCEPTED", entityId: h.handoverId,
      },
    });
    assert.equal(rows.length, 1, "exactly one acceptance was recorded");
    const details = rows[0].details as Record<string, unknown>;
    assert.equal(rows[0].userId, incoming.id);
    assert.equal(details.acceptedStockCountSessionId, h.sessionId);
    assert.equal(details.resolvedTarget, "SHIFT_TO_SHIFT");
    assert.deepEqual(details.boundary, { written: 4, verified: 3, carried: 1 });
    assert.deepEqual(details.varianceCaseIds, result.varianceCaseIds);
    assert.deepEqual(details.spanIds, result.spanIds);
    assert.equal(details.outgoingStockCustodyId, h.outgoingStockCustodyId);
    assert.equal(details.incomingStockCustodyId, result.incomingStockCustodyId);
    assert.equal(details.incomingCashCustodyId, result.incomingCashCustodyId);
    assert.equal(details.outgoingShiftId, h.shiftId);
    assert.equal(details.incomingShiftId, h.incomingShiftId);
    assert.equal(details.outgoingShiftStatus, "CLOSED");
    assert.ok(extra.id);
  });

  test("a retry writes no second audit row", async () => {
    const h = await acceptableHandover();
    const key = `${MARKER}-audit-once-${h.handoverId}`;
    await accept(h.handoverId, { idempotencyKey: key });
    await accept(h.handoverId, { idempotencyKey: key });

    assert.equal(
      await db.auditLog.count({
        where: { cafeId: fx.cafeId, action: "HANDOVER_ACCEPTED", entityId: h.handoverId },
      }),
      1,
    );
  });
});

// ════════ T13 · accepting the handover has a door, behind its own key ════

const acceptPost = (email: string, handoverId: string, body: unknown) =>
  as<{
    status?: string;
    acceptedStockCountSessionId?: string;
    incomingStockCustodyId?: string;
    incomingCashCustodyId?: string;
    incomingShiftId?: string;
    boundary?: { written: number; verified: number; carried: number };
    requiredItems?: { satisfied: number; omitted: string[] };
    varianceCaseIds?: string[];
    spanIds?: string[];
    outgoingShiftStatus?: string;
    alreadyAccepted?: boolean;
    error?: string;
  }>(email, `/api/handovers/${handoverId}/accept`, {
    method: "POST",
    body: JSON.stringify(body),
  });

describe("SH-20 accept route", () => {
  test("a successful accept returns the whole result", async () => {
    const h = await acceptableHandover({ [items.alpha.id]: 9 });
    const r = await acceptPost(incoming.email, h.handoverId, {
      idempotencyKey: `${MARKER}-http-${h.handoverId}`,
    });

    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.status, "COMPLETED");
    assert.equal(r.body.acceptedStockCountSessionId, h.sessionId);
    assert.equal(r.body.incomingShiftId, h.incomingShiftId);
    assert.equal(r.body.outgoingShiftStatus, "CLOSED");
    assert.equal(r.body.alreadyAccepted, false);
    assert.ok(r.body.incomingStockCustodyId);
    assert.ok(r.body.boundary);
    assert.equal(r.body.varianceCaseIds?.length, 0, "stock handover v2: no automatic stock case");

    const row = await db.handoverSession.findUniqueOrThrow({ where: { id: h.handoverId } });
    assert.equal(
      row.incomingUserId, incoming.id,
      "the column recording who took the shelf comes from the session, never the body",
    );
  });

  test("the incoming party is the authenticated user, whatever the body says", async () => {
    const h = await acceptableHandover();
    const r = await acceptPost(incoming.email, h.handoverId, {
      idempotencyKey: `${MARKER}-actor-${h.handoverId}`,
      incomingUserId: fx.cashier.id,
    });
    assert.equal(r.status, 400, "an unknown field is refused rather than quietly dropped");
    assert.match(r.text, /incomingUserId/);
  });

  test("a body naming an answer the service computes is refused by name", async () => {
    const h = await acceptableHandover();
    for (const field of [
      "status", "acceptedStockCountSessionId", "resolvedTarget", "varianceCaseIds",
    ]) {
      const r = await acceptPost(incoming.email, h.handoverId, {
        idempotencyKey: `${MARKER}-strict-${field}`,
        [field]: "anything",
      });
      assert.equal(r.status, 400, `${field} was not refused: ${r.text}`);
      assert.match(r.text, new RegExp(field));
    }
  });

  test("a missing idempotency key answers in the café's own language", async () => {
    const h = await acceptableHandover();
    const r = await acceptPost(incoming.email, h.handoverId, {});
    assert.equal(r.status, 400, r.text);
    assert.match(r.text, /مفتاح/, "not zod's 'expected string, received undefined'");
  });

  test("a user without the key is refused", async () => {
    const h = await acceptableHandover();
    const r = await acceptPost(fx.waiter.email, h.handoverId, {
      idempotencyKey: `${MARKER}-perm-${h.handoverId}`,
    });
    assert.equal(r.status, 403, r.text);

    const row = await db.handoverSession.findUniqueOrThrow({ where: { id: h.handoverId } });
    assert.notEqual(row.status, "COMPLETED");
  });

  test("another café's handover is a 404, not a 403", async () => {
    const r = await acceptPost(incoming.email, otherHandoverId, {
      idempotencyKey: `${MARKER}-foreign`,
    });
    assert.equal(r.status, 404, r.text);
  });

  test("a branch-scoped session cannot accept another branch's handover", async () => {
    const h = await acceptableHandover();
    const r = await acceptPost(annexIncoming.email, h.handoverId, {
      idempotencyKey: `${MARKER}-branch-${h.handoverId}`,
    });
    assert.equal(r.status, 403, r.text);
  });

  test("every gate refusal maps to a stable 409", async () => {
    const h = await reviewedHandover();
    // No arriving shift: one of the refusals v2 keeps (nobody to hand to).
    const r = await acceptPost(incoming.email, h.handoverId, {
      idempotencyKey: `${MARKER}-gate-${h.handoverId}`,
    });
    assert.equal(r.status, 409, r.text);
    assert.ok(r.body.error, "and it carries a message a café can read");
  });

  test("no raw database detail reaches the caller", async () => {
    const h = await reviewedHandover();
    const r = await acceptPost(incoming.email, h.handoverId, {
      idempotencyKey: `${MARKER}-leak-${h.handoverId}`,
    });
    assert.ok(r.status >= 400);
    assert.doesNotMatch(r.text, /prisma|P20\d\d|SELECT |FROM "|constraint/i);
  });

  test("a retry through the door hears the same answer", async () => {
    const h = await acceptableHandover();
    const key = `${MARKER}-http-retry-${h.handoverId}`;
    const first = await acceptPost(incoming.email, h.handoverId, { idempotencyKey: key });
    assert.equal(first.status, 200, first.text);

    const retry = await acceptPost(incoming.email, h.handoverId, { idempotencyKey: key });
    assert.equal(retry.status, 200, retry.text);
    assert.equal(retry.body.alreadyAccepted, true);
    assert.equal(
      retry.body.acceptedStockCountSessionId, first.body.acceptedStockCountSessionId,
    );
    assert.equal(retry.body.incomingStockCustodyId, first.body.incomingStockCustodyId);
    assert.equal(
      await db.auditLog.count({
        where: { cafeId: fx.cafeId, action: "HANDOVER_ACCEPTED", entityId: h.handoverId },
      }),
      1,
    );
  });

  test("the route names no shift, and the branch's waiting one is found", async () => {
    const h = await acceptableHandover();
    const r = await acceptPost(incoming.email, h.handoverId, {
      idempotencyKey: `${MARKER}-resolve-${h.handoverId}`,
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.incomingShiftId, h.incomingShiftId);
  });
});

test('cash handover: an unexplained mismatch is persisted once and custody agrees with incoming opening',async()=>{
  const h=await acceptableHandover();
  await db.shift.update({where:{id:h.incomingShiftId},data:{openingCashAmount:80,expectedCashAmount:80}});
  const url='/api/handovers/'+h.handoverId+'/accept';
  const key=MARKER+'cash-'+h.handoverId;
  const body={idempotencyKey:key,countedOpeningCash:80};
  const accepted=await as(incoming.email,url,{method:'POST',body:JSON.stringify(body)});
  assert.equal(accepted.status,200,accepted.text);
  const persisted=await db.handoverSession.findUniqueOrThrow({where:{id:h.handoverId}});
  assert.equal(Number(persisted.cashVarianceAmount),-20);
  const observation=await db.openingException.findFirstOrThrow({where:{handoverId:h.handoverId,kind:'CASH_MISMATCH'}});
  assert.equal(observation.reasonCodeId,null);
  assert.equal(observation.note,null);
  const custody=await db.custodyPeriod.findUniqueOrThrow({where:{id:persisted.incomingCashCustodyId!}});
  assert.equal(Number(custody.openingCashAmount),80);
  const replay=await as(incoming.email,url,{method:'POST',body:JSON.stringify(body)});
  assert.equal(replay.status,200,replay.text);
  assert.equal(await db.varianceCase.count({where:{acceptedHandoverId:h.handoverId,type:'OPENING_EXCEPTION'}}),1);
  const wrongReplay=await as(fx.manager.email,'/api/handovers/'+h.handoverId+'/override-accept',{method:'POST',body:JSON.stringify({idempotencyKey:key,reasonCodeId:handoverReasonId,note:'Must not turn ordinary cash receipt into manager override',kind:'MANAGER_ADJUSTMENT'})});
  assert.equal(wrongReplay.status,409,wrongReplay.text);
});
