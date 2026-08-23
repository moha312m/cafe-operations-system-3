// SHIFT-001 — a refund must affect expected cash exactly once.
//
// Invariant: expectedCash = accepted opening cash + net legitimate cash
// movements. Refunds are represented as a status flip (PAID → REFUNDED) on
// the original row, so a REFUNDED payment is already excluded from cash
// takings; subtracting it again double-counts the same reversal.

import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import { collectOrderPayment } from "@/lib/payments";
import { recomputeShiftTotals } from "@/lib/shifts";
import {
  db, fixture, sessionFor, openShift, makeOrder, cleanup, cleanupShift,
  clearOpenShifts,
} from "./helpers/db";

after(async () => { await db.$disconnect(); });

/** Mirrors what POST /api/payments/[id]/refund does to the row. */
async function refund(paymentId: string, shiftId: string) {
  await db.payment.update({ where: { id: paymentId }, data: { status: "REFUNDED" } });
  return recomputeShiftTotals(shiftId);
}

async function expectedCash(shiftId: string) {
  const s = await db.shift.findUniqueOrThrow({ where: { id: shiftId } });
  return Number(s.expectedCashAmount);
}

describe("SHIFT-001 expected cash", () => {
  test("full cash refund returns expected cash to the opening float", async () => {
    const fx = await fixture();
    const session = await sessionFor("cashier@demo.com");
    const marker = "PH1-SHIFT001-full";
    await cleanup(marker);
    await clearOpenShifts(fx.branchId, session.id);
    const shift = await openShift(fx, session.id, 500);
    const order = await makeOrder(fx, marker, session.id, 28.5);

    const res = await collectOrderPayment({
      session, orderId: order.id, branchId: fx.branchId,
      splits: [{ method: "CASH", amount: 28.5 }],
    });
    assert.equal(await expectedCash(shift.id), 528.5, "after a 28.50 cash sale");

    await refund(res.payments[0].id, shift.id);
    assert.equal(
      await expectedCash(shift.id), 500,
      "after refunding that same 28.50 the drawer must be back at the float"
    );

    await cleanup(marker); await cleanupShift(shift.id);
  });

  test("multiple cash sales, one refunded, counts the reversal once", async () => {
    const fx = await fixture();
    const session = await sessionFor("cashier@demo.com");
    const marker = "PH1-SHIFT001-multi";
    await cleanup(marker);
    await clearOpenShifts(fx.branchId, session.id);
    const shift = await openShift(fx, session.id, 100);

    const ids: string[] = [];
    for (const amt of [10, 20, 30]) {
      const o = await makeOrder(fx, marker, session.id, amt);
      const r = await collectOrderPayment({
        session, orderId: o.id, branchId: fx.branchId,
        splits: [{ method: "CASH", amount: amt }],
      });
      ids.push(r.payments[0].id);
    }
    assert.equal(await expectedCash(shift.id), 160, "100 + 10 + 20 + 30");

    await refund(ids[1], shift.id); // refund the 20
    assert.equal(await expectedCash(shift.id), 140, "100 + 10 + 30");

    await cleanup(marker); await cleanupShift(shift.id);
  });

  test("a card refund does not move expected cash", async () => {
    const fx = await fixture();
    const session = await sessionFor("cashier@demo.com");
    const marker = "PH1-SHIFT001-card";
    await cleanup(marker);
    await clearOpenShifts(fx.branchId, session.id);
    const shift = await openShift(fx, session.id, 200);
    const order = await makeOrder(fx, marker, session.id, 40);

    const res = await collectOrderPayment({
      session, orderId: order.id, branchId: fx.branchId,
      splits: [{ method: "CARD", amount: 40 }],
    });
    assert.equal(await expectedCash(shift.id), 200, "card never enters the drawer");

    await refund(res.payments[0].id, shift.id);
    assert.equal(await expectedCash(shift.id), 200, "refunding card must not move cash");

    const s = await db.shift.findUniqueOrThrow({ where: { id: shift.id } });
    assert.equal(Number(s.totalRefunds), 40, "refund is still disclosed");

    await cleanup(marker); await cleanupShift(shift.id);
  });

  test("recompute is idempotent — a repeated refund cannot drift the figure", async () => {
    const fx = await fixture();
    const session = await sessionFor("cashier@demo.com");
    const marker = "PH1-SHIFT001-repeat";
    await cleanup(marker);
    await clearOpenShifts(fx.branchId, session.id);
    const shift = await openShift(fx, session.id, 50);
    const order = await makeOrder(fx, marker, session.id, 15);

    const res = await collectOrderPayment({
      session, orderId: order.id, branchId: fx.branchId,
      splits: [{ method: "CASH", amount: 15 }],
    });
    await refund(res.payments[0].id, shift.id);
    const once = await expectedCash(shift.id);

    await recomputeShiftTotals(shift.id);
    await recomputeShiftTotals(shift.id);
    assert.equal(await expectedCash(shift.id), once, "recompute must be stable");
    assert.equal(once, 50, "50 in, 15 taken, 15 returned");

    await cleanup(marker); await cleanupShift(shift.id);
  });

  test("mixed cash+card payment: refunding the cash leg moves only cash", async () => {
    const fx = await fixture();
    const session = await sessionFor("cashier@demo.com");
    const marker = "PH1-SHIFT001-mixed";
    await cleanup(marker);
    await clearOpenShifts(fx.branchId, session.id);
    const shift = await openShift(fx, session.id, 300);
    const order = await makeOrder(fx, marker, session.id);
    const total = Number((await db.order.findUniqueOrThrow({ where: { id: order.id } })).total);
    const cashLeg = round2(total / 2);
    const cardLeg = round2(total - cashLeg);

    const res = await collectOrderPayment({
      session, orderId: order.id, branchId: fx.branchId,
      splits: [{ method: "CASH", amount: cashLeg }, { method: "CARD", amount: cardLeg }],
    });
    assert.equal(res.payments.length, 2, "one row per method");
    assert.equal(await expectedCash(shift.id), round2(300 + cashLeg));

    const cashRow = await db.payment.findFirstOrThrow({
      where: { id: { in: res.payments.map((p) => p.id) }, method: "CASH" },
    });
    await refund(cashRow.id, shift.id);
    assert.equal(await expectedCash(shift.id), 300, "only the cash leg leaves the drawer");

    await cleanup(marker); await cleanupShift(shift.id);
  });
});

function round2(n: number) { return Math.round(n * 100) / 100; }
