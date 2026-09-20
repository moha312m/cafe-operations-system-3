// POS-003 (R-POS-02A/A12) — an order and its bill are one act.
//
// `attachOrderToTableSession` performed five sequential writes with no
// transaction — open the table session, point the order at it, adopt the
// order's inline payments, recompute the session totals, write the audit —
// and it was called AFTER the order transaction had already committed.
//
// So a failure anywhere in the middle left the database in a state nobody
// designed: an OPEN table session with no order on it, or an order attached
// to a session whose payments were never adopted, with the money therefore
// missing from the table's bill while still sitting in the drawer total.
//
// The failure is induced here the way it happens in life — a write in the
// middle fails — rather than by reading the source and hoping.
//
// Loyalty side effects are deliberately NOT in this stage's scope.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { attachOrderToTableSession } from "@/lib/table-sessions";
import {
  db, fixture, sessionFor, cleanup, cleanupShift, clearOpenShifts, openShift, makeOrder,
} from "./helpers/db";

const MARKER = "PH15-POS003";

let cafeId: string;
let branchId: string;
let actorId: string;

before(async () => {
  const fx = await fixture();
  cafeId = fx.cafeId;
  branchId = fx.branchId;
  actorId = (await sessionFor("cashier@demo.com")).id;
});

const tableOf = (suffix: string) => `${MARKER}-${suffix}`;

async function sessionsFor(tableNumber: string) {
  return db.tableSession.findMany({ where: { branchId, tableNumber } });
}

async function purgeTable(tableNumber: string) {
  const rows = await sessionsFor(tableNumber);
  for (const r of rows) {
    await db.order.updateMany({ where: { tableSessionId: r.id }, data: { tableSessionId: null } });
    await db.payment.updateMany({ where: { tableSessionId: r.id }, data: { tableSessionId: null } });
    await db.tableSession.deleteMany({ where: { id: r.id } });
  }
}

describe("POS-003 attaching an order to its table bill is all-or-nothing", () => {
  test("a failure partway through leaves no orphan session", async () => {
    // The order id does not exist, so the write that points the order at the
    // session fails — AFTER the session has been opened. Unprotected, that
    // leaves an OPEN table session for a table nobody is sitting at, which
    // holds the table and shows an empty bill.
    const tableNumber = tableOf("A");
    await purgeTable(tableNumber);
    try {
      await assert.rejects(() =>
        attachOrderToTableSession(
          {
            id: "pos003-no-such-order",
            cafeId,
            branchId,
            type: "DINE_IN",
            tableNumber,
            orderNumber: 1,
            customerName: null,
          },
          actorId
        )
      );

      const left = await sessionsFor(tableNumber);
      assert.equal(
        left.length,
        0,
        `a failed attachment must leave nothing behind, found ${left.length} session(s)`
      );
    } finally {
      await purgeTable(tableNumber);
    }
  });

  test("the happy path still opens the bill and adopts the order's payments", async () => {
    const marker = `${MARKER}-B`;
    const tableNumber = tableOf("B");
    await cleanup(marker);
    await purgeTable(tableNumber);
    const fx = await fixture();
    const cashier = await sessionFor("cashier@demo.com");
    await clearOpenShifts(fx.branchId, cashier.id);
    const shift = await openShift(fx, cashier.id, 0);
    const order = await makeOrder(fx, marker, cashier.id, 80);
    try {
      await db.order.update({
        where: { id: order.id },
        data: { type: "DINE_IN", tableNumber },
      });
      // An inline POS payment, created before the session exists — the rows
      // the attachment is supposed to adopt.
      await db.payment.create({
        data: {
          cafeId: fx.cafeId, branchId: fx.branchId, orderId: order.id,
          shiftId: shift.id, cashierId: cashier.id, amount: 80,
          method: "CASH", status: "PAID", receivedById: cashier.id,
        },
      });

      const session = await attachOrderToTableSession(
        {
          id: order.id, cafeId: fx.cafeId, branchId: fx.branchId,
          type: "DINE_IN", tableNumber, orderNumber: order.orderNumber,
          customerName: null,
        },
        cashier.id
      );
      assert.ok(session, "a dine-in order must open or join its table's bill");

      const attached = await db.order.findUniqueOrThrow({ where: { id: order.id } });
      assert.equal(attached.tableSessionId, session!.id, "the order joins the bill");

      const adopted = await db.payment.count({
        where: { orderId: order.id, tableSessionId: session!.id },
      });
      assert.equal(adopted, 1, "its inline payment joins the same bill");
    } finally {
      await db.payment.deleteMany({ where: { orderId: order.id } });
      await db.order.updateMany({ where: { id: order.id }, data: { tableSessionId: null } });
      await purgeTable(tableNumber);
      await cleanup(marker);
      await cleanupShift(shift.id);
    }
  });

  test("a second order for the same table joins the existing bill", async () => {
    // The ordinary case the transaction must not break.
    const marker = `${MARKER}-C`;
    const tableNumber = tableOf("C");
    await cleanup(marker);
    await purgeTable(tableNumber);
    const fx = await fixture();
    const cashier = await sessionFor("cashier@demo.com");
    await clearOpenShifts(fx.branchId, cashier.id);
    const shift = await openShift(fx, cashier.id, 0);
    const first = await makeOrder(fx, `${marker}-1`, cashier.id, 40);
    const second = await makeOrder(fx, `${marker}-2`, cashier.id, 60);
    try {
      const a = await attachOrderToTableSession(
        { id: first.id, cafeId: fx.cafeId, branchId: fx.branchId, type: "DINE_IN",
          tableNumber, orderNumber: first.orderNumber, customerName: null },
        cashier.id
      );
      const b = await attachOrderToTableSession(
        { id: second.id, cafeId: fx.cafeId, branchId: fx.branchId, type: "DINE_IN",
          tableNumber, orderNumber: second.orderNumber, customerName: null },
        cashier.id
      );
      assert.equal(a!.id, b!.id, "one table, one open bill");
      assert.equal((await sessionsFor(tableNumber)).length, 1);
    } finally {
      await db.order.updateMany(
        { where: { id: { in: [first.id, second.id] } }, data: { tableSessionId: null } }
      );
      await purgeTable(tableNumber);
      await cleanup(`${marker}-1`);
      await cleanup(`${marker}-2`);
      await cleanupShift(shift.id);
    }
  });
});
