// SHIFT-005 — the atomic close boundary.
//
// R1 let a close commit, then a handover start commit, then a freeze commit.
// Each gap was a window in which a sale, a transfer or a purchase confirm
// could move the shelf AFTER the custodian had been told their money was
// settled. Any count taken afterwards described a shelf that had already
// moved past the boundary it claimed to measure.
//
// This suite asserts the replacement: for a handover-required close, the
// financial close, the handover, its required-item snapshot and the inventory
// freeze become durable together or not at all — and that the blockers are
// evaluated BEFORE the money is touched, under the branch's EXCLUSIVE
// inventory lock, so a refused close leaves an untouched, still-operational
// shift rather than one settled into a state it cannot leave.

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { db, tag, teardownTaggedCafe } from "./helpers/db";
import { countCafe, countItem, type CountCafe } from "./helpers/count";
import { as, requireServer } from "./helpers/http";

const MARKER = tag("SHIFT005");
const M20 = "20260831002911_shift_status_awaiting_handover";
const M21 = "20260831003911_shift_two_stage_close";
const M20_SQL = `prisma/migrations/${M20}/migration.sql`;
const M21_SQL = `prisma/migrations/${M21}/migration.sql`;

type CashCloseLib = typeof import("@/lib/cash-close");
const cashCloseLib = (): Promise<CashCloseLib> => import("@/lib/cash-close");
type CustodyLib = typeof import("@/lib/custody");
const custodyLib = (): Promise<CustodyLib> => import("@/lib/custody");
type FreezeLib = typeof import("@/lib/inventory-freeze");
const freezeLib = (): Promise<FreezeLib> => import("@/lib/inventory-freeze");
type LedgerLib = typeof import("@/lib/ledger");
const ledgerLib = (): Promise<LedgerLib> => import("@/lib/ledger");

let fx: CountCafe;
let criticalId: string;
let regularId: string;

const statusIs = (status: number) => (error: unknown) =>
  (error as { status?: number }).status === status;

/** Write the café's effective handover configuration, clearing branch overrides. */
async function configure(
  policy: "NO_SHIFT_COUNT" | "CRITICAL" | "FULL" | "HYBRID" | "CYCLE",
  opts: {
    countType?: "CRITICAL" | "FULL";
    schedule?: "DAILY_LAST_HANDOVER" | "WEEKLY" | "MANUAL_ONLY";
    weekday?: number | null;
  } = {},
) {
  const schedule = opts.schedule ?? "MANUAL_ONLY";
  await db.cafeSettings.update({
    where: { cafeId: fx.cafeId },
    data: {
      stockCountPolicy: policy,
      handoverCountType: opts.countType ?? "CRITICAL",
      periodicFullCountSchedule: schedule,
      periodicFullCountWeekday: schedule === "WEEKLY" ? opts.weekday ?? 0 : null,
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

/** A shift with real CASH and STOCK custody, exactly as SH-5 bootstraps one. */
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
  return db.shift.findUniqueOrThrow({ where: { id: shift.id } });
}

/** Everything this suite creates at the branch, removed between tests. */
async function resetBranch() {
  await db.inventoryFreeze.deleteMany({ where: { branchId: fx.branchId } });
  await db.handoverSession.deleteMany({ where: { branchId: fx.branchId } });
  await db.stockCountSession.deleteMany({ where: { branchId: fx.branchId } });
  await db.inventoryTransaction.deleteMany({ where: { branchId: fx.branchId } });
  await db.order.deleteMany({ where: { branchId: fx.branchId } });
  await db.shift.updateMany({
    where: { branchId: fx.branchId },
    data: { cashVarianceCaseId: null },
  });
  await db.varianceCase.deleteMany({ where: { branchId: fx.branchId } });
  await db.tenderReconciliation.deleteMany({ where: { branchId: fx.branchId } });
  await db.shiftCustody.deleteMany({ where: { shift: { branchId: fx.branchId } } });
  await db.custodyParticipant.deleteMany({
    where: { custodyPeriod: { branchId: fx.branchId } },
  });
  await db.custodyPeriod.updateMany({
    where: { branchId: fx.branchId },
    data: { previousPeriodId: null },
  });
  await db.custodyPeriod.deleteMany({ where: { branchId: fx.branchId } });
  await db.payment.deleteMany({ where: { shift: { branchId: fx.branchId } } });
  await db.shift.deleteMany({ where: { branchId: fx.branchId } });
  await db.auditLog.deleteMany({ where: { cafeId: fx.cafeId } });
}

/** An order nobody served yet — the canonical UNSERVED_ORDERS blocker. */
async function unservedOrder() {
  const last = await db.order.aggregate({
    where: { branchId: fx.branchId },
    _max: { orderNumber: true },
  });
  return db.order.create({
    data: {
      cafeId: fx.cafeId,
      branchId: fx.branchId,
      orderNumber: (last._max.orderNumber ?? 0) + 1,
      type: "TAKEAWAY",
      status: "CONFIRMED",
      source: "CASHIER_POS",
      customerName: MARKER,
      subtotal: 0,
      taxAmount: 0,
      discountAmount: 0,
      serviceChargeAmount: 0,
      total: 0,
      remainingAmount: 0,
      paymentStatus: "PENDING_COLLECTION",
      createdById: fx.cashier.id,
    },
  });
}

/**
 * A branch already carrying an unreleased freeze whose handover is COMPLETED.
 *
 * COMPLETED is not an ACTIVE handover status, so `handoverStartBlockers` lets
 * the close through; `acquireInventoryFreeze` then refuses at the very end of
 * the boundary. That is the injection this suite uses to prove the rollback:
 * by the time it throws, the money, the case, the settlements, the handover
 * and its required items have all been written inside the transaction.
 */
async function injectFreezeConflict() {
  const stranded = await db.handoverSession.create({
    data: {
      cafeId: fx.cafeId,
      branchId: fx.branchId,
      outgoingShiftId: (await openOperationalShift(fx.manager.id)).id,
      outgoingUserId: fx.manager.id,
      status: "COMPLETED",
      completedAt: new Date(),
    },
  });
  await db.inventoryFreeze.create({
    data: {
      cafeId: fx.cafeId,
      branchId: fx.branchId,
      handoverId: stranded.id,
      startedById: fx.manager.id,
    },
  });
  return stranded;
}

const GRANTS_FULL = { handoverSubmit: true, handoverException: true };

async function closeService(args: {
  shiftId: string;
  actualCash: number;
  actorId: string;
  handoverTarget?: "SHIFT_TO_SHIFT" | "BRANCH_CUSTODY";
  grants?: { handoverSubmit: boolean; handoverException: boolean };
  reason?: string;
}) {
  const { closeShiftWithSettlement } = await cashCloseLib();
  return closeShiftWithSettlement({
    shiftId: args.shiftId,
    actualCash: args.actualCash,
    reason: args.reason,
    actorId: args.actorId,
    closedByManager: false,
    handoverTarget: args.handoverTarget,
    grants: args.grants ?? GRANTS_FULL,
  });
}

before(async () => {
  await requireServer();
  fx = await countCafe("SHIFT005");
  criticalId = (await countItem(fx, "critical", { stock: 40, isCritical: true })).id;
  regularId = (await countItem(fx, "regular", { stock: 25, isCritical: false })).id;
});

after(async () => {
  await teardownTaggedCafe(fx?.cafeId, [], { disconnect: true });
});

beforeEach(async () => {
  await resetBranch();
  await configure("HYBRID");
});

describe("SHIFT-005 — the atomic close boundary", () => {
  test("M20 adds only the enum value and M21 only the close-state columns", async () => {
    const m20 = readFileSync(M20_SQL, "utf8");
    const m21 = readFileSync(M21_SQL, "utf8");

    assert.match(m20, /ALTER TYPE "ShiftStatus" ADD VALUE 'AWAITING_HANDOVER'/);
    assert.ok(!/ALTER TABLE/i.test(m20), "M20 must add the enum value and nothing else");
    assert.ok(!/CREATE TABLE/i.test(m20), "M20 must add the enum value and nothing else");

    assert.match(m21, /ALTER TABLE "Shift"/);
    assert.match(m21, /"handoverRequired" BOOLEAN NOT NULL DEFAULT false/);
    assert.match(m21, /"financiallyClosedAt" TIMESTAMP\(3\)/);
    assert.match(m21, /"stockClosedAt" TIMESTAMP\(3\)/);
    assert.ok(!/ALTER TYPE/i.test(m21), "the enum value belongs to M20 alone");
    assert.ok(
      !/DROP TABLE|DROP COLUMN|_disposable_test_database/i.test(`${m20}${m21}`),
      "neither migration may drop anything",
    );

    // The enum is writable, which is the half a file read cannot prove.
    const shift = await openOperationalShift(fx.cashier.id);
    await db.shift.update({
      where: { id: shift.id },
      data: { status: "AWAITING_HANDOVER" },
    });
    const stored = await db.shift.findUniqueOrThrow({ where: { id: shift.id } });
    assert.equal(stored.status, "AWAITING_HANDOVER");
    assert.equal(stored.handoverRequired, false);
    assert.equal(stored.financiallyClosedAt, null);
    assert.equal(stored.stockClosedAt, null);
  });

  test("a SHIFT_TO_SHIFT close commits money, handover, snapshot and freeze together", async () => {
    const shift = await openOperationalShift(fx.cashier.id);

    const result = await closeService({
      shiftId: shift.id,
      actualCash: 100,
      actorId: fx.cashier.id,
      handoverTarget: "SHIFT_TO_SHIFT",
    });

    assert.equal(result.status, "AWAITING_HANDOVER");
    assert.equal(result.handoverRequired, true);
    assert.equal(result.handoverTarget, "SHIFT_TO_SHIFT");
    assert.ok(result.handoverId);
    assert.ok(result.freezeId);
    assert.equal(result.handoverConfigIssue, null);

    const stored = await db.shift.findUniqueOrThrow({ where: { id: shift.id } });
    assert.equal(stored.status, "AWAITING_HANDOVER");
    assert.equal(stored.handoverRequired, true);
    assert.ok(stored.financiallyClosedAt, "the money became a fact at close");
    // The stock stage has not happened: only accept may write these.
    assert.equal(stored.closedAt, null);
    assert.equal(stored.stockClosedAt, null);

    const handovers = await db.handoverSession.findMany({
      where: { branchId: fx.branchId },
      include: { requiredItems: true },
    });
    assert.equal(handovers.length, 1);
    const handover = handovers[0];
    assert.equal(handover.status, "DRAFT");
    assert.equal(handover.target, "SHIFT_TO_SHIFT");
    assert.equal(handover.outgoingShiftId, shift.id);
    assert.equal(handover.outgoingUserId, fx.cashier.id);
    assert.equal(handover.resolvedTarget, null);
    assert.equal(handover.acceptedStockCountSessionId, null);
    assert.ok(handover.requiredItems.length > 0, "the required scope was snapshotted");
    assert.equal(handover.requiredItemCount, handover.requiredItems.length);

    const freezes = await db.inventoryFreeze.findMany({
      where: { branchId: fx.branchId, releasedAt: null },
    });
    assert.equal(freezes.length, 1);
    assert.equal(freezes[0].handoverId, handover.id);

    // SH-15 stays unwired: no boundary is written by the close.
    assert.equal(
      await db.handoverStockBoundary.count({ where: { handoverId: handover.id } }),
      0,
    );

    const audit = await db.auditLog.findFirst({
      where: { cafeId: fx.cafeId, action: "SHIFT_CLOSED", entityId: shift.id },
    });
    const details = audit?.details as Record<string, unknown>;
    assert.equal(details.resultingStatus, "AWAITING_HANDOVER");
    assert.equal(details.handoverRequired, true);
    assert.equal(details.handoverTarget, "SHIFT_TO_SHIFT");
    assert.equal(details.handoverId, handover.id);
    assert.equal(details.freezeId, freezes[0].id);
    assert.equal(details.requiredItemCount, handover.requiredItems.length);
    assert.equal(details.handoverConfigIssue, null);
  });

  test("NO_SHIFT_COUNT closes straight to CLOSED with no handover machinery", async () => {
    await configure("NO_SHIFT_COUNT");
    const shift = await openOperationalShift(fx.cashier.id);

    const result = await closeService({
      shiftId: shift.id,
      actualCash: 100,
      actorId: fx.cashier.id,
      // No target, and no handover grants: a legacy close needs neither.
      grants: { handoverSubmit: false, handoverException: false },
    });

    assert.equal(result.status, "CLOSED");
    assert.equal(result.handoverRequired, false);
    assert.equal(result.handoverTarget, null);
    assert.equal(result.handoverId, null);
    assert.equal(result.freezeId, null);
    assert.equal(result.handoverConfigIssue, null);

    const stored = await db.shift.findUniqueOrThrow({ where: { id: shift.id } });
    assert.equal(stored.status, "CLOSED");
    assert.equal(stored.handoverRequired, false);
    assert.ok(stored.closedAt, "T33 still stamps closedAt on a direct close");
    assert.ok(stored.financiallyClosedAt, "the money became a fact here too");
    assert.equal(stored.stockClosedAt, null);

    assert.equal(await db.handoverSession.count({ where: { branchId: fx.branchId } }), 0);
    assert.equal(await db.inventoryFreeze.count({ where: { branchId: fx.branchId } }), 0);
  });

  test("CYCLE closes normally and records the unsupported policy in the audit", async () => {
    await configure("CYCLE");
    const shift = await openOperationalShift(fx.cashier.id);

    const result = await closeService({
      shiftId: shift.id,
      actualCash: 100,
      actorId: fx.cashier.id,
      grants: { handoverSubmit: false, handoverException: false },
    });

    assert.equal(result.status, "CLOSED");
    assert.equal(result.handoverRequired, false);
    assert.deepEqual(result.handoverConfigIssue?.code, "CYCLE_POLICY_UNSUPPORTED");

    assert.equal(await db.handoverSession.count({ where: { branchId: fx.branchId } }), 0);
    assert.equal(await db.inventoryFreeze.count({ where: { branchId: fx.branchId } }), 0);

    const audit = await db.auditLog.findFirst({
      where: { cafeId: fx.cafeId, action: "SHIFT_CLOSED", entityId: shift.id },
    });
    const details = audit?.details as Record<string, Record<string, unknown>>;
    assert.equal(details.handoverConfigIssue.code, "CYCLE_POLICY_UNSUPPORTED");
  });

  test("a blocker refuses with 409 before anything at all is written", async () => {
    const shift = await openOperationalShift(fx.cashier.id);
    await unservedOrder();
    const before = await db.shift.findUniqueOrThrow({ where: { id: shift.id } });

    await assert.rejects(
      closeService({
        shiftId: shift.id,
        actualCash: 137.5,
        reason: "drawer short",
        actorId: fx.cashier.id,
        handoverTarget: "SHIFT_TO_SHIFT",
      }),
      (error: unknown) => {
        const e = error as { status?: number; blockers?: Array<{ code: string }> };
        assert.equal(e.status, 409);
        assert.ok(e.blockers?.some((b) => b.code === "UNSERVED_ORDERS"));
        return true;
      },
    );

    const after_ = await db.shift.findUniqueOrThrow({ where: { id: shift.id } });
    assert.equal(after_.status, "OPEN", "the shift is still open and operational");
    assert.equal(after_.actualCashAmount, null);
    assert.equal(after_.cashDifference, null);
    assert.equal(after_.closedAt, null);
    assert.equal(after_.financiallyClosedAt, null);
    assert.equal(after_.handoverRequired, false);
    assert.equal(Number(after_.expectedCashAmount), Number(before.expectedCashAmount));

    assert.equal(await db.varianceCase.count({ where: { branchId: fx.branchId } }), 0);
    assert.equal(
      await db.tenderReconciliation.count({ where: { branchId: fx.branchId } }),
      0,
    );
    assert.equal(await db.handoverSession.count({ where: { branchId: fx.branchId } }), 0);
    assert.equal(await db.inventoryFreeze.count({ where: { branchId: fx.branchId } }), 0);
    assert.equal(
      await db.auditLog.count({ where: { cafeId: fx.cafeId, action: "SHIFT_CLOSED" } }),
      0,
      "a refused close writes no close audit",
    );
  });

  test("five concurrent closes produce one winner, one handover and one freeze", async () => {
    const shift = await openOperationalShift(fx.cashier.id);

    const attempts = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        closeService({
          shiftId: shift.id,
          actualCash: 100,
          actorId: fx.cashier.id,
          handoverTarget: "SHIFT_TO_SHIFT",
        }),
      ),
    );

    const won = attempts.filter((a) => a.status === "fulfilled");
    assert.equal(won.length, 1, "exactly one close may win");

    assert.equal(await db.handoverSession.count({ where: { branchId: fx.branchId } }), 1);
    assert.equal(
      await db.inventoryFreeze.count({ where: { branchId: fx.branchId, releasedAt: null } }),
      1,
    );
    const stored = await db.shift.findUniqueOrThrow({ where: { id: shift.id } });
    assert.equal(stored.status, "AWAITING_HANDOVER");
  });

  test("both CLOSED and AWAITING_HANDOVER refuse a second close", async () => {
    const awaiting = await openOperationalShift(fx.cashier.id);
    await closeService({
      shiftId: awaiting.id,
      actualCash: 100,
      actorId: fx.cashier.id,
      handoverTarget: "SHIFT_TO_SHIFT",
    });
    await assert.rejects(
      closeService({
        shiftId: awaiting.id,
        actualCash: 100,
        actorId: fx.cashier.id,
        handoverTarget: "SHIFT_TO_SHIFT",
      }),
      statusIs(400),
    );

    await resetBranch();
    await configure("NO_SHIFT_COUNT");
    const closed = await openOperationalShift(fx.cashier.id);
    await closeService({
      shiftId: closed.id,
      actualCash: 100,
      actorId: fx.cashier.id,
      grants: { handoverSubmit: false, handoverException: false },
    });
    await assert.rejects(
      closeService({ shiftId: closed.id, actualCash: 100, actorId: fx.cashier.id }),
      statusIs(400),
    );
  });

  test("a handover-required close without a target is refused before any write", async () => {
    const shift = await openOperationalShift(fx.cashier.id);

    await assert.rejects(
      closeService({ shiftId: shift.id, actualCash: 100, actorId: fx.cashier.id }),
      statusIs(400),
    );

    const stored = await db.shift.findUniqueOrThrow({ where: { id: shift.id } });
    assert.equal(stored.status, "OPEN");
    assert.equal(stored.financiallyClosedAt, null);
    assert.equal(await db.handoverSession.count({ where: { branchId: fx.branchId } }), 0);
  });

  test("the committed target is immutable — SH-14 wrote it and refuses a rewrite", async () => {
    const shift = await openOperationalShift(fx.cashier.id);
    const result = await closeService({
      shiftId: shift.id,
      actualCash: 100,
      actorId: fx.cashier.id,
      handoverTarget: "SHIFT_TO_SHIFT",
    });

    const { planRequiredItems, persistRequiredItems } = await import(
      "@/lib/handover-required-items"
    );
    await assert.rejects(
      db.$transaction(async (tx) => {
        const plan = await planRequiredItems(tx, {
          cafeId: fx.cafeId,
          branchId: fx.branchId,
          at: new Date(),
          target: "BRANCH_CUSTODY",
        });
        return persistRequiredItems(tx, { handoverId: result.handoverId!, plan });
      }),
      statusIs(409),
    );

    const handover = await db.handoverSession.findUniqueOrThrow({
      where: { id: result.handoverId! },
    });
    assert.equal(handover.target, "SHIFT_TO_SHIFT");
    assert.equal(handover.resolvedTarget, null);
  });

  test("a due schedule does not widen a SHIFT_TO_SHIFT snapshot", async () => {
    for (const schedule of ["DAILY_LAST_HANDOVER", "WEEKLY"] as const) {
      await resetBranch();
      await configure("HYBRID", {
        schedule,
        weekday: new Date().getUTCDay(),
      });
      const shift = await openOperationalShift(fx.cashier.id);
      const result = await closeService({
        shiftId: shift.id,
        actualCash: 100,
        actorId: fx.cashier.id,
        handoverTarget: "SHIFT_TO_SHIFT",
      });

      const handover = await db.handoverSession.findUniqueOrThrow({
        where: { id: result.handoverId! },
        include: { requiredItems: true },
      });
      assert.equal(handover.stockMode, "SELECTED", `${schedule} must not widen`);
      assert.equal(handover.requiredItemTrigger, "REGULAR_MODE");
      assert.deepEqual(
        handover.requiredItems.map((i) => i.inventoryItemId).sort(),
        [criticalId].sort(),
      );
    }
  });

  test("a due daily schedule widens a BRANCH_CUSTODY snapshot to FULL", async () => {
    await configure("HYBRID", { schedule: "DAILY_LAST_HANDOVER" });
    const shift = await openOperationalShift(fx.cashier.id);

    const result = await closeService({
      shiftId: shift.id,
      actualCash: 100,
      actorId: fx.manager.id,
      handoverTarget: "BRANCH_CUSTODY",
    });

    const handover = await db.handoverSession.findUniqueOrThrow({
      where: { id: result.handoverId! },
      include: { requiredItems: true },
    });
    assert.equal(handover.target, "BRANCH_CUSTODY");
    assert.equal(handover.stockMode, "FULL");
    assert.equal(handover.requiredItemTrigger, "PERIODIC_DAILY");
    assert.deepEqual(
      handover.requiredItems.map((i) => i.inventoryItemId).sort(),
      [criticalId, regularId].sort(),
    );
    assert.equal(handover.periodicScheduleSnapshot, "DAILY_LAST_HANDOVER");
    assert.ok(handover.businessDateSnapshot);
  });

  test("BRANCH_CUSTODY without handover.exception is refused before any mutation", async () => {
    const shift = await openOperationalShift(fx.cashier.id);

    // The cashier holds handover.submit but not handover.exception.
    const refused = await as(fx.cashier.email, `/api/shifts/${shift.id}/close`, {
      method: "POST",
      body: JSON.stringify({
        actualCashAmount: 100,
        handoverTarget: "BRANCH_CUSTODY",
      }),
    });
    assert.equal(refused.status, 403);

    const stored = await db.shift.findUniqueOrThrow({ where: { id: shift.id } });
    assert.equal(stored.status, "OPEN");
    assert.equal(stored.financiallyClosedAt, null);
    assert.equal(await db.handoverSession.count({ where: { branchId: fx.branchId } }), 0);
    assert.equal(await db.inventoryFreeze.count({ where: { branchId: fx.branchId } }), 0);
  });

  test("the route accepts SHIFT_TO_SHIFT for a submitter and reports the two-stage close", async () => {
    const shift = await openOperationalShift(fx.cashier.id);

    const ok = await as<{
      shift: { status: string };
      handover: { required: boolean; target: string; handoverId: string; freezeId: string };
    }>(fx.cashier.email, `/api/shifts/${shift.id}/close`, {
      method: "POST",
      body: JSON.stringify({
        actualCashAmount: 100,
        handoverTarget: "SHIFT_TO_SHIFT",
      }),
    });

    assert.equal(ok.status, 200);
    assert.equal(ok.body.shift.status, "AWAITING_HANDOVER");
    assert.equal(ok.body.handover.required, true);
    assert.equal(ok.body.handover.target, "SHIFT_TO_SHIFT");
    assert.ok(ok.body.handover.handoverId);
    assert.ok(ok.body.handover.freezeId);
  });

  test("the route serialises every blocker on the 409 without changing the error format", async () => {
    const shift = await openOperationalShift(fx.cashier.id);
    await unservedOrder();

    const refused = await as<{ error: string; blockers: Array<{ code: string; ids: string[] }> }>(
      fx.cashier.email,
      `/api/shifts/${shift.id}/close`,
      {
        method: "POST",
        body: JSON.stringify({
          actualCashAmount: 100,
          handoverTarget: "SHIFT_TO_SHIFT",
        }),
      },
    );

    assert.equal(refused.status, 409);
    assert.ok(refused.body.error, "the shared { error } shape is preserved");
    assert.ok(Array.isArray(refused.body.blockers));
    assert.ok(refused.body.blockers.some((b) => b.code === "UNSERVED_ORDERS"));
  });

  test("the target is intent: another open shift never changes it", async () => {
    // A second operational shift at the branch is exactly the state a
    // "last handover of the day" reconstruction would read.
    await openOperationalShift(fx.manager.id);
    const shift = await openOperationalShift(fx.cashier.id);

    const result = await closeService({
      shiftId: shift.id,
      actualCash: 100,
      actorId: fx.cashier.id,
      handoverTarget: "BRANCH_CUSTODY",
    });
    assert.equal(result.handoverTarget, "BRANCH_CUSTODY");

    const handover = await db.handoverSession.findUniqueOrThrow({
      where: { id: result.handoverId! },
    });
    assert.equal(
      handover.target,
      "BRANCH_CUSTODY",
      "the stated intent survived a branch that still has an open shift",
    );

    // And no source path reconstructs it.
    const sources = ["src/lib/cash-close.ts", "src/lib/handover.ts"]
      .map((p) => readFileSync(p, "utf8"))
      .join("\n");
    assert.ok(
      !/isLastHandoverOfDay|lastHandoverOfDay/i.test(sources),
      "no last-handover-of-day reconstruction may exist",
    );
  });

  test("a failure after settlement rolls the entire boundary back", async () => {
    await injectFreezeConflict();
    await resetBranchShiftsOnly();
    const shift = await openOperationalShift(fx.cashier.id);

    await assert.rejects(
      closeService({
        shiftId: shift.id,
        actualCash: 88,
        reason: "short",
        actorId: fx.cashier.id,
        handoverTarget: "SHIFT_TO_SHIFT",
      }),
      statusIs(409),
    );

    const stored = await db.shift.findUniqueOrThrow({ where: { id: shift.id } });
    assert.equal(stored.status, "OPEN");
    assert.equal(stored.actualCashAmount, null);
    assert.equal(stored.financiallyClosedAt, null);
    assert.equal(stored.cashVarianceCaseId, null);
    assert.equal(await db.varianceCase.count({ where: { branchId: fx.branchId } }), 0);
    assert.equal(
      await db.handoverSession.count({ where: { branchId: fx.branchId, status: "DRAFT" } }),
      0,
      "the handover rolled back with the money",
    );
    assert.equal(
      await db.auditLog.count({ where: { cafeId: fx.cafeId, action: "SHIFT_CLOSED" } }),
      0,
    );
  });

  test("the EXCLUSIVE boundary really serialises against live stock mutation", async () => {
    const shift = await openOperationalShift(fx.cashier.id);
    // A blocker is present on purpose: if the close could evaluate blockers
    // before taking the EXCLUSIVE lock, it would return 409 immediately
    // instead of waiting behind the SHARED holder.
    await unservedOrder();

    const { acquireInventorySharedLocks, InventoryFrozenError } = await freezeLib();
    const { applyStockMutation } = await ledgerLib();

    let releaseHolder: () => void = () => {};
    const holderReleased = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let holderLocked: () => void = () => {};
    const holderHasLock = new Promise<void>((resolve) => {
      holderLocked = resolve;
    });

    // 1. a legitimate stock mutation holding the SHARED branch lock
    const holder = db.$transaction(
      async (tx) => {
        await acquireInventorySharedLocks(tx, [fx.branchId]);
        await applyStockMutation(tx, {
          inventoryItemId: regularId,
          type: "ADJUSTMENT",
          quantity: -1,
          cafeId: fx.cafeId,
          branchId: fx.branchId,
          createdById: fx.manager.id,
          note: `${MARKER} holder`,
        });
        holderLocked();
        await holderReleased;
      },
      { timeout: 20_000, maxWait: 20_000 },
    );
    await holderHasLock;

    // 2. the close cannot cross the EXCLUSIVE boundary while that runs
    let settled = false;
    const close = closeService({
      shiftId: shift.id,
      actualCash: 100,
      actorId: fx.cashier.id,
      handoverTarget: "SHIFT_TO_SHIFT",
    }).then(
      (v) => {
        settled = true;
        return v;
      },
      (e) => {
        settled = true;
        throw e;
      },
    );
    close.catch(() => {});

    const probe = await Promise.race([
      close.then(() => "settled").catch(() => "settled"),
      new Promise<string>((r) => setTimeout(() => r("pending"), 750)),
    ]);
    assert.equal(probe, "pending", "the close must wait for the SHARED holder");
    assert.equal(settled, false);
    assert.equal(
      (await db.shift.findUniqueOrThrow({ where: { id: shift.id } })).status,
      "OPEN",
      "nothing was reconciled while the close waited",
    );

    // 3. release the holder; the close now reaches its blockers and refuses
    releaseHolder();
    await holder;
    await assert.rejects(close, statusIs(409));

    // 4. with the blocker cleared the close commits its handover and freeze
    await db.order.deleteMany({ where: { branchId: fx.branchId } });
    const result = await closeService({
      shiftId: shift.id,
      actualCash: 100,
      actorId: fx.cashier.id,
      handoverTarget: "SHIFT_TO_SHIFT",
    });
    assert.ok(result.handoverId);
    assert.ok(result.freezeId);

    // 5. a later stock mutation is refused by the durable freeze
    await assert.rejects(
      db.$transaction((tx) =>
        applyStockMutation(tx, {
          inventoryItemId: regularId,
          type: "ADJUSTMENT",
          quantity: -1,
          cafeId: fx.cafeId,
          branchId: fx.branchId,
          createdById: fx.manager.id,
          note: `${MARKER} after freeze`,
        }),
      ),
      (error: unknown) => error instanceof InventoryFrozenError,
    );
  });
});

/** Remove shifts and their custody without touching the injected freeze. */
async function resetBranchShiftsOnly() {
  await db.shiftCustody.deleteMany({ where: { shift: { branchId: fx.branchId } } });
  await db.custodyParticipant.deleteMany({
    where: { custodyPeriod: { branchId: fx.branchId } },
  });
  await db.custodyPeriod.updateMany({
    where: { branchId: fx.branchId },
    data: { previousPeriodId: null },
  });
  await db.custodyPeriod.deleteMany({ where: { branchId: fx.branchId } });
}
