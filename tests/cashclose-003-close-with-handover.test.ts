// CASHCLOSE-003 — the money, unchanged, inside the handover boundary.
//
// SHIFT-005 proves the boundary is atomic. This suite proves the boundary did
// not quietly change what the boundary is made of: T33's cash arithmetic and
// T34's card and wallet settlements must behave exactly as they do on a close
// that creates no handover, and the one genuinely new money act —
// `BRANCH_CUSTODY` discharging the outgoing CASH custody with the reconciled
// figure and opening no successor — must roll back with everything else.
//
// The custody rule under test is narrow and deliberate: `SHIFT_TO_SHIFT`
// leaves CASH open, because SH-20's accept transfers it atomically to the
// arriving custodian, and inventing a successor here would name a holder
// nobody appointed. A legacy shift with no custody link gets no custody
// invented for it either — an unattributable drawer is a fact, not a gap to
// fill.

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { db, tag, teardownTaggedCafe } from "./helpers/db";
import { countCafe, countItem, type CountCafe } from "./helpers/count";
import { requireServer } from "./helpers/http";

const MARKER = tag("CASHCLOSE003");

type CashCloseLib = typeof import("@/lib/cash-close");
const cashCloseLib = (): Promise<CashCloseLib> => import("@/lib/cash-close");
type CustodyLib = typeof import("@/lib/custody");
const custodyLib = (): Promise<CustodyLib> => import("@/lib/custody");

let fx: CountCafe;

const statusIs = (status: number) => (error: unknown) =>
  (error as { status?: number }).status === status;

const GRANTS_FULL = { handoverSubmit: true, handoverException: true };

async function configure(
  policy: "NO_SHIFT_COUNT" | "HYBRID",
  countType: "CRITICAL" | "FULL" = "CRITICAL",
) {
  await db.cafeSettings.update({
    where: { cafeId: fx.cafeId },
    data: {
      stockCountPolicy: policy,
      handoverCountType: countType,
      periodicFullCountSchedule: "MANUAL_ONLY",
      periodicFullCountWeekday: null,
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

async function bareShift(userId: string, openingCash = 100) {
  const last = await db.shift.aggregate({
    where: { branchId: fx.branchId },
    _max: { shiftNumber: true },
  });
  return db.shift.create({
    data: {
      cafeId: fx.cafeId,
      branchId: fx.branchId,
      cashierId: userId,
      shiftNumber: (last._max.shiftNumber ?? 0) + 1,
      openingCashAmount: openingCash,
      expectedCashAmount: openingCash,
    },
  });
}

async function openOperationalShift(userId: string, openingCash = 100) {
  const shift = await bareShift(userId, openingCash);
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

/**
 * Real card and wallet takings for the shift.
 *
 * Written as PAID payments rather than straight onto the shift's totals,
 * because the close freshens those aggregates inside its own transaction
 * (`recomputeShiftTotals`) — a figure typed directly onto the row is
 * overwritten before the settlement ever sees it. The expected figure a
 * settlement reconciles against must come from the same authoritative
 * recomputation the production path uses, or the test proves nothing.
 */
async function withElectronicSales(shiftId: string, card: number, wallet: number) {
  const last = await db.order.aggregate({
    where: { branchId: fx.branchId },
    _max: { orderNumber: true },
  });
  const total = card + wallet;
  const order = await db.order.create({
    data: {
      cafeId: fx.cafeId,
      branchId: fx.branchId,
      orderNumber: (last._max.orderNumber ?? 0) + 1,
      type: "TAKEAWAY",
      status: "SERVED",
      source: "CASHIER_POS",
      customerName: MARKER,
      subtotal: total,
      taxAmount: 0,
      discountAmount: 0,
      serviceChargeAmount: 0,
      total,
      remainingAmount: 0,
      paymentStatus: "PAID",
      createdById: fx.cashier.id,
    },
  });

  for (const [method, amount] of [
    ["CARD", card],
    ["WALLET", wallet],
  ] as const) {
    if (amount === 0) continue;
    await db.payment.create({
      data: {
        cafeId: fx.cafeId,
        branchId: fx.branchId,
        orderId: order.id,
        shiftId,
        cashierId: fx.cashier.id,
        receivedById: fx.cashier.id,
        amount,
        method,
        type: "COLLECTION",
        status: "PAID",
      },
    });
  }
  return order;
}

async function resetBranch() {
  await db.inventoryFreeze.deleteMany({ where: { branchId: fx.branchId } });
  await db.handoverSession.deleteMany({ where: { branchId: fx.branchId } });
  await db.stockCountSession.deleteMany({ where: { branchId: fx.branchId } });
  await db.inventoryTransaction.deleteMany({ where: { branchId: fx.branchId } });
  await db.payment.deleteMany({ where: { order: { branchId: fx.branchId } } });
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

async function closeService(args: {
  shiftId: string;
  actualCash: number;
  actorId: string;
  reason?: string;
  tenders?: import("@/lib/tender-settlement").TenderSettlementInputs;
  handoverTarget?: "SHIFT_TO_SHIFT" | "BRANCH_CUSTODY";
  grants?: { handoverSubmit: boolean; handoverException: boolean };
}) {
  const { closeShiftWithSettlement } = await cashCloseLib();
  return closeShiftWithSettlement({
    shiftId: args.shiftId,
    actualCash: args.actualCash,
    reason: args.reason,
    tenders: args.tenders,
    actorId: args.actorId,
    closedByManager: false,
    handoverTarget: args.handoverTarget,
    grants: args.grants ?? GRANTS_FULL,
  });
}

before(async () => {
  await requireServer();
  fx = await countCafe("CASHCLOSE003");
  await countItem(fx, "critical", { stock: 30, isCritical: true });
});

after(async () => {
  await teardownTaggedCafe(fx?.cafeId, [], { disconnect: true });
});

beforeEach(async () => {
  await resetBranch();
  await configure("HYBRID");
});

describe("CASHCLOSE-003 — money semantics inside the handover close", () => {
  test("cash, card and wallet reconcile exactly as they do without a handover", async () => {
    const shift = await openOperationalShift(fx.cashier.id);
    await withElectronicSales(shift.id, 400, 150);

    const result = await closeService({
      shiftId: shift.id,
      actualCash: 70,
      reason: "درج ناقص",
      actorId: fx.cashier.id,
      tenders: {
        CARD: { actual: 380, reason: "رفض عملية" },
        WALLET: { actual: 150 },
      },
      handoverTarget: "SHIFT_TO_SHIFT",
    });

    // Cash: 70 counted against 100 expected is a 30 shortage, with its reason.
    assert.equal(result.expectedCash, 100);
    assert.equal(result.actualCash, 70);
    assert.equal(result.cashVariance, -30);
    assert.equal(result.kind, "SHORTAGE");
    assert.equal(result.reason, "درج ناقص");
    assert.ok(result.varianceCaseId, "a non-zero cash variance still opens its case");

    // Card and wallet stay separate findings — never netted against cash.
    const card = result.tenders.find((t) => t.method === "CARD");
    const wallet = result.tenders.find((t) => t.method === "WALLET");
    assert.equal(card?.expected, 400);
    assert.equal(card?.actual, 380);
    assert.equal(card?.variance, -20);
    assert.ok(card?.varianceCaseId, "the card shortfall is its own case");
    assert.equal(wallet?.variance, 0);
    assert.equal(wallet?.varianceCaseId, null);

    const stored = await db.shift.findUniqueOrThrow({ where: { id: shift.id } });
    assert.equal(Number(stored.cashDifference), -30);
    assert.equal(stored.cashReasonNote, "درج ناقص");
    // Still no tolerance verdict: the ERP records, it does not rule.
    assert.equal(stored.cashWithinTolerance, null);
    assert.equal(stored.cashToleranceAmount, null);

    const cases = await db.varianceCase.findMany({ where: { branchId: fx.branchId } });
    assert.equal(cases.length, 2, "one CASH case and one CARD case, never merged");
  });

  test("a zero-variance close demands no reason and opens no case", async () => {
    const shift = await openOperationalShift(fx.cashier.id);

    const result = await closeService({
      shiftId: shift.id,
      actualCash: 100,
      actorId: fx.cashier.id,
      handoverTarget: "SHIFT_TO_SHIFT",
    });

    assert.equal(result.cashVariance, 0);
    assert.equal(result.kind, "EXACT");
    assert.equal(result.reason, null);
    assert.equal(result.varianceCaseId, null);
    assert.equal(await db.varianceCase.count({ where: { branchId: fx.branchId } }), 0);
    assert.ok(result.handoverId, "the handover still commits with the money");
  });

  test("SHIFT_TO_SHIFT leaves the outgoing CASH custody open for accept", async () => {
    const shift = await openOperationalShift(fx.cashier.id);
    const cashLink = await db.shiftCustody.findFirstOrThrow({
      where: { shiftId: shift.id, scope: "CASH" },
    });

    const result = await closeService({
      shiftId: shift.id,
      actualCash: 100,
      actorId: fx.cashier.id,
      handoverTarget: "SHIFT_TO_SHIFT",
    });

    const cash = await db.custodyPeriod.findUniqueOrThrow({
      where: { id: cashLink.custodyPeriodId },
    });
    assert.equal(cash.status, "OPEN", "SH-20 transfers this, not the close");
    assert.equal(cash.endedAt, null);
    assert.equal(cash.closingCashAmount, null);

    const stock = await db.custodyPeriod.findFirstOrThrow({
      where: { branchId: fx.branchId, scope: "STOCK" },
    });
    assert.equal(stock.status, "OPEN", "STOCK custody is untouched by the close");

    const handover = await db.handoverSession.findUniqueOrThrow({
      where: { id: result.handoverId! },
    });
    assert.equal(handover.outgoingCashCustodyId, cash.id);
    assert.equal(handover.outgoingStockCustodyId, stock.id);
    assert.equal(handover.incomingCashCustodyId, null);
    assert.equal(handover.incomingStockCustodyId, null);
  });

  test("BRANCH_CUSTODY discharges the CASH custody with the counted cash and opens no successor", async () => {
    const shift = await openOperationalShift(fx.cashier.id);
    const cashLink = await db.shiftCustody.findFirstOrThrow({
      where: { shiftId: shift.id, scope: "CASH" },
    });

    const result = await closeService({
      shiftId: shift.id,
      actualCash: 137.25,
      reason: "زيادة في الدرج",
      actorId: fx.manager.id,
      handoverTarget: "BRANCH_CUSTODY",
    });

    const cash = await db.custodyPeriod.findUniqueOrThrow({
      where: { id: cashLink.custodyPeriodId },
    });
    assert.equal(cash.status, "CLOSED");
    assert.ok(cash.endedAt);
    assert.equal(Number(cash.closingCashAmount), 137.25);

    const cashPeriods = await db.custodyPeriod.findMany({
      where: { branchId: fx.branchId, scope: "CASH" },
    });
    assert.equal(cashPeriods.length, 1, "no BRANCH CASH successor may be opened");
    assert.equal(
      await db.custodyPeriod.count({
        where: { branchId: fx.branchId, scope: "CASH", status: "OPEN" },
      }),
      0,
    );

    const stock = await db.custodyPeriod.findFirstOrThrow({
      where: { branchId: fx.branchId, scope: "STOCK" },
    });
    assert.equal(stock.status, "OPEN", "STOCK stays with SH-22, not this close");
    assert.equal(stock.holderType, "USER");

    // The discharge is recorded where the roadmap put it: the close audit.
    const audit = await db.auditLog.findFirstOrThrow({
      where: { cafeId: fx.cafeId, action: "SHIFT_CLOSED", entityId: shift.id },
    });
    const details = audit.details as Record<string, unknown>;
    const finalization = details.cashCustodyFinalization as Record<string, unknown>;
    assert.equal(finalization.closedCashCustodyId, cash.id);
    assert.equal(finalization.closingCashAmount, 137.25);
    assert.equal(finalization.successorOpened, false);
    assert.equal(
      await db.auditLog.count({ where: { cafeId: fx.cafeId, action: "CUSTODY_CLOSED" } }),
      0,
      "no new audit vocabulary was invented",
    );
    assert.equal(result.handoverTarget, "BRANCH_CUSTODY");
  });

  test("a failure after settlement rolls back money, custody, handover and freeze together", async () => {
    // A branch that already carries an unreleased freeze whose handover is
    // COMPLETED passes the blockers and fails at freeze acquisition — the
    // last act of the boundary, by which point everything else is written.
    const stranded = await db.handoverSession.create({
      data: {
        cafeId: fx.cafeId,
        branchId: fx.branchId,
        outgoingShiftId: (await bareShift(fx.manager.id)).id,
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

    const shift = await openOperationalShift(fx.cashier.id);
    await withElectronicSales(shift.id, 200, 0);
    const cashLink = await db.shiftCustody.findFirstOrThrow({
      where: { shiftId: shift.id, scope: "CASH" },
    });

    await assert.rejects(
      closeService({
        shiftId: shift.id,
        actualCash: 60,
        reason: "ناقص",
        actorId: fx.manager.id,
        tenders: { CARD: { actual: 190, reason: "فرق" } },
        handoverTarget: "BRANCH_CUSTODY",
      }),
      statusIs(409),
    );

    const stored = await db.shift.findUniqueOrThrow({ where: { id: shift.id } });
    assert.equal(stored.status, "OPEN");
    assert.equal(stored.actualCashAmount, null);
    assert.equal(stored.cashDifference, null);
    assert.equal(stored.financiallyClosedAt, null);
    assert.equal(stored.cashVarianceCaseId, null);

    assert.equal(await db.varianceCase.count({ where: { branchId: fx.branchId } }), 0);
    assert.equal(
      await db.tenderReconciliation.count({ where: { branchId: fx.branchId } }),
      0,
    );

    const cash = await db.custodyPeriod.findUniqueOrThrow({
      where: { id: cashLink.custodyPeriodId },
    });
    assert.equal(cash.status, "OPEN", "the CASH discharge rolled back too");
    assert.equal(cash.closingCashAmount, null);
    assert.equal(cash.endedAt, null);

    assert.equal(
      await db.handoverSession.count({ where: { branchId: fx.branchId, status: "DRAFT" } }),
      0,
    );
    assert.equal(
      await db.handoverRequiredItem.count({
        where: { handover: { branchId: fx.branchId } },
      }),
      0,
    );
    assert.equal(await db.inventoryFreeze.count({ where: { branchId: fx.branchId } }), 1);
    assert.equal(
      await db.auditLog.count({ where: { cafeId: fx.cafeId, action: "SHIFT_CLOSED" } }),
      0,
    );
  });

  test("a legacy shift with no custody link closes honestly and invents none", async () => {
    const shift = await bareShift(fx.cashier.id);
    assert.equal(await db.shiftCustody.count({ where: { shiftId: shift.id } }), 0);

    const result = await closeService({
      shiftId: shift.id,
      actualCash: 100,
      actorId: fx.manager.id,
      handoverTarget: "BRANCH_CUSTODY",
    });

    assert.equal(result.status, "AWAITING_HANDOVER");
    assert.ok(result.handoverId);

    const handover = await db.handoverSession.findUniqueOrThrow({
      where: { id: result.handoverId! },
    });
    assert.equal(handover.outgoingCashCustodyId, null);
    assert.equal(handover.outgoingStockCustodyId, null);
    assert.equal(
      await db.custodyPeriod.count({ where: { branchId: fx.branchId } }),
      0,
      "no custody may be invented for a shift that never held one",
    );

    const audit = await db.auditLog.findFirstOrThrow({
      where: { cafeId: fx.cafeId, action: "SHIFT_CLOSED", entityId: shift.id },
    });
    const details = audit.details as Record<string, unknown>;
    const finalization = details.cashCustodyFinalization as Record<string, unknown>;
    assert.equal(finalization.closedCashCustodyId, null);
    assert.equal(finalization.successorOpened, false);
  });

  test("a legacy NO_SHIFT_COUNT café closes byte-for-byte as T33 with the new columns honest", async () => {
    await configure("NO_SHIFT_COUNT");
    const shift = await openOperationalShift(fx.cashier.id);
    await withElectronicSales(shift.id, 250, 0);
    const cashLink = await db.shiftCustody.findFirstOrThrow({
      where: { shiftId: shift.id, scope: "CASH" },
    });

    const result = await closeService({
      shiftId: shift.id,
      actualCash: 100,
      actorId: fx.cashier.id,
      tenders: { CARD: { actual: 250 } },
      grants: { handoverSubmit: false, handoverException: false },
    });

    assert.equal(result.status, "CLOSED");
    assert.equal(result.handoverRequired, false);
    assert.equal(result.tenders.find((t) => t.method === "CARD")?.variance, 0);

    const stored = await db.shift.findUniqueOrThrow({ where: { id: shift.id } });
    assert.ok(stored.closedAt);
    assert.equal(stored.stockClosedAt, null);
    assert.equal(stored.handoverRequired, false);

    const cash = await db.custodyPeriod.findUniqueOrThrow({
      where: { id: cashLink.custodyPeriodId },
    });
    assert.equal(cash.status, "OPEN", "a legacy close touches no custody at all");
    assert.equal(
      await db.auditLog.count({
        where: { cafeId: fx.cafeId, action: "SHIFT_CLOSED", entityId: shift.id },
      }),
      1,
    );
    assert.ok(MARKER);
  });
});
