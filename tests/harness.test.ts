// Smoke test for the Phase 1 harness: proves the runner executes TypeScript,
// resolves tsconfig path aliases, and can reach the configured database.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { db, fixture, sessionFor } from "./helpers/db";

after(async () => { await db.$disconnect(); });

test("harness reaches the database and finds seeded fixtures", async () => {
  const fx = await fixture();
  assert.ok(fx.branchId, "expected a seeded branch");
  assert.ok(fx.productId, "expected a variant-free seeded product");
  assert.ok(fx.unitPrice > 0, "expected a positive unit price");
});

test("harness can build a session for each seeded role", async () => {
  for (const email of ["owner@demo.com", "manager@demo.com", "cashier@demo.com"]) {
    const s = await sessionFor(email);
    assert.equal(s.email, email);
    assert.ok(s.id);
  }
});
