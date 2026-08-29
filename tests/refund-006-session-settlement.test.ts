// REFUND-006 — a fully refunded order left a phantom balance on the table.
//
// Phase 1.5 made a full refund terminal on the order: paymentStatus REFUNDED,
// paidAmount 0, remainingAmount 0 — the customer owes nothing. The table
// session was never taught the same thing. It derives its own receivable as
// `totalAmount - paidAmount`, where totalAmount is the historical value of
// the orders on the table and paidAmount is the net money still held. A full
// refund drives paidAmount back to 0 while totalAmount stays at 120, so the
// table reported 120 still owed against a sale that was closed out.
//
// The damage is operational, not cosmetic: table close refuses to settle a
// session with a balance unless the actor holds tables.manage, so a refunded
// table could only be closed by a manager override — for a bill nobody owes.
//
// The fix keeps the two ideas apart. totalAmount stays historical (reporting
// still sees Gross 120). The session's receivable is the sum of what its
// orders each still say is owed, which is the only figure that already knows
// about refunds, part-payments and loyalty.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { collectOrderPayment } from "@/lib/payments";
import { refundOrder } from "@/lib/refunds";
import { recomputeSessionTotals, attachOrderToTableSession } from "@/lib/table-sessions";
import { periodFinancials } from "@/lib/reporting";
import {
  db, fixture, sessionFor, openShift, makeOrder, cleanup, cleanupShift,
  clearOpenShifts, type Fixture,
} from "./helpers/db";
import { requireServer, login, as } from "./helpers/http";

const CASHIER = "cashier@demo.com", MANAGER = "manager@demo.com";

after(async () => { await db.$disconnect(); });
before(async () => {
  await requireServer();
  await login(CASHIER, "cashier123");
  await login(MANAGER, "manager123");
});

/** A dine-in order sitting on `tableNumber`, attached to that table's session. */
async function dineInOrder(
  fx: Fixture, marker: string, createdById: string, total: number, tableNumber: string
) {
  const order = await makeOrder(fx, marker, createdById, total);
  await db.order.update({
    where: { id: order.id },
    data: { type: "DINE_IN", tableNumber },
  });
  const session = await attachOrderToTableSession(
    {
      id: order.id, cafeId: fx.cafeId, branchId: fx.branchId, type: "DINE_IN",
      tableNumber, orderNumber: order.orderNumber,
    },
    createdById
  );
  return { order, session: session! };
}

/** Sales are recognised on SERVED, so a bill that was served then refunded
 *  has to actually reach SERVED for reporting to see it. */
async function markServed(orderId: string) {
  await db.order.update({
    where: { id: orderId },
    data: { status: "SERVED", stockDeductedAt: new Date() },
  });
}

async function purgeOrders(orderIds: string[], marker: string, sessionId?: string) {
  await db.payment.deleteMany({ where: { orderId: { in: orderIds } } });
  await db.order.updateMany({ where: { id: { in: orderIds } }, data: { tableSessionId: null } });
  await cleanup(marker);
  if (sessionId) await db.tableSession.deleteMany({ where: { id: sessionId } });
}

describe("REFUND-006 table-session settlement", () => {
  // ── A: the refunded bill is closed at both levels ──
  test("A: a fully refunded dine-in order leaves nothing owed on the table", async () => {
    const marker = "PH15-R006-A";
    const fx = await fixture();
    const cashier = await sessionFor(CASHIER);
    const manager = await sessionFor(MANAGER);
    await cleanup(marker);
    await clearOpenShifts(fx.branchId, cashier.id);
    await clearOpenShifts(fx.branchId, manager.id);
    const shift = await openShift(fx, cashier.id, 100);
    const mgrShift = await openShift(fx, manager.id, 0);

    const { order, session } = await dineInOrder(fx, marker, cashier.id, 120, "R006A");
    try {
      await collectOrderPayment({
        session: cashier, orderId: order.id, branchId: fx.branchId,
        splits: [{ method: "CASH", amount: 120 }],
      });
      await refundOrder(order.id, manager, "اختبار التسوية");

      const o = await db.order.findUniqueOrThrow({ where: { id: order.id } });
      assert.equal(o.paymentStatus, "REFUNDED");
      assert.equal(Number(o.paidAmount), 0);
      assert.equal(Number(o.remainingAmount), 0, "the order itself is settled");

      const s = await recomputeSessionTotals(session.id);
      assert.equal(
        Number(s.remainingAmount), 0,
        "the table must not still show the refunded bill as owed"
      );
      // History is untouched: the sale still happened.
      assert.equal(
        Number(s.totalAmount), 120,
        "historical table value must stay — reporting reads it"
      );
    } finally {
      await purgeOrders([order.id], marker, session.id);
      await cleanupShift(shift.id);
      await cleanupShift(mgrShift.id);
    }
  });

  // ── B: no manager override for a bill nobody owes ──
  test("B: a cashier can close a table whose only order was fully refunded", async () => {
    const marker = "PH15-R006-B";
    const fx = await fixture();
    const cashier = await sessionFor(CASHIER);
    const manager = await sessionFor(MANAGER);
    await cleanup(marker);
    await clearOpenShifts(fx.branchId, cashier.id);
    await clearOpenShifts(fx.branchId, manager.id);
    const shift = await openShift(fx, cashier.id, 100);
    const mgrShift = await openShift(fx, manager.id, 0);

    const { order, session } = await dineInOrder(fx, marker, cashier.id, 120, "R006B");
    try {
      await collectOrderPayment({
        session: cashier, orderId: order.id, branchId: fx.branchId,
        splits: [{ method: "CASH", amount: 120 }],
      });
      // Served first, then refunded — the order a café actually refunds is one
      // the customer already received and complained about. Since POLICY-003
      // the close also checks the kitchen, and an order left unserved blocks on
      // its own merits; this test is about the *financial* blocker, so the
      // preparation side is taken out of the picture deliberately.
      await markServed(order.id);
      await refundOrder(order.id, manager, "اختبار القفل");

      // The cashier holds tables.close but NOT tables.manage, so this only
      // succeeds if the session is genuinely settled.
      const res = await as<{ error?: string }>(
        CASHIER, `/api/tables/${session.id}/close`, { method: "POST" }
      );
      assert.equal(
        res.status, 200,
        `a refunded table must close without a manager override, got ${res.status}: ${res.text.slice(0, 160)}`
      );
      const closed = await db.tableSession.findUniqueOrThrow({ where: { id: session.id } });
      assert.equal(closed.status, "CLOSED");
    } finally {
      await purgeOrders([order.id], marker, session.id);
      await cleanupShift(shift.id);
      await cleanupShift(mgrShift.id);
    }
  });

  // ── C–F: the sale still reports, the refund reports beside it ──
  test("C-F: reporting keeps Gross 120, Refunds 120, Net 0, Collections 120", async () => {
    const marker = "PH15-R006-CF";
    const fx = await fixture();
    const cashier = await sessionFor(CASHIER);
    const manager = await sessionFor(MANAGER);
    await cleanup(marker);
    await clearOpenShifts(fx.branchId, cashier.id);
    await clearOpenShifts(fx.branchId, manager.id);
    const shift = await openShift(fx, cashier.id, 100);
    const mgrShift = await openShift(fx, manager.id, 0);

    // Window opens before the test's own rows so nothing else is in scope.
    const from = new Date();
    const { order, session } = await dineInOrder(fx, marker, cashier.id, 120, "R006CF");
    try {
      await collectOrderPayment({
        session: cashier, orderId: order.id, branchId: fx.branchId,
        splits: [{ method: "CASH", amount: 120 }],
      });
      await markServed(order.id);
      await refundOrder(order.id, manager, "اختبار التقارير");
      await recomputeSessionTotals(session.id);

      // Bounded at BOTH ends. `{ gte: from }` says "from now on, for ever",
      // which is a window this test cannot own: anything else in the café
      // carrying a later timestamp lands inside it and is counted against
      // figures asserted to the piastre. Closing it at the moment the work
      // finished states what the assertion actually means — what THIS test
      // did — and none of its own rows fall outside.
      const fin = await periodFinancials({
        cafeId: fx.cafeId, branchId: fx.branchId,
        period: { gte: from, lte: new Date() },
      });
      assert.equal(fin.grossSales, 120, "C: the sale happened and must stay in Gross");
      assert.equal(fin.refunds, 120, "D: the refund must be reported");
      assert.equal(fin.netSales, 0, "E: Net is Gross minus Refunds");
      assert.equal(fin.collections, 120, "F: money was in fact collected");
    } finally {
      await purgeOrders([order.id], marker, session.id);
      await cleanupShift(shift.id);
      await cleanupShift(mgrShift.id);
    }
  });

  // ── G: a refunded bill must not swallow a real one ──
  test("G: refunded 120 + unpaid 80 leaves exactly 80 due", async () => {
    const marker = "PH15-R006-G";
    const fx = await fixture();
    const cashier = await sessionFor(CASHIER);
    const manager = await sessionFor(MANAGER);
    await cleanup(marker);
    await clearOpenShifts(fx.branchId, cashier.id);
    await clearOpenShifts(fx.branchId, manager.id);
    const shift = await openShift(fx, cashier.id, 100);
    const mgrShift = await openShift(fx, manager.id, 0);

    const a = await dineInOrder(fx, marker + "-A", cashier.id, 120, "R006G");
    const b = await dineInOrder(fx, marker + "-B", cashier.id, 80, "R006G");
    try {
      assert.equal(a.session.id, b.session.id, "both orders share one table session");
      await collectOrderPayment({
        session: cashier, orderId: a.order.id, branchId: fx.branchId,
        splits: [{ method: "CASH", amount: 120 }],
      });
      await refundOrder(a.order.id, manager, "اختبار مختلط");

      const s = await recomputeSessionTotals(a.session.id);
      assert.equal(
        Number(s.remainingAmount), 80,
        "only the unpaid 80 is owed — not 200, and not 0"
      );
      assert.equal(Number(s.totalAmount), 200, "historical value of both bills");
    } finally {
      await purgeOrders([a.order.id, b.order.id], marker, a.session.id);
      await cleanupShift(shift.id);
      await cleanupShift(mgrShift.id);
    }
  });

  // ── H: refunded beside settled leaves nothing ──
  test("H: refunded 120 + fully paid 80 leaves nothing due", async () => {
    const marker = "PH15-R006-H";
    const fx = await fixture();
    const cashier = await sessionFor(CASHIER);
    const manager = await sessionFor(MANAGER);
    await cleanup(marker);
    await clearOpenShifts(fx.branchId, cashier.id);
    await clearOpenShifts(fx.branchId, manager.id);
    const shift = await openShift(fx, cashier.id, 100);
    const mgrShift = await openShift(fx, manager.id, 0);

    const a = await dineInOrder(fx, marker + "-A", cashier.id, 120, "R006H");
    const b = await dineInOrder(fx, marker + "-B", cashier.id, 80, "R006H");
    try {
      await collectOrderPayment({
        session: cashier, orderId: a.order.id, branchId: fx.branchId,
        splits: [{ method: "CASH", amount: 120 }],
      });
      await collectOrderPayment({
        session: cashier, orderId: b.order.id, branchId: fx.branchId,
        splits: [{ method: "CASH", amount: 80 }],
      });
      await refundOrder(a.order.id, manager, "اختبار مختلط");

      const s = await recomputeSessionTotals(a.session.id);
      assert.equal(Number(s.remainingAmount), 0, "one refunded, one paid — nothing owed");
    } finally {
      await purgeOrders([a.order.id, b.order.id], marker, a.session.id);
      await cleanupShift(shift.id);
      await cleanupShift(mgrShift.id);
    }
  });
});
