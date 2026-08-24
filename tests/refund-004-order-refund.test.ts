// REFUND-004 — refunding an order means refunding all of it.
//
// An order can hold several collections: a MIXED payment writes one row per
// method, a PARTIAL order is collected again later, and table allocations
// pay orders in instalments. Reversing one payment at a time would let
// somebody refund the cash leg of a mixed order, see "refunded", and leave
// the card leg standing — a half-reversed sale that reconciles to nothing.
//
// So a full refund is all-or-nothing: every collection on the order is
// reversed inside one transaction, or none is. Cash custody is required once
// if any leg touched the drawer, and a closed shift still keeps the figures
// its cashier accepted (SHIFT-002).

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { collectOrderPayment } from "@/lib/payments";
import { refundOrder } from "@/lib/refunds";
import {
  db, fixture, sessionFor, openShift, makeOrder, cleanup, cleanupShift,
  clearOpenShifts,
} from "./helpers/db";
import { requireServer, login, as } from "./helpers/http";

after(async () => { await db.$disconnect(); });
before(async () => {
  await requireServer();
  await login("manager@demo.com", "manager123");
  await login("cashier@demo.com", "cashier123");
});

const REASON = "طلب العميل إلغاء الطلب";

async function purge(orderId: string) {
  await db.payment.deleteMany({ where: { orderId, reversalOfPaymentId: { not: null } } });
  await db.payment.deleteMany({ where: { orderId } });
}

/** Cashier sells; manager holds a drawer so they can hand cash back. */
async function scene(marker: string, total: number) {
  const fx = await fixture();
  const cashier = await sessionFor("cashier@demo.com");
  const manager = await sessionFor("manager@demo.com");
  await cleanup(marker);
  await clearOpenShifts(fx.branchId, cashier.id);
  await clearOpenShifts(fx.branchId, manager.id);
  const shift = await openShift(fx, cashier.id, 100);
  const mgrShift = await openShift(fx, manager.id, 0);
  const order = await makeOrder(fx, marker, cashier.id, total);
  return { fx, cashier, manager, shift, mgrShift, order };
}

describe("REFUND-004 order-level full refund", () => {
  test("A+F: an eligible cash order refunds in full", async () => {
    const marker = "PH15-R004-A";
    const s = await scene(marker, 120);
    try {
      await collectOrderPayment({
        session: s.cashier, orderId: s.order.id, branchId: s.fx.branchId,
        splits: [{ method: "CASH", amount: 120 }],
      });

      const res = await refundOrder(s.order.id, s.manager, REASON);
      assert.equal(res.refunds.length, 1, "one collection means one refund row");
      assert.equal(Number(res.totalRefunded), 120);

      const o = await db.order.findUniqueOrThrow({ where: { id: s.order.id } });
      assert.equal(o.paymentStatus, "REFUNDED");
      assert.equal(Number(o.paidAmount), 0);
      assert.equal(Number(o.remainingAmount), 0);

      const refund = await db.payment.findFirstOrThrow({
        where: { orderId: s.order.id, type: "REFUND" },
      });
      assert.equal(Number(refund.amount), 120, "positive magnitude");
      assert.equal(refund.refundReason, REASON, "the reason must be persisted on the refund");
      assert.ok(refund.reversalOfPaymentId, "the refund must stay traceable to its collection");
    } finally {
      await purge(s.order.id);
      await cleanup(marker);
      await cleanupShift(s.shift.id);
      await cleanupShift(s.mgrShift.id);
    }
  });

  test("every leg of a mixed-payment order is reversed, atomically", async () => {
    const marker = "PH15-R004-mixed";
    const s = await scene(marker, 120);
    try {
      await collectOrderPayment({
        session: s.cashier, orderId: s.order.id, branchId: s.fx.branchId,
        splits: [{ method: "CASH", amount: 70 }, { method: "CARD", amount: 50 }],
      });
      assert.equal(
        await db.payment.count({ where: { orderId: s.order.id, type: "COLLECTION" } }), 2,
        "precondition: the order really does hold two collections"
      );

      const res = await refundOrder(s.order.id, s.manager, REASON);
      assert.equal(res.refunds.length, 2, "both legs must be reversed, not just one");

      const refunds = await db.payment.findMany({
        where: { orderId: s.order.id, type: "REFUND" },
      });
      const byMethod = Object.fromEntries(refunds.map((r) => [r.method, Number(r.amount)]));
      assert.deepEqual(byMethod, { CASH: 70, CARD: 50 }, "each method reversed for its own amount");

      const o = await db.order.findUniqueOrThrow({ where: { id: s.order.id } });
      assert.equal(o.paymentStatus, "REFUNDED", "a half-reversed order must never be the outcome");
      assert.equal(Number(o.paidAmount), 0);
    } finally {
      await purge(s.order.id);
      await cleanup(marker);
      await cleanupShift(s.shift.id);
      await cleanupShift(s.mgrShift.id);
    }
  });

  test("B: a blank reason is refused", async () => {
    const marker = "PH15-R004-B";
    const s = await scene(marker, 30);
    try {
      await collectOrderPayment({
        session: s.cashier, orderId: s.order.id, branchId: s.fx.branchId,
        splits: [{ method: "CASH", amount: 30 }],
      });
      await assert.rejects(
        () => refundOrder(s.order.id, s.manager, "   "),
        /سبب|reason/i,
        "whitespace is not a reason"
      );
      const o = await db.order.findUniqueOrThrow({ where: { id: s.order.id } });
      assert.equal(o.paymentStatus, "PAID", "the refused attempt must change nothing");
      assert.equal(
        await db.payment.count({ where: { orderId: s.order.id, type: "REFUND" } }), 0
      );
    } finally {
      await purge(s.order.id);
      await cleanup(marker);
      await cleanupShift(s.shift.id);
      await cleanupShift(s.mgrShift.id);
    }
  });

  test("C+D: an order already refunded cannot be refunded again", async () => {
    const marker = "PH15-R004-C";
    const s = await scene(marker, 45);
    try {
      await collectOrderPayment({
        session: s.cashier, orderId: s.order.id, branchId: s.fx.branchId,
        splits: [{ method: "CASH", amount: 45 }],
      });
      await refundOrder(s.order.id, s.manager, REASON);

      await assert.rejects(
        () => refundOrder(s.order.id, s.manager, REASON),
        /مرتجع|refunded/i,
        "a second refund must be refused"
      );
      assert.equal(
        await db.payment.count({ where: { orderId: s.order.id, type: "REFUND" } }), 1,
        "no second refund row may be written"
      );
    } finally {
      await purge(s.order.id);
      await cleanup(marker);
      await cleanupShift(s.shift.id);
      await cleanupShift(s.mgrShift.id);
    }
  });

  test("L: two simultaneous refunds reverse the money once", async () => {
    // A double-tapped button sends both requests before either has written.
    // Both read an unrefunded order, so without a serialisation point in the
    // transaction both would proceed and the money would go out twice. This
    // is a server guarantee — a disabled button cannot provide it.
    const marker = "PH15-R004-L";
    const s = await scene(marker, 120);
    try {
      await collectOrderPayment({
        session: s.cashier, orderId: s.order.id, branchId: s.fx.branchId,
        splits: [{ method: "CASH", amount: 120 }],
      });

      const results = await Promise.allSettled([
        refundOrder(s.order.id, s.manager, REASON),
        refundOrder(s.order.id, s.manager, REASON),
      ]);
      const ok = results.filter((r) => r.status === "fulfilled");
      assert.equal(ok.length, 1, "exactly one of the two refunds may succeed");

      assert.equal(
        await db.payment.count({ where: { orderId: s.order.id, type: "REFUND" } }), 1,
        "the money must leave the drawer once, not twice"
      );
      const o = await db.order.findUniqueOrThrow({ where: { id: s.order.id } });
      assert.equal(Number(o.paidAmount), 0);

      const shift = await db.shift.findUniqueOrThrow({ where: { id: s.shift.id } });
      assert.equal(
        Number(shift.expectedCashAmount), 100,
        "the drawer must be back at its opening float, not below it"
      );
    } finally {
      await purge(s.order.id);
      await cleanup(marker);
      await cleanupShift(s.shift.id);
      await cleanupShift(s.mgrShift.id);
    }
  });

  test("G: a cash refund without custody is refused and writes nothing", async () => {
    const marker = "PH15-R004-G";
    const fx = await fixture();
    const cashier = await sessionFor("cashier@demo.com");
    const manager = await sessionFor("manager@demo.com");
    await cleanup(marker);
    await clearOpenShifts(fx.branchId, cashier.id);
    await clearOpenShifts(fx.branchId, manager.id);
    const shift = await openShift(fx, cashier.id, 100);
    const order = await makeOrder(fx, marker, cashier.id, 30);
    try {
      await collectOrderPayment({
        session: cashier, orderId: order.id, branchId: fx.branchId,
        splits: [{ method: "CASH", amount: 30 }],
      });
      await assert.rejects(
        () => refundOrder(order.id, manager, REASON),
        /شيفت|وردية|custody/i,
        "no drawer, no cash out"
      );
      const o = await db.order.findUniqueOrThrow({ where: { id: order.id } });
      assert.equal(o.paymentStatus, "PAID", "a refused refund must leave settlement untouched");
      assert.equal(await db.payment.count({ where: { orderId: order.id, type: "REFUND" } }), 0);
    } finally {
      await purge(order.id);
      await cleanup(marker);
      await cleanupShift(shift.id);
    }
  });

  test("H: the original closed shift keeps its accepted figures", async () => {
    const marker = "PH15-R004-H";
    const fx = await fixture();
    const cashier = await sessionFor("cashier@demo.com");
    const manager = await sessionFor("manager@demo.com");
    await cleanup(marker);
    await clearOpenShifts(fx.branchId, cashier.id);
    await clearOpenShifts(fx.branchId, manager.id);
    const closed = await openShift(fx, cashier.id, 100);
    const order = await makeOrder(fx, marker, cashier.id, 28.5);
    try {
      await collectOrderPayment({
        session: cashier, orderId: order.id, branchId: fx.branchId,
        splits: [{ method: "CASH", amount: 28.5 }],
      });
      await db.shift.update({
        where: { id: closed.id },
        data: { status: "CLOSED", closedAt: new Date(), actualCashAmount: 128.5, cashDifference: 0 },
      });
      const before = await db.shift.findUniqueOrThrow({ where: { id: closed.id } });

      const mgrShift = await openShift(fx, manager.id, 0);
      try {
        await refundOrder(order.id, manager, REASON);

        const after = await db.shift.findUniqueOrThrow({ where: { id: closed.id } });
        assert.equal(Number(after.expectedCashAmount), Number(before.expectedCashAmount));
        assert.equal(Number(after.actualCashAmount), Number(before.actualCashAmount));
        assert.equal(Number(after.cashDifference), Number(before.cashDifference));

        const mgr = await db.shift.findUniqueOrThrow({ where: { id: mgrShift.id } });
        assert.equal(
          Number(mgr.totalRefunds), 28.5,
          "the outflow belongs to the drawer it actually left"
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

  test("I: a card refund leaves expected physical cash alone", async () => {
    const marker = "PH15-R004-I";
    const s = await scene(marker, 60);
    try {
      await collectOrderPayment({
        session: s.cashier, orderId: s.order.id, branchId: s.fx.branchId,
        splits: [{ method: "CARD", amount: 60 }],
      });
      const before = await db.shift.findUniqueOrThrow({ where: { id: s.shift.id } });
      await refundOrder(s.order.id, s.manager, REASON);
      const after = await db.shift.findUniqueOrThrow({ where: { id: s.shift.id } });

      assert.equal(
        Number(after.expectedCashAmount), Number(before.expectedCashAmount),
        "card money never sat in the drawer, so returning it must not empty the drawer"
      );
      assert.equal(Number(after.expectedCashAmount), 100, "still the opening float");
    } finally {
      await purge(s.order.id);
      await cleanup(marker);
      await cleanupShift(s.shift.id);
      await cleanupShift(s.mgrShift.id);
    }
  });

  test("J: an unauthorised actor is refused through the API", async () => {
    const marker = "PH15-R004-J";
    const s = await scene(marker, 30);
    try {
      await collectOrderPayment({
        session: s.cashier, orderId: s.order.id, branchId: s.fx.branchId,
        splits: [{ method: "CASH", amount: 30 }],
      });
      const r = await as("cashier@demo.com", `/api/orders/${s.order.id}/refund`, {
        method: "POST", body: JSON.stringify({ reason: REASON }),
      });
      assert.equal(r.status, 403, `a cashier must not be able to refund: ${r.text.slice(0, 120)}`);
      assert.equal(await db.payment.count({ where: { orderId: s.order.id, type: "REFUND" } }), 0);
    } finally {
      await purge(s.order.id);
      await cleanup(marker);
      await cleanupShift(s.shift.id);
      await cleanupShift(s.mgrShift.id);
    }
  });

  test("the API refuses a missing reason and accepts a real one", async () => {
    const marker = "PH15-R004-api";
    const s = await scene(marker, 30);
    try {
      await collectOrderPayment({
        session: s.cashier, orderId: s.order.id, branchId: s.fx.branchId,
        splits: [{ method: "CASH", amount: 30 }],
      });

      const blank = await as("manager@demo.com", `/api/orders/${s.order.id}/refund`, {
        method: "POST", body: JSON.stringify({ reason: "  " }),
      });
      assert.equal(blank.status, 400, "a blank reason must be refused at the boundary too");

      const ok = await as<{ order?: { paymentStatus: string }; totalRefunded?: number }>(
        "manager@demo.com", `/api/orders/${s.order.id}/refund`,
        { method: "POST", body: JSON.stringify({ reason: REASON }) }
      );
      assert.equal(ok.status, 200, `refund failed: ${ok.text.slice(0, 160)}`);
      assert.equal(ok.body.order?.paymentStatus, "REFUNDED", "the response must carry the new state");
    } finally {
      await purge(s.order.id);
      await cleanup(marker);
      await cleanupShift(s.shift.id);
      await cleanupShift(s.mgrShift.id);
    }
  });
});
