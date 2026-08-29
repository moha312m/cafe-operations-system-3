// SHIFT-002 — an accepted shift close is a historical snapshot.
//
// Invariant: once a shift is CLOSED, no later transaction may change its
// accepted reconciliation (expected cash, counted cash, or the stored
// difference). Money that moves after the close belongs to the period in
// which it actually moved, and must stay traceable to the original payment.

import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import { collectOrderPayment } from "@/lib/payments";
import { recomputeShiftTotals } from "@/lib/shifts";
import { refundPayment } from "@/lib/refunds";
import {
  db, fixture, sessionFor, openShift, makeOrder, cleanup, cleanupShift,
  clearOpenShifts,
} from "./helpers/db";

after(async () => { await db.$disconnect(); });

async function snapshot(shiftId: string) {
  const s = await db.shift.findUniqueOrThrow({ where: { id: shiftId } });
  return {
    status: s.status,
    expected: Number(s.expectedCashAmount),
    actual: s.actualCashAmount === null ? null : Number(s.actualCashAmount),
    difference: s.cashDifference === null ? null : Number(s.cashDifference),
  };
}

describe("SHIFT-002 closed-shift integrity", () => {
  test("refund during an OPEN shift still adjusts that shift", async () => {
    const fx = await fixture();
    const session = await sessionFor("cashier@demo.com");
    const owner = await sessionFor("owner@demo.com");
    const marker = "PH1-SHIFT002-open";
    await cleanup(marker);
    await clearOpenShifts(fx.branchId, session.id);
    await clearOpenShifts(fx.branchId, owner.id);
    const shift = await openShift(fx, session.id, 100);
    // Handing cash back requires holding a drawer, manager or not.
    const ownerShift = await openShift(fx, owner.id, 0);
    const order = await makeOrder(fx, marker, session.id, 30);

    try {
      const res = await collectOrderPayment({
        session, orderId: order.id, branchId: fx.branchId,
        splits: [{ method: "CASH", amount: 30 }],
      });
      assert.equal((await snapshot(shift.id)).expected, 130);

      await refundPayment(res.payments[0].id, owner);
      assert.equal(
        (await snapshot(shift.id)).expected, 100,
        "an open shift must still absorb its own refund"
      );
    } finally {
      await db.payment.deleteMany({
        where: { orderId: order.id, reversalOfPaymentId: { not: null } },
      });
      await cleanup(marker);
      await cleanupShift(shift.id);
      await cleanupShift(ownerShift.id);
    }
  });

  test("refund after close leaves the accepted snapshot byte-for-byte intact", async () => {
    const fx = await fixture();
    const session = await sessionFor("cashier@demo.com");
    const owner = await sessionFor("owner@demo.com");
    const marker = "PH1-SHIFT002-closed";
    await cleanup(marker);
    await clearOpenShifts(fx.branchId, session.id);
    await clearOpenShifts(fx.branchId, owner.id);
    const closedShift = await openShift(fx, session.id, 100);
    const order = await makeOrder(fx, marker, session.id, 28.5);

    try {
      const res = await collectOrderPayment({
        session, orderId: order.id, branchId: fx.branchId,
        splits: [{ method: "CASH", amount: 28.5 }],
      });

      // Cashier counts 128.50 and closes clean.
      await db.shift.update({
        where: { id: closedShift.id },
        data: {
          actualCashAmount: 128.5, cashDifference: 0,
          closedAt: new Date(), status: "CLOSED",
        },
      });
      const before = await snapshot(closedShift.id);
      assert.deepEqual(before, {
        status: "CLOSED", expected: 128.5, actual: 128.5, difference: 0,
      });

      // The owner refunds the next day, on their own open shift.
      const ownerShift = await openShift(fx, owner.id, 0);
      await refundPayment(res.payments[0].id, owner);

      const afterClose = await snapshot(closedShift.id);
      assert.deepEqual(
        afterClose, before,
        "a post-close refund silently rewrote the accepted reconciliation"
      );

      // Self-consistency of the closed record must hold.
      assert.equal(
        afterClose.difference,
        Number((afterClose.actual! - afterClose.expected).toFixed(2)),
        "closed shift difference no longer equals actual - expected"
      );

      // The cash actually left the refunder's drawer, in the current period.
      const cur = await snapshot(ownerShift.id);
      assert.equal(cur.expected, -28.5, "reversal must land in the current period");

      // ...and is disclosed there as a refund, not just a shrunken sales line.
      const curRow = await db.shift.findUniqueOrThrow({ where: { id: ownerShift.id } });
      assert.equal(
        Number(curRow.totalRefunds), 28.5,
        "the current period must disclose the outflow as a refund"
      );

      await cleanupShift(ownerShift.id);
    } finally {
      await cleanup(marker);
      await cleanupShift(closedShift.id);
    }
  });

  test("the post-close reversal is traceable to the original payment", async () => {
    const fx = await fixture();
    const session = await sessionFor("cashier@demo.com");
    const owner = await sessionFor("owner@demo.com");
    const marker = "PH1-SHIFT002-trace";
    await cleanup(marker);
    await clearOpenShifts(fx.branchId, session.id);
    await clearOpenShifts(fx.branchId, owner.id);
    const closedShift = await openShift(fx, session.id, 0);
    const order = await makeOrder(fx, marker, session.id, 12);

    try {
      const res = await collectOrderPayment({
        session, orderId: order.id, branchId: fx.branchId,
        splits: [{ method: "CASH", amount: 12 }],
      });
      const originalId = res.payments[0].id;
      await db.shift.update({
        where: { id: closedShift.id },
        data: { actualCashAmount: 12, cashDifference: 0, closedAt: new Date(), status: "CLOSED" },
      });

      const ownerShift = await openShift(fx, owner.id, 0);
      await refundPayment(originalId, owner);

      // Original stays as posted, in its own period.
      const original = await db.payment.findUniqueOrThrow({ where: { id: originalId } });
      assert.equal(original.shiftId, closedShift.id, "original was moved out of its period");
      assert.equal(Number(original.amount), 12, "original amount was altered");

      // The reversal is a distinct row in the current period, linked back.
      const reversal = await db.payment.findFirstOrThrow({
        where: { reversalOfPaymentId: originalId },
      });
      assert.equal(reversal.shiftId, ownerShift.id);
      assert.equal(reversal.type, "REFUND", "the reversal must be typed as returned money");
      assert.equal(
        Number(reversal.amount), 12,
        "a refund carries a positive magnitude; direction lives in `type`"
      );
      assert.equal(reversal.method, original.method);
      assert.equal(reversal.orderId, original.orderId, "reversal must stay on the same order");

      // Reporting reconstructable: collections less refunds nets to zero
      // across both periods, without reading meaning from the sign.
      const rows = await db.payment.findMany({
        where: { orderId: original.orderId, method: "CASH" },
        select: { amount: true, type: true },
      });
      const net = rows.reduce(
        (s, r) => s + (r.type === "REFUND" ? -Number(r.amount) : Number(r.amount)),
        0
      );
      assert.equal(net, 0, "sale and reversal must net to zero");

      await cleanupShift(ownerShift.id);
    } finally {
      await cleanup(marker);
      await cleanupShift(closedShift.id);
    }
  });

  test("recomputeShiftTotals refuses to write to a CLOSED shift", async () => {
    const fx = await fixture();
    const session = await sessionFor("cashier@demo.com");
    const marker = "PH1-SHIFT002-recompute";
    await cleanup(marker);
    await clearOpenShifts(fx.branchId, session.id);
    const shift = await openShift(fx, session.id, 77);

    try {
      await db.shift.update({
        where: { id: shift.id },
        data: { actualCashAmount: 77, cashDifference: 0, closedAt: new Date(), status: "CLOSED" },
      });
      const before = await snapshot(shift.id);

      await recomputeShiftTotals(shift.id);

      assert.deepEqual(await snapshot(shift.id), before, "recompute mutated a closed shift");
    } finally {
      await cleanup(marker);
      await cleanupShift(shift.id);
    }
  });
});
