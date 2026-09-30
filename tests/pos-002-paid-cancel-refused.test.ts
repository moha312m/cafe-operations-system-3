// POS-002 (R-POS-02A/A8) — money that was collected cannot be cancelled away.
//
// Cancelling an order required only `orders:cancel`. Nothing checked whether
// the order had been paid, and no refund was issued, so the money stayed
// collected while the sale disappeared:
//
//   • `recomputeSessionTotals` excludes CANCELLED orders from BOTH the order
//     aggregate and the payment group-by, so the table's bill forgets it;
//   • `recomputeShiftTotals` filters on `shiftId` alone, so the drawer still
//     has to contain it;
//   • reporting counts the collection with no matching sale and no refund.
//
// The owner's rule: an unpaid order still cancels; a paid or partly paid one
// is refused and must go through the refund flow. Nothing is auto-refunded.
//
// "Paid" is decided by `collectedAmount` — collections less refunds — and not
// by `paymentStatus`, so an order that was refunded back to zero stays
// cancellable. The status route already loads the payment rows for exactly
// this reason.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { collectOrderPayment } from "@/lib/payments";
import { refundOrder } from "@/lib/refunds";
import { collectedAmount } from "@/lib/order-payments";
import {
  db, fixture, sessionFor, cleanup, cleanupShift, clearOpenShifts, openShift, makeOrder,
} from "./helpers/db";
import { requireServer, login, as } from "./helpers/http";

const MARKER = "PH15-POS002";
const REASON = "PH15 cancel-rule refund";

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

async function purge(orderId: string) {
  await db.payment.deleteMany({ where: { orderId } });
  await db.orderItem.deleteMany({ where: { orderId } });
  await db.order.deleteMany({ where: { id: orderId } });
}

const cancel = (email: string, orderId: string) =>
  as(email, `/api/orders/${orderId}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status: "CANCELLED" }),
  });

before(async () => {
  await requireServer();
  await login("manager@demo.com", "manager123");
});

describe("POS-002 cancelling an order with money on it", () => {
  test("an UNPAID order still cancels — the existing path is untouched", async () => {
    const marker = `${MARKER}-A`;
    const s = await scene(marker, 100);
    try {
      const res = await cancel("manager@demo.com", s.order.id);
      assert.equal(res.status, 200, res.text);
      const o = await db.order.findUniqueOrThrow({ where: { id: s.order.id } });
      assert.equal(o.status, "CANCELLED");
    } finally {
      await purge(s.order.id);
      await cleanup(marker);
      await cleanupShift(s.shift.id);
      await cleanupShift(s.mgrShift.id);
    }
  });

  test("a FULLY PAID order is refused, and the money stays reconciled", async () => {
    const marker = `${MARKER}-B`;
    const s = await scene(marker, 100);
    try {
      await collectOrderPayment({
        session: s.cashier, orderId: s.order.id, branchId: s.fx.branchId,
        splits: [{ method: "CASH", amount: 100 }],
      });

      const res = await cancel("manager@demo.com", s.order.id);
      assert.equal(res.status, 400, res.text);
      assert.match(res.text, /مرتجع|استرجاع|refund/i, "the refusal must point at the refund flow");

      // Nothing moved: the sale is still a sale and the money is still on it.
      const o = await db.order.findUniqueOrThrow({ where: { id: s.order.id } });
      assert.notEqual(o.status, "CANCELLED", "a paid order must not be cancelled");
      assert.equal(Number(o.paidAmount), 100, "the collected money is untouched");
      const payments = await db.payment.findMany({ where: { orderId: s.order.id } });
      assert.equal(collectedAmount(payments), 100, "still collected, not orphaned");
    } finally {
      await purge(s.order.id);
      await cleanup(marker);
      await cleanupShift(s.shift.id);
      await cleanupShift(s.mgrShift.id);
    }
  });

  test("a PARTIALLY paid order is refused too", async () => {
    const marker = `${MARKER}-C`;
    const s = await scene(marker, 100);
    try {
      await collectOrderPayment({
        session: s.cashier, orderId: s.order.id, branchId: s.fx.branchId,
        splits: [{ method: "CASH", amount: 40 }],
      });

      const res = await cancel("manager@demo.com", s.order.id);
      assert.equal(res.status, 400, res.text);

      const o = await db.order.findUniqueOrThrow({ where: { id: s.order.id } });
      assert.notEqual(o.status, "CANCELLED");
      assert.equal(Number(o.paidAmount), 40, "part payment is still money");
    } finally {
      await purge(s.order.id);
      await cleanup(marker);
      await cleanupShift(s.shift.id);
      await cleanupShift(s.mgrShift.id);
    }
  });

  test("an order refunded back to zero becomes cancellable again", async () => {
    // The reason the rule reads net collections rather than `paymentStatus`:
    // once the money has been properly returned through the refund flow,
    // there is nothing left to orphan.
    const marker = `${MARKER}-D`;
    const s = await scene(marker, 100);
    try {
      await collectOrderPayment({
        session: s.cashier, orderId: s.order.id, branchId: s.fx.branchId,
        splits: [{ method: "CASH", amount: 100 }],
      });
      await refundOrder(s.order.id, s.manager, REASON);

      const payments = await db.payment.findMany({ where: { orderId: s.order.id } });
      assert.equal(collectedAmount(payments), 0, "the refund returned everything");

      const res = await cancel("manager@demo.com", s.order.id);
      assert.equal(res.status, 200, `a fully refunded order may cancel: ${res.text}`);
    } finally {
      await purge(s.order.id);
      await cleanup(marker);
      await cleanupShift(s.shift.id);
      await cleanupShift(s.mgrShift.id);
    }
  });

  test("the refusal does not auto-refund", async () => {
    // A cancel that quietly reversed the money would be a different bug: the
    // owner's rule is that correction goes through the approved flow, with
    // its own permission and accounting checks.
    const marker = `${MARKER}-E`;
    const s = await scene(marker, 100);
    try {
      await collectOrderPayment({
        session: s.cashier, orderId: s.order.id, branchId: s.fx.branchId,
        splits: [{ method: "CASH", amount: 100 }],
      });
      await cancel("manager@demo.com", s.order.id);

      const refunds = await db.payment.count({
        where: { orderId: s.order.id, type: "REFUND" },
      });
      assert.equal(refunds, 0, "no refund may be created behind the user's back");
    } finally {
      await purge(s.order.id);
      await cleanup(marker);
      await cleanupShift(s.shift.id);
      await cleanupShift(s.mgrShift.id);
    }
  });
});
