// REFUND-001 — a refund is a kind of transaction, not a negative payment.
//
// A refund was recorded two different ways depending on whether the original
// shift had closed: in-period it flipped the original row PAID → REFUNDED,
// post-close it wrote a second row carrying a NEGATIVE amount with status
// PAID. Because every report selects `status: "PAID"` and sums `amount`,
// those negative rows were counted as sales — an owner reading "sales per
// cashier" saw a cashier with negative sales.
//
// The invariant: money returned is recorded as its own refund transaction,
// with a positive magnitude, linked to the payment it reverses. The sign of
// a column never carries business meaning, so no report has to know about it.

import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import { collectOrderPayment } from "@/lib/payments";
import { refundPayment } from "@/lib/refunds";
import {
  db, fixture, sessionFor, openShift, makeOrder, cleanup, cleanupShift,
  clearOpenShifts,
} from "./helpers/db";

after(async () => { await db.$disconnect(); });

/** Payment rows on an order, newest last. */
async function paymentsOf(orderId: string) {
  return db.payment.findMany({
    where: { orderId },
    orderBy: { createdAt: "asc" },
  });
}

/** Remove reversals before originals — the self-FK is ON DELETE RESTRICT. */
async function purge(orderId: string) {
  await db.payment.deleteMany({ where: { orderId, reversalOfPaymentId: { not: null } } });
  await db.payment.deleteMany({ where: { orderId } });
}

describe("REFUND-001 refunds are typed transactions", () => {
  test("an in-period refund records a linked refund transaction", async () => {
    const fx = await fixture();
    const cashier = await sessionFor("cashier@demo.com");
    const manager = await sessionFor("manager@demo.com");
    const marker = "PH15-R001-inperiod";
    await cleanup(marker);
    await clearOpenShifts(fx.branchId, cashier.id);
    await clearOpenShifts(fx.branchId, manager.id);
    const shift = await openShift(fx, cashier.id, 100);
    // The refunder needs custody to hand cash back.
    const mgrShift = await openShift(fx, manager.id, 0);
    const order = await makeOrder(fx, marker, cashier.id, 30);

    try {
      const res = await collectOrderPayment({
        session: cashier, orderId: order.id, branchId: fx.branchId,
        splits: [{ method: "CASH", amount: 30 }],
      });
      const original = res.payments[0];

      await refundPayment(original.id, manager);

      const rows = await paymentsOf(order.id);
      assert.equal(rows.length, 2, "expected the collection plus a separate refund row");

      const kept = rows.find((r) => r.id === original.id)!;
      assert.equal(
        Number(kept.amount), 30,
        "the original collection must stay on the books as taken"
      );

      const refund = rows.find((r) => r.reversalOfPaymentId === original.id);
      assert.ok(refund, "the refund must be linked to the payment it reverses");
      assert.ok(
        Number(refund.amount) > 0,
        `a refund must carry a positive magnitude, got ${refund.amount}`
      );
      assert.equal(Number(refund.amount), 30, "the refund must match the amount returned");
    } finally {
      await purge(order.id);
      await cleanup(marker);
      await cleanupShift(shift.id);
      await cleanupShift(mgrShift.id);
    }
  });

  test("a post-close refund records the same shape", async () => {
    const fx = await fixture();
    const cashier = await sessionFor("cashier@demo.com");
    const manager = await sessionFor("manager@demo.com");
    const marker = "PH15-R001-postclose";
    await cleanup(marker);
    await clearOpenShifts(fx.branchId, cashier.id);
    await clearOpenShifts(fx.branchId, manager.id);
    const closed = await openShift(fx, cashier.id, 100);
    const order = await makeOrder(fx, marker, cashier.id, 30);

    try {
      const res = await collectOrderPayment({
        session: cashier, orderId: order.id, branchId: fx.branchId,
        splits: [{ method: "CASH", amount: 30 }],
      });
      await db.shift.update({
        where: { id: closed.id },
        data: { status: "CLOSED", closedAt: new Date(), actualCashAmount: 130, cashDifference: 0 },
      });

      const mgrShift = await openShift(fx, manager.id, 0);
      try {
        await refundPayment(res.payments[0].id, manager);

        const refund = (await paymentsOf(order.id))
          .find((r) => r.reversalOfPaymentId === res.payments[0].id);
        assert.ok(refund, "post-close refund must still link to the original");
        assert.ok(
          Number(refund.amount) > 0,
          `a refund must carry a positive magnitude, got ${refund.amount}`
        );
      } finally {
        await purge(order.id);
        await cleanupShift(mgrShift.id);
      }
    } finally {
      await cleanup(marker);
      await cleanupShift(closed.id);
    }
  });

  test("no payment row anywhere carries a negative amount", async () => {
    const negatives = await db.payment.count({ where: { amount: { lt: 0 } } });
    assert.equal(
      negatives, 0,
      `${negatives} payment row(s) still encode meaning in the sign; reports summing ` +
        `amount will read them as sales`
    );
  });

  test("expected cash still nets to the opening float after a refund", async () => {
    // SHIFT-001 must keep holding once the sign no longer carries meaning.
    const fx = await fixture();
    const cashier = await sessionFor("cashier@demo.com");
    const manager = await sessionFor("manager@demo.com");
    const marker = "PH15-R001-cash";
    await cleanup(marker);
    await clearOpenShifts(fx.branchId, cashier.id);
    await clearOpenShifts(fx.branchId, manager.id);
    const shift = await openShift(fx, cashier.id, 500);
    const mgrShift = await openShift(fx, manager.id, 0);
    const order = await makeOrder(fx, marker, cashier.id, 28.5);

    try {
      const res = await collectOrderPayment({
        session: cashier, orderId: order.id, branchId: fx.branchId,
        splits: [{ method: "CASH", amount: 28.5 }],
      });
      let s = await db.shift.findUniqueOrThrow({ where: { id: shift.id } });
      assert.equal(Number(s.expectedCashAmount), 528.5);

      await refundPayment(res.payments[0].id, manager);
      s = await db.shift.findUniqueOrThrow({ where: { id: shift.id } });
      assert.equal(
        Number(s.expectedCashAmount), 500,
        "the refund must leave the drawer back at its opening float"
      );
    } finally {
      await purge(order.id);
      await cleanup(marker);
      await cleanupShift(shift.id);
      await cleanupShift(mgrShift.id);
    }
  });

  test("a cash refund requires the refunder to hold a drawer, even in period", async () => {
    // The in-period path performed no custody check at all: a manager could
    // reverse cash on somebody else's open drawer while holding none.
    const fx = await fixture();
    const cashier = await sessionFor("cashier@demo.com");
    const manager = await sessionFor("manager@demo.com");
    const marker = "PH15-R001-custody";
    await cleanup(marker);
    await clearOpenShifts(fx.branchId, cashier.id);
    await clearOpenShifts(fx.branchId, manager.id);
    const shift = await openShift(fx, cashier.id, 100);
    const order = await makeOrder(fx, marker, cashier.id, 30);

    try {
      const res = await collectOrderPayment({
        session: cashier, orderId: order.id, branchId: fx.branchId,
        splits: [{ method: "CASH", amount: 30 }],
      });

      await assert.rejects(
        () => refundPayment(res.payments[0].id, manager),
        /شيفت|drawer|custody/i,
        "handing cash back without holding a drawer must be refused"
      );
    } finally {
      await purge(order.id);
      await cleanup(marker);
      await cleanupShift(shift.id);
    }
  });
});
