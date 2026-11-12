// Stock handover v2 (owner decision 2026-11-12): conditions that only ever
// mattered because the handover froze the shelf — an open count, corrections
// awaiting approval, draft purchase invoices — are WARNINGS at close. They are
// still reported; they no longer refuse the close.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, countItem, type CountCafe } from "./helpers/count";
import { as, requireServer } from "./helpers/http";

let fx: CountCafe;

before(async () => {
  await requireServer();
  fx = await countCafe("SHV2003");
  await countItem(fx, "milk", { stock: 10, isCritical: true });
  await db.cafeSettings.update({
    where: { cafeId: fx.cafeId },
    data: { stockCountPolicy: "HYBRID", handoverCountType: "CRITICAL", periodicFullCountSchedule: "MANUAL_ONLY", periodicFullCountWeekday: null, varianceBlocksHandover: false, varianceHardBlockAmount: null },
  });
});

after(async () => {
  await teardownTaggedCafe([fx?.cafeId].filter((id): id is string => Boolean(id)), [], { disconnect: true });
});

describe("stock handover v2: count conditions warn, never block the close", () => {
  test("an open stock count in the branch is a warning in readiness and does not refuse the close", async () => {
    const open = await db.stockCountSession.create({
      data: {
        cafeId: fx.cafeId, branchId: fx.branchId, type: "CRITICAL", scopeDerivation: "CRITICAL_ONLY",
        initiatedById: fx.manager.id, status: "IN_PROGRESS",
      },
    });

    const readiness = await as<{ readiness: { blockers: { code: string }[]; warnings: { code: string; ids: string[] }[] } }>(
      fx.manager.email, `/api/branches/${fx.branchId}/close-readiness`,
    );
    assert.equal(readiness.status, 200, readiness.text);
    assert.ok(!readiness.body.readiness.blockers.some((b) => b.code === "FOREIGN_ACTIVE_COUNT"), "not a blocker");
    const warning = readiness.body.readiness.warnings.find((w) => w.code === "FOREIGN_ACTIVE_COUNT");
    assert.ok(warning, "still reported, as a warning");
    assert.deepEqual(warning!.ids, [open.id]);

    const last = await db.shift.aggregate({ where: { branchId: fx.branchId }, _max: { shiftNumber: true } });
    const shift = await db.shift.create({
      data: { cafeId: fx.cafeId, branchId: fx.branchId, cashierId: fx.cashier.id, shiftNumber: (last._max.shiftNumber ?? 0) + 1, openingCashAmount: 100, expectedCashAmount: 100 },
    });
    const { ensureCustodyForShift } = await import("@/lib/custody");
    await db.$transaction((tx) => ensureCustodyForShift(tx, { cafeId: fx.cafeId, branchId: fx.branchId, shiftId: shift.id, userId: fx.cashier.id, openingCashAmount: 100 }));
    const { closeShiftWithSettlement } = await import("@/lib/cash-close");
    const closed = await closeShiftWithSettlement({
      shiftId: shift.id, actualCash: 100, actorId: fx.cashier.id, closedByManager: false,
      handoverTarget: "SHIFT_TO_SHIFT", grants: { handoverSubmit: true, handoverException: true },
    });
    assert.equal(closed.status, "AWAITING_HANDOVER", "the close went through");
    assert.ok(closed.handoverId);
    assert.equal(closed.freezeId, null);
    // The open count is untouched — it is somebody's record, not the close's to discard.
    assert.equal((await db.stockCountSession.findUniqueOrThrow({ where: { id: open.id } })).status, "IN_PROGRESS");
  });
});
