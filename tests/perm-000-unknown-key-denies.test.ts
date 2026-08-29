// PERM-000 — a key nobody has declared is a key nobody holds.
//
// This is a characterization test, not a bug fix. It pins a property the
// whole milestone is about to lean on: `requireKey` resolves the acting
// user's effective key set and checks membership, and that set is built
// only ever from the catalog. An uncatalogued key is therefore absent from
// every effective set — the café owner's and the super admin's included —
// so a route guarded on one throws 403 for literally everyone.
//
// Why that matters enough to pin before anything changes: every endpoint
// this milestone adds is written against a key. If the key is not in the
// catalog first, the route is unreachable and its own tests could assert
// nothing but 403 — a green suite that proves nothing. So the catalog must
// grow before the endpoints (T2), and the property that makes that ordering
// mandatory is worth protecting from a well-meant "helpful" default.
//
// Integration, against the real database: the resolver reads the user's
// role, custom role, overrides, and the café's feature flags. A mock would
// only assert what the mock was told.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { db, sessionFor } from "./helpers/db";
import { resolvePermissions } from "@/lib/perms/effective";
import { ALL_KEYS, CAFE_KEYS, MODULES, PERMISSION_KEYS } from "@/lib/perms/catalog";
import { getCafeSettings } from "@/lib/cafe-settings";

after(async () => { await db.$disconnect(); });

// Shaped exactly like a real key (module.action) so nothing can dismiss the
// result as "malformed input was rejected". The module is real; only the
// action is undeclared.
const UNDECLARED = "inventory.abscond_with_the_beans";

before(() => {
  assert.ok(
    !ALL_KEYS.includes(UNDECLARED),
    "this test is meaningless if the key it calls undeclared is in the catalog"
  );
});

/**
 * The café keys a disabled feature flag has NOT removed.
 *
 * An owner does not read back all of CAFE_KEYS: the feature gate applies to
 * everyone, so a café with `aiAssistantEnabled: false` strips `ai.use` even
 * from the tenant root. That is the gate working, not a hole in the catalog,
 * and conflating the two would make the assertion below unfalsifiable.
 */
async function grantableIn(cafeId: string): Promise<string[]> {
  const settings = (await getCafeSettings(cafeId)) as unknown as Record<string, unknown>;
  const off = new Set(
    MODULES.filter((m) => m.feature && settings[m.feature] === false).map((m) => m.code)
  );
  return PERMISSION_KEYS
    .filter((p) => p.key !== "platform.manage" && !off.has(p.module))
    .map((p) => p.key);
}

describe("PERM-000 an uncatalogued key denies everyone", () => {
  test("the café owner, who holds every café key, does not hold an undeclared one", async () => {
    const owner = await sessionFor("owner@demo.com");
    const { keys } = await resolvePermissions(owner);

    // Establish that this account really is the maximal café identity, so
    // the absence below is about the catalog and not about a thin account.
    for (const k of await grantableIn(owner.cafeId!)) {
      assert.ok(keys.has(k), `owner is missing catalogued key ${k}`);
    }
    assert.equal(
      keys.has(UNDECLARED), false,
      "an owner holds every key that exists — and nothing that does not"
    );
  });

  test("the super admin, who also holds the platform key, does not hold an undeclared one", async () => {
    const admin = await sessionFor("admin@cafeops.dev");
    const { keys } = await resolvePermissions(admin);

    assert.ok(keys.has("platform.manage"), "super admin holds the platform key");
    assert.equal(
      keys.has(UNDECLARED), false,
      "cross-tenant reach is still bounded by the catalog"
    );
  });

  test("a branch manager and a cashier do not hold an undeclared one either", async () => {
    for (const email of ["manager@demo.com", "cashier@demo.com"]) {
      const { keys } = await resolvePermissions(await sessionFor(email));
      assert.ok(keys.size > 0, `${email} resolved to an empty set — fixture problem`);
      assert.equal(
        keys.has(UNDECLARED), false,
        `${email} must not hold an undeclared key`
      );
    }
  });

  test("the grantable set is derived from the catalog, so growth is the only route in", async () => {
    // CAFE_KEYS is what an owner is unconditionally given and what the
    // OWNER role template ships. If it were hand-maintained, a key could
    // become grantable without ever being declared — and the property the
    // three tests above assert would decay quietly.
    const derived = PERMISSION_KEYS
      .filter((p) => p.key !== "platform.manage")
      .map((p) => p.key);
    assert.deepEqual(
      [...CAFE_KEYS], derived,
      "CAFE_KEYS must be PERMISSION_KEYS minus the platform key, in catalog order"
    );

    const seen = new Set<string>();
    for (const p of PERMISSION_KEYS) {
      assert.equal(seen.has(p.key), false, `duplicate catalog key ${p.key}`);
      seen.add(p.key);
    }
  });
});
