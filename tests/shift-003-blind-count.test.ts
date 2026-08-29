// SHIFT-003 — the physical cash count must be independent.
//
// Invariant: the employee who will count the drawer must not be able to learn
// the reconciliation target before they commit a count. Expected cash,
// shortage and overage are revealed only after the server confirms the count
// was persisted.
//
// The control is keyed on custody, not role: the target is withheld from the
// holder of an OPEN shift. A supervisor looking at somebody else's shift is
// not the one counting it and keeps visibility.
//
// These run against the real API because the defect is in what the server
// hands the cashier's browser.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import {
  db, fixture, clearOpenShifts, sessionFor, cleanup, policyProduct, cleanupProduct,
} from "./helpers/db";
import { requireServer, login, as } from "./helpers/http";

type ShiftPayload = Record<string, unknown> & { id: string; status: string };

const CASHIER = "cashier@demo.com";
const OWNER = "owner@demo.com";

/**
 * The item every sale here is rung up on.
 *
 * This suite is about whether a cashier can see the reconciliation target
 * before they count the drawer. It reached for the first variant-free product
 * on the seeded menu, which made it depend on whichever café data happened to
 * be loaded — and once a real menu was imported that product was a coffee
 * whose recipe wants beans this branch holds none of. With the POS now
 * refusing to sell what the branch cannot make, every test here failed at
 * "take one cash sale" for reasons of inventory.
 *
 * `policyProduct` is the fixture the serving and table-close suites already
 * moved to for exactly this reason. Nothing about the blind-count assertions
 * changes; the sale simply stops being an inventory question.
 */
let productId: string;

before(async () => {
  await requireServer();
  await login(CASHIER, "cashier123");
  await login(OWNER, "owner1234");
  const fx = await fixture();
  productId = (await policyProduct(fx, "PH1-SHIFT003")).id;
});

after(async () => {
  await cleanupProduct(productId);
  await db.$disconnect();
});

/** Open a shift through the real API and take one cash sale on it. */
async function openWithSale(openingCash: number, marker: string) {
  const fx = await fixture();
  const cashier = await sessionFor(CASHIER);
  await cleanup(marker);
  await clearOpenShifts(fx.branchId, cashier.id);

  const opened = await as<{ shift: ShiftPayload }>(CASHIER, "/api/shifts", {
    method: "POST",
    body: JSON.stringify({ branchId: fx.branchId, openingCashAmount: openingCash }),
  });
  assert.ok(opened.status < 300, `open shift failed: ${opened.text}`);

  const sale = await as<{ order: { id: string } }>(CASHIER, "/api/orders", {
    method: "POST",
    body: JSON.stringify({
      branchId: fx.branchId, type: "TAKEAWAY", customerName: marker,
      collectionMode: "NOW", method: "CASH",
      items: [{ productId, quantity: 1, addOnIds: [] }],
    }),
  });
  assert.ok(sale.status < 300, `sale failed: ${sale.text}`);

  return { fx, shiftId: opened.body.shift.id, marker };
}

describe("SHIFT-003 blind count", () => {
  // ── Test A: nothing pre-count may carry the target ──
  test("A1: the holder's own OPEN shift hides expected cash on /api/shifts/active", async () => {
    const { fx, shiftId, marker } = await openWithSale(100, "PH1-SHIFT003-A1");
    try {
      const r = await as<{ shift: ShiftPayload }>(
        CASHIER, `/api/shifts/active?branchId=${fx.branchId}`
      );
      assert.equal(r.status, 200);
      assert.ok(r.body.shift, "expected an active shift");
      assert.ok(
        !("expectedCashAmount" in r.body.shift),
        "active-shift payload disclosed the reconciliation target before counting"
      );
      // Operationally useful figures stay available.
      assert.ok("openingCashAmount" in r.body.shift, "opening float should remain visible");
      assert.ok("totalCashSales" in r.body.shift, "sales summary should remain visible");
    } finally {
      await cleanup(marker);
      await db.shift.deleteMany({ where: { id: shiftId } });
    }
  });

  test("A2: listing own shifts hides expected cash on the OPEN one", async () => {
    const { shiftId, marker } = await openWithSale(100, "PH1-SHIFT003-A2");
    try {
      const r = await as<{ shifts: ShiftPayload[] }>(CASHIER, "/api/shifts?status=OPEN");
      assert.equal(r.status, 200);
      const mine = r.body.shifts.find((s) => s.id === shiftId);
      assert.ok(mine, "cashier should still see their own open shift");
      assert.ok(
        !("expectedCashAmount" in mine),
        "shift list disclosed the target for the holder's own open shift"
      );
    } finally {
      await cleanup(marker);
      await db.shift.deleteMany({ where: { id: shiftId } });
    }
  });

  test("A3: re-opening an already-open shift does not leak the target", async () => {
    const { fx, shiftId, marker } = await openWithSale(100, "PH1-SHIFT003-A3");
    try {
      const again = await as<{ shift: ShiftPayload; alreadyOpen?: boolean }>(
        CASHIER, "/api/shifts",
        { method: "POST", body: JSON.stringify({ branchId: fx.branchId, openingCashAmount: 0 }) }
      );
      assert.equal(again.body.alreadyOpen, true, "expected the already-open branch");
      assert.ok(
        !("expectedCashAmount" in again.body.shift),
        "already-open response disclosed the target"
      );
    } finally {
      await cleanup(marker);
      await db.shift.deleteMany({ where: { id: shiftId } });
    }
  });

  test("A4: a supervisor viewing someone else's open shift still sees expected cash", async () => {
    const { shiftId, marker } = await openWithSale(100, "PH1-SHIFT003-A4");
    try {
      const r = await as<{ shifts: ShiftPayload[] }>(OWNER, "/api/shifts?status=OPEN");
      assert.equal(r.status, 200);
      const theirs = r.body.shifts.find((s) => s.id === shiftId);
      assert.ok(theirs, "owner should see the cashier's open shift");
      assert.ok(
        "expectedCashAmount" in theirs,
        "oversight must not be blinded — only the counting holder is"
      );
    } finally {
      await cleanup(marker);
      await db.shift.deleteMany({ where: { id: shiftId } });
    }
  });

  // ── Test C: reveal only after the server persists the count ──
  test("C: a successful close returns the full reconciliation", async () => {
    const { shiftId, marker } = await openWithSale(100, "PH1-SHIFT003-C");
    try {
      const r = await as<{ shift: ShiftPayload }>(CASHIER, `/api/shifts/${shiftId}/close`, {
        method: "POST", body: JSON.stringify({ actualCashAmount: 120 }),
      });
      assert.ok(r.status < 300, `close failed: ${r.text}`);
      assert.ok("expectedCashAmount" in r.body.shift, "reveal expected after commit");
      assert.equal(Number(r.body.shift.actualCashAmount), 120);
      assert.equal(
        Number(r.body.shift.cashDifference),
        Number(r.body.shift.actualCashAmount) - Number(r.body.shift.expectedCashAmount),
        "difference must equal actual - expected"
      );
    } finally {
      await cleanup(marker);
      await db.shift.deleteMany({ where: { id: shiftId } });
    }
  });

  // ── Test D: a rejected submit reveals nothing ──
  test("D: a failed close does not disclose expected cash", async () => {
    const { shiftId, marker } = await openWithSale(100, "PH1-SHIFT003-D");
    try {
      const ok = await as(CASHIER, `/api/shifts/${shiftId}/close`, {
        method: "POST", body: JSON.stringify({ actualCashAmount: 111 }),
      });
      assert.ok(ok.status < 300);

      // Second attempt must fail — and say nothing about the target.
      const bad = await as(CASHIER, `/api/shifts/${shiftId}/close`, {
        method: "POST", body: JSON.stringify({ actualCashAmount: 999 }),
      });
      assert.ok(bad.status >= 400, "re-closing a closed shift must fail");
      assert.ok(
        !bad.text.includes("expectedCashAmount"),
        "error response leaked the reconciliation target"
      );
    } finally {
      await cleanup(marker);
      await db.shift.deleteMany({ where: { id: shiftId } });
    }
  });

  // ── First count evidence ──
  test("the first committed count is preserved and cannot be revised", async () => {
    const { shiftId, marker } = await openWithSale(100, "PH1-SHIFT003-first");
    try {
      await as(CASHIER, `/api/shifts/${shiftId}/close`, {
        method: "POST", body: JSON.stringify({ actualCashAmount: 111 }),
      });
      const first = await db.shift.findUniqueOrThrow({ where: { id: shiftId } });
      assert.equal(Number(first.actualCashAmount), 111);

      // Try to walk the count towards the expected figure after seeing it.
      const retry = await as(CASHIER, `/api/shifts/${shiftId}/close`, {
        method: "POST", body: JSON.stringify({ actualCashAmount: Number(first.expectedCashAmount) }),
      });
      assert.ok(retry.status >= 400, "a second count must be refused");

      const still = await db.shift.findUniqueOrThrow({ where: { id: shiftId } });
      assert.equal(
        Number(still.actualCashAmount), 111,
        "the first submitted count was overwritten"
      );
      assert.equal(Number(still.cashDifference), Number(first.cashDifference));
    } finally {
      await cleanup(marker);
      await db.shift.deleteMany({ where: { id: shiftId } });
    }
  });

  // ── Test E: after commit, history is legitimately visible ──
  test("E: after close the reconciliation is readable and the shift is no longer active", async () => {
    const { fx, shiftId, marker } = await openWithSale(100, "PH1-SHIFT003-E");
    try {
      await as(CASHIER, `/api/shifts/${shiftId}/close`, {
        method: "POST", body: JSON.stringify({ actualCashAmount: 128.5 }),
      });

      const active = await as<{ shift: ShiftPayload | null }>(
        CASHIER, `/api/shifts/active?branchId=${fx.branchId}`
      );
      assert.equal(active.body.shift, null, "closed shift must not still be active");

      const closed = await as<{ shifts: ShiftPayload[] }>(CASHIER, "/api/shifts?status=CLOSED");
      const row = closed.body.shifts.find((s) => s.id === shiftId);
      assert.ok(row, "the closed shift should be readable");
      assert.ok(
        "expectedCashAmount" in row,
        "a committed reconciliation is history and stays visible"
      );
      assert.equal(Number(row.actualCashAmount), 128.5);
    } finally {
      await cleanup(marker);
      await db.shift.deleteMany({ where: { id: shiftId } });
    }
  });
});
