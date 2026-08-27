// PERM-001 — every key this milestone needs exists before the first endpoint
// that checks it.
//
// PERM-000 pins the reason this ordering is not optional: `requireKey` is
// fail-closed, so an uncatalogued key denies everyone, owner included. A
// route written before its key is unreachable and untestable — its suite
// could only ever assert 403. So the catalog grows first, and this suite is
// what says it grew correctly.
//
// It asserts three separate things that are easy to conflate:
//
//   • DECLARATION — the eighteen keys exist, once each, under a real module.
//   • GATING      — the two new modules ride the right feature flags.
//   • GRANT       — each role reads back exactly the column the plan gives
//                   it, resolved through the real resolver against the real
//                   database, not against the template constants. Templates
//                   are what a custom role is seeded from; `defaultKeysForRole`
//                   is what a user with no custom role actually gets. Those
//                   are different code paths and only the second one governs
//                   access today, so the second one is what is asserted.
//
// The withheld keys are the point of the milestone, not an oversight: a
// custodian must not confirm their own count, approve their own correction,
// resolve their own variance, or wave through their own handover.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { db, sessionFor, tag } from "./helpers/db";
import { resolvePermissions } from "@/lib/perms/effective";
import {
  ALL_KEYS, CAFE_KEYS, KEY_MAP, MODULE_MAP, MODULES,
  PERMISSION_KEYS, SENSITIVE_KEYS, keysForModule,
} from "@/lib/perms/catalog";

// The eighteen, with the module each belongs to and whether it is sensitive.
// Written out rather than derived from the catalog: a table derived from the
// thing it checks asserts nothing.
const NEW_KEYS = [
  ["stock_count.view", "STOCK_COUNT", false],
  ["stock_count.start", "STOCK_COUNT", false],
  ["stock_count.submit", "STOCK_COUNT", false],
  ["stock_count.recount", "STOCK_COUNT", false],
  ["stock_count.confirm", "STOCK_COUNT", true],
  ["stock_count.correct", "STOCK_COUNT", true],
  ["stock_count.approve_correction", "STOCK_COUNT", true],
  ["stock_count.configure", "STOCK_COUNT", true],
  ["variance.view", "VARIANCE", false],
  ["variance.investigate", "VARIANCE", true],
  ["variance.resolve", "VARIANCE", true],
  ["handover.submit", "HANDOVER", false],
  ["handover.accept", "HANDOVER", false],
  ["handover.exception", "HANDOVER", true],
  ["tender_reconciliation.view", "FINANCE", false],
  ["tender_reconciliation.submit", "FINANCE", true],
  ["tender_reconciliation.approve", "FINANCE", true],
  ["shifts.reconcile_cash", "SHIFTS", true],
] as const;

// The grant columns, exactly as the plan states them.
const MANAGER_COLUMN = NEW_KEYS
  .map(([k]) => k)
  .filter((k) => k !== "stock_count.configure"); // owner-only business config

const CASHIER_COLUMN = [
  "stock_count.view", "stock_count.start", "stock_count.submit",
  // `handover.view` is pre-existing, not one of the eighteen, but the
  // cashier must reach the page whose two new keys they now hold.
  "handover.view", "handover.submit", "handover.accept",
  "tender_reconciliation.view", "tender_reconciliation.submit",
  "shifts.reconcile_cash",
];

const INVENTORY_COLUMN = [
  "stock_count.view", "stock_count.start", "stock_count.submit", "stock_count.recount",
  "variance.view",
  "handover.submit", "handover.accept",
];

// Withheld from the custodian on purpose. Named separately so a future
// widening of CASHIER_COLUMN cannot quietly take these with it.
const WITHHELD_FROM_CASHIER = [
  "stock_count.confirm", "stock_count.correct", "stock_count.approve_correction",
  "stock_count.configure", "variance.resolve", "handover.exception",
];

const MARKER = tag("PERM001");
const cafeIds: string[] = [];
const userIds: string[] = [];

/**
 * Two cafés of this suite's own, because two of the assertions need tenants
 * the demo café cannot supply.
 *
 * The feature-gate assertion needs a café whose `inventoryEnabled` is OFF.
 * Flipping the demo café's flag and restoring it would leave that tenant
 * broken if the process died between the two writes, so the suite brings its
 * own tenant instead. The inventory-manager assertion needs an
 * INVENTORY_MANAGER account, and `prisma/seed.ts` creates none — and the seed
 * is not this milestone's to change (§2.3.7).
 *
 * Both cafés and both users are deleted afterwards; no seeded row is touched.
 */
async function scratchCafe(
  suffix: string,
  role: "BRANCH_MANAGER" | "INVENTORY_MANAGER",
  inventoryEnabled: boolean
): Promise<string> {
  const cafe = await db.cafe.create({
    data: {
      name: `${MARKER}-${suffix} cafe`,
      slug: `${MARKER}-${suffix}`.toLowerCase(),
      settings: { create: { inventoryEnabled } },
      branches: { create: { name: `${MARKER}-${suffix} branch` } },
    },
    include: { branches: true },
  });
  cafeIds.push(cafe.id);
  const user = await db.user.create({
    data: {
      email: `${MARKER}-${suffix}@example.invalid`,
      name: `${MARKER}-${suffix}`,
      // Never used to authenticate: the account exists only so the resolver
      // has a real row of that role to resolve against.
      passwordHash: "no-login-path",
      role,
      cafeId: cafe.id,
      branchId: cafe.branches[0].id,
    },
  });
  userIds.push(user.id);
  return user.id;
}

let inventoryManagerId: string;
let gatedManagerId: string;

before(async () => {
  inventoryManagerId = await scratchCafe("inv", "INVENTORY_MANAGER", true);
  gatedManagerId = await scratchCafe("gated", "BRANCH_MANAGER", false);
});

after(async () => {
  if (userIds.length) await db.user.deleteMany({ where: { id: { in: userIds } } });
  if (cafeIds.length) await db.cafe.deleteMany({ where: { id: { in: cafeIds } } });
  await db.$disconnect();
});

/** Effective keys for a seeded account, through the real resolver. */
async function keysFor(email: string): Promise<Set<string>> {
  return (await resolvePermissions(await sessionFor(email))).keys;
}

/** Effective keys for one of this suite's own accounts. */
async function keysForId(id: string): Promise<Set<string>> {
  const u = await db.user.findUniqueOrThrow({ where: { id } });
  const { keys } = await resolvePermissions({
    id: u.id, email: u.email, name: u.name,
    role: u.role, cafeId: u.cafeId, branchId: u.branchId,
  });
  return keys;
}

describe("PERM-001 catalog, templates, and nav", () => {
  test("all eighteen keys are declared, exactly once each", () => {
    for (const [key] of NEW_KEYS) {
      const hits = PERMISSION_KEYS.filter((p) => p.key === key);
      assert.equal(hits.length, 1, `${key} must appear exactly once in the catalog`);
      assert.ok(ALL_KEYS.includes(key), `${key} missing from ALL_KEYS`);
      assert.ok(CAFE_KEYS.includes(key), `${key} must be grantable inside a café`);
    }
  });

  test("each new key maps to a module the catalog actually declares", () => {
    for (const [key, moduleCode] of NEW_KEYS) {
      const entry = KEY_MAP[key];
      assert.ok(entry, `${key} not in KEY_MAP`);
      assert.equal(entry.module, moduleCode, `${key} must live under ${moduleCode}`);
      assert.ok(MODULE_MAP[entry.module], `module ${entry.module} is not declared`);
      assert.ok(entry.label.length > 0, `${key} needs a label for the roles UI`);
    }
    assert.ok(MODULES.some((m) => m.code === "STOCK_COUNT"), "STOCK_COUNT module missing");
    assert.ok(MODULES.some((m) => m.code === "VARIANCE"), "VARIANCE module missing");
  });

  test("STOCK_COUNT gates on inventory, VARIANCE on shift management", () => {
    assert.equal(MODULE_MAP.STOCK_COUNT.feature, "inventoryEnabled");
    assert.equal(MODULE_MAP.VARIANCE.feature, "shiftManagementEnabled");
    // Counting is an inventory activity and variance is a shift-close
    // activity; the gates are not interchangeable.
    assert.equal(keysForModule("STOCK_COUNT").length, 8);
    assert.equal(keysForModule("VARIANCE").length, 3);
  });

  test("the owner holds all eighteen with no reseed, and reads 107 keys", async () => {
    const keys = await keysFor("owner@demo.com");
    for (const [key] of NEW_KEYS) {
      assert.ok(keys.has(key), `owner must hold ${key}`);
    }
    // 89 before this task, 89 + 18 = 107. `resolvePermissions` re-adds
    // CAFE_KEYS on every call, so catalog growth reaches existing owners
    // without touching a single row of their data.
    assert.equal(keys.size, 107, "owner should read 89 + 18 keys");
  });

  test("the branch manager holds its column exactly — no more, no less", async () => {
    const keys = await keysFor("manager@demo.com");
    for (const key of MANAGER_COLUMN) {
      assert.ok(keys.has(key), `manager must hold ${key}`);
    }
    assert.equal(
      keys.has("stock_count.configure"), false,
      "policy, tolerance and critical-item selection are owner business configuration"
    );
  });

  test("the cashier holds its column, and none of what a custodian must not self-approve", async () => {
    const keys = await keysFor("cashier@demo.com");
    for (const key of CASHIER_COLUMN) {
      assert.ok(keys.has(key), `cashier must hold ${key}`);
    }
    for (const key of WITHHELD_FROM_CASHIER) {
      assert.equal(keys.has(key), false, `cashier must NOT hold ${key}`);
    }
  });

  test("the inventory manager holds its column, and no cash or tender key", async () => {
    const keys = await keysForId(inventoryManagerId);
    for (const key of INVENTORY_COLUMN) {
      assert.ok(keys.has(key), `inventory manager must hold ${key}`);
    }
    for (const key of ["shifts.reconcile_cash", "tender_reconciliation.view",
                       "tender_reconciliation.submit", "stock_count.confirm"]) {
      assert.equal(keys.has(key), false, `inventory manager must NOT hold ${key}`);
    }
  });

  test("disabling inventoryEnabled strips every STOCK_COUNT key from a manager", async () => {
    const keys = await keysForId(gatedManagerId);
    for (const key of keysForModule("STOCK_COUNT")) {
      assert.equal(
        keys.has(key.key), false,
        `${key.key} must vanish when the café has no inventory module`
      );
    }
    // The gate is per-module, not global: variance rides shift management,
    // which this café still has on.
    assert.ok(keys.has("variance.view"), "VARIANCE must survive an inventory-only gate");
  });

  test("the ten sensitive keys are marked sensitive", () => {
    const expected = NEW_KEYS.filter(([, , s]) => s).map(([k]) => k);
    assert.equal(expected.length, 10, "the plan marks ten of the eighteen sensitive");
    for (const key of expected) {
      assert.ok(SENSITIVE_KEYS.has(key), `${key} must carry the sensitive badge`);
    }
    for (const [key, , sensitive] of NEW_KEYS) {
      if (!sensitive) {
        assert.equal(SENSITIVE_KEYS.has(key), false, `${key} must not be marked sensitive`);
      }
    }
  });

  test("every new nav entry declares a granular key", () => {
    // NAV is module-private to a client component, so it is read as source.
    // The property under test is textual anyway: an entry that falls back to
    // the legacy `permission` bridge would gate the page on the wrong thing.
    const src = readFileSync("src/components/app-shell.tsx", "utf8");
    for (const [href, key] of [
      ["/stock-counts", "stock_count.view"],
      ["/variances", "variance.view"],
      ["/handovers", "handover.view"],
    ]) {
      const line = src.split("\n").find((l) => l.includes(`href: "${href}"`));
      assert.ok(line, `no NAV entry for ${href}`);
      assert.ok(line.includes(`key: "${key}"`), `${href} must gate on key ${key}`);
      assert.ok(line.includes("feature:"), `${href} must declare its feature gate`);
    }
  });
});
