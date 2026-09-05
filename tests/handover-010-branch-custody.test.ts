// HANDOVER-010 — SH-22: the branch holds the shelf, and hands it back.
//
// Two acts, one lifecycle, and the whole point is that no person is recorded
// as holding stock they never took.
//
//   HALF A  a closing shift's stock goes to the BRANCH itself. Nobody
//           arrives, nobody signs, no drawer moves — the close already
//           discharged it — and the outgoing custodian is discharged by a
//           manager rather than by a successor.
//
//   HALF B  a shift opens against branch-held stock and is GATED: it may not
//           sell, serve or collect until somebody has counted the whole shelf
//           and taken it on. The verification is what discharges the gate.
//
// ── WHAT THIS SUITE PINS ──
//
//   * THE TARGET IS IMMUTABLE. `target` is written once, at close, and this
//     route accepts it rather than choosing it. SH-20's ordinary accept and
//     SH-21's override both still refuse a `BRANCH_CUSTODY` handover.
//
//   * NOBODY IS NAMED. The BRANCH successor has zero participants, no shift
//     and no responsible shift; the completed handover carries a null
//     incoming user, shift and cash custody.
//
//   * OPTION B. An opening difference is measured against what was EXPECTED
//     at the count point, never against the old boundary. Recorded stock
//     movement is not a shortage, and the two numeric fixtures below are the
//     whole of that claim: 100 + a recorded 10, counted 110, is zero; counted
//     108 is minus two. Never +10 and never +8.
//
//   * THE GATE IS REAL. A gated shift cannot collect, cannot serve, and is
//     not the branch's active shift. After verification all three work.
//
// The rollback and concurrency matrices live in the sibling
// `handover-010b-branch-custody-rollback.test.ts`.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { db, tag, teardownTaggedCafe } from "./helpers/db";
import { countCafe, countItem, COUNT_PASSWORD, type CountCafe } from "./helpers/count";
import { as, login, requireServer } from "./helpers/http";

const MARKER = tag("HANDOVER010");

type HandoverLib = typeof import("@/lib/handover");
const handoverLib = (): Promise<HandoverLib> => import("@/lib/handover");
type BoundaryLib = typeof import("@/lib/handover-boundary");
const boundaryLib = (): Promise<BoundaryLib> => import("@/lib/handover-boundary");
type CashCloseLib = typeof import("@/lib/cash-close");
const cashCloseLib = (): Promise<CashCloseLib> => import("@/lib/cash-close");
type CustodyLib = typeof import("@/lib/custody");
const custodyLib = (): Promise<CustodyLib> => import("@/lib/custody");
type ShiftsLib = typeof import("@/lib/shifts");
const shiftsLib = (): Promise<ShiftsLib> => import("@/lib/shifts");

/** Both handover grants, so the close itself is never the thing refusing. */
const GRANTS_FULL = { handoverSubmit: true, handoverException: true };

let fx: CountCafe;

// alpha and bravo are CRITICAL, so the handover's CRITICAL count reaches them
// and their boundaries are PHYSICAL_COUNT / verified. charlie is not, so its
// boundary is SYSTEM_CARRIED / unverified — which is what makes it the
// PERIOD_UNRESOLVED fixture at opening verification.
const ITEM_KEYS = ["alpha", "bravo", "charlie"] as const;
type ItemKey = (typeof ITEM_KEYS)[number];
const items: Record<ItemKey, { id: string; name: string }> = {} as never;

/** The cashier whose shift opens against branch-held stock. */
let opener: { id: string; email: string };
let handoverReasonId: string;
let stockReasonId: string;
let productId: string;

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

/** The opening balances every case starts from. */
const OPENING_STOCK: Record<ItemKey, string> = {
  alpha: "100",
  bravo: "100",
  charlie: "10",
};

async function restoreItems() {
  for (const key of ITEM_KEYS) {
    await db.inventoryItem.update({
      where: { id: items[key].id },
      data: {
        unit: "KG",
        isCritical: key !== "charlie",
        isActive: true,
        archivedAt: null,
        currentStock: OPENING_STOCK[key],
        costPerUnit: 450,
        name: items[key].name,
      },
    });
  }
}

/**
 * Empty the branch of everything a previous case created.
 *
 * Order is dictated by the schema's deliberate `Restrict` keys: evidence must
 * outlive the thing it describes, so acknowledgements and boundaries go
 * before lines, spans before the lines they close on, count sessions before
 * the handovers that cite them, and handovers before the custody periods
 * naming who was answerable.
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
    data: {
      lockedByHandoverId: null,
      handoverId: null,
      openingBranchCustodyPeriodId: null,
      accountabilityContext: "NONE",
    },
  });
  await db.stockCountRebase.deleteMany({ where: { session: { branchId } } });
  await db.stockCountSession.deleteMany({ where: { branchId } });
  await db.inventoryFreeze.deleteMany({ where: { branchId } });
  await db.openingException.deleteMany({ where: { branchId } });
  await db.handoverSession.deleteMany({ where: { branchId } });
  await db.tenderReconciliation.deleteMany({ where: { branchId } });
  await db.payment.deleteMany({ where: { branchId } });
  await db.inventoryTransaction.deleteMany({ where: { branchId } });
  await db.orderItemAddOn.deleteMany({ where: { orderItem: { order: { branchId } } } });
  await db.orderItem.deleteMany({ where: { order: { branchId } } });
  await db.order.deleteMany({ where: { branchId } });
  await db.shiftCustody.deleteMany({ where: { shift: { branchId } } });
  await db.custodyParticipant.deleteMany({ where: { custodyPeriod: { branchId } } });
  await db.custodyPeriod.updateMany({ where: { branchId }, data: { previousPeriodId: null } });
  await db.custodyPeriod.deleteMany({ where: { branchId } });
  await db.shift.deleteMany({ where: { branchId } });
  await restoreItems();
}

async function openOperationalShift(userId: string, openingCash = 100) {
  const last = await db.shift.aggregate({
    where: { branchId: fx.branchId },
    _max: { shiftNumber: true },
  });
  const shift = await db.shift.create({
    data: {
      cafeId: fx.cafeId,
      branchId: fx.branchId,
      cashierId: userId,
      shiftNumber: (last._max.shiftNumber ?? 0) + 1,
      openingCashAmount: openingCash,
      expectedCashAmount: openingCash,
    },
  });
  const { ensureCustodyForShift } = await custodyLib();
  await db.$transaction((tx) =>
    ensureCustodyForShift(tx, {
      cafeId: fx.cafeId,
      branchId: fx.branchId,
      shiftId: shift.id,
      userId,
      openingCashAmount: openingCash,
    }),
  );
  return shift;
}

// ───────────────────────────── HTTP drivers ──────────────────────────────

const post = <T = Record<string, unknown>>(email: string, body: unknown) =>
  as<T>(email, "/api/handovers", { method: "POST", body: JSON.stringify(body) });

const startCountHttp = (handoverId: string, email = fx.cashier.email) =>
  post<{ countSession: { id: string; reused: boolean } }>(email, {
    action: "start_count",
    handoverId,
  });

const patchLine = (email: string, sessionId: string, lineId: string, countedQuantity: number) =>
  as<{ error?: string }>(email, `/api/stock-counts/${sessionId}/lines/${lineId}`, {
    method: "PATCH",
    body: JSON.stringify({ countedQuantity }),
  });

const submitCount = (email: string, sessionId: string) =>
  as<{ error?: string }>(email, `/api/stock-counts/${sessionId}/submit`, {
    method: "POST",
    body: "{}",
  });

const acceptVariance = (email: string, sessionId: string, lineId: string) =>
  as<{ error?: string }>(
    email,
    `/api/stock-counts/${sessionId}/lines/${lineId}/accept-variance`,
    { method: "POST", body: JSON.stringify({ reasonCodeId: stockReasonId }) },
  );

const confirmCount = (email: string, sessionId: string, idempotencyKey: string) =>
  as<{ status?: string; error?: string }>(email, `/api/stock-counts/${sessionId}/confirm`, {
    method: "POST",
    body: JSON.stringify({ idempotencyKey }),
  });

const submitHandoverHttp = (handoverId: string, email = fx.cashier.email) =>
  post<{ status?: string; error?: string }>(email, { action: "submit", handoverId });

const ackPost = (email: string, handoverId: string, body: unknown) =>
  as<{ decision?: string; error?: string }>(
    email,
    `/api/handovers/${handoverId}/acknowledge`,
    { method: "POST", body: JSON.stringify(body) },
  );

const toBranchHttp = (handoverId: string, body: unknown, email = fx.manager.email) =>
  as<Record<string, unknown> & { error?: string }>(
    email,
    `/api/handovers/${handoverId}/to-branch-custody`,
    { method: "POST", body: JSON.stringify(body) },
  );

const acceptHttp = (handoverId: string, body: unknown, email = fx.manager.email) =>
  as<{ error?: string }>(email, `/api/handovers/${handoverId}/accept`, {
    method: "POST",
    body: JSON.stringify(body),
  });

const overrideHttp = (handoverId: string, body: unknown, email = fx.manager.email) =>
  as<{ error?: string }>(email, `/api/handovers/${handoverId}/override-accept`, {
    method: "POST",
    body: JSON.stringify(body),
  });

const openingHttp = <T = Record<string, unknown>>(email: string, body: unknown) =>
  as<T & { error?: string }>(email, "/api/custody/opening-verification", {
    method: "POST",
    body: JSON.stringify(body),
  });

const movement = (email: string, itemId: string, quantity: number) =>
  as<{ error?: string }>(email, `/api/inventory/${itemId}/movement`, {
    method: "POST",
    body: JSON.stringify({ type: "PURCHASE", quantity, unitCost: 450 }),
  });

// ────────────────────────── the Half A walk ──────────────────────────────

type Handover = {
  handoverId: string;
  shiftId: string;
  freezeId: string;
  outgoingStockCustodyId: string | null;
  outgoingCashCustodyId: string | null;
};

/**
 * A branch in exactly the state a `BRANCH_CUSTODY` close leaves it: the shift
 * AWAITING_HANDOVER with its money settled and its drawer already discharged,
 * an open freeze naming the handover, and a DRAFT handover carrying its
 * snapshot.
 */
async function freshBranchHandover(
  target: "SHIFT_TO_SHIFT" | "BRANCH_CUSTODY" = "BRANCH_CUSTODY",
): Promise<Handover> {
  await resetBranch(fx.branchId);
  const shift = await openOperationalShift(fx.cashier.id);
  const { closeShiftWithSettlement } = await cashCloseLib();
  const closed = await closeShiftWithSettlement({
    shiftId: shift.id,
    actualCash: 100,
    actorId: fx.cashier.id,
    closedByManager: false,
    handoverTarget: target,
    grants: GRANTS_FULL,
  });
  if (!closed.handoverId || !closed.freezeId) {
    throw new Error(`close produced no handover (status ${closed.status})`);
  }
  const handover = await db.handoverSession.findUniqueOrThrow({
    where: { id: closed.handoverId },
    select: { outgoingStockCustodyId: true, outgoingCashCustodyId: true },
  });
  return {
    handoverId: closed.handoverId,
    shiftId: shift.id,
    freezeId: closed.freezeId,
    outgoingStockCustodyId: handover.outgoingStockCustodyId,
    outgoingCashCustodyId: handover.outgoingCashCustodyId,
  };
}

/**
 * Capture, submit, settle and confirm a session through the real routes, in
 * the one order the disposition state machine permits.
 *
 * `counted` maps item id to figure; anything unnamed is counted at whatever
 * the shelf currently says, so an unmentioned item produces no variance.
 */
async function walkTheCount(
  sessionId: string,
  counted: Partial<Record<ItemKey, number>> = {},
  skip: readonly ItemKey[] = [],
) {
  const skipIds = new Set(skip.map((k) => items[k].id));
  const byId = new Map(ITEM_KEYS.map((k) => [items[k].id, k]));
  const lines = await db.stockCountLine.findMany({
    where: { sessionId },
    select: { id: true, inventoryItemId: true },
  });
  for (const line of lines) {
    if (skipIds.has(line.inventoryItemId)) continue;
    const key = byId.get(line.inventoryItemId);
    const figure =
      key && counted[key] !== undefined
        ? (counted[key] as number)
        : Number(
            (
              await db.inventoryItem.findUniqueOrThrow({
                where: { id: line.inventoryItemId },
                select: { currentStock: true },
              })
            ).currentStock,
          );
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
    const r = await acceptVariance(fx.manager.email, sessionId, line.id);
    assert.ok(r.status < 300, `accept-variance failed: ${r.text}`);
  }

  // A difference the tolerance FORGAVE is settled already, but a handover
  // still refuses to be submitted while any non-zero variance has no stated
  // reason. Stating it is the capture step's job, and this stands in for it.
  const forgiven = await db.stockCountLine.findMany({
    where: { sessionId, disposition: "WITHIN_TOLERANCE", reasonCodeId: null },
    select: { id: true, varianceQuantity: true },
  });
  for (const line of forgiven) {
    if (line.varianceQuantity === null || Number(line.varianceQuantity) === 0) continue;
    await db.stockCountLine.update({
      where: { id: line.id },
      data: { reasonCodeId: stockReasonId },
    });
  }
  return lines;
}

/** Sign for every counted line of a session. Nobody arrives, so a manager does. */
async function acknowledgeAll(handoverId: string, sessionId: string) {
  const lines = await db.stockCountLine.findMany({
    where: { sessionId, countedQuantity: { not: null } },
    select: { id: true },
  });
  for (const line of lines) {
    const r = await ackPost(fx.manager.email, handoverId, { stockCountLineId: line.id });
    assert.equal(r.status, 200, `acknowledge failed: ${r.text}`);
  }
  return lines.map((l) => l.id);
}

/** A `BRANCH_CUSTODY` handover ready for the manager to accept. */
async function readyForBranchCustody(
  counted: Partial<Record<ItemKey, number>> = {},
  skip: readonly ItemKey[] = [],
) {
  const h = await freshBranchHandover();
  const started = await startCountHttp(h.handoverId);
  assert.equal(started.status, 200, started.text);
  const sessionId = started.body.countSession.id;
  await walkTheCount(sessionId, counted, skip);
  const confirmed = await confirmCount(fx.manager.email, sessionId, `${MARKER}-${sessionId}`);
  assert.ok(confirmed.status < 300, `confirm failed: ${confirmed.text}`);
  const submitted = await submitHandoverHttp(h.handoverId);
  assert.equal(submitted.status, 200, submitted.text);
  await acknowledgeAll(h.handoverId, sessionId);
  return { ...h, sessionId };
}

// ─────────────────────────────── service calls ───────────────────────────

let keySeq = 0;
const nextKey = () => `${MARKER}-key-${(keySeq += 1)}`;

async function acceptToBranch(
  handoverId: string,
  overrides: Partial<{
    managerId: string;
    idempotencyKey: string;
    omissionReasonCodeId: string;
    omissionNote: string;
    cafeId: string;
    viewerBranchId: string | null;
    __afterStep: (step: number, tx: unknown) => Promise<void>;
  }> = {},
) {
  const { acceptToBranchCustody } = await handoverLib();
  return acceptToBranchCustody({
    handoverId,
    managerId: overrides.managerId ?? fx.manager.id,
    idempotencyKey: overrides.idempotencyKey ?? nextKey(),
    omissionReasonCodeId: overrides.omissionReasonCodeId,
    omissionNote: overrides.omissionNote,
    cafeId: overrides.cafeId ?? fx.cafeId,
    viewerBranchId:
      overrides.viewerBranchId === undefined ? fx.branchId : overrides.viewerBranchId,
    __afterStep: overrides.__afterStep as never,
  });
}

const statusIs = (status: number) => (error: unknown) =>
  (error as { status?: number }).status === status;

// ────────────────────────── the Half B walk ──────────────────────────────

/** The opening shift: OPEN, holding a drawer, and gated on the shelf. */
async function openGatedShift() {
  const shift = await openOperationalShift(opener.id, 50);
  const row = await db.shift.findUniqueOrThrow({ where: { id: shift.id } });
  assert.equal(
    row.custodyGateReason,
    "AWAITING_OPENING_VERIFICATION",
    "a shift opening against branch-held stock holds nothing until it verifies it",
  );
  return shift;
}

/** Start the opening count through the route, and walk it to CONFIRMED. */
async function walkOpeningCount(
  shiftId: string,
  counted: Partial<Record<ItemKey, number>>,
) {
  const started = await openingHttp<{ countSession: { id: string; reused: boolean } }>(
    opener.email,
    { action: "start_count", shiftId },
  );
  assert.equal(started.status, 200, started.text);
  const sessionId = started.body.countSession.id;
  await walkTheCount(sessionId, counted);
  const confirmed = await confirmCount(fx.manager.email, sessionId, `${MARKER}-${sessionId}`);
  assert.ok(confirmed.status < 300, `opening confirm failed: ${confirmed.text}`);
  return sessionId;
}

/**
 * The whole lifecycle: branch takes the shelf, a shift opens gated, counts,
 * and verifies. The Option B fixtures live here — alpha and bravo close at
 * 100, each receives a recorded 10, and the opening count finds 110 and 108.
 */
async function verifiedOpening(counted: Partial<Record<ItemKey, number>> = {}) {
  const ready = await readyForBranchCustody();
  const accepted = await acceptToBranch(ready.handoverId);

  // The recorded movement Option B must not blame anybody for. It goes
  // through the real movement route, which also proves the freeze released.
  for (const key of ["alpha", "bravo"] as const) {
    const r = await movement(fx.manager.email, items[key].id, 10);
    assert.equal(r.status, 200, `recorded receipt refused: ${r.text}`);
  }

  const shift = await openGatedShift();
  const sessionId = await walkOpeningCount(shift.id, {
    alpha: 110,
    bravo: 108,
    charlie: 9,
    ...counted,
  });
  return { ready, accepted, shift, sessionId };
}

const verify = (shiftId: string, countSessionId: string, email = opener.email) =>
  openingHttp<{
    status?: string;
    branchCustodyPeriodId?: string;
    incomingStockCustodyId?: string;
    countStatus?: string;
    varianceCaseIds?: string[];
    spanIds?: string[];
    alreadyVerified?: boolean;
    cashCustodyPeriodId?: string | null;
  }>(email, { action: "verify", shiftId, countSessionId });

// ──────────────────────────────── fixture ────────────────────────────────

before(async () => {
  await requireServer();
  fx = await countCafe("HANDOVER010");

  for (const key of ITEM_KEYS) {
    const created = await countItem(fx, key, {
      stock: Number(OPENING_STOCK[key]),
      isCritical: key !== "charlie",
    });
    items[key] = { id: created.id, name: created.name };
  }

  const hash = await bcrypt.hash(COUNT_PASSWORD, 10);
  opener = await db.user.create({
    data: {
      email: `${fx.marker.toLowerCase()}-opener@example.invalid`,
      name: `${fx.marker}-opener`,
      passwordHash: hash,
      role: "CASHIER",
      cafeId: fx.cafeId,
      branchId: fx.branchId,
    },
    select: { id: true, email: true },
  });
  await login(opener.email, COUNT_PASSWORD);

  handoverReasonId = (
    await db.reasonCode.create({
      data: {
        cafeId: fx.cafeId,
        domain: "HANDOVER",
        code: `${MARKER}-H`,
        label: "استثناء تسليم",
      },
    })
  ).id;
  stockReasonId = (
    await db.reasonCode.create({
      data: {
        cafeId: fx.cafeId,
        domain: "STOCK",
        code: `${MARKER}-S`,
        label: "فرق جرد",
      },
    })
  ).id;

  const category = await db.menuCategory.create({
    data: { cafeId: fx.cafeId, name: `${MARKER} cat` },
  });
  const product = await db.product.create({
    data: { cafeId: fx.cafeId, categoryId: category.id, name: `${MARKER} item`, basePrice: 20 },
  });
  await db.recipe.create({
    data: {
      cafeId: fx.cafeId,
      productId: product.id,
      notApplicable: true,
      notApplicableReason: "Test fixture — exercises the custody gate, consumes no stock",
    },
  });
  productId = product.id;

  await configureBranch();
});

// `resetBranch` first: the purge discovers its tables by their `cafeId`
// column, and `HandoverStockAcknowledgement` has none — it hangs off the
// handover — so one leftover acknowledgement pins the user who signed it, and
// the whole café graph behind them.
after(() =>
  teardownTaggedCafe(fx?.cafeId, [() => resetBranch(fx.branchId)], { disconnect: true }),
);

// ══════════════════════════════ HALF A ═══════════════════════════════════

describe("SH-22 Half A · the branch takes the shelf", () => {
  test("a BRANCH_CUSTODY handover completes with nobody holding the stock", async () => {
    const ready = await readyForBranchCustody();

    const before = await db.handoverSession.findUniqueOrThrow({
      where: { id: ready.handoverId },
      select: { target: true, resolvedTarget: true },
    });
    assert.equal(before.target, "BRANCH_CUSTODY");
    assert.equal(before.resolvedTarget, null, "nothing has resolved it yet");

    const result = await acceptToBranch(ready.handoverId);

    assert.equal(result.status, "COMPLETED");
    assert.equal(result.handoverTarget, "BRANCH_CUSTODY");
    assert.equal(result.resolvedTarget, "BRANCH_CUSTODY");
    assert.equal(result.alreadyAccepted, false);
    assert.equal(result.acceptedStockCountSessionId, ready.sessionId);
    assert.equal(result.incomingShiftId, null, "nobody arrives");
    assert.equal(result.incomingUserId, null, "and nobody is named");
    assert.equal(result.incomingCashCustodyId, null, "and no drawer moves");

    const persisted = await db.handoverSession.findUniqueOrThrow({
      where: { id: ready.handoverId },
    });
    assert.equal(persisted.status, "COMPLETED");
    assert.equal(
      persisted.target,
      "BRANCH_CUSTODY",
      "the immutable target is read, never rewritten",
    );
    assert.equal(persisted.resolvedTarget, "BRANCH_CUSTODY");
    assert.equal(persisted.incomingShiftId, null);
    assert.equal(persisted.incomingUserId, null);
    assert.equal(persisted.incomingCashCustodyId, null);
    assert.equal(persisted.incomingStockCustodyId, result.incomingStockCustodyId);
    assert.ok(persisted.acceptedAt, "an acceptance instant was established");

    // ── the successor holds nothing that could be read as a person ──
    const successor = await db.custodyPeriod.findUniqueOrThrow({
      where: { id: result.incomingStockCustodyId! },
      include: { participants: true, shiftLinks: true },
    });
    assert.equal(successor.scope, "STOCK");
    assert.equal(successor.holderType, "BRANCH");
    assert.equal(successor.status, "OPEN");
    assert.equal(successor.participants.length, 0, "a branch custody has no participants");
    assert.equal(successor.shiftLinks.length, 0, "and is attached to no shift");
    assert.equal(successor.responsibleShiftId, null, "and no shift answers for it");
    assert.equal(successor.openedById, fx.manager.id, "the manager put it there");
    assert.equal(successor.previousPeriodId, ready.outgoingStockCustodyId);

    const predecessor = await db.custodyPeriod.findUniqueOrThrow({
      where: { id: ready.outgoingStockCustodyId! },
    });
    assert.equal(predecessor.status, "TRANSFERRED");
    assert.equal(
      predecessor.acceptedById,
      fx.manager.id,
      "the manager accepted the custody being discharged",
    );
    assert.ok(predecessor.acceptedAt);
  });

  test("the drawer was already closed, and this acceptance does not touch it", async () => {
    const ready = await readyForBranchCustody();
    const cashBefore = await db.custodyPeriod.findUniqueOrThrow({
      where: { id: ready.outgoingCashCustodyId! },
    });
    assert.equal(
      cashBefore.status,
      "CLOSED",
      "a BRANCH_CUSTODY close discharges the drawer at financial close",
    );

    await acceptToBranch(ready.handoverId);

    const cashAfter = await db.custodyPeriod.findUniqueOrThrow({
      where: { id: ready.outgoingCashCustodyId! },
    });
    assert.equal(cashAfter.status, "CLOSED");
    assert.equal(
      cashAfter.endedAt?.getTime(),
      cashBefore.endedAt?.getTime(),
      "the acceptance did not re-close it",
    );
    assert.equal(
      await db.custodyPeriod.count({
        where: { branchId: fx.branchId, scope: "CASH", status: "OPEN" },
      }),
      0,
      "and opened no successor — nobody was appointed to hold it",
    );
  });

  test("the outgoing shift closes, by the manager, and the freeze is released", async () => {
    const ready = await readyForBranchCustody();
    const result = await acceptToBranch(ready.handoverId);
    assert.equal(result.outgoingShiftStatus, "CLOSED");

    const shift = await db.shift.findUniqueOrThrow({ where: { id: ready.shiftId } });
    assert.equal(shift.status, "CLOSED");
    assert.equal(shift.closedById, fx.manager.id);
    assert.ok(shift.stockClosedAt, "the shelf became a fact");
    assert.ok(shift.financiallyClosedAt, "the money already had");

    const freeze = await db.inventoryFreeze.findUniqueOrThrow({ where: { id: ready.freezeId } });
    assert.ok(freeze.releasedAt, "the shelf is open again");

    // Legitimate movement works, which is what a released freeze MEANS.
    const moved = await movement(fx.manager.email, items.alpha.id, 10);
    assert.equal(moved.status, 200, moved.text);
    const alpha = await db.inventoryItem.findUniqueOrThrow({ where: { id: items.alpha.id } });
    assert.equal(Number(alpha.currentStock), 110);

    // And a future handover can freeze the branch again.
    const next = await openOperationalShift(fx.cashier.id);
    const { closeShiftWithSettlement } = await cashCloseLib();
    const closed = await closeShiftWithSettlement({
      shiftId: next.id,
      actualCash: 100,
      actorId: fx.cashier.id,
      closedByManager: false,
      handoverTarget: "SHIFT_TO_SHIFT",
      grants: GRANTS_FULL,
    });
    assert.ok(closed.freezeId, "a later handover acquired its own freeze");
  });

  test("the accepted evidence is locked, rebased and turned into a boundary", async () => {
    const ready = await readyForBranchCustody({ alpha: 98 });
    const result = await acceptToBranch(ready.handoverId);

    const session = await db.stockCountSession.findUniqueOrThrow({
      where: { id: ready.sessionId },
    });
    assert.equal(session.status, "LOCKED");
    assert.equal(
      session.lockedByHandoverId,
      ready.handoverId,
      "a handover acceptance still names itself on the lock",
    );

    assert.ok(result.rebase, "the shelf was moved to match the count");
    const alpha = await db.inventoryItem.findUniqueOrThrow({ where: { id: items.alpha.id } });
    assert.equal(Number(alpha.currentStock), 98);

    // One boundary row per ACTIVE item, counted or carried.
    const boundaries = await db.handoverStockBoundary.findMany({
      where: { handoverId: ready.handoverId },
      select: { inventoryItemId: true, source: true, verified: true },
    });
    assert.equal(boundaries.length, 3, "the whole shelf, not just the counted part");
    const byItem = new Map(boundaries.map((b) => [b.inventoryItemId, b]));
    assert.equal(byItem.get(items.alpha.id)?.source, "PHYSICAL_COUNT");
    assert.equal(byItem.get(items.alpha.id)?.verified, true);
    assert.equal(
      byItem.get(items.charlie.id)?.source,
      "SYSTEM_CARRIED",
      "an item outside the CRITICAL scope was not observed",
    );
    assert.equal(byItem.get(items.charlie.id)?.verified, false);
  });

  test("a completed acceptance is audited once, as an acceptance", async () => {
    const ready = await readyForBranchCustody();
    await acceptToBranch(ready.handoverId);

    const rows = await db.auditLog.findMany({
      where: {
        cafeId: fx.cafeId,
        action: "HANDOVER_ACCEPTED",
        entityId: ready.handoverId,
      },
    });
    assert.equal(rows.length, 1);
    const details = rows[0].details as Record<string, unknown>;
    assert.equal(details.resolvedTarget, "BRANCH_CUSTODY");
    assert.equal(details.incomingShiftId, null);
    assert.equal(details.incomingUserId, null);
    assert.equal(details.incomingCashCustodyId, null);
    assert.equal(rows[0].userId, fx.manager.id);
  });
});

describe("SH-22 Half A · what it refuses", () => {
  test("SH-20's ordinary accept still refuses a BRANCH_CUSTODY handover", async () => {
    const ready = await readyForBranchCustody();
    const r = await acceptHttp(ready.handoverId, { idempotencyKey: nextKey() });
    assert.equal(r.status, 409, r.text);
    assert.match(r.body.error ?? "", /المركزية/);

    const untouched = await db.handoverSession.findUniqueOrThrow({
      where: { id: ready.handoverId },
    });
    assert.notEqual(untouched.status, "COMPLETED");
  });

  test("SH-21's override still refuses a BRANCH_CUSTODY handover", async () => {
    const ready = await readyForBranchCustody();
    const r = await overrideHttp(ready.handoverId, {
      idempotencyKey: nextKey(),
      reasonCodeId: handoverReasonId,
      note: "manager finishing",
      kind: "MANAGER_ADJUSTMENT",
    });
    assert.equal(r.status, 409, r.text);

    const untouched = await db.handoverSession.findUniqueOrThrow({
      where: { id: ready.handoverId },
    });
    assert.notEqual(untouched.status, "COMPLETED");
  });

  test("this route refuses a SHIFT_TO_SHIFT handover", async () => {
    await resetBranch(fx.branchId);
    const shift = await openOperationalShift(fx.cashier.id);
    const { closeShiftWithSettlement } = await cashCloseLib();
    const closed = await closeShiftWithSettlement({
      shiftId: shift.id,
      actualCash: 100,
      actorId: fx.cashier.id,
      closedByManager: false,
      handoverTarget: "SHIFT_TO_SHIFT",
      grants: GRANTS_FULL,
    });
    const started = await startCountHttp(closed.handoverId!);
    const sessionId = started.body.countSession.id;
    await walkTheCount(sessionId);
    await confirmCount(fx.manager.email, sessionId, `${MARKER}-${sessionId}`);
    await submitHandoverHttp(closed.handoverId!);
    await acknowledgeAll(closed.handoverId!, sessionId);

    await assert.rejects(() => acceptToBranch(closed.handoverId!), statusIs(409));
  });

  test("R-A1 — a shift already waiting for a transfer is a deterministic refusal", async () => {
    const ready = await readyForBranchCustody();
    // A shift that opened while the handover was live. It is gated on
    // AWAITING_CUSTODY_TRANSFER, and branch custody names nobody to release
    // it, so completing would strand it forever.
    const waiting = await openOperationalShift(opener.id, 50);
    const gate = await db.shift.findUniqueOrThrow({ where: { id: waiting.id } });
    assert.equal(gate.custodyGateReason, "AWAITING_CUSTODY_TRANSFER");

    await assert.rejects(() => acceptToBranch(ready.handoverId), statusIs(409));
    const r = await toBranchHttp(ready.handoverId, { idempotencyKey: nextKey() });
    assert.equal(r.status, 409, r.text);
    assert.match(r.body.error ?? "", /وردية مستنية العهدة/);

    // Nothing was written. The refusal is before the first write.
    const handover = await db.handoverSession.findUniqueOrThrow({
      where: { id: ready.handoverId },
    });
    assert.notEqual(handover.status, "COMPLETED");
    assert.equal(handover.resolvedTarget, null);
    assert.equal(
      await db.handoverStockBoundary.count({ where: { handoverId: ready.handoverId } }),
      0,
    );
    const custody = await db.custodyPeriod.findUniqueOrThrow({
      where: { id: ready.outgoingStockCustodyId! },
    });
    assert.equal(custody.status, "OPEN");
  });

  test("an uncounted required item refuses without a manager's reason", async () => {
    const ready = await readyForBranchCustody({}, ["bravo"]);
    await assert.rejects(() => acceptToBranch(ready.handoverId), statusIs(409));

    const required = await db.handoverRequiredItem.findMany({
      where: { handoverId: ready.handoverId },
      select: { omitted: true, omissionNote: true },
    });
    assert.ok(
      required.every((r) => !r.omitted && r.omissionNote === null),
      "a refused acceptance leaves the omission rows exactly as they were",
    );
  });

  test("half an authorisation is refused before the row lock", async () => {
    const ready = await readyForBranchCustody({}, ["bravo"]);
    // A reason with no note, and a note with no reason. Either alone is
    // somebody believing they authorised an omission when they did not.
    await assert.rejects(
      () => acceptToBranch(ready.handoverId, { omissionReasonCodeId: handoverReasonId }),
      statusIs(400),
    );
    await assert.rejects(
      () => acceptToBranch(ready.handoverId, { omissionNote: "bravo was not reached" }),
      statusIs(400),
    );
    // A whitespace note beside a reason is the same half-authorisation, and
    // is refused by the trim rather than written as an empty justification.
    await assert.rejects(
      () =>
        acceptToBranch(ready.handoverId, {
          omissionReasonCodeId: handoverReasonId,
          omissionNote: "   ",
        }),
      statusIs(400),
    );
    // And nothing at all is not an authorisation either — it is the ordinary
    // refusal, 409, from the settlement gate.
    await assert.rejects(() => acceptToBranch(ready.handoverId), statusIs(409));
  });

  test("another café's handover is not confirmed to exist", async () => {
    const ready = await readyForBranchCustody();
    await assert.rejects(
      () => acceptToBranch(ready.handoverId, { cafeId: `${MARKER}-nope` }),
      statusIs(404),
    );
  });
});

describe("SH-22 Half A · the manager's omission, and idempotency", () => {
  test("a manager may finish over an uncounted item, and it is recorded", async () => {
    const ready = await readyForBranchCustody({}, ["bravo"]);
    const result = await acceptToBranch(ready.handoverId, {
      omissionReasonCodeId: handoverReasonId,
      omissionNote: "closing early — bravo not reached",
    });

    assert.equal(result.status, "COMPLETED");
    assert.deepEqual(result.missingItemIds, [items.bravo.id]);
    assert.ok(result.openingExceptionId, "the authority became a record");

    const exception = await db.openingException.findUniqueOrThrow({
      where: { id: result.openingExceptionId! },
    });
    assert.equal(
      exception.kind,
      "MANAGER_ADJUSTMENT",
      "NO_INCOMING is not manufactured — nobody was expected to arrive",
    );
    assert.equal(exception.authorizedById, fx.manager.id);
    assert.equal(exception.reasonCodeId, handoverReasonId);

    // Nobody counted bravo, so its boundary says so and names nobody.
    const boundary = await db.handoverStockBoundary.findFirstOrThrow({
      where: { handoverId: ready.handoverId, inventoryItemId: items.bravo.id },
    });
    assert.equal(boundary.source, "SYSTEM_CARRIED");
    assert.equal(boundary.verified, false);

    const exceptionAudit = await db.auditLog.count({
      where: {
        cafeId: fx.cafeId,
        action: "HANDOVER_MANAGER_EXCEPTION",
        entityId: ready.handoverId,
      },
    });
    assert.equal(exceptionAudit, 1, "the authority is audited under its own name");
  });

  test("a retry with the same key reads persisted state and writes nothing", async () => {
    const ready = await readyForBranchCustody();
    const key = `${MARKER}-replay-${ready.handoverId}`;
    const first = await acceptToBranch(ready.handoverId, { idempotencyKey: key });

    const auditBefore = await db.auditLog.count({
      where: { cafeId: fx.cafeId, entityId: ready.handoverId },
    });
    const second = await acceptToBranch(ready.handoverId, { idempotencyKey: key });

    assert.equal(second.alreadyAccepted, true);
    assert.equal(second.status, "COMPLETED");
    assert.equal(second.resolvedTarget, "BRANCH_CUSTODY");
    assert.equal(second.incomingStockCustodyId, first.incomingStockCustodyId);
    assert.deepEqual(second.varianceCaseIds, first.varianceCaseIds);
    assert.equal(
      second.rebase,
      null,
      "a replay rebased nothing, and does not restate the first call's work",
    );
    assert.equal(
      await db.auditLog.count({ where: { cafeId: fx.cafeId, entityId: ready.handoverId } }),
      auditBefore,
      "a replay wrote no audit row",
    );
    assert.equal(
      await db.custodyPeriod.count({
        where: { branchId: fx.branchId, scope: "STOCK", holderType: "BRANCH" },
      }),
      1,
      "and no second branch custody",
    );
  });

  test("a different key after completion is a controlled 409", async () => {
    const ready = await readyForBranchCustody();
    await acceptToBranch(ready.handoverId, { idempotencyKey: `${MARKER}-first` });
    await assert.rejects(
      () => acceptToBranch(ready.handoverId, { idempotencyKey: `${MARKER}-second` }),
      statusIs(409),
    );
  });

  test("the route derives every identity, and refuses a body that states one", async () => {
    const ready = await readyForBranchCustody();
    for (const forbidden of [
      { managerId: fx.cashier.id },
      { incomingUserId: opener.id },
      { incomingShiftId: ready.shiftId },
      { resolvedTarget: "SHIFT_TO_SHIFT" },
      { target: "SHIFT_TO_SHIFT" },
      { acceptedStockCountSessionId: ready.sessionId },
    ]) {
      const r = await toBranchHttp(ready.handoverId, {
        idempotencyKey: nextKey(),
        ...forbidden,
      });
      assert.equal(r.status, 400, `${JSON.stringify(forbidden)} was not refused: ${r.text}`);
    }

    // And the clean body works, with the manager taken from the session.
    const ok = await toBranchHttp(ready.handoverId, { idempotencyKey: nextKey() });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.resolvedTarget, "BRANCH_CUSTODY");
    const persisted = await db.handoverSession.findUniqueOrThrow({
      where: { id: ready.handoverId },
    });
    assert.equal(persisted.exceptionById, null, "no exception on a clean acceptance");
  });
});

// ══════════════════════════════ HALF B ═══════════════════════════════════

describe("SH-22 Half B · the gated shift", () => {
  test("a shift opening against branch-held stock can neither collect nor serve", async () => {
    const ready = await readyForBranchCustody();
    await acceptToBranch(ready.handoverId);
    const shift = await openGatedShift();

    const { getActiveShift, requireCashCustody } = await shiftsLib();
    assert.equal(
      await getActiveShift(fx.branchId, opener.id),
      null,
      "a gated shift is not the branch's active shift",
    );
    await assert.rejects(() => requireCashCustody(fx.branchId, opener.id), statusIs(400));

    // ── SELL: the POS refuses the order outright ──
    const order = await as<{ error?: string }>(opener.email, "/api/orders", {
      method: "POST",
      body: JSON.stringify({
        type: "TAKEAWAY",
        collectionMode: "PENDING",
        items: [{ productId, quantity: 1 }],
        branchId: fx.branchId,
      }),
    });
    assert.equal(order.status, 400, `an order was taken while gated: ${order.text}`);

    // ── COLLECT and SERVE: on an order the branch already had ──
    //
    // Built directly, because the POS will not create one for a gated shift —
    // which is the refusal proved a line above. An order taken before the
    // custody moved is an ordinary state, and it is the only way to put the
    // collection and serving gates in front of this shift at all.
    const standing = await db.order.create({
      data: {
        cafeId: fx.cafeId,
        branchId: fx.branchId,
        orderNumber: 900_000 + (keySeq += 1),
        type: "TAKEAWAY",
        // READY, so the only thing standing between it and SERVED is the
        // custody gate rather than the kitchen state machine.
        status: "READY",
        source: "CASHIER_POS",
        subtotal: 20,
        taxAmount: 0,
        discountAmount: 0,
        serviceChargeAmount: 0,
        total: 20,
        // Already settled, so the only thing standing between it and SERVED
        // is the custody gate rather than the payment one.
        remainingAmount: 0,
        paymentStatus: "PAID",
        createdById: fx.manager.id,
        items: {
          create: [
            {
              productId,
              productName: `${MARKER} item`,
              unitPrice: 20,
              quantity: 1,
              lineTotal: 20,
            },
          ],
        },
        // The settlement the serving gate reads. Without it the refusal
        // below would be about money rather than about custody, which is not
        // the thing being proved.
        payments: {
          create: [
            {
              cafeId: fx.cafeId,
              branchId: fx.branchId,
              amount: 20,
              method: "CASH",
              receivedById: fx.manager.id,
            },
          ],
        },
      },
      select: { id: true },
    });

    const pay = await as<{ error?: string }>(opener.email, "/api/payments", {
      method: "POST",
      body: JSON.stringify({ orderId: standing.id, amount: 20, method: "CASH" }),
    });
    assert.equal(pay.status, 400, `collection was allowed while gated: ${pay.text}`);

    const serve = await as<{ error?: string }>(opener.email, `/api/orders/${standing.id}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status: "SERVED" }),
    });
    assert.equal(
      serve.status,
      409,
      `serving was allowed while the BRANCH held the stock: ${serve.text}`,
    );

    void shift;
  });

  test("the opening count is FULL, server-derived, and bound to the branch custody", async () => {
    const ready = await readyForBranchCustody();
    const accepted = await acceptToBranch(ready.handoverId);
    const shift = await openGatedShift();

    const started = await openingHttp<{
      countSession: { id: string; type: string; scopeItemIds: string[]; reused: boolean };
      branchCustodyPeriodId: string;
    }>(opener.email, { action: "start_count", shiftId: shift.id });
    assert.equal(started.status, 200, started.text);
    assert.equal(started.body.countSession.type, "FULL");
    assert.equal(started.body.countSession.reused, false);
    assert.equal(
      started.body.branchCustodyPeriodId,
      accepted.incomingStockCustodyId,
      "the count is bound to the custody it is discharging",
    );
    assert.deepEqual(
      [...started.body.countSession.scopeItemIds].sort(),
      ITEM_KEYS.map((k) => items[k].id).sort(),
      "the WHOLE active shelf — the handover's CRITICAL policy does not narrow it",
    );

    const session = await db.stockCountSession.findUniqueOrThrow({
      where: { id: started.body.countSession.id },
      include: { lines: true },
    });
    assert.equal(session.accountabilityContext, "BRANCH_OPENING_VERIFICATION");
    assert.equal(session.handoverId, null, "no handover answers for this count");
    assert.equal(session.openingBranchCustodyPeriodId, accepted.incomingStockCustodyId);
    assert.equal(session.custodyPeriodId, accepted.incomingStockCustodyId);
    assert.equal(session.shiftId, shift.id);
    assert.equal(session.type, "FULL");
    assert.equal(session.scopeDerivation, "ALL_ELIGIBLE");
    assert.equal(session.lines.length, 3);
    assert.ok(session.lines.every((l) => l.disposition === "PENDING"));

    // A retry returns the same count and creates nothing.
    const again = await openingHttp<{ countSession: { id: string; reused: boolean } }>(
      opener.email,
      { action: "start_count", shiftId: shift.id },
    );
    assert.equal(again.status, 200, again.text);
    assert.equal(again.body.countSession.id, started.body.countSession.id);
    assert.equal(again.body.countSession.reused, true);
    assert.equal(
      await db.stockCountSession.count({
        where: { branchId: fx.branchId, accountabilityContext: "BRANCH_OPENING_VERIFICATION" },
      }),
      1,
      "no duplicate session",
    );
  });

  test("the generic count route cannot forge this context", async () => {
    const ready = await readyForBranchCustody();
    await acceptToBranch(ready.handoverId);
    await openGatedShift();

    const forged = await as<{ error?: string }>(opener.email, "/api/stock-counts", {
      method: "POST",
      body: JSON.stringify({
        type: "FULL",
        accountabilityContext: "BRANCH_OPENING_VERIFICATION",
        branchId: fx.branchId,
      }),
    });
    assert.ok(
      forged.status >= 400 || true,
      "whatever the generic route does, it must not produce this context",
    );
    const forgedSessions = await db.stockCountSession.count({
      where: {
        branchId: fx.branchId,
        accountabilityContext: "BRANCH_OPENING_VERIFICATION",
      },
    });
    assert.equal(
      forgedSessions,
      0,
      "the generic stock-count route cannot client-force a branch opening verification",
    );
  });

  test("an incomplete opening count refuses at submit — there is no gap to state", async () => {
    const ready = await readyForBranchCustody();
    await acceptToBranch(ready.handoverId);
    const shift = await openGatedShift();

    const started = await openingHttp<{ countSession: { id: string } }>(opener.email, {
      action: "start_count",
      shiftId: shift.id,
    });
    const sessionId = started.body.countSession.id;

    const lines = await db.stockCountLine.findMany({
      where: { sessionId },
      select: { id: true, inventoryItemId: true },
    });
    // Every line but one.
    for (const line of lines.filter((l) => l.inventoryItemId !== items.charlie.id)) {
      const r = await patchLine(fx.manager.email, sessionId, line.id, 100);
      assert.ok(r.status < 300, r.text);
    }

    const submitted = await submitCount(fx.manager.email, sessionId);
    assert.equal(
      submitted.status,
      400,
      `an opening verification must not be able to state a gap: ${submitted.text}`,
    );

    const session = await db.stockCountSession.findUniqueOrThrow({ where: { id: sessionId } });
    assert.equal(session.status, "DRAFT" === session.status ? "DRAFT" : "IN_PROGRESS");
    assert.notEqual(session.status, "SUBMITTED");
  });

  test("confirming an opening count opens no cases — accountability is deferred", async () => {
    const ready = await readyForBranchCustody();
    await acceptToBranch(ready.handoverId);
    for (const key of ["alpha", "bravo"] as const) {
      await movement(fx.manager.email, items[key].id, 10);
    }
    const shift = await openGatedShift();
    const sessionId = await walkOpeningCount(shift.id, { alpha: 110, bravo: 108, charlie: 9 });

    const session = await db.stockCountSession.findUniqueOrThrow({
      where: { id: sessionId },
      include: { lines: { select: { id: true, disposition: true } } },
    });
    assert.equal(session.status, "CONFIRMED");
    assert.ok(
      session.lines.every((l) => l.disposition !== "PENDING"),
      "no PENDING line survives into a CONFIRMED opening count",
    );
    assert.equal(
      await db.varianceCase.count({
        where: { stockCountLineId: { in: session.lines.map((l) => l.id) } },
      }),
      0,
      "confirmation opens nothing — the verification answers for the figures",
    );
  });
});

describe("SH-22 Half B · Option B, and who answers", () => {
  test("recorded stock movement is not a variance, and a real gap still is", async () => {
    const { ready, accepted, shift, sessionId } = await verifiedOpening();
    void ready;

    const lines = await db.stockCountLine.findMany({
      where: { sessionId },
      select: {
        id: true,
        inventoryItemId: true,
        expectedQuantity: true,
        countedQuantity: true,
        varianceQuantity: true,
      },
    });
    const byItem = new Map(lines.map((l) => [l.inventoryItemId, l]));

    // ── Case A: 100 + a recorded 10, counted 110 ──
    const alpha = byItem.get(items.alpha.id)!;
    assert.equal(Number(alpha.expectedQuantity), 110, "the receipt moved the expectation");
    assert.equal(Number(alpha.countedQuantity), 110);
    assert.equal(Number(alpha.varianceQuantity), 0);

    // ── Case B: the same, counted 108 ──
    const bravo = byItem.get(items.bravo.id)!;
    assert.equal(Number(bravo.expectedQuantity), 110);
    assert.equal(Number(bravo.countedQuantity), 108);
    assert.equal(Number(bravo.varianceQuantity), -2);

    const result = await verify(shift.id, sessionId);
    assert.equal(result.status, 200, result.text);

    const cases = await db.varianceCase.findMany({
      where: { stockCountLineId: { in: lines.map((l) => l.id) } },
      include: { varianceSpan: { include: { custodyLinks: true } } },
    });
    const caseByItem = new Map(
      cases.map((c) => [
        lines.find((l) => l.id === c.stockCountLineId)!.inventoryItemId,
        c,
      ]),
    );

    assert.equal(
      caseByItem.has(items.alpha.id),
      false,
      "a zero effective variance opens NO case — the receipt is not a shortage",
    );

    const bravoCase = caseByItem.get(items.bravo.id);
    assert.ok(bravoCase, "a real gap is still a case");
    assert.equal(
      Number(bravoCase!.quantityVariance),
      -2,
      "minus two: the gap against what was expected, never +8 and never +10",
    );
    assert.equal(
      bravoCase!.attribution,
      "BRANCH_CUSTODY",
      "a verified prior boundary and one branch custody throughout",
    );
    assert.equal(bravoCase!.custodyPeriodId, accepted.incomingStockCustodyId);
    assert.equal(bravoCase!.varianceSpan, null, "a resolved attribution needs no span");
    assert.equal(bravoCase!.acceptedHandoverId, null, "no handover accepted this evidence");
    assert.equal(bravoCase!.shiftId, null, "and no shift is named");
    assert.equal(
      bravoCase!.assignedResponsibilityUserId,
      null,
      "and no employee is on the hook",
    );

    // ── the carried boundary: nobody observed it, so nobody answers ──
    const charlieCase = caseByItem.get(items.charlie.id);
    assert.ok(charlieCase, "a gap on an unverified chain is still recorded");
    assert.equal(Number(charlieCase!.quantityVariance), -1);
    assert.equal(charlieCase!.attribution, "PERIOD_UNRESOLVED");
    assert.equal(charlieCase!.custodyPeriodId, null, "there is no custody to name");
    assert.equal(charlieCase!.assignedResponsibilityUserId, null);

    const span = charlieCase!.varianceSpan;
    assert.ok(span, "an unresolved difference records the interval it crossed");
    assert.equal(
      span!.toBoundaryId,
      null,
      "an opening verification writes no boundary, and invents none",
    );
    assert.equal(
      span!.toStockCountLineId,
      charlieCase!.stockCountLineId,
      "the accepted opening line IS the evidence that found the gap",
    );
    assert.equal(
      span!.fromBoundaryId,
      null,
      "a carried boundary is not an observation, so the span starts nowhere",
    );
    assert.equal(span!.fromVerifiedAt, null);
    assert.ok(span!.custodyLinks.length > 0, "every custody the interval crossed is joinable");
    assert.ok(
      span!.custodyLinks.some((l) => l.custodyPeriodId === accepted.incomingStockCustodyId),
      "including the branch custody being discharged",
    );

    // The span closed at the ACCEPTANCE, not at the count.
    const line = lines.find((l) => l.id === charlieCase!.stockCountLineId)!;
    const countedAt = (
      await db.stockCountLine.findUniqueOrThrow({
        where: { id: line.id },
        select: { countedAt: true },
      })
    ).countedAt!;
    assert.ok(
      span!.toVerifiedAt.getTime() > countedAt.getTime(),
      "toVerifiedAt is when the evidence was ACCEPTED, not when it was written down",
    );
  });
});

describe("SH-22 Half B · custody, lock and gate", () => {
  test("verification rebases, locks the count with no handover, and hands over", async () => {
    const { accepted, shift, sessionId } = await verifiedOpening();
    const cashBefore = await db.custodyPeriod.findFirstOrThrow({
      where: { branchId: fx.branchId, scope: "CASH", status: "OPEN" },
    });

    const result = await verify(shift.id, sessionId);
    assert.equal(result.status, 200, result.text);
    assert.equal(result.body.status, "VERIFIED");
    assert.equal(result.body.alreadyVerified, false);
    assert.equal(result.body.branchCustodyPeriodId, accepted.incomingStockCustodyId);
    assert.equal(result.body.countStatus, "LOCKED");

    // ── the count ──
    const session = await db.stockCountSession.findUniqueOrThrow({ where: { id: sessionId } });
    assert.equal(session.status, "LOCKED");
    assert.equal(
      session.lockedByHandoverId,
      null,
      "no handover locked this count, and none is borrowed to fill the column",
    );
    assert.ok(session.lockedAt);

    // ── the shelf ──
    const bravo = await db.inventoryItem.findUniqueOrThrow({ where: { id: items.bravo.id } });
    assert.equal(Number(bravo.currentStock), 108, "the shelf matches what was counted");
    assert.equal(
      await db.stockCountRebase.count({ where: { sessionId } }),
      3,
      "every counted line was rebased",
    );

    // ── the custody ──
    const predecessor = await db.custodyPeriod.findUniqueOrThrow({
      where: { id: accepted.incomingStockCustodyId! },
    });
    assert.equal(predecessor.status, "TRANSFERRED");
    assert.equal(predecessor.acceptedById, opener.id, "the verifier accepted it");
    assert.ok(predecessor.acceptedAt);

    const successor = await db.custodyPeriod.findUniqueOrThrow({
      where: { id: result.body.incomingStockCustodyId! },
      include: { participants: true, shiftLinks: true },
    });
    assert.equal(successor.holderType, "USER");
    assert.equal(successor.status, "OPEN");
    assert.equal(successor.previousPeriodId, accepted.incomingStockCustodyId);
    assert.equal(successor.responsibleShiftId, shift.id, "a shift answers for it");
    assert.deepEqual(
      successor.participants.map((p) => [p.userId, p.role]),
      [[opener.id, "PRIMARY"]],
    );
    assert.deepEqual(
      successor.shiftLinks.map((l) => [l.shiftId, l.scope]),
      [[shift.id, "STOCK"]],
    );

    // ── the drawer, asserted and untouched ──
    const cashAfter = await db.custodyPeriod.findUniqueOrThrow({ where: { id: cashBefore.id } });
    assert.equal(cashAfter.status, "OPEN");
    assert.equal(cashAfter.updatedAt.getTime(), cashBefore.updatedAt.getTime());
    assert.equal(result.body.cashCustodyPeriodId, cashBefore.id);

    // ── the gate ──
    const gated = await db.shift.findUniqueOrThrow({ where: { id: shift.id } });
    assert.equal(gated.custodyGateReason, null);
    assert.ok(gated.custodyReadyAt);
    assert.equal(gated.status, "OPEN");

    const audits = await db.auditLog.findMany({
      where: {
        cafeId: fx.cafeId,
        action: "BRANCH_CUSTODY_VERIFIED",
        entityId: accepted.incomingStockCustodyId!,
      },
    });
    assert.equal(audits.length, 1);
    assert.equal(audits[0].userId, opener.id);
  });

  test("after verification the shift may collect and serve", async () => {
    const { shift, sessionId } = await verifiedOpening();
    const done = await verify(shift.id, sessionId);
    assert.equal(done.status, 200, done.text);

    const { getActiveShift, requireCashCustody } = await shiftsLib();
    const active = await getActiveShift(fx.branchId, opener.id);
    assert.equal(active?.id, shift.id, "the shift is operational");
    assert.ok(await requireCashCustody(fx.branchId, opener.id));

    const order = await as<{ order?: { id: string } }>(opener.email, "/api/orders", {
      method: "POST",
      body: JSON.stringify({
        type: "TAKEAWAY",
        collectionMode: "PENDING",
        items: [{ productId, quantity: 1 }],
        branchId: fx.branchId,
      }),
    });
    assert.equal(order.status, 201, order.text);
    const orderId = order.body.order!.id;

    const pay = await as<{ error?: string }>(opener.email, "/api/payments", {
      method: "POST",
      body: JSON.stringify({ orderId, amount: 20, method: "CASH" }),
    });
    assert.ok(pay.status < 300, `collection still refused after verification: ${pay.text}`);

    for (const step of ["PREPARING", "READY"] as const) {
      const moved = await as<{ error?: string }>(
        opener.email,
        `/api/orders/${orderId}/status`,
        { method: "PATCH", body: JSON.stringify({ status: step }) },
      );
      assert.ok(moved.status < 300, `${step} refused: ${moved.text}`);
    }
    const serve = await as<{ error?: string }>(opener.email, `/api/orders/${orderId}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status: "SERVED" }),
    });
    assert.ok(serve.status < 300, `serving still refused after verification: ${serve.text}`);

    const served = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    assert.equal(
      served.servedShiftId,
      shift.id,
      "and the sale is attributable to the shift that took the shelf",
    );
  });
});

describe("SH-22 Half B · replay and refusal", () => {
  test("verifying the accepted session again writes nothing", async () => {
    const { shift, sessionId } = await verifiedOpening();
    const first = await verify(shift.id, sessionId);
    assert.equal(first.status, 200, first.text);

    const counts = async () => ({
      cases: await db.varianceCase.count({ where: { branchId: fx.branchId } }),
      spans: await db.stockVarianceSpan.count({
        where: { varianceCase: { branchId: fx.branchId } },
      }),
      custody: await db.custodyPeriod.count({ where: { branchId: fx.branchId } }),
      links: await db.shiftCustody.count({ where: { shift: { branchId: fx.branchId } } }),
      rebases: await db.stockCountRebase.count({ where: { sessionId } }),
      audits: await db.auditLog.count({ where: { cafeId: fx.cafeId } }),
    });
    const before = await counts();

    const second = await verify(shift.id, sessionId);
    assert.equal(second.status, 200, second.text);
    assert.equal(second.body.alreadyVerified, true);
    assert.equal(second.body.status, "VERIFIED");
    assert.equal(second.body.incomingStockCustodyId, first.body.incomingStockCustodyId);
    assert.equal(second.body.countStatus, "LOCKED");
    assert.deepEqual(second.body.varianceCaseIds, first.body.varianceCaseIds);
    assert.deepEqual(second.body.spanIds, first.body.spanIds);

    assert.deepEqual(await counts(), before, "a structural replay writes nothing at all");
  });

  test("a different session after the transfer is a conflict, not a retry", async () => {
    const { accepted, shift, sessionId } = await verifiedOpening();
    await verify(shift.id, sessionId);

    // A second session naming the same, now-transferred, branch custody.
    // Unreachable through the start route — which is the point — so it is
    // built directly to prove the verify gate refuses it on its own.
    const impostor = await db.stockCountSession.create({
      data: {
        cafeId: fx.cafeId,
        branchId: fx.branchId,
        shiftId: shift.id,
        custodyPeriodId: accepted.incomingStockCustodyId,
        openingBranchCustodyPeriodId: accepted.incomingStockCustodyId,
        accountabilityContext: "BRANCH_OPENING_VERIFICATION",
        type: "FULL",
        status: "CONFIRMED",
        scopeDerivation: "ALL_ELIGIBLE",
        initiatedById: fx.manager.id,
      },
      select: { id: true },
    });

    const r = await verify(shift.id, impostor.id);
    assert.equal(r.status, 409, r.text);
    assert.equal(
      await db.stockCountSession.count({ where: { id: impostor.id, status: "LOCKED" } }),
      0,
      "the impostor was not locked",
    );
  });

  test("starting an opening count refuses once the branch no longer holds the stock", async () => {
    const { shift, sessionId } = await verifiedOpening();
    await verify(shift.id, sessionId);

    const again = await openingHttp(opener.email, {
      action: "start_count",
      shiftId: shift.id,
    });
    assert.equal(again.status, 409, again.text);
  });

  test("two gated shifts are an ambiguity rather than a choice", async () => {
    const ready = await readyForBranchCustody();
    await acceptToBranch(ready.handoverId);
    const first = await openGatedShift();
    const second = await openOperationalShift(fx.cashier.id, 40);
    assert.equal(
      (await db.shift.findUniqueOrThrow({ where: { id: second.id } })).custodyGateReason,
      "AWAITING_OPENING_VERIFICATION",
    );

    const started = await openingHttp(opener.email, {
      action: "start_count",
      shiftId: first.id,
    });
    assert.equal(started.status, 409, started.text);
    assert.match(started.body.error ?? "", /أكتر من وردية/);
  });

  test("an unconfirmed count cannot be verified", async () => {
    const ready = await readyForBranchCustody();
    await acceptToBranch(ready.handoverId);
    const shift = await openGatedShift();
    const started = await openingHttp<{ countSession: { id: string } }>(opener.email, {
      action: "start_count",
      shiftId: shift.id,
    });
    const sessionId = started.body.countSession.id;

    const r = await verify(shift.id, sessionId);
    assert.equal(r.status, 409, r.text);

    const custody = await db.custodyPeriod.findFirstOrThrow({
      where: { branchId: fx.branchId, scope: "STOCK", status: "OPEN" },
    });
    assert.equal(custody.holderType, "BRANCH", "the branch still holds the shelf");
  });
});
