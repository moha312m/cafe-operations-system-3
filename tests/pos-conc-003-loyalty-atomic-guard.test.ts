// POS-CONC-003 (R-POS-02B1) — a customer cannot spend points twice.
//
// Both redemption paths checked the balance on an ordinary read and then
// decremented it, with nothing in between to stop a second redemption
// slipping through the gap:
//
//   payments.ts  applyLoyaltyRedemptionInTx — "Re-read the customer inside
//                the tx — concurrent redemptions serialize."
//
// They do not serialize. A SELECT inside a transaction takes no lock under
// READ COMMITTED, which is this database's default and the only isolation
// level the repository configures. So two collections for the same customer
// both read the same balance, both find it sufficient, and both subtract —
// leaving `loyaltyPointsBalance` NEGATIVE. The column is a plain `Int` with
// no CHECK, so the database accepts it, the receipt prints it, and the café
// has given away a discount it was never owed.
//
// The repair is the house's own conditional-update idiom (refunds.ts): make
// the guard part of the write, so PostgreSQL re-evaluates it against the
// committed row and the loser writes nothing.
//
// R-POS-02B1 fixes the guard in application code only. No CHECK constraint
// and no migration — those stay the owner's decision.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { collectOrderPayment } from "@/lib/payments";
import { recordRedemptionInTx } from "@/lib/loyalty";
import {
  db, fixture, sessionFor, cleanup, cleanupShift, clearOpenShifts, openShift, makeOrder,
  type Fixture,
} from "./helpers/db";

const MARKER = "PH15-LOYAT";

let fx: Fixture;

/** A customer holding exactly `points`, with nothing else attached. */
async function customerWith(points: number, phone: string) {
  await db.customer.deleteMany({ where: { cafeId: fx.cafeId, normalizedPhone: phone } });
  return db.customer.create({
    data: {
      cafeId: fx.cafeId,
      name: MARKER,
      phone,
      normalizedPhone: phone,
      loyaltyPointsBalance: points,
    },
  });
}

async function dropCustomer(id: string) {
  await db.loyaltyTransaction.deleteMany({ where: { customerId: id } });
  await db.order.updateMany({ where: { customerId: id }, data: { customerId: null } });
  await db.customer.deleteMany({ where: { id } });
}

before(async () => {
  fx = await fixture();
});

after(async () => {
  await db.$disconnect();
});

describe("POS-CONC-003 loyalty points cannot be spent twice", () => {
  test("two parallel collections redeeming the same points: balance never goes negative", async () => {
    const marker = `${MARKER}-A`;
    const cashier = await sessionFor("cashier@demo.com");
    await cleanup(marker);
    await clearOpenShifts(fx.branchId, cashier.id);
    const shift = await openShift(fx, cashier.id, 0);
    const customer = await customerWith(50, "01099000001");
    const orderA = await makeOrder(fx, `${marker}-1`, cashier.id, 100);
    const orderB = await makeOrder(fx, `${marker}-2`, cashier.id, 100);

    try {
      const redeem = (orderId: string) =>
        collectOrderPayment({
          session: cashier,
          orderId,
          branchId: fx.branchId,
          splits: [{ method: "CASH" as const, amount: 50 }],
          redemption: { customerId: customer.id, points: 50, discount: 50 },
          pointValue: 1,
        });

      const settled = await Promise.allSettled([redeem(orderA.id), redeem(orderB.id)]);
      const outcomes = settled
        .map((r) => (r.status === "fulfilled" ? "ok" : (r.reason as Error).message))
        .join(" | ");

      const after = await db.customer.findUniqueOrThrow({ where: { id: customer.id } });
      assert.ok(
        after.loyaltyPointsBalance >= 0,
        `the customer's balance went negative (${after.loyaltyPointsBalance}) — ${outcomes}`
      );
      assert.equal(
        after.loyaltyPointsBalance,
        0,
        `fifty points were held and fifty may be spent, once: ${outcomes}`
      );

      // The ledger is the café's account of the points, so it has to agree
      // with the balance — a second REDEEM row for points nobody had would
      // make the history justify the wrong number.
      const redeemed = await db.loyaltyTransaction.aggregate({
        where: { customerId: customer.id, type: "REDEEM" },
        _sum: { points: true },
      });
      assert.equal(
        redeemed._sum.points ?? 0,
        -50,
        `the ledger records points that were never held: ${outcomes}`
      );
    } finally {
      await cleanup(marker);
      await cleanupShift(shift.id);
      await dropCustomer(customer.id);
    }
  });

  test("two parallel order-creation redemptions: exactly one may take the points", async () => {
    // The other redemption path. An order placed with points attached
    // deducts them through `recordRedemptionInTx`, which R-POS-02B1 moved
    // inside the order's own transaction so a refused claim cannot leave a
    // discounted order behind.
    const marker = `${MARKER}-B`;
    const cashier = await sessionFor("cashier@demo.com");
    await cleanup(marker);
    const customer = await customerWith(40, "01099000002");
    const orderA = await makeOrder(fx, `${marker}-1`, cashier.id, 100);
    const orderB = await makeOrder(fx, `${marker}-2`, cashier.id, 100);

    try {
      const claim = (orderId: string, orderNumber: number) =>
        db.$transaction((tx) =>
          recordRedemptionInTx(tx, {
            cafeId: fx.cafeId,
            customerId: customer.id,
            orderId,
            orderNumber,
            points: 40,
            amountValue: 40,
            userId: cashier.id,
          })
        );

      const settled = await Promise.allSettled([
        claim(orderA.id, orderA.orderNumber),
        claim(orderB.id, orderB.orderNumber),
      ]);
      const ok = settled.filter((r) => r.status === "fulfilled").length;
      const outcomes = settled
        .map((r) => (r.status === "fulfilled" ? "ok" : (r.reason as Error).message))
        .join(" | ");

      assert.equal(ok, 1, `exactly one redemption may commit, got ${ok}: ${outcomes}`);

      const after = await db.customer.findUniqueOrThrow({ where: { id: customer.id } });
      assert.equal(after.loyaltyPointsBalance, 0, `balance is ${after.loyaltyPointsBalance}`);
      assert.equal(after.lifetimePointsRedeemed, 40, "lifetime redeemed must match what was taken");

      const rows = await db.loyaltyTransaction.count({
        where: { customerId: customer.id, type: "REDEEM" },
      });
      assert.equal(rows, 1, "the refused redemption must leave no ledger row");
    } finally {
      await cleanup(marker);
      await dropCustomer(customer.id);
    }
  });

  test("insufficient points are refused in words the cashier can read", async () => {
    const marker = `${MARKER}-C`;
    const cashier = await sessionFor("cashier@demo.com");
    await cleanup(marker);
    const customer = await customerWith(5, "01099000003");
    const order = await makeOrder(fx, marker, cashier.id, 100);

    try {
      await assert.rejects(
        () =>
          db.$transaction((tx) =>
            recordRedemptionInTx(tx, {
              cafeId: fx.cafeId,
              customerId: customer.id,
              orderId: order.id,
              orderNumber: order.orderNumber,
              points: 50,
              amountValue: 50,
              userId: cashier.id,
            })
          ),
        (e: Error) => {
          assert.match(e.message, /رصيد/, `unreadable refusal: ${e.message}`);
          return true;
        }
      );

      const after = await db.customer.findUniqueOrThrow({ where: { id: customer.id } });
      assert.equal(after.loyaltyPointsBalance, 5, "a refused redemption must change nothing");
    } finally {
      await cleanup(marker);
      await dropCustomer(customer.id);
    }
  });

  test("an ordinary redemption still works", async () => {
    // The guard must refuse overspending, not redemption itself.
    const marker = `${MARKER}-D`;
    const cashier = await sessionFor("cashier@demo.com");
    await cleanup(marker);
    const customer = await customerWith(30, "01099000004");
    const order = await makeOrder(fx, marker, cashier.id, 100);

    try {
      await db.$transaction((tx) =>
        recordRedemptionInTx(tx, {
          cafeId: fx.cafeId,
          customerId: customer.id,
          orderId: order.id,
          orderNumber: order.orderNumber,
          points: 30,
          amountValue: 30,
          userId: cashier.id,
        })
      );

      const after = await db.customer.findUniqueOrThrow({ where: { id: customer.id } });
      assert.equal(after.loyaltyPointsBalance, 0);
      assert.equal(after.lifetimePointsRedeemed, 30);
      const row = await db.loyaltyTransaction.findFirstOrThrow({
        where: { customerId: customer.id, type: "REDEEM" },
      });
      assert.equal(row.points, -30, "the ledger row must mirror the deduction");
    } finally {
      await cleanup(marker);
      await dropCustomer(customer.id);
    }
  });
});
