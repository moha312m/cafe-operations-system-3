// HANDOVER-009b — SH-21: a failed override leaves the branch exactly as it
// found it, and two hands reaching for one exception get one of them.
//
// The sibling `handover-009-override-accept.test.ts` pins what an override
// DOES. This suite pins the two properties visible only when it does not
// finish, and each needs a different kind of proof:
//
//   * THE ROLLBACK MATRIX. An override is SH-20's single transaction with one
//     more write in it, and that write is the dangerous one: an
//     `OpeningException` surviving a rolled-back acceptance would claim a
//     manager authorised a handover that never happened, and would sit in the
//     record with nothing to contradict it. So the matrix fails inside the
//     transaction at each of eleven points — including immediately after the
//     exception row is created — and looks at what committed, every time on a
//     connection that was never inside the aborted transaction.
//
//   * THE CONCURRENCY MATRIX. Real transactions, real row locks, real unique
//     indexes on real PostgreSQL. Exactly-once for the `OpeningException` is
//     claimed WITHOUT a unique constraint — it rests on the status guard in
//     the step-14 completion write — so nothing but a real race proves it.
//
// After every injected failure the suite also proves the state is not merely
// unchanged but still USABLE: a clean override afterwards succeeds. A rollback
// that left the branch consistent and un-overridable would satisfy every
// assertion about absence and still be a defect.

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import { db, tag, teardownTaggedCafe } from "./helpers/db";
import { countCafe, countItem, COUNT_PASSWORD, type CountCafe } from "./helpers/count";
import { as, login, requireServer } from "./helpers/http";

const MARKER = tag("HANDOVER009B");

type HandoverLib = typeof import("@/lib/handover");
const handoverLib = (): Promise<HandoverLib> => import("@/lib/handover");
type CashCloseLib = typeof import("@/lib/cash-close");
const cashCloseLib = (): Promise<CashCloseLib> => import("@/lib/cash-close");
type CustodyLib = typeof import("@/lib/custody");
const custodyLib = (): Promise<CustodyLib> => import("@/lib/custody");

const GRANTS_FULL = { handoverSubmit: true, handoverException: true };

let fx: CountCafe;
// `charlie` is the required item whose line disappears, so every override
// below has a real omission to settle and a real exception to record.
const ITEM_KEYS = ["alpha", "bravo", "charlie"] as const;
type ItemKey = (typeof ITEM_KEYS)[number];
const items: Record<ItemKey, { id: string; name: string }> = {} as never;
let incoming: { id: string; email: string };
let handoverReasonId: string;
let stockReasonId: string;

/**
 * A connection that was never inside the aborted transaction.
 *
 * Reading through the shared client would answer the same question most of the
 * time and would not be proof: what is being ruled out is a write that escaped
 * the caller's rollback, and only an outside observer can see one.
 */
const observer = new PrismaClient();

async function configureBranch() {
  await db.cafeSettings.update({
    where: { cafeId: fx.cafeId },
    data: {
      stockCountPolicy: "HYBRID", handoverCountType: "CRITICAL",
      periodicFullCountSchedule: "MANUAL_ONLY", periodicFullCountWeekday: null,
      varianceBlocksHandover: false, varianceHardBlockAmount: null,
    },
  });
  await db.branch.update({
    where: { id: fx.branchId },
    data: {
      stockCountPolicyOverride: null, handoverCountTypeOverride: null,
      periodicFullCountScheduleOverride: null, periodicFullCountWeekdayOverride: null,
    },
  });
}

async function restoreItems() {
  for (const key of ITEM_KEYS) {
    await db.inventoryItem.update({
      where: { id: items[key].id },
      data: {
        unit: "KG", isCritical: true, isActive: true, archivedAt: null,
        currentStock: "10", costPerUnit: 450,
      },
    });
  }
}

/** Empty the branch, in the order the schema's `Restrict` keys dictate. */
async function resetBranch(branchId: string) {
  await db.handoverStockAcknowledgement.deleteMany({ where: { handover: { branchId } } });
  await db.handoverStockBoundary.deleteMany({ where: { handover: { branchId } } });
  await db.handoverRequiredItem.updateMany({
    where: { handover: { branchId } }, data: { satisfiedByLineId: null },
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

const post = <T = Record<string, unknown>>(email: string, body: unknown) =>
  as<T>(email, "/api/handovers", { method: "POST", body: JSON.stringify(body) });

const startCountHttp = (handoverId: string) =>
  post<{ countSession: { id: string } }>(
    fx.cashier.email, { action: "start_count", handoverId },
  );

const patchLine = (sessionId: string, lineId: string, countedQuantity: number) =>
  as<{ error?: string }>(fx.manager.email, `/api/stock-counts/${sessionId}/lines/${lineId}`, {
    method: "PATCH", body: JSON.stringify({ countedQuantity }),
  });

const acceptVariance = (sessionId: string, lineId: string) =>
  as<{ error?: string }>(
    fx.manager.email, `/api/stock-counts/${sessionId}/lines/${lineId}/accept-variance`,
    { method: "POST", body: JSON.stringify({ reasonCodeId: stockReasonId }) },
  );

const ackPost = (handoverId: string, body: unknown) =>
  as<{ error?: string }>(incoming.email, `/api/handovers/${handoverId}/acknowledge`, {
    method: "POST", body: JSON.stringify(body) });

const overridePost = (handoverId: string, body: unknown) =>
  as<{ status?: string; alreadyAccepted?: boolean; openingExceptionId?: string; error?: string }>(
    fx.manager.email, `/api/handovers/${handoverId}/override-accept`,
    { method: "POST", body: JSON.stringify(body) },
  );

type Ready = {
  handoverId: string;
  outgoingShiftId: string;
  incomingShiftId: string;
  sessionId: string;
  freezeId: string;
  outgoingStockCustodyId: string;
  outgoingCashCustodyId: string | null;
  /** The required item nobody counted. */
  missingItemId: string;
  alphaVersionBefore: bigint;
  alphaStockBefore: number;
  /**
   * The outgoing shift's close columns BEFORE the override.
   *
   * `closedById` and `closedAt` are not null here: the financial close already
   * wrote them when the money became a fact. Step 13 overwrites them with the
   * acceptor and the moment the shelf changed hands, so a rollback has to
   * restore what was there — asserting NULL would assert a state that never
   * existed.
   */
  outgoingBefore: {
    status: string;
    closedAt: Date | null;
    closedById: string | null;
    stockClosedAt: Date | null;
  };
};

/**
 * A branch one step from an OVERRIDE: a confirmed, acknowledged count with one
 * required item left unmeasured, a shift waiting for custody, and a freeze the
 * handover owns.
 *
 * `alpha` is counted short on purpose, so every run below has a rebase to
 * apply and a variance case to open — a rollback matrix against a handover
 * with nothing to undo would prove nothing. `charlie`'s line is removed after
 * the review, the way `handover-008` reaches the same state, so the omission
 * an ordinary accept refuses is genuinely present.
 */
async function readyToOverride(): Promise<Ready> {
  await resetBranch(fx.branchId);
  const outgoing = await openOperationalShift(fx.cashier.id);
  const { closeShiftWithSettlement } = await cashCloseLib();
  const closed = await closeShiftWithSettlement({
    shiftId: outgoing.id, actualCash: 100, actorId: fx.cashier.id,
    closedByManager: false, handoverTarget: "SHIFT_TO_SHIFT", grants: GRANTS_FULL,
  });
  if (!closed.handoverId || !closed.freezeId) {
    throw new Error(`close produced no handover: ${JSON.stringify(closed.handoverConfigIssue)}`);
  }
  const handoverId = closed.handoverId;

  const started = await startCountHttp(handoverId);
  assert.equal(started.status, 200, started.text);
  const sessionId = started.body.countSession.id;

  const lines = await db.stockCountLine.findMany({
    where: { sessionId }, select: { id: true, inventoryItemId: true },
  });
  for (const line of lines) {
    // charlie is never PATCHed: nobody reached that shelf. The line stays in
    // scope and PENDING, which is what makes the required item omitted and
    // gives the manager something to override. It used to be DELETED here,
    // after the round was signed for, because the count engine refused to
    // submit a session carrying a null figure — a corruption standing in for
    // a workflow, and the thing that hid SH-21 being unreachable.
    if (line.inventoryItemId === items.charlie.id) continue;
    const figure = line.inventoryItemId === items.alpha.id ? 9 : 10;
    const r = await patchLine(sessionId, line.id, figure);
    assert.ok(r.status < 300, `capture failed: ${r.text}`);
  }
  const submitted = await as<{ error?: string }>(
    fx.manager.email, `/api/stock-counts/${sessionId}/submit`, { method: "POST", body: "{}" },
  );
  assert.ok(submitted.status < 300, `count submit failed: ${submitted.text}`);
  for (const line of await db.stockCountLine.findMany({
    where: { sessionId, disposition: { in: ["OUTSIDE_TOLERANCE", "RECOUNT_REQUIRED"] } },
    select: { id: true },
  })) {
    const r = await acceptVariance(sessionId, line.id);
    assert.ok(r.status < 300, `accept-variance failed: ${r.text}`);
  }
  const confirmed = await as<{ error?: string }>(
    fx.manager.email, `/api/stock-counts/${sessionId}/confirm`,
    { method: "POST", body: JSON.stringify({ idempotencyKey: `${MARKER}-${sessionId}` }) },
  );
  assert.ok(confirmed.status < 300, `confirm failed: ${confirmed.text}`);
  const handoverSubmitted = await post<{ error?: string }>(
    fx.cashier.email, { action: "submit", handoverId },
  );
  assert.equal(handoverSubmitted.status, 200, handoverSubmitted.text);

  const incomingShift = await openOperationalShift(incoming.id);
  // Only the lines carrying a figure need signing. charlie has none, and the
  // evidence gate does not ask for a signature on a shelf nobody reached — so
  // the ONLY refusal left is the omission SH-21 authorises past.
  for (const line of lines) {
    if (line.inventoryItemId === items.charlie.id) continue;
    const r = await ackPost(handoverId, { stockCountLineId: line.id });
    assert.equal(r.status, 200, `acknowledge failed: ${r.text}`);
  }

  const handover = await db.handoverSession.findUniqueOrThrow({ where: { id: handoverId } });
  const alpha = await db.inventoryItem.findUniqueOrThrow({ where: { id: items.alpha.id } });
  const outgoingRow = await db.shift.findUniqueOrThrow({ where: { id: outgoing.id } });
  return {
    handoverId,
    outgoingShiftId: outgoing.id,
    incomingShiftId: incomingShift.id,
    sessionId,
    freezeId: closed.freezeId,
    outgoingStockCustodyId: handover.outgoingStockCustodyId!,
    outgoingCashCustodyId: handover.outgoingCashCustodyId,
    missingItemId: items.charlie.id,
    alphaVersionBefore: alpha.ledgerVersion,
    alphaStockBefore: Number(alpha.currentStock),
    outgoingBefore: {
      status: outgoingRow.status,
      closedAt: outgoingRow.closedAt,
      closedById: outgoingRow.closedById,
      stockClosedAt: outgoingRow.stockClosedAt,
    },
  };
}

type OverrideArgs = {
  idempotencyKey?: string;
  managerId?: string;
  kind?: "MANAGER_ADJUSTMENT" | "NO_INCOMING";
  note?: string;
  __afterStep?: (step: number, tx: unknown) => Promise<void>;
};

async function override(handoverId: string, o: OverrideArgs = {}) {
  const { overrideAcceptHandover } = await handoverLib();
  return overrideAcceptHandover({
    handoverId,
    managerId: o.managerId ?? fx.manager.id,
    reasonCodeId: handoverReasonId,
    note: o.note ?? "الجرد ماكملش والفرع لازم يفتح",
    kind: o.kind ?? "MANAGER_ADJUSTMENT",
    idempotencyKey: o.idempotencyKey ?? `${MARKER}-${handoverId}-${Math.random()}`,
    cafeId: fx.cafeId,
    viewerBranchId: fx.branchId,
    __afterStep: o.__afterStep as never,
  });
}

async function accept(handoverId: string, idempotencyKey?: string) {
  const { acceptHandover } = await handoverLib();
  return acceptHandover({
    handoverId,
    incomingUserId: incoming.id,
    idempotencyKey: idempotencyKey ?? `${MARKER}-acc-${handoverId}-${Math.random()}`,
    cafeId: fx.cafeId,
    viewerBranchId: fx.branchId,
  });
}

before(async () => {
  await requireServer();
  fx = await countCafe("HANDOVER009B");
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
      cafeId: fx.cafeId, domain: "HANDOVER", code: `${MARKER}-HO`, label: "استثناء",
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
  await teardownTaggedCafe(
    fx?.cafeId,
    [
      () => resetBranch(fx.branchId),
      () => resetBranch(fx.otherBranchId),
      () => observer.$disconnect(),
    ],
    { disconnect: true },
  );
});

/**
 * Everything a completed override would have written, asked over a connection
 * that was never inside the transaction.
 *
 * One function rather than eleven copies, because the assertion after every
 * injection is the same assertion: nothing.
 */
async function assertNothingCommitted(r: Ready, step: number) {
  const where = `after step ${step}`;

  const handover = await observer.handoverSession.findUniqueOrThrow({
    where: { id: r.handoverId },
  });
  assert.notEqual(handover.status, "COMPLETED", `${where}: the handover completed`);
  assert.notEqual(handover.status, "MANAGER_EXCEPTION", `${where}: status moved`);
  assert.equal(handover.acceptedStockCountSessionId, null, `${where}: accepted pointer`);
  assert.equal(handover.acceptedAt, null, `${where}: acceptedAt`);
  assert.equal(handover.completedAt, null, `${where}: completedAt`);
  assert.equal(handover.resolvedTarget, null, `${where}: resolvedTarget`);
  assert.equal(handover.idempotencyKey, null, `${where}: idempotencyKey`);
  assert.equal(handover.incomingStockCustodyId, null, `${where}: incoming stock custody`);
  assert.equal(handover.incomingCashCustodyId, null, `${where}: incoming cash custody`);

  // SH-21's own three columns. An authority that outlived the acceptance it
  // authorised would be the worst of the survivals: unfalsifiable afterwards.
  assert.equal(handover.exceptionById, null, `${where}: EXCEPTION AUTHORITY SURVIVED`);
  assert.equal(handover.exceptionReason, null, `${where}: exceptionReason survived`);
  assert.equal(handover.exceptionAt, null, `${where}: exceptionAt survived`);

  assert.equal(
    await observer.openingException.count({ where: { handoverId: r.handoverId } }), 0,
    `${where}: AN OpeningException SURVIVED A ROLLED-BACK OVERRIDE`,
  );

  // The omission flags are exactly as settlement found them.
  const required = await observer.handoverRequiredItem.findMany({
    where: { handoverId: r.handoverId },
  });
  assert.ok(required.length > 0, `${where}: fixture invariant`);
  for (const row of required) {
    assert.equal(row.omitted, false, `${where}: an omitted flag survived`);
    assert.equal(row.omissionNote, null, `${where}: an omission note survived`);
    assert.equal(row.satisfiedByLineId, null, `${where}: a settlement survived`);
  }

  const session = await observer.stockCountSession.findUniqueOrThrow({
    where: { id: r.sessionId },
  });
  assert.equal(session.status, "CONFIRMED", `${where}: the accepted count was locked`);
  assert.equal(session.lockedByHandoverId, null, `${where}: lockedByHandoverId`);

  assert.equal(
    await observer.stockCountRebase.count({ where: { sessionId: r.sessionId } }), 0,
    `${where}: a rebase record survived`,
  );
  assert.equal(
    await observer.inventoryTransaction.count({
      where: { branchId: fx.branchId, type: "COUNT_REBASE" },
    }),
    0,
    `${where}: a COUNT_REBASE ledger row survived`,
  );
  const alpha = await observer.inventoryItem.findUniqueOrThrow({
    where: { id: items.alpha.id },
  });
  assert.equal(Number(alpha.currentStock), r.alphaStockBefore, `${where}: the shelf moved`);
  assert.equal(alpha.ledgerVersion, r.alphaVersionBefore, `${where}: the version moved`);

  assert.equal(
    await observer.handoverStockBoundary.count({ where: { handoverId: r.handoverId } }), 0,
    `${where}: a boundary row survived`,
  );
  assert.equal(
    await observer.varianceCase.count({ where: { acceptedHandoverId: r.handoverId } }), 0,
    `${where}: a variance case survived`,
  );
  assert.equal(
    await observer.stockVarianceSpan.count({
      where: { varianceCase: { branchId: fx.branchId } },
    }),
    0,
    `${where}: a variance span survived`,
  );

  const outgoingCustody = await observer.custodyPeriod.findUniqueOrThrow({
    where: { id: r.outgoingStockCustodyId },
  });
  assert.equal(outgoingCustody.status, "OPEN", `${where}: the outgoing custody moved`);
  assert.equal(outgoingCustody.endedAt, null, `${where}: endedAt`);
  assert.equal(outgoingCustody.acceptedById, null, `${where}: acceptedById`);
  assert.equal(
    await observer.custodyPeriod.count({
      where: { previousPeriodId: r.outgoingStockCustodyId },
    }),
    0,
    `${where}: a successor custody survived`,
  );

  const incomingShift = await observer.shift.findUniqueOrThrow({
    where: { id: r.incomingShiftId },
  });
  assert.equal(
    incomingShift.custodyGateReason, "AWAITING_CUSTODY_TRANSFER",
    `${where}: the arriving shift's gate opened`,
  );
  assert.equal(incomingShift.custodyReadyAt, null, `${where}: custodyReadyAt`);

  const outgoingShift = await observer.shift.findUniqueOrThrow({
    where: { id: r.outgoingShiftId },
  });
  assert.equal(
    outgoingShift.status, "AWAITING_HANDOVER", `${where}: the outgoing shift closed`,
  );
  assert.equal(
    outgoingShift.closedById, r.outgoingBefore.closedById,
    `${where}: closedById was rewritten`,
  );
  assert.equal(
    outgoingShift.stockClosedAt, null,
    `${where}: stockClosedAt — only acceptance writes it, so it must still be absent`,
  );

  const freeze = await observer.inventoryFreeze.findUniqueOrThrow({
    where: { id: r.freezeId },
  });
  assert.equal(
    freeze.releasedAt, null,
    `${where}: THE FREEZE WAS RELEASED — the shelf was reopened by an override that failed`,
  );

  for (const action of ["HANDOVER_ACCEPTED", "HANDOVER_MANAGER_EXCEPTION"]) {
    assert.equal(
      await observer.auditLog.count({
        where: { cafeId: fx.cafeId, action, entityId: r.handoverId },
      }),
      0,
      `${where}: a ${action} row recorded something that did not happen`,
    );
  }
}

/** The override committed exactly once, whatever raced it. */
async function assertOverriddenExactlyOnce(r: Ready) {
  const handover = await observer.handoverSession.findUniqueOrThrow({
    where: { id: r.handoverId },
  });
  assert.equal(handover.status, "COMPLETED");
  assert.equal(handover.exceptionById, fx.manager.id);
  assert.equal(
    await observer.openingException.count({ where: { handoverId: r.handoverId } }), 1,
    "exactly one OpeningException, with no unique index to enforce it",
  );
  assert.equal(
    await observer.handoverStockBoundary.count({ where: { handoverId: r.handoverId } }), 3,
    "one boundary row per active item, written once",
  );
  assert.equal(
    await observer.stockCountRebase.count({ where: { sessionId: r.sessionId } }), 2,
    "one rebase per counted line, applied once",
  );
  assert.equal(
    await observer.auditLog.count({
      where: {
        cafeId: fx.cafeId, action: "HANDOVER_MANAGER_EXCEPTION", entityId: r.handoverId,
      },
    }),
    1,
    "one exception audit row",
  );
  assert.equal(
    await observer.custodyPeriod.count({
      where: { previousPeriodId: r.outgoingStockCustodyId },
    }),
    1,
    "one successor stock custody",
  );
  const missing = await observer.handoverRequiredItem.findFirstOrThrow({
    where: { handoverId: r.handoverId, inventoryItemId: r.missingItemId },
  });
  assert.equal(missing.omitted, true);
  assert.ok(missing.omissionNote);
}

// ═════════════════════════ the rollback matrix ═══════════════════════════

const STEPS: { step: number; what: string }[] = [
  { step: 5, what: "omission settlement" },
  { step: 6, what: "the stock rebase" },
  { step: 7, what: "boundary persistence" },
  { step: 8, what: "the accepted count lock" },
  { step: 9, what: "variance-case creation" },
  { step: 10, what: "the STOCK custody transfer" },
  { step: 11, what: "the CASH custody transfer" },
  { step: 12, what: "the incoming gate release" },
  { step: 13, what: "outgoing shift finalization" },
  { step: 14, what: "the completion write, before the exception row" },
  { step: 14.5, what: "OpeningException creation, before the freeze release" },
  { step: 15, what: "the freeze release, with everything else already written" },
];

describe("SH-21 rollback matrix", () => {
  for (const { step, what } of STEPS) {
    test(`a failure after ${what} leaves the branch as it was`, async () => {
      const r = await readyToOverride();

      await assert.rejects(
        () =>
          override(r.handoverId, {
            __afterStep: async (reached) => {
              if (reached === step) throw new Error(`HANDOVER-009B injected at ${step}`);
            },
          }),
        new RegExp(`HANDOVER-009B injected at ${step}`),
      );

      await assertNothingCommitted(r, step);

      // And the branch is not merely unchanged but still usable. A rollback
      // that left consistent, un-overridable state would satisfy every
      // assertion above and still be a defect.
      const clean = await override(r.handoverId);
      assert.equal(clean.status, "COMPLETED", `after step ${step}, the retry could not override`);
      assert.equal(clean.alreadyAccepted, false);
      assert.ok(clean.openingExceptionId);
      assert.deepEqual(clean.missingItemIds, [r.missingItemId]);
    });
  }
});

// ══════════════════════ the concurrency matrix ═══════════════════════════

describe("SH-21 concurrency", () => {
  test("two overrides with the SAME key produce exactly one exception", async () => {
    const r = await readyToOverride();
    const key = `${MARKER}-same-${r.handoverId}`;
    const outcomes = await Promise.allSettled([
      override(r.handoverId, { idempotencyKey: key }),
      override(r.handoverId, { idempotencyKey: key }),
    ]);

    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    assert.ok(fulfilled.length >= 1, "at least one override had to succeed");
    const performed = fulfilled.filter(
      (o) => (o as PromiseFulfilledResult<{ alreadyAccepted: boolean }>).value.alreadyAccepted === false,
    );
    assert.equal(performed.length, 1, "exactly one call performed the override");

    // Whoever replayed saw the winner's exception, not a second one.
    const ids = new Set(
      fulfilled.map(
        (o) => (o as PromiseFulfilledResult<{ openingExceptionId: string }>).value.openingExceptionId,
      ),
    );
    assert.equal(ids.size, 1, "both callers name the same OpeningException");
    await assertOverriddenExactlyOnce(r);
  });

  test("two overrides with DIFFERENT keys produce exactly one exception", async () => {
    const r = await readyToOverride();
    const outcomes = await Promise.allSettled([
      override(r.handoverId, { idempotencyKey: `${MARKER}-a-${r.handoverId}` }),
      override(r.handoverId, { idempotencyKey: `${MARKER}-b-${r.handoverId}` }),
    ]);
    assert.equal(
      outcomes.filter((o) => o.status === "fulfilled").length, 1,
      "the loser is refused rather than overriding a second time",
    );
    await assertOverriddenExactlyOnce(r);
  });

  test("an ordinary accept racing an override leaves one winner and no partial state", async () => {
    const r = await readyToOverride();
    const outcomes = await Promise.allSettled([
      accept(r.handoverId),
      override(r.handoverId),
    ]);

    // The ordinary accept CANNOT win: the required set is incomplete, and step
    // 5 refuses it whether it arrives first, second or simultaneously. Only
    // the override can finish this handover, and it finishes it once.
    const acceptOutcome = outcomes[0];
    assert.equal(
      acceptOutcome.status, "rejected",
      "an ordinary accept must never pass an incomplete required set, even in a race",
    );
    const overrideOutcome = outcomes[1];
    assert.equal(overrideOutcome.status, "fulfilled", "the override is the only way through");
    await assertOverriddenExactlyOnce(r);
  });

  test("an override racing a recount request leaves one winner and no partial state", async () => {
    const r = await readyToOverride();
    const { requestRecount } = await handoverLib();

    const outcomes = await Promise.allSettled([
      override(r.handoverId),
      requestRecount({
        handoverId: r.handoverId,
        incomingUserId: incoming.id,
        reasonCodeId: handoverReasonId,
        note: "عايز إعادة جرد",
        cafeId: fx.cafeId,
        viewerBranchId: fx.branchId,
      }),
    ]);

    const overrideWon = outcomes[0].status === "fulfilled";
    const recountWon = outcomes[1].status === "fulfilled";
    assert.notEqual(
      overrideWon, recountWon,
      "exactly one of accept-by-exception and send-it-back may win",
    );

    if (overrideWon) {
      await assertOverriddenExactlyOnce(r);
    } else {
      // The recount won: the handover went back to be counted again, and NO
      // exception was recorded against a handover nobody finished.
      const handover = await observer.handoverSession.findUniqueOrThrow({
        where: { id: r.handoverId },
      });
      assert.notEqual(handover.status, "COMPLETED");
      assert.equal(handover.exceptionById, null);
      assert.equal(
        await observer.openingException.count({ where: { handoverId: r.handoverId } }), 0,
      );
      assert.equal(
        await observer.handoverStockBoundary.count({ where: { handoverId: r.handoverId } }), 0,
      );
    }
  });

  test("an override racing an acknowledgement leaves one winner and no partial state", async () => {
    const r = await readyToOverride();
    // A line of the CURRENT round that was signed for, then unsigned, so the
    // acknowledgement below is a real one arriving mid-acceptance.
    const line = await db.stockCountLine.findFirstOrThrow({
      where: { sessionId: r.sessionId, inventoryItemId: items.bravo.id },
      select: { id: true },
    });
    await db.handoverStockAcknowledgement.deleteMany({
      where: { stockCountLineId: line.id },
    });

    const { acknowledgeStockLine } = await handoverLib();
    const outcomes = await Promise.allSettled([
      override(r.handoverId),
      acknowledgeStockLine({
        handoverId: r.handoverId,
        stockCountLineId: line.id,
        acknowledgedById: incoming.id,
        cafeId: fx.cafeId,
        viewerBranchId: fx.branchId,
      }),
    ]);

    // Both orderings are legitimate, and the invariant is the same either way:
    // an override may only complete over a FULLY SIGNED round. The
    // acknowledgement gate is not among the refusals a manager's exception
    // reaches, so whether it holds depends on which transaction reached the
    // handover's row lock first — never on the exception.
    assert.equal(
      outcomes[1].status, "fulfilled",
      "the acknowledgement itself is never the loser of this race",
    );

    const handover = await observer.handoverSession.findUniqueOrThrow({
      where: { id: r.handoverId },
    });

    if (outcomes[0].status === "fulfilled") {
      // The signature landed before the gate read it. Then — and only then —
      // the override was entitled to finish, and every counted line of the
      // accepted session is signed for.
      const counted = await observer.stockCountLine.count({
        where: { sessionId: r.sessionId, countedQuantity: { not: null } },
      });
      const acknowledged = await observer.handoverStockAcknowledgement.count({
        where: { handoverId: r.handoverId, line: { sessionId: r.sessionId } },
      });
      assert.equal(
        acknowledged, counted,
        "AN OVERRIDE COMPLETED OVER AN UNSIGNED LINE — the exception reached a gate it must not",
      );
      await assertOverriddenExactlyOnce(r);
    } else {
      // The override read the unsigned line and refused, leaving nothing.
      assert.notEqual(handover.status, "COMPLETED");
      assert.equal(handover.exceptionById, null);
      assert.equal(
        await observer.openingException.count({ where: { handoverId: r.handoverId } }), 0,
      );
      assert.equal(
        await observer.handoverStockBoundary.count({ where: { handoverId: r.handoverId } }), 0,
      );
      assert.equal(
        await observer.stockCountRebase.count({ where: { sessionId: r.sessionId } }), 0,
      );
    }
  });

  test("a retry after the commit replays and writes nothing twice", async () => {
    const r = await readyToOverride();
    const key = `${MARKER}-retry-${r.handoverId}`;
    const first = await override(r.handoverId, { idempotencyKey: key });
    assert.equal(first.alreadyAccepted, false);

    const second = await override(r.handoverId, { idempotencyKey: key });
    assert.equal(second.alreadyAccepted, true);
    assert.equal(second.openingExceptionId, first.openingExceptionId);
    assert.deepEqual(second.missingItemIds, first.missingItemIds);
    await assertOverriddenExactlyOnce(r);
  });

  test("two overrides through the HTTP door produce one exception", async () => {
    const r = await readyToOverride();
    const body = {
      idempotencyKey: `${MARKER}-http-${r.handoverId}`,
      reasonCodeId: handoverReasonId,
      note: "استثناء عبر الـHTTP",
      kind: "MANAGER_ADJUSTMENT",
    };
    const [a, b] = await Promise.all([
      overridePost(r.handoverId, body),
      overridePost(r.handoverId, body),
    ]);
    const ok = [a, b].filter((x) => x.status === 200);
    assert.ok(ok.length >= 1, `neither call succeeded: ${a.text} / ${b.text}`);
    const performed = ok.filter((x) => x.body.alreadyAccepted === false);
    assert.equal(performed.length, 1, "exactly one HTTP call performed the override");
    await assertOverriddenExactlyOnce(r);
  });
});
