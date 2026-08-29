// REFUND-002 — a refunded order must not still read as settled, and must be
// terminal.
//
// Neither refund path touched the order's settlement fields, so a fully
// refunded order kept paymentStatus PAID with paidAmount equal to the total,
// which reads as money the café is still holding.
//
// The invariant: a full refund closes the order out. Nothing is paid and
// nothing is owed — REFUNDED means the customer owes nothing, not that the
// bill is open again. Collecting against a refunded order is refused; a
// customer who buys again gets a new order. Allowing a fresh collection here
// would make Gross 120 / Refunds 120 / Net 0 coexist with a live 120 against
// the same sale, which no reconciliation can express.
//
// The payment rows keep the history the balance no longer carries.

import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import { collectOrderPayment } from "@/lib/payments";
import { refundPayment } from "@/lib/refunds";
import {
  db, fixture, sessionFor, openShift, makeOrder, cleanup, cleanupShift,
  clearOpenShifts,
} from "./helpers/db";

after(async () => { await db.$disconnect(); });

async function purge(orderId: string) {
  await db.payment.deleteMany({ where: { orderId, reversalOfPaymentId: { not: null } } });
  await db.payment.deleteMany({ where: { orderId } });
}

/** Collect in full, then refund, returning the order's settlement state. */
async function sellThenRefund(marker: string, total: number) {
  const fx = await fixture();
  const cashier = await sessionFor("cashier@demo.com");
  const manager = await sessionFor("manager@demo.com");
  await cleanup(marker);
  await clearOpenShifts(fx.branchId, cashier.id);
  await clearOpenShifts(fx.branchId, manager.id);
  const shift = await openShift(fx, cashier.id, 100);
  const mgrShift = await openShift(fx, manager.id, 0);
  const order = await makeOrder(fx, marker, cashier.id, total);

  const res = await collectOrderPayment({
    session: cashier, orderId: order.id, branchId: fx.branchId,
    splits: [{ method: "CASH", amount: total }],
  });
  await refundPayment(res.payments[0].id, manager);

  return { fx, cashier, manager, shift, mgrShift, order, total };
}

describe("REFUND-002 order settlement after a full refund", () => {
  test("a fully refunded order is no longer settled", async () => {
    const marker = "PH15-R002-settle";
    const ctx = await sellThenRefund(marker, 102.6);
    try {
      const o = await db.order.findUniqueOrThrow({ where: { id: ctx.order.id } });

      assert.equal(
        Number(o.paidAmount), 0,
        "a full refund must leave nothing standing as paid"
      );
      assert.equal(
        Number(o.remainingAmount), 0,
        "a refunded order is closed out — the customer owes nothing"
      );
      assert.equal(
        o.paymentStatus, "REFUNDED",
        "an order whose money was returned must not read as PAID"
      );
      assert.equal(
        Number(o.total), 102.6,
        "the sale still happened — the total must not be rewritten"
      );
    } finally {
      await purge(ctx.order.id);
      await cleanup(marker);
      await cleanupShift(ctx.shift.id);
      await cleanupShift(ctx.mgrShift.id);
    }
  });

  test("a refunded order is terminal — it cannot be collected again", async () => {
    // The guard derives its own remaining from `total - paidAmount`, so
    // zeroing paidAmount is not by itself enough to close the order: the
    // refunded state has to be refused explicitly.
    const marker = "PH15-R002-terminal";
    const ctx = await sellThenRefund(marker, 30);
    try {
      await assert.rejects(
        () => collectOrderPayment({
          session: ctx.cashier, orderId: ctx.order.id, branchId: ctx.fx.branchId,
          splits: [{ method: "CASH", amount: 30 }],
        }),
        (e: Error) => {
          assert.match(
            e.message, /مرتجع|refund/i,
            `expected a refusal that names the refunded state, got: ${e.message}`
          );
          return true;
        },
        "collecting against a refunded order must be refused"
      );

      const o = await db.order.findUniqueOrThrow({ where: { id: ctx.order.id } });
      assert.equal(Number(o.paidAmount), 0, "the refused attempt must not settle anything");
      assert.equal(Number(o.remainingAmount), 0);
      assert.equal(o.paymentStatus, "REFUNDED", "the order stays closed out");
      assert.equal(
        await db.payment.count({ where: { orderId: ctx.order.id } }), 2,
        "no third payment row may be written by a refused collection"
      );
    } finally {
      await purge(ctx.order.id);
      await cleanup(marker);
      await cleanupShift(ctx.shift.id);
      await cleanupShift(ctx.mgrShift.id);
    }
  });

  test("the customer can still buy again — on a new order", async () => {
    // Terminal means terminal for that sale only; trade continues normally.
    const marker = "PH15-R002-newsale";
    const ctx = await sellThenRefund(marker, 30);
    const fresh = await makeOrder(ctx.fx, marker + "-b", ctx.cashier.id, 30);
    try {
      const res = await collectOrderPayment({
        session: ctx.cashier, orderId: fresh.id, branchId: ctx.fx.branchId,
        splits: [{ method: "CASH", amount: 30 }],
      });
      assert.ok(res.payments.length > 0, "a new order must collect normally");

      const o = await db.order.findUniqueOrThrow({ where: { id: fresh.id } });
      assert.equal(Number(o.paidAmount), 30);
      assert.equal(Number(o.remainingAmount), 0);
      assert.equal(o.paymentStatus, "PAID");

      // The refunded order is untouched by the new sale.
      const old = await db.order.findUniqueOrThrow({ where: { id: ctx.order.id } });
      assert.equal(old.paymentStatus, "REFUNDED");
      assert.equal(Number(old.paidAmount), 0);
    } finally {
      await purge(fresh.id);
      await purge(ctx.order.id);
      await cleanup(marker);
      await cleanupShift(ctx.shift.id);
      await cleanupShift(ctx.mgrShift.id);
    }
  });

  test("the money that moved is still on the record", async () => {
    const marker = "PH15-R002-history";
    const ctx = await sellThenRefund(marker, 45);
    try {
      const rows = await db.payment.findMany({ where: { orderId: ctx.order.id } });
      assert.equal(
        rows.length, 2,
        "both the collection and the refund must survive as history"
      );
      const collected = rows.filter((r) => !r.reversalOfPaymentId);
      const returned = rows.filter((r) => r.reversalOfPaymentId);
      assert.equal(collected.length, 1, "the original collection must not be erased");
      assert.equal(returned.length, 1, "the refund must be recorded in its own right");
      assert.equal(
        Number(collected[0].amount), 45,
        "what was taken stays derivable even though the balance is now zero"
      );
    } finally {
      await purge(ctx.order.id);
      await cleanup(marker);
      await cleanupShift(ctx.shift.id);
      await cleanupShift(ctx.mgrShift.id);
    }
  });
});
