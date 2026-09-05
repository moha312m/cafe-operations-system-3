// HANDOVER-010b — SH-22: neither half of branch custody can half-happen, and
// two hands reaching for one act get one of them.
//
// The sibling `handover-010-branch-custody.test.ts` pins what the two halves
// DO. This suite pins the two properties that are only visible when they do
// not finish, and each needs a different kind of proof:
//
//   * THE ROLLBACK MATRICES. Each half claims to be one transaction. The only
//     honest way to test that is to fail inside it at each step and look at
//     what committed — every time, on a connection that was never inside the
//     aborted transaction. Mutilating the fixture to make a step fail would
//     test the mutilation instead, so the failure comes from a narrow
//     test-only checkpoint no route can reach.
//
//   * THE CONCURRENCY MATRIX. Real transactions, real row locks, real unique
//     indexes and a real PostgreSQL. No mock stands in for `FOR UPDATE`, and
//     R-A1's whole claim is about what one transaction does while another
//     holds a lock.
//
// After every injected failure the suite also proves the state is not merely
// unchanged but still USABLE: a clean acceptance, or a clean verification,
// afterwards succeeds. A rollback that left the branch consistent and
// unusable would satisfy every assertion about absence and still be a defect.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import { db, tag, teardownTaggedCafe } from "./helpers/db";
import { countCafe, countItem, COUNT_PASSWORD, type CountCafe } from "./helpers/count";
import { as, login, requireServer } from "./helpers/http";

const MARKER = tag("HANDOVER010B");

type HandoverLib = typeof import("@/lib/handover");
const handoverLib = (): Promise<HandoverLib> => import("@/lib/handover");
type BoundaryLib = typeof import("@/lib/handover-boundary");
const boundaryLib = (): Promise<BoundaryLib> => import("@/lib/handover-boundary");
type CashCloseLib = typeof import("@/lib/cash-close");
const cashCloseLib = (): Promise<CashCloseLib> => import("@/lib/cash-close");
type CustodyLib = typeof import("@/lib/custody");
const custodyLib = (): Promise<CustodyLib> => import("@/lib/custody");

const GRANTS_FULL = { handoverSubmit: true, handoverException: true };

/**
 * A connection that was never inside the aborted transaction.
 *
 * Reading through the shared client would answer the same question most of
 * the time and would not be proof: what is being ruled out is a write that
 * escaped the caller's rollback, and only an outside observer can see one.
 */
const observer = new PrismaClient();

let fx: CountCafe;
const ITEM_KEYS = ["alpha", "charlie"] as const;
type ItemKey = (typeof ITEM_KEYS)[number];
const items: Record<ItemKey, { id: string; name: string }> = {} as never;
let opener: { id: string; email: string };
let handoverReasonId: string;
let stockReasonId: string;

const OPENING_STOCK: Record<ItemKey, string> = { alpha: "100", charlie: "10" };

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
        unit: "KG",
        isCritical: key !== "charlie",
        isActive: true,
        archivedAt: null,
        currentStock: OPENING_STOCK[key],
        costPerUnit: 450,
        // With the balance: `resetBranch` deleted the ledger rows the counter
        // was counting, and an item whose `ledgerVersion` outlives its own
        // history is what LEDGER-001 refuses.
        ledgerVersion: BigInt(0),
      },
    });
  }
}

/** Empty the branch, in the order the schema's `Restrict` keys dictate. */
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

const patchLine = (sessionId: string, lineId: string, countedQuantity: number) =>
  as<{ error?: string }>(fx.manager.email, `/api/stock-counts/${sessionId}/lines/${lineId}`, {
    method: "PATCH",
    body: JSON.stringify({ countedQuantity }),
  });

const confirmCount = (sessionId: string, idempotencyKey: string) =>
  as<{ status?: string; error?: string }>(
    fx.manager.email,
    `/api/stock-counts/${sessionId}/confirm`,
    { method: "POST", body: JSON.stringify({ idempotencyKey }) },
  );

const openingHttp = <T = Record<string, unknown>>(email: string, body: unknown) =>
  as<T & { error?: string }>(email, "/api/custody/opening-verification", {
    method: "POST",
    body: JSON.stringify(body),
  });

let seq = 0;
const nextKey = () => `${MARKER}-key-${(seq += 1)}`;

/** Capture, submit, settle and confirm through the real routes. */
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
    const r = await patchLine(sessionId, line.id, figure);
    assert.ok(r.status < 300, `capture failed: ${r.text}`);
  }
  const submitted = await as(fx.manager.email, `/api/stock-counts/${sessionId}/submit`, {
    method: "POST",
    body: "{}",
  });
  assert.ok(submitted.status < 300, `count submit failed: ${submitted.text}`);

  const unsettled = await db.stockCountLine.findMany({
    where: { sessionId, disposition: { in: ["OUTSIDE_TOLERANCE", "RECOUNT_REQUIRED"] } },
    select: { id: true },
  });
  for (const line of unsettled) {
    const r = await as(
      fx.manager.email,
      `/api/stock-counts/${sessionId}/lines/${line.id}/accept-variance`,
      { method: "POST", body: JSON.stringify({ reasonCodeId: stockReasonId }) },
    );
    assert.ok(r.status < 300, `accept-variance failed: ${r.text}`);
  }
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
}

type Ready = {
  handoverId: string;
  shiftId: string;
  freezeId: string;
  sessionId: string;
  outgoingStockCustodyId: string;
  outgoingCashCustodyId: string | null;
  alphaStockBefore: number;
  alphaVersionBefore: bigint;
};

/** A `BRANCH_CUSTODY` handover ready for the manager to accept. */
async function readyToAccept(
  counted: Partial<Record<ItemKey, number>> = { alpha: 98 },
  skip: readonly ItemKey[] = [],
): Promise<Ready> {
  await resetBranch(fx.branchId);
  const shift = await openOperationalShift(fx.cashier.id);
  const { closeShiftWithSettlement } = await cashCloseLib();
  const closed = await closeShiftWithSettlement({
    shiftId: shift.id,
    actualCash: 100,
    actorId: fx.cashier.id,
    closedByManager: false,
    handoverTarget: "BRANCH_CUSTODY",
    grants: GRANTS_FULL,
  });
  const handoverId = closed.handoverId!;

  const started = await post<{ countSession: { id: string } }>(fx.cashier.email, {
    action: "start_count",
    handoverId,
  });
  assert.equal(started.status, 200, started.text);
  const sessionId = started.body.countSession.id;
  await walkTheCount(sessionId, counted, skip);
  const confirmed = await confirmCount(sessionId, `${MARKER}-${sessionId}`);
  assert.ok(confirmed.status < 300, confirmed.text);
  const submitted = await post(fx.cashier.email, { action: "submit", handoverId });
  assert.equal(submitted.status, 200, submitted.text);

  const lines = await db.stockCountLine.findMany({
    where: { sessionId, countedQuantity: { not: null } },
    select: { id: true },
  });
  for (const line of lines) {
    const r = await as(fx.manager.email, `/api/handovers/${handoverId}/acknowledge`, {
      method: "POST",
      body: JSON.stringify({ stockCountLineId: line.id }),
    });
    assert.equal(r.status, 200, `acknowledge failed: ${r.text}`);
  }

  const handover = await db.handoverSession.findUniqueOrThrow({
    where: { id: handoverId },
    select: { outgoingStockCustodyId: true, outgoingCashCustodyId: true },
  });
  const alpha = await db.inventoryItem.findUniqueOrThrow({ where: { id: items.alpha.id } });

  return {
    handoverId,
    shiftId: shift.id,
    freezeId: closed.freezeId!,
    sessionId,
    outgoingStockCustodyId: handover.outgoingStockCustodyId!,
    outgoingCashCustodyId: handover.outgoingCashCustodyId,
    alphaStockBefore: Number(alpha.currentStock),
    alphaVersionBefore: alpha.ledgerVersion,
  };
}

type AcceptOverrides = Partial<{
  managerId: string;
  idempotencyKey: string;
  omissionReasonCodeId: string;
  omissionNote: string;
  __afterStep: (step: number, tx: unknown) => Promise<void>;
}>;

async function acceptToBranch(handoverId: string, overrides: AcceptOverrides = {}) {
  const { acceptToBranchCustody } = await handoverLib();
  return acceptToBranchCustody({
    handoverId,
    managerId: overrides.managerId ?? fx.manager.id,
    idempotencyKey: overrides.idempotencyKey ?? nextKey(),
    omissionReasonCodeId: overrides.omissionReasonCodeId,
    omissionNote: overrides.omissionNote,
    cafeId: fx.cafeId,
    viewerBranchId: fx.branchId,
    __afterStep: overrides.__afterStep as never,
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ──────────────────── what a failed Half A must not leave ────────────────

async function assertHalfANothingCommitted(r: Ready, step: number) {
  const where = `after step ${step}`;

  const handover = await observer.handoverSession.findUniqueOrThrow({
    where: { id: r.handoverId },
  });
  assert.notEqual(handover.status, "COMPLETED", `${where}: the handover completed`);
  assert.equal(handover.resolvedTarget, null, `${where}: resolvedTarget was written`);
  assert.equal(handover.target, "BRANCH_CUSTODY", `${where}: the immutable target moved`);
  assert.equal(handover.acceptedStockCountSessionId, null, `${where}: accepted session`);
  assert.equal(handover.incomingStockCustodyId, null, `${where}: incoming stock custody`);
  assert.equal(handover.idempotencyKey, null, `${where}: a retry key survived`);
  assert.equal(handover.acceptedAt, null, `${where}: acceptedAt`);

  const required = await observer.handoverRequiredItem.findMany({
    where: { handoverId: r.handoverId },
    select: { omitted: true, omissionNote: true, satisfiedByLineId: true },
  });
  assert.ok(
    required.every((row) => row.satisfiedByLineId === null && !row.omitted),
    `${where}: required-item settlement survived`,
  );

  const session = await observer.stockCountSession.findUniqueOrThrow({
    where: { id: r.sessionId },
  });
  assert.equal(session.status, "CONFIRMED", `${where}: the accepted count was locked`);
  assert.equal(session.lockedByHandoverId, null, `${where}: lockedByHandoverId`);

  assert.equal(
    await observer.stockCountRebase.count({ where: { sessionId: r.sessionId } }),
    0,
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
    await observer.handoverStockBoundary.count({ where: { handoverId: r.handoverId } }),
    0,
    `${where}: a boundary row survived`,
  );
  assert.equal(
    await observer.varianceCase.count({ where: { acceptedHandoverId: r.handoverId } }),
    0,
    `${where}: a variance case survived`,
  );
  assert.equal(
    await observer.stockVarianceSpan.count({
      where: { varianceCase: { branchId: fx.branchId } },
    }),
    0,
    `${where}: a variance span survived`,
  );

  const outgoing = await observer.custodyPeriod.findUniqueOrThrow({
    where: { id: r.outgoingStockCustodyId },
  });
  assert.equal(outgoing.status, "OPEN", `${where}: the outgoing custody closed`);
  assert.equal(outgoing.acceptedById, null, `${where}: acceptedById`);
  assert.equal(
    await observer.custodyPeriod.count({
      where: { branchId: fx.branchId, holderType: "BRANCH" },
    }),
    0,
    `${where}: A BRANCH SUCCESSOR SURVIVED — the branch holds stock nobody gave it`,
  );

  const outgoingShift = await observer.shift.findUniqueOrThrow({ where: { id: r.shiftId } });
  assert.equal(
    outgoingShift.status,
    "AWAITING_HANDOVER",
    `${where}: the outgoing shift closed`,
  );
  assert.equal(outgoingShift.stockClosedAt, null, `${where}: stockClosedAt was written`);

  const freeze = await observer.inventoryFreeze.findUniqueOrThrow({ where: { id: r.freezeId } });
  assert.equal(
    freeze.releasedAt,
    null,
    `${where}: THE FREEZE WAS RELEASED — the shelf was reopened by an acceptance that failed`,
  );

  assert.equal(
    await observer.openingException.count({ where: { handoverId: r.handoverId } }),
    0,
    `${where}: an exception recorded an authority nobody exercised`,
  );
  assert.equal(
    await observer.auditLog.count({
      where: { cafeId: fx.cafeId, action: "HANDOVER_ACCEPTED", entityId: r.handoverId },
    }),
    0,
    `${where}: an acceptance was recorded that did not happen`,
  );
}

// ──────────────────── the Half B fixture, and its rollback ───────────────

type Verifiable = {
  branchCustodyPeriodId: string;
  shiftId: string;
  sessionId: string;
  cashCustodyPeriodId: string;
  alphaStockBefore: number;
};

/** Branch custody accepted, a gated shift opened, its FULL count confirmed. */
async function readyToVerify(): Promise<Verifiable> {
  const ready = await readyToAccept();
  const accepted = await acceptToBranch(ready.handoverId);

  const shift = await openOperationalShift(opener.id, 50);
  const gate = await db.shift.findUniqueOrThrow({ where: { id: shift.id } });
  assert.equal(gate.custodyGateReason, "AWAITING_OPENING_VERIFICATION");

  const started = await openingHttp<{ countSession: { id: string } }>(opener.email, {
    action: "start_count",
    shiftId: shift.id,
  });
  assert.equal(started.status, 200, started.text);
  const sessionId = started.body.countSession.id;
  await walkTheCount(sessionId, { alpha: 96, charlie: 9 });
  const confirmed = await confirmCount(sessionId, `${MARKER}-open-${sessionId}`);
  assert.ok(confirmed.status < 300, confirmed.text);

  const cash = await db.custodyPeriod.findFirstOrThrow({
    where: { branchId: fx.branchId, scope: "CASH", status: "OPEN" },
  });
  const alpha = await db.inventoryItem.findUniqueOrThrow({ where: { id: items.alpha.id } });

  return {
    branchCustodyPeriodId: accepted.incomingStockCustodyId!,
    shiftId: shift.id,
    sessionId,
    cashCustodyPeriodId: cash.id,
    alphaStockBefore: Number(alpha.currentStock),
  };
}

async function verifyOpening(
  v: Verifiable,
  overrides: Partial<{
    shiftId: string;
    countSessionId: string;
    verifierId: string;
    __afterStep: (step: number, tx: unknown) => Promise<void>;
  }> = {},
) {
  const { verifyOpeningAgainstBoundary } = await boundaryLib();
  return verifyOpeningAgainstBoundary({
    cafeId: fx.cafeId,
    branchId: fx.branchId,
    shiftId: overrides.shiftId ?? v.shiftId,
    countSessionId: overrides.countSessionId ?? v.sessionId,
    verifierId: overrides.verifierId ?? opener.id,
    __afterStep: overrides.__afterStep as never,
  });
}

async function assertHalfBNothingCommitted(v: Verifiable, step: number) {
  const where = `after step ${step}`;

  assert.equal(
    await observer.varianceCase.count({
      where: { branchId: fx.branchId, stockCountLine: { sessionId: v.sessionId } },
    }),
    0,
    `${where}: a variance case survived`,
  );
  assert.equal(
    // Scoped to THIS session's lines. The Half A acceptance that put the
    // stock in branch custody left its own cases and spans behind, and they
    // are history rather than something this verification could have written.
    await observer.stockVarianceSpan.count({
      where: { varianceCase: { stockCountLine: { sessionId: v.sessionId } } },
    }),
    0,
    `${where}: a variance span survived`,
  );
  assert.equal(
    await observer.stockCountRebase.count({ where: { sessionId: v.sessionId } }),
    0,
    `${where}: a rebase record survived`,
  );
  const alpha = await observer.inventoryItem.findUniqueOrThrow({
    where: { id: items.alpha.id },
  });
  assert.equal(Number(alpha.currentStock), v.alphaStockBefore, `${where}: the shelf moved`);

  const session = await observer.stockCountSession.findUniqueOrThrow({
    where: { id: v.sessionId },
  });
  assert.equal(session.status, "CONFIRMED", `${where}: the opening count was locked`);
  assert.equal(session.lockedAt, null, `${where}: lockedAt`);

  const predecessor = await observer.custodyPeriod.findUniqueOrThrow({
    where: { id: v.branchCustodyPeriodId },
  });
  assert.equal(predecessor.status, "OPEN", `${where}: the branch custody was discharged`);
  assert.equal(predecessor.acceptedById, null, `${where}: acceptedById`);
  assert.equal(
    await observer.custodyPeriod.count({
      where: { previousPeriodId: v.branchCustodyPeriodId },
    }),
    0,
    `${where}: A USER SUCCESSOR SURVIVED — somebody holds stock they never took`,
  );
  assert.equal(
    await observer.shiftCustody.count({ where: { shiftId: v.shiftId, scope: "STOCK" } }),
    0,
    `${where}: a STOCK shift-custody link survived`,
  );

  const shift = await observer.shift.findUniqueOrThrow({ where: { id: v.shiftId } });
  assert.equal(
    shift.custodyGateReason,
    "AWAITING_OPENING_VERIFICATION",
    `${where}: THE GATE OPENED — the shift may sell against a shelf nobody verified`,
  );
  assert.equal(shift.custodyReadyAt, null, `${where}: custodyReadyAt`);

  const cash = await observer.custodyPeriod.findUniqueOrThrow({
    where: { id: v.cashCustodyPeriodId },
  });
  assert.equal(cash.status, "OPEN", `${where}: the drawer was touched`);

  assert.equal(
    await observer.auditLog.count({
      where: {
        cafeId: fx.cafeId,
        action: "BRANCH_CUSTODY_VERIFIED",
        entityId: v.branchCustodyPeriodId,
      },
    }),
    0,
    `${where}: a verification was recorded that did not happen`,
  );
}

// ──────────────────────────────── fixture ────────────────────────────────

before(async () => {
  await requireServer();
  fx = await countCafe("HANDOVER010B");
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
      data: { cafeId: fx.cafeId, domain: "HANDOVER", code: `${MARKER}-H`, label: "استثناء" },
    })
  ).id;
  stockReasonId = (
    await db.reasonCode.create({
      data: { cafeId: fx.cafeId, domain: "STOCK", code: `${MARKER}-S`, label: "فرق" },
    })
  ).id;

  await configureBranch();
});

after(async () => {
  await teardownTaggedCafe(fx?.cafeId, [() => resetBranch(fx.branchId)], { disconnect: true });
  await observer.$disconnect();
});

// ═════════════════════════ Half A rollback matrix ════════════════════════

const HALF_A_STEPS: { step: number; what: string }[] = [
  { step: 6, what: "required-item settlement" },
  { step: 7, what: "the stock rebase" },
  { step: 8, what: "boundary persistence" },
  { step: 9, what: "the accepted count lock" },
  { step: 10, what: "variance-case creation" },
  { step: 12, what: "the BRANCH successor" },
  { step: 14, what: "outgoing shift finalization" },
  { step: 15, what: "handover completion" },
  { step: 17, what: "the freeze release" },
  { step: 18, what: "the audit row" },
];

describe("SH-22 Half A rollback matrix", () => {
  for (const { step, what } of HALF_A_STEPS) {
    test(`a failure after ${what} leaves the branch as it was`, async () => {
      const r = await readyToAccept();

      await assert.rejects(
        () =>
          acceptToBranch(r.handoverId, {
            __afterStep: async (reached) => {
              if (reached === step) throw new Error(`HANDOVER-010B injected at ${step}`);
            },
          }),
        new RegExp(`HANDOVER-010B injected at ${step}`),
      );

      await assertHalfANothingCommitted(r, step);

      // Not merely unchanged but still USABLE.
      const clean = await acceptToBranch(r.handoverId);
      assert.equal(clean.status, "COMPLETED", `after step ${step}, the retry could not accept`);
      assert.equal(clean.alreadyAccepted, false);
      assert.equal(clean.resolvedTarget, "BRANCH_CUSTODY");
    });
  }

  test("a failure after the OpeningException takes the authority with it", async () => {
    const r = await readyToAccept({ alpha: 98 }, ["alpha"]);

    await assert.rejects(
      () =>
        acceptToBranch(r.handoverId, {
          omissionReasonCodeId: handoverReasonId,
          omissionNote: "alpha not reached",
          __afterStep: async (reached) => {
            if (reached === 16) throw new Error("HANDOVER-010B injected at 16");
          },
        }),
      /HANDOVER-010B injected at 16/,
    );

    await assertHalfANothingCommitted(r, 16);

    const clean = await acceptToBranch(r.handoverId, {
      omissionReasonCodeId: handoverReasonId,
      omissionNote: "alpha not reached",
    });
    assert.equal(clean.status, "COMPLETED");
    assert.ok(clean.openingExceptionId, "and the authority is recorded on the clean run");
  });
});

// ═════════════════════════ Half B rollback matrix ════════════════════════

// The transfer's two writes — the predecessor closing and the USER successor
// opening — are ONE call to `transferCustody`, deliberately: they are the act,
// and a seam between them would be a seam inside an indivisible statement
// about who holds the room. Step 8 is therefore the seam for both, and the
// assertions below check each of them separately.
const HALF_B_STEPS: { step: number; what: string }[] = [
  { step: 5, what: "the case and span writer" },
  { step: 6, what: "the rebase" },
  { step: 7, what: "the accepted count lock" },
  { step: 8, what: "the BRANCH→USER transfer" },
  { step: 9, what: "the shift-custody link" },
  { step: 10, what: "the gate release" },
  { step: 11, what: "the audit row" },
];

describe("SH-22 Half B rollback matrix", () => {
  for (const { step, what } of HALF_B_STEPS) {
    test(`a failure after ${what} leaves the shift gated and nothing moved`, async () => {
      const v = await readyToVerify();

      await assert.rejects(
        () =>
          verifyOpening(v, {
            __afterStep: async (reached) => {
              if (reached === step) throw new Error(`HANDOVER-010B/B injected at ${step}`);
            },
          }),
        new RegExp(`HANDOVER-010B/B injected at ${step}`),
      );

      await assertHalfBNothingCommitted(v, step);

      const clean = await verifyOpening(v);
      assert.equal(clean.status, "VERIFIED", `after step ${step}, the retry could not verify`);
      assert.equal(clean.alreadyVerified, false);
      assert.equal(clean.countStatus, "LOCKED");
    });
  }
});

// ═══════════════════════════ concurrency matrix ══════════════════════════

describe("SH-22 Half A concurrency", () => {
  test("two branch acceptances with the SAME key produce exactly one", async () => {
    const r = await readyToAccept();
    const key = `${MARKER}-same-${r.handoverId}`;
    const outcomes = await Promise.allSettled([
      acceptToBranch(r.handoverId, { idempotencyKey: key }),
      acceptToBranch(r.handoverId, { idempotencyKey: key }),
    ]);
    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    assert.ok(fulfilled.length >= 1, "at least one had to succeed");
    const performed = fulfilled.filter(
      (o) => (o as PromiseFulfilledResult<{ alreadyAccepted: boolean }>).value.alreadyAccepted === false,
    );
    assert.equal(performed.length, 1, "exactly one acceptance was performed");
    assert.equal(
      await db.custodyPeriod.count({
        where: { branchId: fx.branchId, holderType: "BRANCH" },
      }),
      1,
      "and one branch custody exists",
    );
  });

  test("two branch acceptances with DIFFERENT keys produce exactly one", async () => {
    const r = await readyToAccept();
    const outcomes = await Promise.allSettled([
      acceptToBranch(r.handoverId, { idempotencyKey: `${MARKER}-a` }),
      acceptToBranch(r.handoverId, { idempotencyKey: `${MARKER}-b` }),
    ]);
    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    assert.equal(fulfilled.length, 1, "the loser is refused rather than answered");
    assert.equal(
      await db.custodyPeriod.count({
        where: { branchId: fx.branchId, holderType: "BRANCH" },
      }),
      1,
    );
  });

  test("a branch acceptance racing a recount request leaves one winner", async () => {
    const r = await readyToAccept();
    const outcomes = await Promise.allSettled([
      acceptToBranch(r.handoverId),
      as(fx.manager.email, `/api/handovers/${r.handoverId}/request-recount`, {
        method: "POST",
        body: JSON.stringify({ reasonCodeId: handoverReasonId, note: "look again" }),
      }),
    ]);
    const accepted = outcomes[0].status === "fulfilled";
    const handover = await db.handoverSession.findUniqueOrThrow({
      where: { id: r.handoverId },
    });
    if (accepted) {
      assert.equal(handover.status, "COMPLETED");
      assert.equal(handover.acceptedStockCountSessionId, r.sessionId);
    } else {
      assert.notEqual(handover.status, "COMPLETED");
      assert.equal(handover.resolvedTarget, null, "and no partial completion survived");
    }
  });

  test("an acknowledgement arriving after a branch acceptance is refused", async () => {
    const r = await readyToAccept();
    await acceptToBranch(r.handoverId);
    const line = await db.stockCountLine.findFirstOrThrow({
      where: { sessionId: r.sessionId },
      select: { id: true },
    });
    const late = await as(fx.manager.email, `/api/handovers/${r.handoverId}/acknowledge`, {
      method: "POST",
      body: JSON.stringify({ stockCountLineId: line.id }),
    });
    assert.equal(late.status, 409, late.text);
  });

  test("the ordinary accept and the branch accept cannot both win", async () => {
    const r = await readyToAccept();
    const outcomes = await Promise.allSettled([
      acceptToBranch(r.handoverId),
      as(fx.manager.email, `/api/handovers/${r.handoverId}/accept`, {
        method: "POST",
        body: JSON.stringify({ idempotencyKey: nextKey() }),
      }),
    ]);
    // The ordinary accept refuses a BRANCH_CUSTODY target outright, so this is
    // a one-sided race by construction — which is the guarantee.
    assert.equal(outcomes[0].status, "fulfilled", "the branch acceptance is the only door");
    const handover = await db.handoverSession.findUniqueOrThrow({
      where: { id: r.handoverId },
    });
    assert.equal(handover.resolvedTarget, "BRANCH_CUSTODY");
    assert.equal(handover.incomingUserId, null);
  });

  test("SH-21's override and the branch accept cannot both win", async () => {
    const r = await readyToAccept();
    const outcomes = await Promise.allSettled([
      acceptToBranch(r.handoverId),
      as(fx.manager.email, `/api/handovers/${r.handoverId}/override-accept`, {
        method: "POST",
        body: JSON.stringify({
          idempotencyKey: nextKey(),
          reasonCodeId: handoverReasonId,
          note: "manager finishing",
          kind: "MANAGER_ADJUSTMENT",
        }),
      }),
    ]);
    assert.equal(outcomes[0].status, "fulfilled");
    const handover = await db.handoverSession.findUniqueOrThrow({
      where: { id: r.handoverId },
    });
    assert.equal(handover.resolvedTarget, "BRANCH_CUSTODY");
    assert.equal(
      await db.openingException.count({ where: { handoverId: r.handoverId } }),
      0,
      "and no override exception was written beside it",
    );
  });

  test("a stock mutation racing a branch acceptance cannot pass the freeze", async () => {
    const r = await readyToAccept();
    const outcomes = await Promise.allSettled([
      acceptToBranch(r.handoverId),
      as(fx.manager.email, `/api/inventory/${items.alpha.id}/movement`, {
        method: "POST",
        body: JSON.stringify({ type: "PURCHASE", quantity: 5, unitCost: 450 }),
      }),
    ]);
    assert.equal(outcomes[0].status, "fulfilled", "the acceptance won");
    const alpha = await db.inventoryItem.findUniqueOrThrow({ where: { id: items.alpha.id } });
    // The count said 98. A mutation that slipped through the freeze would have
    // landed either side of the rebase and left a different figure.
    assert.ok(
      Number(alpha.currentStock) === 98 || Number(alpha.currentStock) === 103,
      `the shelf is at a figure the acceptance or a post-release movement produced, not a torn one: ${alpha.currentStock}`,
    );
  });

  test("R-A1 — a shift opening mid-acceptance blocks, then lands on the right gate", async () => {
    const r = await readyToAccept();

    let t2Settled = false;
    let t2SettledAt = 0;
    let t1CommittedAt = 0;
    let t2: Promise<{ gate: string | null; shiftId: string }> | null = null;

    const accepted = await acceptToBranch(r.handoverId, {
      __afterStep: async (reached) => {
        // Step 10 is past the R-A1 gate and past every read the decision
        // depends on, and before the completion. The handover row has been
        // held FOR UPDATE since step 1.
        if (reached !== 10 || t2 !== null) return;

        t2 = (async () => {
          const { ensureCustodyForShift } = await custodyLib();
          const last = await observer.shift.aggregate({
            where: { branchId: fx.branchId },
            _max: { shiftNumber: true },
          });
          return observer.$transaction(
            async (tx) => {
              const shift = await tx.shift.create({
                data: {
                  cafeId: fx.cafeId,
                  branchId: fx.branchId,
                  cashierId: opener.id,
                  shiftNumber: (last._max.shiftNumber ?? 0) + 1,
                  openingCashAmount: 50,
                  expectedCashAmount: 50,
                },
                select: { id: true },
              });
              // THIS is the call that must block: its live-handover probe
              // takes FOR SHARE on the row T1 holds FOR UPDATE.
              const verdict = await ensureCustodyForShift(tx, {
                cafeId: fx.cafeId,
                branchId: fx.branchId,
                shiftId: shift.id,
                userId: opener.id,
                openingCashAmount: 50,
              });
              return { gate: verdict.gate, shiftId: shift.id };
            },
            { timeout: 20_000, maxWait: 20_000 },
          );
        })().then((v) => {
          t2Settled = true;
          t2SettledAt = Date.now();
          return v;
        });

        // Long enough that an unblocked shift-open would have finished many
        // times over: everything it does is a handful of indexed writes.
        await sleep(600);
        assert.equal(
          t2Settled,
          false,
          "SHIFT-OPEN DID NOT BLOCK — it decided against a snapshot the acceptance was about to invalidate",
        );
      },
    });
    t1CommittedAt = Date.now();

    const verdict = await t2!;
    assert.ok(
      t2SettledAt >= t1CommittedAt,
      "the shift-open finished only after the acceptance committed",
    );
    assert.equal(accepted.status, "COMPLETED");
    assert.equal(
      verdict.gate,
      "AWAITING_OPENING_VERIFICATION",
      "and it re-evaluated: the branch now holds the stock, so the shift waits for a VERIFICATION",
    );

    // The final invariant, stated as itself.
    assert.equal(
      await db.shift.count({
        where: {
          branchId: fx.branchId,
          status: "OPEN",
          custodyGateReason: "AWAITING_CUSTODY_TRANSFER",
        },
      }),
      0,
      "AFTER A COMPLETED BRANCH ACCEPTANCE, NO OPEN SHIFT IS STRANDED ON A TRANSFER GATE",
    );
    const shift = await db.shift.findUniqueOrThrow({ where: { id: verdict.shiftId } });
    assert.equal(shift.custodyGateReason, "AWAITING_OPENING_VERIFICATION");
  });
});

describe("SH-22 Half B concurrency", () => {
  test("two opening-count starts produce one count", async () => {
    const r = await readyToAccept();
    await acceptToBranch(r.handoverId);
    const shift = await openOperationalShift(opener.id, 50);

    const [a, b] = await Promise.all([
      openingHttp<{ countSession: { id: string } }>(opener.email, {
        action: "start_count",
        shiftId: shift.id,
      }),
      openingHttp<{ countSession: { id: string } }>(opener.email, {
        action: "start_count",
        shiftId: shift.id,
      }),
    ]);
    const ok = [a, b].filter((r) => r.status === 200);
    assert.ok(ok.length >= 1, `${a.text} / ${b.text}`);
    assert.equal(
      await db.stockCountSession.count({
        where: { branchId: fx.branchId, accountabilityContext: "BRANCH_OPENING_VERIFICATION" },
      }),
      1,
      "one branch-opening count, however many callers asked for it",
    );
  });

  test("two verifications produce one transfer", async () => {
    const v = await readyToVerify();
    const outcomes = await Promise.allSettled([verifyOpening(v), verifyOpening(v)]);
    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    assert.ok(fulfilled.length >= 1, "at least one had to succeed");
    const performed = fulfilled.filter(
      (o) =>
        (o as PromiseFulfilledResult<{ alreadyVerified: boolean }>).value.alreadyVerified === false,
    );
    assert.equal(performed.length, 1, "exactly one verification was performed");
    assert.equal(
      await db.custodyPeriod.count({
        where: { previousPeriodId: v.branchCustodyPeriodId },
      }),
      1,
      "and one successor exists",
    );
  });

  test("a correction racing a verification leaves one winner and no torn state", async () => {
    const v = await readyToVerify();
    const line = await db.stockCountLine.findFirstOrThrow({
      where: { sessionId: v.sessionId, inventoryItemId: items.alpha.id },
      select: { id: true },
    });
    const outcomes = await Promise.allSettled([
      verifyOpening(v),
      as(fx.manager.email, `/api/stock-counts/${v.sessionId}/lines/${line.id}/corrections`, {
        method: "POST",
        body: JSON.stringify({
          newCountedQuantity: 5,
          reasonCodeId: stockReasonId,
          note: "miscounted",
        }),
      }),
    ]);

    const session = await db.stockCountSession.findUniqueOrThrow({ where: { id: v.sessionId } });
    if (outcomes[0].status === "fulfilled") {
      assert.equal(session.status, "LOCKED");
      assert.equal(session.lockedByHandoverId, null);
    } else {
      assert.equal(session.status, "CONFIRMED");
      assert.equal(
        await db.custodyPeriod.count({ where: { previousPeriodId: v.branchCustodyPeriodId } }),
        0,
        "a refused verification left no successor",
      );
    }
  });

  test("a stock mutation racing a verification cannot tear the rebase", async () => {
    const v = await readyToVerify();
    const outcomes = await Promise.allSettled([
      verifyOpening(v),
      as(fx.manager.email, `/api/inventory/${items.alpha.id}/movement`, {
        method: "POST",
        body: JSON.stringify({ type: "PURCHASE", quantity: 4, unitCost: 450 }),
      }),
    ]);
    assert.equal(outcomes[0].status, "fulfilled", "the verification won");

    const alpha = await db.inventoryItem.findUniqueOrThrow({ where: { id: items.alpha.id } });
    const movementLanded = outcomes[1].status === "fulfilled"
      && (outcomes[1] as PromiseFulfilledResult<{ status: number }>).value.status < 300;
    // Either the movement landed before the rebase and was replayed above the
    // count cursor, or it landed after it. Both are whole figures; a torn one
    // would be neither.
    assert.ok(
      Number(alpha.currentStock) === 96 || Number(alpha.currentStock) === 100,
      `the shelf holds a whole figure (${alpha.currentStock}, movement landed: ${movementLanded})`,
    );
  });

  test("a shift close racing a verification leaves one winner", async () => {
    const v = await readyToVerify();
    const { closeShiftWithSettlement } = await cashCloseLib();
    const outcomes = await Promise.allSettled([
      verifyOpening(v),
      closeShiftWithSettlement({
        shiftId: v.shiftId,
        actualCash: 50,
        actorId: opener.id,
        closedByManager: false,
        handoverTarget: "BRANCH_CUSTODY",
        grants: GRANTS_FULL,
      }),
    ]);

    const shift = await db.shift.findUniqueOrThrow({ where: { id: v.shiftId } });
    if (outcomes[0].status === "fulfilled") {
      // The verification won: the gate is clear, and the successor exists.
      assert.equal(
        await db.custodyPeriod.count({ where: { previousPeriodId: v.branchCustodyPeriodId } }),
        1,
      );
    } else {
      // The close won: the shift left, and nothing was transferred to it.
      assert.notEqual(shift.status, "OPEN");
      assert.equal(
        await db.custodyPeriod.count({ where: { previousPeriodId: v.branchCustodyPeriodId } }),
        0,
        "no successor was opened for a shift that is no longer taking the room",
      );
    }
  });

  test("a replay after commit writes nothing a second time", async () => {
    const v = await readyToVerify();
    const first = await verifyOpening(v);
    const audits = await db.auditLog.count({ where: { cafeId: fx.cafeId } });

    const second = await verifyOpening(v);
    assert.equal(second.alreadyVerified, true);
    assert.equal(second.incomingStockCustodyId, first.incomingStockCustodyId);
    assert.equal(
      await db.auditLog.count({ where: { cafeId: fx.cafeId } }),
      audits,
      "a replay wrote no audit row",
    );
    assert.equal(second.rebase, null, "and does not restate the first call's rebase");
  });
});
