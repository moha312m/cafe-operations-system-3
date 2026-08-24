// REFUND-005 — "status: PAID" stopped meaning "money received".
//
// Phase 1.5 gave a payment row an explicit financial meaning: COLLECTION is
// money in, REFUND is money out, and both carry a positive amount with
// status PAID because status describes lifecycle, not direction. Reporting
// was taught the difference, but older calculations that had always read
// `status: "PAID"` as "money collected" were not — so a refund began to
// count as income.
//
// The damage was not confined to reports. The serving guard sums the same
// rows, so refunding an order made it look MORE paid and it became servable;
// a table session showed 240 collected against a 120 bill.
//
// The invariant: any question about money received, settlement progress or
// serving eligibility must ask for COLLECTION explicitly. Lifecycle
// questions may keep using status.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { collectOrderPayment } from "@/lib/payments";
import { refundOrder } from "@/lib/refunds";
import { recomputeSessionTotals } from "@/lib/table-sessions";
import { collectedAmount, isOrderFullyPaid } from "@/lib/order-payments";
import {
  db, fixture, sessionFor, openShift, makeOrder, cleanup, cleanupShift,
  clearOpenShifts,
} from "./helpers/db";
import { requireServer, login, as } from "./helpers/http";

const CASHIER = "cashier@demo.com", MANAGER = "manager@demo.com", ADMIN = "admin@cafeops.dev";

after(async () => { await db.$disconnect(); });
before(async () => {
  await requireServer();
  await login(CASHIER, "cashier123");
  await login(MANAGER, "manager123");
  await login(ADMIN, "admin1234");
});

async function purge(orderId: string) {
  await db.payment.deleteMany({ where: { orderId, reversalOfPaymentId: { not: null } } });
  await db.payment.deleteMany({ where: { orderId } });
}

/** Sell for cash, then refund it in full. Both actors hold a drawer. */
async function soldThenRefunded(marker: string, total: number) {
  const fx = await fixture();
  const cashier = await sessionFor(CASHIER);
  const manager = await sessionFor(MANAGER);
  await cleanup(marker);
  await clearOpenShifts(fx.branchId, cashier.id);
  await clearOpenShifts(fx.branchId, manager.id);
  const shift = await openShift(fx, cashier.id, 100);
  const mgrShift = await openShift(fx, manager.id, 0);
  const order = await makeOrder(fx, marker, cashier.id, total);
  await collectOrderPayment({
    session: cashier, orderId: order.id, branchId: fx.branchId,
    splits: [{ method: "CASH", amount: total }],
  });
  await refundOrder(order.id, manager, "اختبار الدلالة");
  return { fx, cashier, manager, shift, mgrShift, order, total };
}

describe("REFUND-005 collection semantics", () => {
  test("A: a refunded order is not fully paid, and is not servable", async () => {
    const marker = "PH15-R005-A";
    const ctx = await soldThenRefunded(marker, 120);
    try {
      const o = await db.order.findUniqueOrThrow({ where: { id: ctx.order.id } });
      assert.equal(o.paymentStatus, "REFUNDED");
      assert.equal(Number(o.paidAmount), 0);
      assert.equal(Number(o.remainingAmount), 0);

      // Walk it to READY so SERVED is the next legal move, then try to serve.
      // stockDeductedAt is pre-set so a recipe shortage cannot block the
      // request for an unrelated reason and disguise the result.
      await db.order.update({
        where: { id: ctx.order.id },
        data: { status: "READY", stockDeductedAt: new Date() },
      });
      const served = await as<{ error?: string }>(
        CASHIER, `/api/orders/${ctx.order.id}/status`,
        { method: "PATCH", body: JSON.stringify({ status: "SERVED" }) }
      );
      assert.notEqual(
        served.status, 200,
        "a refunded order must not be servable — its refund is not a payment"
      );
      assert.match(
        served.body.error ?? served.text, /يتدفع|دفع|paid|payment/i,
        `expected a refusal about payment, got: ${served.text.slice(0, 160)}`
      );
      const still = await db.order.findUniqueOrThrow({ where: { id: ctx.order.id } });
      assert.notEqual(still.status, "SERVED");
    } finally {
      await purge(ctx.order.id);
      await cleanup(marker);
      await cleanupShift(ctx.shift.id);
      await cleanupShift(ctx.mgrShift.id);
    }
  });

  test("B+C: a refund never raises the collected total on an order or session", async () => {
    const marker = "PH15-R005-BC";
    const fx = await fixture();
    const cashier = await sessionFor(CASHIER);
    const manager = await sessionFor(MANAGER);
    await cleanup(marker);
    await clearOpenShifts(fx.branchId, cashier.id);
    await clearOpenShifts(fx.branchId, manager.id);
    const shift = await openShift(fx, cashier.id, 100);
    const mgrShift = await openShift(fx, manager.id, 0);

    const order = await makeOrder(fx, marker, cashier.id, 120);
    const session = await db.tableSession.create({
      data: {
        cafeId: fx.cafeId, branchId: fx.branchId, tableNumber: "T-R005",
        status: "OPEN", totalAmount: 0, paidAmount: 0, remainingAmount: 0,
      },
    });
    await db.order.update({ where: { id: order.id }, data: { tableSessionId: session.id } });

    try {
      await collectOrderPayment({
        session: cashier, orderId: order.id, branchId: fx.branchId,
        splits: [{ method: "CASH", amount: 120 }],
      });
      const before = await recomputeSessionTotals(session.id);
      assert.equal(Number(before.paidAmount), 120, "precondition: one collection of 120");

      await refundOrder(order.id, manager, "اختبار");
      const after = await recomputeSessionTotals(session.id);

      assert.equal(
        Number(after.paidAmount), 0,
        `a returned 120 must not read as collected; got paid=${after.paidAmount}`
      );
      assert.ok(
        Number(after.paidAmount) <= Number(after.totalAmount) + 0.001,
        "a session can never be collected beyond its own total"
      );
    } finally {
      await purge(order.id);
      await cleanup(marker);
      await db.tableSession.deleteMany({ where: { id: session.id } });
      await cleanupShift(shift.id);
      await cleanupShift(mgrShift.id);
    }
  });

  test("D: collect-info reports what was collected, not collected+returned", async () => {
    const marker = "PH15-R005-D";
    const ctx = await soldThenRefunded(marker, 120);
    try {
      const r = await as<{ target?: { paidAmount?: number; payments?: { amount: string }[] } }>(
        MANAGER, `/api/payments/collect-info?orderId=${ctx.order.id}`
      );
      assert.equal(r.status, 200, `collect-info failed: ${r.text.slice(0, 160)}`);
      const target = r.body.target;
      assert.ok(target, "collect-info must describe the collection target");

      const listed = (target.payments ?? []).reduce((sum, p) => sum + Number(p.amount), 0);
      assert.ok(
        listed <= 120,
        `collect-info handed the POS ${listed} in payment rows on a 120 order — ` +
          `the refund is being presented as money received`
      );
      if (typeof target.paidAmount === "number") {
        assert.ok(target.paidAmount <= 120, `paidAmount reported as ${target.paidAmount}`);
      }
    } finally {
      await purge(ctx.order.id);
      await cleanup(marker);
      await cleanupShift(ctx.shift.id);
      await cleanupShift(ctx.mgrShift.id);
    }
  });

  test("E: platform admin reports do not count a refund as money received", async () => {
    const marker = "PH15-R005-E";
    // Platform-wide over 30 days, so the figure is measured as a delta around
    // this scenario rather than in absolute terms.
    const readCash = async () => {
      const r = await as<{ totals?: { cash: number } }>(ADMIN, "/api/admin/reports");
      assert.equal(r.status, 200, `admin reports failed: ${r.text.slice(0, 160)}`);
      return Number(r.body.totals?.cash ?? 0);
    };
    const before = await readCash();
    const ctx = await soldThenRefunded(marker, 120);
    try {
      const delta = Math.round((await readCash() - before) * 100) / 100;
      // The collection stands on its own; the refund must not be added on top.
      assert.equal(
        delta, 120,
        `a 120 sale refunded in full moved platform cash received by ${delta} — ` +
          `240 means the refund was added instead of ignored`
      );
    } finally {
      await purge(ctx.order.id);
      await cleanup(marker);
      await cleanupShift(ctx.shift.id);
      await cleanupShift(ctx.mgrShift.id);
    }
  });

  test("F+G: the shared paid check used by kitchen and orders ignores refunds", async () => {
    // Both screens decided "is this paid?" by summing status PAID. The rule
    // now lives in one place so the two screens cannot drift apart, and so it
    // can be tested at all.
    const rows = [
      { amount: "120", type: "COLLECTION" as const, status: "PAID" as const },
      { amount: "120", type: "REFUND" as const, status: "PAID" as const },
    ];
    assert.equal(
      collectedAmount(rows), 0,
      "collected must net the refund out, not add it"
    );
    assert.equal(
      isOrderFullyPaid({ total: "120", payments: rows }), false,
      "a fully refunded order is not paid"
    );
    assert.equal(
      collectedAmount([rows[0]]), 120,
      "an unrefunded collection still counts in full"
    );
    assert.equal(
      isOrderFullyPaid({ total: "120", payments: [rows[0]] }), true
    );
    // Legacy in-period reversal: the collection itself was flipped REFUNDED.
    assert.equal(
      collectedAmount([{ amount: "120", type: "COLLECTION", status: "REFUNDED" }]), 0,
      "a legacy reversed collection is not money in hand either"
    );
  });

  test("H+I+J: Commit A/B guarantees still hold", async () => {
    const marker = "PH15-R005-HIJ";
    const fx = await fixture();
    const cashier = await sessionFor(CASHIER);
    const manager = await sessionFor(MANAGER);
    await cleanup(marker);
    await clearOpenShifts(fx.branchId, cashier.id);
    await clearOpenShifts(fx.branchId, manager.id);
    const shift = await openShift(fx, cashier.id, 500);
    const mgrShift = await openShift(fx, manager.id, 0);
    const order = await makeOrder(fx, marker, cashier.id, 120);
    try {
      // J: mixed payment, refunded atomically
      await collectOrderPayment({
        session: cashier, orderId: order.id, branchId: fx.branchId,
        splits: [{ method: "CASH", amount: 70 }, { method: "CARD", amount: 50 }],
      });
      const beforeCash = Number(
        (await db.shift.findUniqueOrThrow({ where: { id: shift.id } })).expectedCashAmount
      );
      await refundOrder(order.id, manager, "اختبار");

      const refunds = await db.payment.findMany({ where: { orderId: order.id, type: "REFUND" } });
      assert.equal(refunds.length, 2, "J: both legs reversed");
      assert.ok(refunds.every((r) => Number(r.amount) > 0), "J: positive magnitudes");

      // I: only the cash leg moves the drawer
      const afterCash = Number(
        (await db.shift.findUniqueOrThrow({ where: { id: shift.id } })).expectedCashAmount
      );
      assert.equal(beforeCash - afterCash, 70, "I: drawer moves by the cash portion only");

      // H: reporting definitions unchanged
      const day = new Date();
      const ds = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
      const rep = await as<{ financials?: { grossSales: number; refunds: number; netSales: number; collections: number } }>(
        MANAGER, `/api/reports/daily?date=${ds}`
      );
      const f = rep.body.financials;
      assert.ok(f, "H: financials block still present");
      assert.equal(
        Math.round((f.grossSales - f.refunds) * 100) / 100, f.netSales,
        "H: Net Sales still reconciles as Gross - Refunds"
      );
      assert.ok(f.refunds >= 120, "H: the refund is still reported as a refund");
    } finally {
      await purge(order.id);
      await cleanup(marker);
      await cleanupShift(shift.id);
      await cleanupShift(mgrShift.id);
    }
  });
});
