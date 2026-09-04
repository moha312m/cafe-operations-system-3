// HANDOVER-008b — SH-20: a failed acceptance leaves the branch exactly as it
// found it, and two hands reaching for one acceptance get one of them.
//
// The sibling `handover-008-accept.test.ts` pins what acceptance DOES. This
// suite pins the two properties that are only visible when it does not
// finish, and each needs a different kind of proof:
//
//   * THE ROLLBACK MATRIX. Acceptance's whole claim is that it is one
//     transaction. The only honest way to test that is to fail inside it at
//     each of nine steps and look at what committed — every time, on a
//     connection outside the aborted transaction. Mutilating the fixture to
//     make a step fail naturally would test the mutilation instead, so the
//     failure comes from a narrow test-only checkpoint the route cannot
//     reach.
//
//   * THE CONCURRENCY MATRIX. Real transactions, real row locks, real unique
//     indexes. No mock stands in for `FOR UPDATE` or for PostgreSQL's own
//     decision about who wins a constraint.
//
// After every injected failure the suite also proves the state is not merely
// unchanged but still USABLE: a clean acceptance afterwards succeeds. A
// rollback that left the branch consistent and unacceptable would satisfy
// every assertion about absence and still be a defect.

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import { db, tag, teardownTaggedCafe } from "./helpers/db";
import { countCafe, countItem, COUNT_PASSWORD, type CountCafe } from "./helpers/count";
import { as, login, requireServer } from "./helpers/http";

const MARKER = tag("HANDOVER008B");

type HandoverLib = typeof import("@/lib/handover");
const handoverLib = (): Promise<HandoverLib> => import("@/lib/handover");
type CashCloseLib = typeof import("@/lib/cash-close");
const cashCloseLib = (): Promise<CashCloseLib> => import("@/lib/cash-close");
type CustodyLib = typeof import("@/lib/custody");
const custodyLib = (): Promise<CustodyLib> => import("@/lib/custody");

const GRANTS_FULL = { handoverSubmit: true, handoverException: true };

let fx: CountCafe;
const ITEM_KEYS = ["alpha", "bravo"] as const;
type ItemKey = (typeof ITEM_KEYS)[number];
const items: Record<ItemKey, { id: string; name: string }> = {} as never;
let incoming: { id: string; email: string };
let handoverReasonId: string;
let stockReasonId: string;

/**
 * A connection that was never inside the aborted transaction.
 *
 * Reading through the shared client would answer the same question most of
 * the time and would not be proof: what is being ruled out is a write that
 * escaped the caller's rollback, and only an outside observer can see one.
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
    method: "POST", body: JSON.stringify(body),
  });

const acceptPost = (handoverId: string, body: unknown) =>
  as<{ status?: string; alreadyAccepted?: boolean; error?: string }>(
    incoming.email, `/api/handovers/${handoverId}/accept`,
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
  alphaVersionBefore: bigint;
  alphaStockBefore: number;
  /**
   * The outgoing shift's close columns BEFORE acceptance.
   *
   * `closedById` and `closedAt` are not null here: the financial close already
   * wrote them when the money became a fact. SH-20 overwrites them at step 13
   * with the acceptor and the moment the shelf changed hands, so a rollback
   * has to restore what was there — asserting NULL would be asserting a state
   * that never existed.
   */
  outgoingBefore: {
    status: string;
    closedAt: Date | null;
    closedById: string | null;
    stockClosedAt: Date | null;
  };
};

/**
 * A branch one step from an acceptance: a confirmed, acknowledged count, a
 * shift waiting for custody, and a freeze the handover owns.
 *
 * `alpha` is counted short on purpose, so the acceptance below has a rebase to
 * apply and a variance case to open — a rollback matrix run against a
 * handover with nothing to undo would prove nothing.
 */
async function readyToAccept(): Promise<Ready> {
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
  for (const line of lines) {
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

type AcceptArgs = {
  incomingShiftId?: string | null;
  idempotencyKey?: string;
  __afterStep?: (step: number, tx: unknown) => Promise<void>;
};

async function accept(handoverId: string, overrides: AcceptArgs = {}) {
  const { acceptHandover } = await handoverLib();
  return acceptHandover({
    handoverId,
    incomingUserId: incoming.id,
    incomingShiftId: overrides.incomingShiftId,
    idempotencyKey: overrides.idempotencyKey ?? `${MARKER}-${handoverId}-${Math.random()}`,
    cafeId: fx.cafeId,
    viewerBranchId: fx.branchId,
    __afterStep: overrides.__afterStep as never,
  });
}

before(async () => {
  await requireServer();
  fx = await countCafe("HANDOVER008B");
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

  handoverReasonId = (await db.reasonCode.create({
    data: {
      cafeId: fx.cafeId, domain: "HANDOVER", code: `${MARKER}-HO`, label: "خلاف",
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
 * Everything a completed acceptance would have written, asked over a
 * connection that was never inside the transaction.
 *
 * One function rather than nine copies, because the assertion after every
 * injection is the same assertion: nothing.
 */
async function assertNothingCommitted(r: Ready, step: number) {
  const where = `after step ${step}`;

  const handover = await observer.handoverSession.findUniqueOrThrow({
    where: { id: r.handoverId },
  });
  assert.notEqual(handover.status, "COMPLETED", `${where}: the handover completed`);
  assert.notEqual(handover.status, "ACCEPTED", `${where}: the handover was accepted`);
  assert.equal(handover.acceptedStockCountSessionId, null, `${where}: accepted pointer`);
  assert.equal(handover.acceptedAt, null, `${where}: acceptedAt`);
  assert.equal(handover.completedAt, null, `${where}: completedAt`);
  assert.equal(handover.resolvedTarget, null, `${where}: resolvedTarget`);
  assert.equal(handover.idempotencyKey, null, `${where}: idempotencyKey`);
  assert.equal(handover.incomingStockCustodyId, null, `${where}: incoming stock custody`);
  assert.equal(handover.incomingCashCustodyId, null, `${where}: incoming cash custody`);

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
  assert.equal(outgoingCustody.status, "OPEN", `${where}: the outgoing custody closed`);
  assert.equal(outgoingCustody.endedAt, null, `${where}: endedAt`);
  assert.equal(outgoingCustody.acceptedById, null, `${where}: acceptedById`);
  assert.equal(outgoingCustody.acceptedAt, null, `${where}: acceptedAt on custody`);
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
  assert.equal(outgoingShift.status, r.outgoingBefore.status, `${where}: status moved`);
  assert.equal(
    outgoingShift.closedAt?.getTime() ?? null, r.outgoingBefore.closedAt?.getTime() ?? null,
    `${where}: closedAt was rewritten`,
  );
  assert.equal(
    outgoingShift.closedById, r.outgoingBefore.closedById,
    `${where}: closedById was rewritten — the acceptor's name outlived the acceptance`,
  );
  assert.equal(
    outgoingShift.stockClosedAt, null,
    `${where}: stockClosedAt — only acceptance writes it, so it must still be absent`,
  );
  assert.equal(r.outgoingBefore.stockClosedAt, null, `${where}: fixture invariant`);

  const freeze = await observer.inventoryFreeze.findUniqueOrThrow({
    where: { id: r.freezeId },
  });
  assert.equal(
    freeze.releasedAt, null,
    `${where}: THE FREEZE WAS RELEASED — the shelf was reopened by an acceptance that failed`,
  );

  assert.equal(
    await observer.auditLog.count({
      where: { cafeId: fx.cafeId, action: "HANDOVER_ACCEPTED", entityId: r.handoverId },
    }),
    0,
    `${where}: an acceptance was recorded that did not happen`,
  );
}

const STEPS: { step: number; what: string }[] = [
  { step: 5, what: "required-item settlement" },
  { step: 6, what: "the stock rebase" },
  { step: 7, what: "boundary persistence" },
  { step: 8, what: "the accepted count lock" },
  { step: 9, what: "variance-case creation" },
  { step: 10, what: "the STOCK custody transfer" },
  { step: 11, what: "the CASH custody transfer" },
  { step: 12, what: "the incoming gate release" },
  { step: 13, what: "outgoing shift finalization" },
  { step: 14, what: "handover completion, before the freeze release" },
];

describe("SH-20 rollback matrix", () => {
  for (const { step, what } of STEPS) {
    test(`a failure after ${what} leaves the branch as it was`, async () => {
      const r = await readyToAccept();

      await assert.rejects(
        () =>
          accept(r.handoverId, {
            incomingShiftId: r.incomingShiftId,
            __afterStep: async (reached) => {
              if (reached === step) throw new Error(`HANDOVER-008B injected at ${step}`);
            },
          }),
        new RegExp(`HANDOVER-008B injected at ${step}`),
      );

      await assertNothingCommitted(r, step);

      // And the branch is not merely unchanged but still usable. A rollback
      // that left consistent, unacceptable state would satisfy every
      // assertion above and still be a defect.
      const clean = await accept(r.handoverId, { incomingShiftId: r.incomingShiftId });
      assert.equal(clean.status, "COMPLETED", `after step ${step}, the retry could not accept`);
      assert.equal(clean.alreadyAccepted, false);
    });
  }
});

describe("SH-20 concurrency and idempotency", () => {
  test("two accepts with the SAME key produce exactly one acceptance", async () => {
    const r = await readyToAccept();
    const key = `${MARKER}-same-${r.handoverId}`;
    const outcomes = await Promise.allSettled([
      accept(r.handoverId, { incomingShiftId: r.incomingShiftId, idempotencyKey: key }),
      accept(r.handoverId, { incomingShiftId: r.incomingShiftId, idempotencyKey: key }),
    ]);

    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    assert.ok(fulfilled.length >= 1, "at least one accept had to succeed");
    const performed = fulfilled.filter(
      (o) => (o as PromiseFulfilledResult<{ alreadyAccepted: boolean }>).value.alreadyAccepted === false,
    );
    assert.equal(performed.length, 1, "exactly one call performed the acceptance");

    await assertAcceptedExactlyOnce(r);
  });

  test("two accepts with DIFFERENT keys produce exactly one acceptance", async () => {
    const r = await readyToAccept();
    const outcomes = await Promise.allSettled([
      accept(r.handoverId, {
        incomingShiftId: r.incomingShiftId, idempotencyKey: `${MARKER}-a-${r.handoverId}`,
      }),
      accept(r.handoverId, {
        incomingShiftId: r.incomingShiftId, idempotencyKey: `${MARKER}-b-${r.handoverId}`,
      }),
    ]);

    assert.equal(
      outcomes.filter((o) => o.status === "fulfilled").length, 1,
      "the loser is refused rather than accepting a second time",
    );
    await assertAcceptedExactlyOnce(r);
  });

  test("an accept racing a recount request leaves one winner and no partial state", async () => {
    const r = await readyToAccept();
    const { requestRecount } = await handoverLib();

    const outcomes = await Promise.allSettled([
      accept(r.handoverId, { incomingShiftId: r.incomingShiftId }),
      requestRecount({
        handoverId: r.handoverId, incomingUserId: incoming.id,
        reasonCodeId: handoverReasonId, note: "نعيد",
        cafeId: fx.cafeId, viewerBranchId: fx.branchId,
      }),
    ]);

    const handover = await observer.handoverSession.findUniqueOrThrow({
      where: { id: r.handoverId },
    });
    const acceptWon = outcomes[0].status === "fulfilled";
    const recountWon = outcomes[1].status === "fulfilled";
    assert.notEqual(
      acceptWon, recountWon,
      "the row lock serialises them, so exactly one may commit",
    );

    if (acceptWon) {
      assert.equal(handover.status, "COMPLETED");
      const session = await observer.stockCountSession.findUniqueOrThrow({
        where: { id: r.sessionId },
      });
      assert.equal(session.status, "LOCKED", "the accepted evidence stays locked");
    } else {
      assert.equal(handover.status, "REJECTED");
      assert.equal(handover.acceptedStockCountSessionId, null);
      assert.equal(
        await observer.stockCountRebase.count({ where: { sessionId: r.sessionId } }), 0,
        "a losing accept rebased nothing",
      );
      const freeze = await observer.inventoryFreeze.findUniqueOrThrow({
        where: { id: r.freezeId },
      });
      assert.equal(freeze.releasedAt, null, "and left the freeze held");
    }
  });

  test("an acknowledgement arriving after acceptance is refused", async () => {
    const r = await readyToAccept();
    const line = await db.stockCountLine.findFirstOrThrow({
      where: { sessionId: r.sessionId }, select: { id: true },
    });
    await accept(r.handoverId, { incomingShiftId: r.incomingShiftId });

    const late = await ackPost(r.handoverId, { stockCountLineId: line.id });
    assert.ok(late.status >= 400, `a completed handover accepted a signature: ${late.text}`);
  });

  test("a superseded session is never the evidence, however the pointer moved", async () => {
    const r = await readyToAccept();
    // The pointer is sent back and a replacement is started, so the session
    // this acceptance was prepared against is no longer current.
    await ackPost(r.handoverId, { stockCountLineId: "" });
    const { requestRecount } = await handoverLib();
    await requestRecount({
      handoverId: r.handoverId, incomingUserId: incoming.id,
      reasonCodeId: handoverReasonId, note: "نعيد",
      cafeId: fx.cafeId, viewerBranchId: fx.branchId,
    });
    const restarted = await startCountHttp(r.handoverId);
    assert.equal(restarted.status, 200, restarted.text);

    await assert.rejects(
      () => accept(r.handoverId, { incomingShiftId: r.incomingShiftId }),
      (e: { status?: number }) => e.status === 409,
      "the replacement is a DRAFT nobody has counted, let alone signed for",
    );
    assert.equal(
      await observer.stockCountRebase.count({ where: { sessionId: r.sessionId } }), 0,
      "and the superseded round was not rebased on the way past",
    );
  });

  test("a retry after a lost response writes nothing a second time", async () => {
    const r = await readyToAccept();
    const key = `${MARKER}-lost-${r.handoverId}`;
    const first = await accept(r.handoverId, {
      incomingShiftId: r.incomingShiftId, idempotencyKey: key,
    });
    assert.equal(first.alreadyAccepted, false);

    const retry = await accept(r.handoverId, {
      incomingShiftId: r.incomingShiftId, idempotencyKey: key,
    });
    assert.equal(retry.alreadyAccepted, true);
    assert.equal(retry.acceptedStockCountSessionId, first.acceptedStockCountSessionId);
    assert.equal(retry.incomingStockCustodyId, first.incomingStockCustodyId);
    assert.equal(retry.incomingCashCustodyId, first.incomingCashCustodyId);
    assert.deepEqual(retry.boundary, first.boundary);
    assert.deepEqual(retry.varianceCaseIds, first.varianceCaseIds);
    assert.deepEqual(retry.spanIds, first.spanIds);
    assert.equal(retry.outgoingShiftStatus, first.outgoingShiftStatus);

    await assertAcceptedExactlyOnce(r);
  });

  test("a retry with a different key after completion is refused", async () => {
    const r = await readyToAccept();
    await accept(r.handoverId, {
      incomingShiftId: r.incomingShiftId, idempotencyKey: `${MARKER}-one-${r.handoverId}`,
    });
    await assert.rejects(
      () =>
        accept(r.handoverId, {
          incomingShiftId: r.incomingShiftId, idempotencyKey: `${MARKER}-two-${r.handoverId}`,
        }),
      (e: { status?: number }) => e.status === 409,
    );
    await assertAcceptedExactlyOnce(r);
  });

  test("two accepts through the HTTP door produce one acceptance", async () => {
    const r = await readyToAccept();
    const key = `${MARKER}-http-race-${r.handoverId}`;
    const [a, b] = await Promise.all([
      acceptPost(r.handoverId, { idempotencyKey: key }),
      acceptPost(r.handoverId, { idempotencyKey: key }),
    ]);
    assert.ok(
      [a.status, b.status].every((s) => s === 200 || s === 409),
      `unexpected statuses ${a.status}/${b.status}: ${a.text} ${b.text}`,
    );
    await assertAcceptedExactlyOnce(r);
  });
});

/**
 * Exactly one of everything an acceptance creates.
 *
 * The duplicate-prevention half of the concurrency matrix: the boundary's
 * `@@unique(handoverId, inventoryItemId)`, the rebase's `@@unique(sessionId,
 * inventoryItemId)`, `VarianceCase.stockCountLineId @unique`,
 * `CustodyPeriod.previousPeriodId @unique` and the single audit row are each
 * asserted through their observable consequence rather than by naming the
 * index.
 */
async function assertAcceptedExactlyOnce(r: Ready) {
  const handover = await observer.handoverSession.findUniqueOrThrow({
    where: { id: r.handoverId },
  });
  assert.equal(handover.status, "COMPLETED");
  assert.equal(handover.acceptedStockCountSessionId, r.sessionId);

  const boundaries = await observer.handoverStockBoundary.findMany({
    where: { handoverId: r.handoverId }, select: { inventoryItemId: true },
  });
  assert.equal(
    new Set(boundaries.map((b) => b.inventoryItemId)).size, boundaries.length,
    "one boundary row per item",
  );

  const rebases = await observer.stockCountRebase.findMany({
    where: { sessionId: r.sessionId }, select: { inventoryItemId: true },
  });
  assert.equal(
    new Set(rebases.map((x) => x.inventoryItemId)).size, rebases.length,
    "one rebase per item",
  );
  const alpha = await observer.inventoryItem.findUniqueOrThrow({
    where: { id: items.alpha.id },
  });
  assert.equal(Number(alpha.currentStock), 9, "one delta, not two");
  assert.equal(
    alpha.ledgerVersion, r.alphaVersionBefore + BigInt(1),
    "exactly one ledger version was consumed",
  );

  const cases = await observer.varianceCase.findMany({
    where: { acceptedHandoverId: r.handoverId }, select: { stockCountLineId: true },
  });
  assert.equal(
    new Set(cases.map((c) => c.stockCountLineId)).size, cases.length,
    "one case per line",
  );

  assert.equal(
    await observer.custodyPeriod.count({
      where: { branchId: fx.branchId, scope: "STOCK", status: "OPEN" },
    }),
    1,
    "one open stock custody at the branch",
  );
  assert.equal(
    await observer.custodyPeriod.count({
      where: { previousPeriodId: r.outgoingStockCustodyId },
    }),
    1,
    "one successor claims the predecessor",
  );

  assert.equal(
    await observer.auditLog.count({
      where: { cafeId: fx.cafeId, action: "HANDOVER_ACCEPTED", entityId: r.handoverId },
    }),
    1,
    "one acceptance recorded",
  );
}
