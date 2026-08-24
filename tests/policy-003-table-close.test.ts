// POLICY-003 — closing a table means the work is finished, not just the bill.
//
// Close already refused a table that still owed money. It never looked at the
// kitchen. Once dine-in can be served before payment, that gap becomes real:
// a table can reach a zero balance while a drink is still on the pass, and
// closing it there releases the table and orphans the order.
//
// A close therefore has to check both, and has to check them at the moment it
// runs. Eligibility computed for the screen a few seconds ago is a claim about
// the past; between the prompt appearing and the button being pressed a waiter
// can ring in another round. The endpoint revalidates rather than trusting
// what the client believed.
//
// Serving and paying make a table *eligible* to close. Neither ever closes it.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { refundOrder } from "@/lib/refunds";
import {
  db, fixture, sessionFor, openShift, clearOpenShifts, cleanup, cleanupShift,
} from "./helpers/db";
import { requireServer, login, as } from "./helpers/http";

const CASHIER = "cashier@demo.com", MANAGER = "manager@demo.com";

after(async () => { await db.$disconnect(); });
before(async () => {
  await requireServer();
  await login(CASHIER, "cashier123");
  await login(MANAGER, "manager123");
});

async function drawer(fx: Awaited<ReturnType<typeof fixture>>, who = CASHIER, opening = 200) {
  const u = await sessionFor(who);
  await clearOpenShifts(fx.branchId, u.id);
  return openShift(fx, u.id, opening);
}

/** A dine-in order on `table`, paid or not, left at `stopAt`. */
async function dineIn(
  branchId: string, marker: string, table: string,
  { paid = true, stopAt = "READY" as "CONFIRMED" | "PREPARING" | "READY" | "SERVED" } = {}
) {
  const products = (await as(CASHIER, "/api/products")).body as { products: { id: string; variants: unknown[] }[] };
  const product = products.products.find((p) => p.variants.length === 0)!;
  const created = await as<{ order: { id: string } }>(CASHIER, "/api/orders", {
    method: "POST",
    body: JSON.stringify({
      branchId, type: "DINE_IN", tableNumber: table, customerName: marker,
      collectionMode: paid ? "NOW" : "PENDING",
      ...(paid ? { method: "CASH" } : {}),
      items: [{ productId: product.id, quantity: 1, addOnIds: [] }],
    }),
  });
  assert.ok(created.status < 300, `setup failed: ${created.text.slice(0, 160)}`);
  const id = created.body.order.id;
  const walk = ["PREPARING", "READY", "SERVED"];
  for (const s of walk) {
    if (walk.indexOf(s) > walk.indexOf(stopAt) - 0 && s !== stopAt) {
      if (walk.indexOf(s) > walk.indexOf(stopAt)) break;
    }
    const r = await as(CASHIER, `/api/orders/${id}/status`, {
      method: "PATCH", body: JSON.stringify({ status: s }),
    });
    assert.ok(r.status < 300, `walk to ${s} failed: ${r.text.slice(0, 160)}`);
    if (s === stopAt) break;
  }
  return id;
}

const sessionFor_ = (table: string) =>
  db.tableSession.findFirstOrThrow({ where: { tableNumber: table, status: "OPEN" } });
const closeAs = (who: string, id: string) =>
  as<{ error?: string }>(who, `/api/tables/${id}/close`, { method: "POST" });

async function scrub(marker: string, table: string) {
  const orders = await db.order.findMany({
    where: { customerName: { startsWith: marker } }, select: { id: true },
  });
  const ids = orders.map((o) => o.id);
  if (ids.length) await db.payment.deleteMany({ where: { orderId: { in: ids } } });
  await db.order.updateMany({ where: { id: { in: ids } }, data: { tableSessionId: null } });
  await cleanup(marker);
  await db.tableSession.deleteMany({ where: { tableNumber: table } });
}

describe("POLICY-003 table close integrity", () => {
  // ── T: the existing financial gate still holds ──
  test("T: a table that still owes money cannot be closed normally", async () => {
    const fx = await fixture(); const marker = "POL3-T", table = "POL3T";
    await scrub(marker, table);
    const shift = await drawer(fx);
    // Pay-later, so the order can legitimately reach SERVED unpaid and the
    // only thing left standing between this table and closing is the money.
    await db.cafeSettings.update({
      where: { cafeId: fx.cafeId },
      data: { dineInServingPolicy: "ALLOW_BEFORE_PAYMENT" },
    });
    try {
      await dineIn(fx.branchId, marker, table, { paid: false, stopAt: "SERVED" });
      const s = await sessionFor_(table);
      const res = await closeAs(CASHIER, s.id);
      assert.ok(res.status >= 400, "an unpaid table must not close");
      assert.equal((await db.tableSession.findUniqueOrThrow({ where: { id: s.id } })).status, "OPEN");
    } finally {
      await db.cafeSettings.update({
        where: { cafeId: fx.cafeId },
        data: { dineInServingPolicy: "REQUIRE_PAYMENT_FIRST" },
      });
      await scrub(marker, table); await cleanupShift(shift.id);
    }
  });

  // ── U: work still in the kitchen ──
  test("U: a table with an order still PREPARING cannot be closed normally", async () => {
    const fx = await fixture(); const marker = "POL3-U", table = "POL3U";
    await scrub(marker, table);
    const shift = await drawer(fx);
    try {
      await dineIn(fx.branchId, marker, table, { paid: true, stopAt: "PREPARING" });
      const s = await sessionFor_(table);
      assert.equal(Number(s.remainingAmount), 0, "the bill is settled — only the kitchen is outstanding");
      const res = await closeAs(CASHIER, s.id);
      assert.ok(res.status >= 400, "a paid table with food still being made must not close");
    } finally { await scrub(marker, table); await cleanupShift(shift.id); }
  });

  // ── V: made, but not handed over ──
  test("V: a table with a READY but unserved order cannot be closed normally", async () => {
    const fx = await fixture(); const marker = "POL3-V", table = "POL3V";
    await scrub(marker, table);
    const shift = await drawer(fx);
    try {
      await dineIn(fx.branchId, marker, table, { paid: true, stopAt: "READY" });
      const s = await sessionFor_(table);
      assert.equal(Number(s.remainingAmount), 0);
      const res = await closeAs(CASHIER, s.id);
      assert.ok(res.status >= 400, "READY is not served — the drink is still on the pass");
    } finally { await scrub(marker, table); await cleanupShift(shift.id); }
  });

  // ── W: settled and finished ──
  test("W: a settled, fully served table closes normally", async () => {
    const fx = await fixture(); const marker = "POL3-W", table = "POL3W";
    await scrub(marker, table);
    const shift = await drawer(fx);
    try {
      await dineIn(fx.branchId, marker, table, { paid: true, stopAt: "SERVED" });
      const s = await sessionFor_(table);
      const res = await closeAs(CASHIER, s.id);
      assert.equal(res.status, 200, `should close: ${res.text.slice(0, 160)}`);
      assert.equal((await db.tableSession.findUniqueOrThrow({ where: { id: s.id } })).status, "CLOSED");
    } finally { await scrub(marker, table); await cleanupShift(shift.id); }
  });

  // ── X + Y + Z: eligibility is not closure ──
  test("X+Y+Z: paying and serving make a table eligible but never close it", async () => {
    const fx = await fixture(); const marker = "POL3-XYZ", table = "POL3XYZ";
    await scrub(marker, table);
    const shift = await drawer(fx);
    try {
      await dineIn(fx.branchId, marker, table, { paid: true, stopAt: "SERVED" });
      const s = await sessionFor_(table);
      assert.equal(s.status, "OPEN", "paid and served, and still open — closing is a decision");
      assert.equal(Number(s.remainingAmount), 0);
      // "Keep table open" is simply not calling close; the table stays usable.
      const again = await db.tableSession.findUniqueOrThrow({ where: { id: s.id } });
      assert.equal(again.status, "OPEN");
    } finally { await scrub(marker, table); await cleanupShift(shift.id); }
  });

  // ── AB: eligibility decided a moment ago is not eligibility now ──
  test("AB: a new round after the prompt prevents a stale close", async () => {
    const fx = await fixture(); const marker = "POL3-AB", table = "POL3AB";
    await scrub(marker, table);
    const shift = await drawer(fx);
    try {
      await dineIn(fx.branchId, marker + "-1", table, { paid: true, stopAt: "SERVED" });
      const s = await sessionFor_(table);
      // The waiter saw "close?" here. Before pressing it, another round lands.
      await dineIn(fx.branchId, marker + "-2", table, { paid: true, stopAt: "PREPARING" });
      const res = await closeAs(CASHIER, s.id);
      assert.ok(
        res.status >= 400,
        "a close decided before the new round must not release the table"
      );
      assert.equal((await db.tableSession.findUniqueOrThrow({ where: { id: s.id } })).status, "OPEN");
    } finally { await scrub(marker, table); await cleanupShift(shift.id); }
  });

  // ── Q + R: keeping the table open is what lets a second round exist ──
  test("Q+R: a later round joins the same session and leaves the first bill alone", async () => {
    const fx = await fixture(); const marker = "POL3-QR", table = "POL3QR";
    await scrub(marker, table);
    const shift = await drawer(fx);
    try {
      const first = await dineIn(fx.branchId, marker + "-1", table, { paid: true, stopAt: "SERVED" });
      const s1 = await sessionFor_(table);
      const before = await db.order.findUniqueOrThrow({ where: { id: first } });

      // The waiter chose "keep open", so no close call happens at all.
      const second = await dineIn(fx.branchId, marker + "-2", table, { paid: false, stopAt: "PREPARING" });

      const s2 = await sessionFor_(table);
      assert.equal(s2.id, s1.id, "the new round must join the open session, not start a new one");
      assert.equal(s2.status, "OPEN");

      const after = await db.order.findUniqueOrThrow({ where: { id: first } });
      assert.equal(after.paymentStatus, before.paymentStatus, "the settled bill must not reopen");
      assert.equal(Number(after.paidAmount), Number(before.paidAmount));
      assert.equal(Number(after.remainingAmount), 0);
      assert.equal(after.status, "SERVED");

      // Only the new round is owed.
      const secondOrder = await db.order.findUniqueOrThrow({ where: { id: second } });
      assert.equal(
        Number(s2.remainingAmount), Number(secondOrder.total),
        "the table owes the new round and nothing else"
      );
    } finally { await scrub(marker, table); await cleanupShift(shift.id); }
  });

  // ── S: a refunded bill stays terminal across later rounds ──
  test("S: a refunded order stays terminal when a later round is added", async () => {
    const fx = await fixture(); const marker = "POL3-S", table = "POL3S";
    await scrub(marker, table);
    const shift = await drawer(fx);
    const manager = await sessionFor(MANAGER);
    await clearOpenShifts(fx.branchId, manager.id);
    const mgrShift = await openShift(fx, manager.id, 0);
    try {
      const first = await dineIn(fx.branchId, marker + "-1", table, { paid: true, stopAt: "SERVED" });
      await refundOrder(first, manager, "POLICY-003 S");
      const second = await dineIn(fx.branchId, marker + "-2", table, { paid: false, stopAt: "PREPARING" });

      const o = await db.order.findUniqueOrThrow({ where: { id: first } });
      assert.equal(o.paymentStatus, "REFUNDED");
      assert.equal(Number(o.paidAmount), 0);
      assert.equal(Number(o.remainingAmount), 0, "the refunded bill contributes nothing");

      const s = await sessionFor_(table);
      const secondOrder = await db.order.findUniqueOrThrow({ where: { id: second } });
      assert.equal(
        Number(s.remainingAmount), Number(secondOrder.total),
        "only the live round is owed — the refund adds no phantom debt"
      );
    } finally {
      await scrub(marker, table);
      await cleanupShift(shift.id); await cleanupShift(mgrShift.id);
    }
  });

  // ── AC: a refunded bill is settled, not an obstacle ──
  test("AC: a fully refunded order creates no financial close blocker", async () => {
    const fx = await fixture(); const marker = "POL3-AC", table = "POL3AC";
    await scrub(marker, table);
    const shift = await drawer(fx);
    const manager = await sessionFor(MANAGER);
    await clearOpenShifts(fx.branchId, manager.id);
    const mgrShift = await openShift(fx, manager.id, 0);
    try {
      const id = await dineIn(fx.branchId, marker, table, { paid: true, stopAt: "SERVED" });
      await refundOrder(id, manager, "POLICY-003");
      const s = await sessionFor_(table);
      assert.equal(Number(s.remainingAmount), 0, "REFUND-006: no phantom debt");
      const res = await closeAs(CASHIER, s.id);
      assert.equal(
        res.status, 200,
        `a refunded, served table must close without an override: ${res.text.slice(0, 160)}`
      );
    } finally {
      await scrub(marker, table);
      await cleanupShift(shift.id); await cleanupShift(mgrShift.id);
    }
  });
});
