// POS-CONC-001 (R-POS-02A) — the POS money paths under concurrency.
//
// The SH domain has real concurrency tests; the POS layer has almost none,
// and that absence is why these defects survived. Two of the functions below
// carry a comment ASSERTING serialization that the code does not provide:
//
//   payments.ts  "concurrent collections serialize here and the second one
//                 sees the updated remaining"
//
// They do not serialize. A plain SELECT inside a transaction blocks nobody
// under PostgreSQL's default READ COMMITTED, and no isolation level is
// configured anywhere in the repository. So two collections both read
// `paidAmount = 0`, both pass the duplicate guard, and both insert — leaving
// one order marked paid once and TWO payment rows. `recomputeShiftTotals`
// sums payment ROWS, so the drawer is then expected to hold twice the sale
// and the cashier is raised a shortage at close for money nobody took.
//
// These tests race the real services, the way REFUND-004 races refundOrder.
// Every one of them fails against the unrepaired code.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { collectOrderPayment } from "@/lib/payments";
import { refundPayment } from "@/lib/refunds";
import {
  db,
  fixture,
  sessionFor,
  cleanup,
  cleanupShift,
  clearOpenShifts,
  openShift,
  makeOrder,
} from "./helpers/db";
import { recomputeShiftTotals } from "@/lib/shifts";

const MARKER = "PH15-POSC1";

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

describe("POS-CONC-001 a double-tapped collection takes the money once", () => {
  test("two parallel full collections: exactly one succeeds", async () => {
    const marker = `${MARKER}-A`;
    const s = await scene(marker, 100);
    try {
      const collect = () =>
        collectOrderPayment({
          session: s.cashier,
          orderId: s.order.id,
          branchId: s.fx.branchId,
          splits: [{ method: "CASH", amount: 100 }],
        });

      const results = await Promise.allSettled([collect(), collect()]);
      const ok = results.filter((r) => r.status === "fulfilled");
      assert.equal(
        ok.length,
        1,
        `exactly one collection may commit, got ${ok.length}: ` +
          results
            .map((r) => (r.status === "rejected" ? (r.reason as Error).message : "ok"))
            .join(" | ")
      );
    } finally {
      await purge(s.order.id);
      await cleanup(marker);
      await cleanupShift(s.shift.id);
      await cleanupShift(s.mgrShift.id);
    }
  });

  test("two parallel collections leave exactly one Payment row", async () => {
    const marker = `${MARKER}-B`;
    const s = await scene(marker, 100);
    try {
      const collect = () =>
        collectOrderPayment({
          session: s.cashier,
          orderId: s.order.id,
          branchId: s.fx.branchId,
          splits: [{ method: "CASH", amount: 100 }],
        });
      await Promise.allSettled([collect(), collect()]);

      const rows = await db.payment.count({
        where: { orderId: s.order.id, type: "COLLECTION" },
      });
      assert.equal(rows, 1, "one sale, one collection row");
    } finally {
      await purge(s.order.id);
      await cleanup(marker);
      await cleanupShift(s.shift.id);
      await cleanupShift(s.mgrShift.id);
    }
  });

  test("the drawer expectation matches the sale, not twice the sale", async () => {
    // The consequence that reaches a person: `recomputeShiftTotals` sums
    // payment rows, so a duplicated collection makes the shift expect money
    // the till never received, and the cashier answers for the difference.
    const marker = `${MARKER}-C`;
    const s = await scene(marker, 100);
    try {
      const collect = () =>
        collectOrderPayment({
          session: s.cashier,
          orderId: s.order.id,
          branchId: s.fx.branchId,
          splits: [{ method: "CASH", amount: 100 }],
        });
      await Promise.allSettled([collect(), collect()]);
      await recomputeShiftTotals(s.shift.id);

      const shift = await db.shift.findUniqueOrThrow({ where: { id: s.shift.id } });
      const order = await db.order.findUniqueOrThrow({ where: { id: s.order.id } });

      assert.equal(Number(order.paidAmount), 100, "the order was paid once");
      assert.equal(
        Number(shift.totalCashSales),
        100,
        "the shift must not expect money the till never took"
      );
      assert.equal(
        Number(shift.expectedCashAmount),
        Number(shift.openingCashAmount) + 100,
        "opening float plus one sale"
      );
    } finally {
      await purge(s.order.id);
      await cleanup(marker);
      await cleanupShift(s.shift.id);
      await cleanupShift(s.mgrShift.id);
    }
  });

  test("sequential partial collections still accumulate correctly", async () => {
    // The lock must not break the ordinary split-payment flow.
    const marker = `${MARKER}-D`;
    const s = await scene(marker, 100);
    try {
      await collectOrderPayment({
        session: s.cashier, orderId: s.order.id, branchId: s.fx.branchId,
        splits: [{ method: "CASH", amount: 40 }],
      });
      await collectOrderPayment({
        session: s.cashier, orderId: s.order.id, branchId: s.fx.branchId,
        splits: [{ method: "CARD", amount: 60 }],
      });

      const order = await db.order.findUniqueOrThrow({ where: { id: s.order.id } });
      assert.equal(Number(order.paidAmount), 100);
      assert.equal(Number(order.remainingAmount), 0);
      assert.equal(order.paymentStatus, "PAID");
      assert.equal(
        await db.payment.count({ where: { orderId: s.order.id, type: "COLLECTION" } }),
        2
      );
    } finally {
      await purge(s.order.id);
      await cleanup(marker);
      await cleanupShift(s.shift.id);
      await cleanupShift(s.mgrShift.id);
    }
  });
});

describe("POS-CONC-001 a double-tapped refund gives the money back once", () => {
  // `refundOrder` has taken a conditional claim since REFUND-004, with a
  // comment naming this exact scenario. `refundPayment` — the other refund
  // path, the one the closed-shift case uses — never got one: every
  // eligibility check ran on a read taken OUTSIDE its transaction, and the
  // transaction opened with an unconditional create.
  async function collected(marker: string, amount: number) {
    const s = await scene(marker, amount);
    await collectOrderPayment({
      session: s.cashier, orderId: s.order.id, branchId: s.fx.branchId,
      splits: [{ method: "CASH", amount }],
    });
    const payment = await db.payment.findFirstOrThrow({
      where: { orderId: s.order.id, type: "COLLECTION" },
      select: { id: true },
    });
    return { ...s, paymentId: payment.id };
  }

  test("two parallel payment-level refunds: exactly one applies", async () => {
    const marker = `${MARKER}-E`;
    const s = await collected(marker, 120);
    try {
      const results = await Promise.allSettled([
        refundPayment(s.paymentId, s.manager, "PH15 double tap"),
        refundPayment(s.paymentId, s.manager, "PH15 double tap"),
      ]);
      const ok = results.filter((r) => r.status === "fulfilled");
      assert.equal(
        ok.length,
        1,
        `exactly one refund may commit, got ${ok.length}: ` +
          results
            .map((r) => (r.status === "rejected" ? (r.reason as Error).message : "ok"))
            .join(" | ")
      );
    } finally {
      await purge(s.order.id);
      await cleanup(marker);
      await cleanupShift(s.shift.id);
      await cleanupShift(s.mgrShift.id);
    }
  });

  test("two parallel payment-level refunds leave exactly one REFUND row", async () => {
    const marker = `${MARKER}-F`;
    const s = await collected(marker, 120);
    try {
      await Promise.allSettled([
        refundPayment(s.paymentId, s.manager, "PH15 double tap"),
        refundPayment(s.paymentId, s.manager, "PH15 double tap"),
      ]);
      const refunds = await db.payment.count({
        where: { orderId: s.order.id, type: "REFUND" },
      });
      assert.equal(refunds, 1, "one collection reverses once");
    } finally {
      await purge(s.order.id);
      await cleanup(marker);
      await cleanupShift(s.shift.id);
      await cleanupShift(s.mgrShift.id);
    }
  });

  test("the drawer is not short after a double-tapped refund", async () => {
    // The consequence: `recomputeShiftTotals` subtracts every REFUND row, so
    // a duplicate leaves the cashier short by the refund amount at close.
    const marker = `${MARKER}-G`;
    const s = await collected(marker, 120);
    try {
      await Promise.allSettled([
        refundPayment(s.paymentId, s.manager, "PH15 double tap"),
        refundPayment(s.paymentId, s.manager, "PH15 double tap"),
      ]);
      await recomputeShiftTotals(s.shift.id);
      const shift = await db.shift.findUniqueOrThrow({ where: { id: s.shift.id } });
      assert.equal(
        Number(shift.expectedCashAmount),
        Number(shift.openingCashAmount),
        "collected once and returned once nets to the opening float"
      );
    } finally {
      await purge(s.order.id);
      await cleanup(marker);
      await cleanupShift(s.shift.id);
      await cleanupShift(s.mgrShift.id);
    }
  });

  test("a single refund still works, and stays traceable to its collection", async () => {
    const marker = `${MARKER}-H`;
    const s = await collected(marker, 120);
    try {
      await refundPayment(s.paymentId, s.manager, "PH15 single");
      const refund = await db.payment.findFirstOrThrow({
        where: { orderId: s.order.id, type: "REFUND" },
      });
      assert.equal(Number(refund.amount), 120, "positive magnitude");
      assert.equal(refund.reversalOfPaymentId, s.paymentId);
      // The original row keeps its own status: `collectedAmount` treats a
      // COLLECTION marked REFUNDED as zero money in hand, so flipping it
      // here would double-count the reversal.
      const original = await db.payment.findUniqueOrThrow({ where: { id: s.paymentId } });
      assert.equal(original.status, "PAID", "the original collection is not rewritten");
    } finally {
      await purge(s.order.id);
      await cleanup(marker);
      await cleanupShift(s.shift.id);
      await cleanupShift(s.mgrShift.id);
    }
  });
});
