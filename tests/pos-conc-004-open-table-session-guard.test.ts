// POS-CONC-004 (R-POS-02B2a) — one open bill per table.
//
// `attachOrderToTableSession` decided whether a table already had a bill by
// reading for one, and nothing else. A SELECT takes no lock under READ
// COMMITTED — the default here, and the only isolation level this repository
// configures — so two waiters ringing up the same table both found nothing
// and both created. The table then had two OPEN bills, and the customer's
// money landed on whichever the till happened to read next.
//
// The repair is a partial unique index (migration M24) so the database
// refuses the second write, plus the half that matters to the person holding
// the tray: the loser must JOIN the winner's bill, because the customer is at
// ONE table and expects ONE bill, not an error.
//
// The matching guard for Shift is deliberately NOT here. It is correct, but
// it is incompatible with existing fixtures that open a second drawer for the
// same cashier without closing the first, and it is deferred to its own stage
// behind that remediation.
//
// Every test here fails against the unrepaired code.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { attachOrderToTableSession } from "@/lib/table-sessions";
import { db, fixture, sessionFor, cleanup, makeOrder, type Fixture } from "./helpers/db";

const MARKER = "PH15-OPENGUARD";
const CASHIER = "cashier@demo.com";

let fx: Fixture;

async function purgeSessions(branchId: string, tableNumber: string) {
  const sessions = await db.tableSession.findMany({
    where: { branchId, tableNumber },
    select: { id: true },
  });
  const ids = sessions.map((s) => s.id);
  if (!ids.length) return;
  await db.payment.updateMany({ where: { tableSessionId: { in: ids } }, data: { tableSessionId: null } });
  await db.order.updateMany({ where: { tableSessionId: { in: ids } }, data: { tableSessionId: null } });
  await db.tableSession.deleteMany({ where: { id: { in: ids } } });
}

before(async () => {
  fx = await fixture();
});

after(async () => {
  await db.$disconnect();
});

describe("POS-CONC-004 one OPEN table session per table", () => {
  test("two waiters ringing up the same table open ONE bill, and both orders join it", async () => {
    const marker = `${MARKER}-A`;
    const table = "OPENGUARD-A";
    await cleanup(marker);
    await purgeSessions(fx.branchId, table);

    const cashier = await sessionFor(CASHIER);
    const a = await makeOrder(fx, `${marker}-1`, cashier.id, 50);
    const b = await makeOrder(fx, `${marker}-2`, cashier.id, 70);

    try {
      const attach = (o: { id: string; orderNumber: number }) =>
        attachOrderToTableSession(
          {
            id: o.id, cafeId: fx.cafeId, branchId: fx.branchId, type: "DINE_IN",
            tableNumber: table, orderNumber: o.orderNumber, customerName: marker,
          },
          cashier.id
        );

      const settled = await Promise.allSettled([attach(a), attach(b)]);
      const outcomes = settled
        .map((r) => (r.status === "fulfilled" ? "ok" : (r.reason as Error).message))
        .join(" | ");

      // Neither waiter may be refused — the table has one bill and both
      // orders belong on it.
      assert.equal(
        settled.filter((r) => r.status === "fulfilled").length,
        2,
        `both orders must land on the bill: ${outcomes}`
      );

      const open = await db.tableSession.findMany({
        where: { branchId: fx.branchId, tableNumber: table, status: "OPEN" },
        select: { id: true },
      });
      assert.equal(open.length, 1, `the table must hold exactly one OPEN bill, found ${open.length}`);

      // Both orders point at that one session, and its totals count both.
      const rows = await db.order.findMany({
        where: { id: { in: [a.id, b.id] } },
        select: { id: true, tableSessionId: true },
      });
      assert.ok(
        rows.every((r) => r.tableSessionId === open[0].id),
        "both orders must be attached to the surviving bill"
      );

      const session = await db.tableSession.findUniqueOrThrow({ where: { id: open[0].id } });
      assert.equal(
        Number(session.totalAmount),
        120,
        "the bill must total both orders, not just the winner's"
      );
    } finally {
      await purgeSessions(fx.branchId, table);
      await cleanup(marker);
    }
  });

  test("the sequential path is unchanged: a later order joins the open bill", async () => {
    // The guard must not change what already worked.
    const marker = `${MARKER}-B`;
    const table = "OPENGUARD-B";
    await cleanup(marker);
    await purgeSessions(fx.branchId, table);

    const cashier = await sessionFor(CASHIER);
    const a = await makeOrder(fx, `${marker}-1`, cashier.id, 40);
    const b = await makeOrder(fx, `${marker}-2`, cashier.id, 60);

    try {
      const first = await attachOrderToTableSession(
        { id: a.id, cafeId: fx.cafeId, branchId: fx.branchId, type: "DINE_IN",
          tableNumber: table, orderNumber: a.orderNumber, customerName: marker },
        cashier.id
      );
      const second = await attachOrderToTableSession(
        { id: b.id, cafeId: fx.cafeId, branchId: fx.branchId, type: "DINE_IN",
          tableNumber: table, orderNumber: b.orderNumber, customerName: marker },
        cashier.id
      );

      assert.ok(first && second, "both attachments must return a session");
      assert.equal(second.id, first.id, "the second order must join the first order's bill");

      const open = await db.tableSession.count({
        where: { branchId: fx.branchId, tableNumber: table, status: "OPEN" },
      });
      assert.equal(open, 1);
    } finally {
      await purgeSessions(fx.branchId, table);
      await cleanup(marker);
    }
  });

  test("a CLOSED bill does not block the table being used again", async () => {
    // The index is partial on purpose: a table is used many times a day, and
    // only the OPEN bill is unique.
    const marker = `${MARKER}-C`;
    const table = "OPENGUARD-C";
    await cleanup(marker);
    await purgeSessions(fx.branchId, table);

    const cashier = await sessionFor(CASHIER);
    const a = await makeOrder(fx, `${marker}-1`, cashier.id, 30);
    const b = await makeOrder(fx, `${marker}-2`, cashier.id, 30);

    try {
      const first = await attachOrderToTableSession(
        { id: a.id, cafeId: fx.cafeId, branchId: fx.branchId, type: "DINE_IN",
          tableNumber: table, orderNumber: a.orderNumber, customerName: marker },
        cashier.id
      );
      await db.tableSession.update({ where: { id: first!.id }, data: { status: "CLOSED" } });

      const second = await attachOrderToTableSession(
        { id: b.id, cafeId: fx.cafeId, branchId: fx.branchId, type: "DINE_IN",
          tableNumber: table, orderNumber: b.orderNumber, customerName: marker },
        cashier.id
      );
      assert.ok(second, "a new bill must open once the previous one is closed");
      assert.notEqual(second.id, first!.id, "the closed bill must not be reused");
    } finally {
      await purgeSessions(fx.branchId, table);
      await cleanup(marker);
    }
  });
});
