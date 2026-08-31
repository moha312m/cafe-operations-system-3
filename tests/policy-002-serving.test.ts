// POLICY-002 — the serving gate obeys configuration, and only the server.
//
// Before this, an order could never be marked SERVED until it was fully paid.
// That is right for a takeaway counter and wrong for a café with table
// service, where the bill arrives after the coffee. The rule is now the
// owner's to set per order type, and the API is where it is enforced —
// hiding a button is not a control, so every case here drives the real
// endpoint rather than a component.
//
// SERVED remains the handover boundary. Nothing new was invented for it:
// READY -> SERVED is already the only transition that puts an order in the
// customer's hands, so it is the only place the policy can bite.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import {
  db, fixture, sessionFor, openShift, clearOpenShifts, cleanup, cleanupShift,
  policyProduct, cleanupProduct,
} from "./helpers/db";
import { requireServer, login, as } from "./helpers/http";
import type { ServingPaymentPolicy } from "@prisma/client";

const CASHIER = "cashier@demo.com", OWNER = "owner@demo.com";

/**
 * The product every order in this suite is built from.
 *
 * These tests are about when an order may be handed over, not about what it is
 * made of. Reaching for "the first variant-free product on the menu" made them
 * depend on café data: after a real menu was imported that product carried a
 * recipe whose beans the branch had no stock of, and the inventory guard —
 * correctly — refused the handover, failing tests that had asked nothing about
 * inventory. The suite now brings a recipe-free product of its own.
 */
let productId: string;
after(async () => { await cleanupProduct(productId); await db.$disconnect(); });
before(async () => {
  await requireServer();
  await login(CASHIER, "cashier123");
  await login(OWNER, "owner1234");
  productId = (await policyProduct(await fixture(), "POL2")).id;
});

async function setCafePolicy(
  cafeId: string,
  dineIn: ServingPaymentPolicy,
  takeaway: ServingPaymentPolicy
) {
  await db.cafeSettings.update({
    where: { cafeId },
    data: { dineInServingPolicy: dineIn, takeawayServingPolicy: takeaway },
  });
}
async function resetPolicy(cafeId: string, branchId: string) {
  await setCafePolicy(cafeId, "REQUIRE_PAYMENT_FIRST", "REQUIRE_PAYMENT_FIRST");
  await db.branch.update({
    where: { id: branchId },
    data: { dineInServingPolicyOverride: null, takeawayServingPolicyOverride: null },
  });
}

/** POS-001: a cashier cannot record an order without holding a drawer. */
async function ensureDrawer(fx: Awaited<ReturnType<typeof fixture>>) {
  const cashier = await sessionFor(CASHIER);
  await clearOpenShifts(fx.branchId, cashier.id);
  const shift = await openShift(fx, cashier.id, 100);
  const custody = await db.custodyPeriod.findFirst({
    where: { branchId: fx.branchId, scope: "STOCK", status: "OPEN" }, select: { id: true },
  });
  if (custody) await db.custodyPeriod.update({ where: { id: custody.id }, data: { holderType: "USER", responsibleShiftId: shift.id } });
  else await db.custodyPeriod.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, scope: "STOCK", holderType: "USER", openedById: cashier.id, responsibleShiftId: shift.id } });
  return shift;
}

/** An unpaid order walked as far as READY, i.e. sitting on the pass. */
async function unpaidReadyOrder(
  branchId: string, marker: string, opts: { table?: string } = {}
) {
  const created = await as<{ order: { id: string } }>(CASHIER, "/api/orders", {
    method: "POST",
    body: JSON.stringify({
      branchId,
      type: opts.table ? "DINE_IN" : "TAKEAWAY",
      ...(opts.table ? { tableNumber: opts.table } : {}),
      customerName: marker,
      collectionMode: "PENDING",
      items: [{ productId, quantity: 1, addOnIds: [] }],
    }),
  });
  assert.ok(created.status < 300, `order setup failed: ${created.text.slice(0, 160)}`);
  const id = created.body.order.id;
  for (const s of ["PREPARING", "READY"]) {
    const r = await as(CASHIER, `/api/orders/${id}/status`, {
      method: "PATCH", body: JSON.stringify({ status: s }),
    });
    assert.ok(r.status < 300, `walk to ${s} failed: ${r.text.slice(0, 160)}`);
  }
  return id;
}
const serve = (id: string) =>
  as<{ error?: string }>(CASHIER, `/api/orders/${id}/status`, {
    method: "PATCH", body: JSON.stringify({ status: "SERVED" }),
  });

async function purge(marker: string) { await cleanup(marker); }

describe("POLICY-002 serving enforcement", () => {
  // ── H + M: dine-in, pay later ──
  test("H+M: dine-in allow-before-payment serves an unpaid order", async () => {
    const fx = await fixture();
    const marker = "POL2-H";
    await purge(marker);
    const shift = await ensureDrawer(fx);
    await setCafePolicy(fx.cafeId, "ALLOW_BEFORE_PAYMENT", "REQUIRE_PAYMENT_FIRST");
    try {
      const id = await unpaidReadyOrder(fx.branchId, marker, { table: "POL2H" });
      const res = await serve(id);
      assert.equal(res.status, 200, `unpaid serving must be allowed: ${res.text.slice(0, 160)}`);

      // SERVED + UNPAID is a legitimate resting state, not a contradiction.
      const o = await db.order.findUniqueOrThrow({ where: { id } });
      assert.equal(o.status, "SERVED");
      assert.equal(Number(o.paidAmount), 0, "no money was collected");
      assert.notEqual(o.paymentStatus, "PAID");
    } finally {
      await resetPolicy(fx.cafeId, fx.branchId);
      await purge(marker);
      await cleanupShift(shift.id);
    }
  });

  // ── I: dine-in, pay first ──
  test("I: dine-in require-payment-first refuses to serve an unpaid order", async () => {
    const fx = await fixture();
    const marker = "POL2-I";
    await purge(marker);
    const shift = await ensureDrawer(fx);
    await setCafePolicy(fx.cafeId, "REQUIRE_PAYMENT_FIRST", "REQUIRE_PAYMENT_FIRST");
    try {
      const id = await unpaidReadyOrder(fx.branchId, marker, { table: "POL2I" });
      const res = await serve(id);
      assert.ok(res.status >= 400, "unpaid serving must be refused under pay-first");
      const o = await db.order.findUniqueOrThrow({ where: { id } });
      assert.equal(o.status, "READY", "the refused order must stay on the pass");
    } finally {
      await resetPolicy(fx.cafeId, fx.branchId);
      await purge(marker);
      await cleanupShift(shift.id);
    }
  });

  // ── K + L: neither serving nor paying closes a table ──
  test("K+L: serving and paying leave the table open", async () => {
    const fx = await fixture();
    const marker = "POL2-KL";
    const cashier = await sessionFor(CASHIER);
    await purge(marker);
    await clearOpenShifts(fx.branchId, cashier.id);
    const shift = await ensureDrawer(fx);
    await setCafePolicy(fx.cafeId, "ALLOW_BEFORE_PAYMENT", "REQUIRE_PAYMENT_FIRST");
    try {
      const id = await unpaidReadyOrder(fx.branchId, marker, { table: "POL2KL" });
      assert.equal((await serve(id)).status, 200);

      let session = await db.tableSession.findFirstOrThrow({ where: { tableNumber: "POL2KL", status: "OPEN" } });
      assert.equal(session.status, "OPEN", "serving must not close the table");

      const total = Number((await db.order.findUniqueOrThrow({ where: { id } })).total);
      const paid = await as(CASHIER, "/api/payments", {
        method: "POST", body: JSON.stringify({ orderId: id, method: "CASH", amount: total }),
      });
      assert.ok(paid.status < 300, `collection failed: ${paid.text.slice(0, 160)}`);

      session = await db.tableSession.findFirstOrThrow({ where: { id: session.id } });
      assert.equal(session.status, "OPEN", "paying must not close the table either");
    } finally {
      await resetPolicy(fx.cafeId, fx.branchId);
      await db.tableSession.deleteMany({ where: { tableNumber: "POL2KL" } });
      await purge(marker);
      await cleanupShift(shift.id);
    }
  });

  // ── N: takeaway, pay first ──
  test("N: takeaway require-payment-first refuses handover of an unpaid order", async () => {
    const fx = await fixture();
    const marker = "POL2-N";
    await purge(marker);
    const shift = await ensureDrawer(fx);
    await setCafePolicy(fx.cafeId, "ALLOW_BEFORE_PAYMENT", "REQUIRE_PAYMENT_FIRST");
    try {
      const id = await unpaidReadyOrder(fx.branchId, marker);
      const res = await serve(id);
      assert.ok(res.status >= 400, "unpaid takeaway handover must be refused");
      const o = await db.order.findUniqueOrThrow({ where: { id } });
      assert.equal(o.status, "READY");
    } finally {
      await resetPolicy(fx.cafeId, fx.branchId);
      await purge(marker);
      await cleanupShift(shift.id);
    }
  });

  // ── O: takeaway, pay later ──
  test("O: takeaway allow-before-payment permits handover of an unpaid order", async () => {
    const fx = await fixture();
    const marker = "POL2-O";
    await purge(marker);
    const shift = await ensureDrawer(fx);
    await setCafePolicy(fx.cafeId, "REQUIRE_PAYMENT_FIRST", "ALLOW_BEFORE_PAYMENT");
    try {
      const id = await unpaidReadyOrder(fx.branchId, marker);
      const res = await serve(id);
      assert.equal(res.status, 200, `unpaid takeaway handover must be allowed: ${res.text.slice(0, 160)}`);
    } finally {
      await resetPolicy(fx.cafeId, fx.branchId);
      await purge(marker);
      await cleanupShift(shift.id);
    }
  });

  // ── Each order type is governed independently ──
  test("the two order types are governed separately at the same branch", async () => {
    const fx = await fixture();
    const marker = "POL2-SPLIT";
    await purge(marker);
    // Dine-in relaxed, takeaway strict — the common café arrangement.
    const shift = await ensureDrawer(fx);
    await setCafePolicy(fx.cafeId, "ALLOW_BEFORE_PAYMENT", "REQUIRE_PAYMENT_FIRST");
    try {
      const dineIn = await unpaidReadyOrder(fx.branchId, marker + "-D", { table: "POL2SP" });
      const takeaway = await unpaidReadyOrder(fx.branchId, marker + "-T");
      assert.equal((await serve(dineIn)).status, 200, "dine-in may go out unpaid");
      assert.ok((await serve(takeaway)).status >= 400, "takeaway may not");
    } finally {
      await resetPolicy(fx.cafeId, fx.branchId);
      await db.tableSession.deleteMany({ where: { tableNumber: "POL2SP" } });
      await purge(marker);
      await cleanupShift(shift.id);
    }
  });

  // ── A branch override governs the branch's own orders ──
  test("P: a branch override governs serving at that branch only", async () => {
    const fx = await fixture();
    const marker = "POL2-P";
    await purge(marker);
    const shift = await ensureDrawer(fx);
    await setCafePolicy(fx.cafeId, "ALLOW_BEFORE_PAYMENT", "ALLOW_BEFORE_PAYMENT");
    await db.branch.update({
      where: { id: fx.branchId },
      data: { dineInServingPolicyOverride: "REQUIRE_PAYMENT_FIRST" },
    });
    try {
      const id = await unpaidReadyOrder(fx.branchId, marker, { table: "POL2P" });
      const res = await serve(id);
      assert.ok(
        res.status >= 400,
        "the branch override must win over a permissive café default"
      );
    } finally {
      await resetPolicy(fx.cafeId, fx.branchId);
      await db.tableSession.deleteMany({ where: { tableNumber: "POL2P" } });
      await purge(marker);
      await cleanupShift(shift.id);
    }
  });
});
