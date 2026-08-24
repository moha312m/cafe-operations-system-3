// POLICY-004 — the badge on a table has to mean what closing it means.
//
// sessionDisplayStatus judged a table on money alone. That was true enough
// while nothing could be served unpaid, because a settled table had by then
// been served. Since POLICY-003 the two come apart, and the screen started
// saying "جاهزة للقفل" over a table with a drink still on the pass — while
// the prompt correctly stayed hidden and the server correctly refused. Three
// answers to one question, two of them right.
//
// The badge now asks the same two things closing asks: is the bill settled,
// and has everything reached the customer. READY_TO_CLOSE therefore means
// exactly what it says, and a settled-but-unfinished table gets its own
// state instead of borrowing one that promises something else.
//
// No new database state: this is a derived label, computed per request from
// the session totals and the count of orders still owed to the customer.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import {
  sessionDisplayStatus, BLOCKING_ORDER_STATUSES,
} from "@/lib/table-sessions";
import {
  db, fixture, sessionFor, openShift, clearOpenShifts, cleanup, cleanupShift,
} from "./helpers/db";
import { requireServer, login, as } from "./helpers/http";

const CASHIER = "cashier@demo.com";

after(async () => { await db.$disconnect(); });
before(async () => {
  await requireServer();
  await login(CASHIER, "cashier123");
});

const settled = { status: "OPEN", totalAmount: 120, paidAmount: 120, remainingAmount: 0 };
const owing = { status: "OPEN", totalAmount: 120, paidAmount: 0, remainingAmount: 120 };

async function drawer(fx: Awaited<ReturnType<typeof fixture>>) {
  const u = await sessionFor(CASHIER);
  await clearOpenShifts(fx.branchId, u.id);
  return openShift(fx, u.id, 300);
}
async function dineIn(branchId: string, marker: string, table: string, stopAt: string) {
  const products = (await as(CASHIER, "/api/products")).body as { products: { id: string; variants: unknown[] }[] };
  const product = products.products.find((p) => p.variants.length === 0)!;
  const r = await as<{ order: { id: string } }>(CASHIER, "/api/orders", {
    method: "POST",
    body: JSON.stringify({
      branchId, type: "DINE_IN", tableNumber: table, customerName: marker,
      collectionMode: "NOW", method: "CASH",
      items: [{ productId: product.id, quantity: 1, addOnIds: [] }],
    }),
  });
  assert.ok(r.status < 300, `setup failed: ${r.text.slice(0, 160)}`);
  const id = r.body.order.id;
  for (const s of ["PREPARING", "READY", "SERVED"]) {
    await as(CASHIER, `/api/orders/${id}/status`, { method: "PATCH", body: JSON.stringify({ status: s }) });
    if (s === stopAt) break;
  }
  return id;
}
const card = async (table: string) =>
  (await as<{ sessions: { displayStatus: string; unservedOrders: number; remainingAmount: number }[] }>(
    CASHIER, `/api/tables?tableNumber=${table}`
  )).body.sessions?.[0];

async function scrub(marker: string, table: string) {
  const orders = await db.order.findMany({ where: { customerName: { startsWith: marker } }, select: { id: true } });
  const ids = orders.map((o) => o.id);
  if (ids.length) await db.payment.deleteMany({ where: { orderId: { in: ids } } });
  await db.order.updateMany({ where: { id: { in: ids } }, data: { tableSessionId: null } });
  await cleanup(marker);
  await db.tableSession.deleteMany({ where: { tableNumber: table } });
}

describe("POLICY-004 table display status", () => {
  // ── the helper itself ──
  test("A: settled with work still in the kitchen is not READY_TO_CLOSE", () => {
    assert.notEqual(
      sessionDisplayStatus(settled, 1), "READY_TO_CLOSE",
      "a drink still on the pass must not read as ready to close"
    );
    assert.equal(sessionDisplayStatus(settled, 1), "AWAITING_HANDOVER");
  });

  test("C: settled with everything served is READY_TO_CLOSE", () => {
    assert.equal(sessionDisplayStatus(settled, 0), "READY_TO_CLOSE");
  });

  test("D: an unpaid table still asks for collection", () => {
    assert.equal(sessionDisplayStatus(owing, 0), "PENDING_COLLECTION");
    // Money outstanding is the louder problem; it is reported even when the
    // kitchen is also still busy.
    assert.equal(sessionDisplayStatus(owing, 2), "PENDING_COLLECTION");
    assert.equal(
      sessionDisplayStatus({ ...owing, paidAmount: 50, remainingAmount: 70 }, 0),
      "PARTIAL"
    );
  });

  test("E: a closed session reads as closed whatever its numbers say", () => {
    assert.equal(sessionDisplayStatus({ ...settled, status: "CLOSED" }, 0), "CLOSED");
    assert.equal(sessionDisplayStatus({ ...owing, status: "CLOSED" }, 3), "CLOSED");
  });

  test("the blocking states are the ones that have not reached the customer", () => {
    assert.deepEqual([...BLOCKING_ORDER_STATUSES], ["CONFIRMED", "PREPARING", "READY"]);
  });

  // ── through the API the screen actually reads ──
  test("B: a READY but unserved table is not advertised as ready to close", async () => {
    const fx = await fixture(); const marker = "POL4-B", table = "POL4B";
    await scrub(marker, table);
    const shift = await drawer(fx);
    try {
      await dineIn(fx.branchId, marker, table, "READY");
      const c = await card(table);
      assert.equal(Number(c.remainingAmount), 0, "the bill is settled");
      assert.equal(c.unservedOrders, 1, "one order has not reached the customer");
      assert.notEqual(c.displayStatus, "READY_TO_CLOSE");
      assert.equal(c.displayStatus, "AWAITING_HANDOVER");
    } finally { await scrub(marker, table); await cleanupShift(shift.id); }
  });

  test("F+H: the badge, the prompt and the server agree", async () => {
    const fx = await fixture(); const marker = "POL4-F", table = "POL4F";
    await scrub(marker, table);
    const shift = await drawer(fx);
    try {
      const id = await dineIn(fx.branchId, marker, table, "PREPARING");
      // Not ready: badge says so, and the server refuses.
      const busy = await card(table);
      assert.notEqual(busy.displayStatus, "READY_TO_CLOSE");
      const session = await db.tableSession.findFirstOrThrow({ where: { tableNumber: table, status: "OPEN" } });
      const refused = await as(CASHIER, `/api/tables/${session.id}/close`, { method: "POST" });
      assert.ok(refused.status >= 400, "server must refuse while the badge says not ready");

      // Finish the work: badge flips, and the same close now succeeds.
      for (const s of ["READY", "SERVED"]) {
        await as(CASHIER, `/api/orders/${id}/status`, { method: "PATCH", body: JSON.stringify({ status: s }) });
      }
      const done = await card(table);
      assert.equal(done.displayStatus, "READY_TO_CLOSE");
      assert.equal(done.unservedOrders, 0);
      const ok = await as(CASHIER, `/api/tables/${session.id}/close`, { method: "POST" });
      assert.equal(ok.status, 200, "server must allow exactly when the badge says ready");
    } finally { await scrub(marker, table); await cleanupShift(shift.id); }
  });

  test("G: a new round moves the table off ready-to-close again", async () => {
    const fx = await fixture(); const marker = "POL4-G", table = "POL4G";
    await scrub(marker, table);
    const shift = await drawer(fx);
    try {
      await dineIn(fx.branchId, marker + "-1", table, "SERVED");
      assert.equal((await card(table)).displayStatus, "READY_TO_CLOSE");

      // This is what makes a dismissed prompt come back: the state changed.
      await dineIn(fx.branchId, marker + "-2", table, "PREPARING");
      const after = await card(table);
      assert.equal(after.displayStatus, "AWAITING_HANDOVER");
      assert.equal(after.unservedOrders, 1);
    } finally { await scrub(marker, table); await cleanupShift(shift.id); }
  });
});
