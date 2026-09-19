// SEC-005 (R-SEC-01/A4) — refund and shift-close authority must obey the
// permissions the café actually configured.
//
// `orders.refund` and `shifts.close_others` were defined in the catalog —
// both marked sensitive — and enforced by no route at all. Both refund
// routes and the "close somebody else's shift" check read `shifts:read`
// out of the STATIC role table instead, so:
//
//   • revoking refund rights through a custom café role or a per-user
//     override changed nothing — the legacy `role` column still said
//     BRANCH_MANAGER and the money went back; and
//   • granting refund rights to a cashier was silently ignored.
//
// The roles-permissions screen could not bind either way, which made the
// whole permission system advisory on the one action that moves money out
// of the drawer.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, COUNT_PASSWORD, type CountCafe } from "./helpers/count";
import { requireServer, login, as } from "./helpers/http";
import { PERMISSION_KEYS, LEGACY_TO_KEYS } from "@/lib/perms/catalog";
import { ROLE_PERMISSIONS } from "@/lib/permissions";
import { defaultKeysForRole } from "@/lib/perms/templates";

let fx: CountCafe;

before(async () => {
  await requireServer();
  fx = await countCafe("SEC005");
});

after(() => teardownTaggedCafe(fx.cafeId, [], { disconnect: true }));

/** Deny one key for one user, the way the roles screen does. */
function override(userId: string, permissionKey: string, allowed: boolean) {
  return db.userPermissionOverride.create({
    data: { userId, permissionKey, allowed },
  });
}

describe("SEC-005 the keys exist and are the ones enforced", () => {
  test("both keys are in the catalog and marked sensitive", () => {
    for (const key of ["orders.refund", "shifts.close_others"]) {
      const entry = PERMISSION_KEYS.find((k) => k.key === key);
      assert.ok(entry, `${key} must exist`);
      assert.equal(entry!.sensitive, true, `${key} is a sensitive power`);
    }
  });

  test("refund authority is unchanged by default — a manager has it, a waiter does not", () => {
    // The repair moves WHERE the answer comes from, not who gets it.
    assert.ok(defaultKeysForRole("BRANCH_MANAGER" as never).includes("orders.refund"));
    assert.equal(defaultKeysForRole("WAITER" as never).includes("orders.refund"), false);
  });

  test("shifts.close_others is granted to NOBODY but the owner — why that guard is unchanged", () => {
    // This is the finding that stopped the close-others half of A4. The key
    // is catalogued and sensitive, and no manager template or legacy bridge
    // grants it; only CAFE_OWNER holds it, through the owner's union of
    // every café key. Enforcing it would have stopped a branch manager
    // closing a cashier's shift — an ordinary end-of-day act — so the legacy
    // check stays until the owner rules on the grant.
    assert.equal(
      defaultKeysForRole("BRANCH_MANAGER" as never).includes("shifts.close_others"),
      false,
      "if a manager ever gains this key, the close route should switch to it"
    );
    const bridged = new Set<string>();
    for (const p of ROLE_PERMISSIONS.BRANCH_MANAGER ?? []) {
      for (const k of LEGACY_TO_KEYS[p] ?? []) bridged.add(k);
    }
    assert.equal(
      bridged.has("shifts.close_others"),
      false,
      "nor does the legacy bridge grant it"
    );
  });
});

describe("SEC-005 refund authority follows the effective permission", () => {
  test("a manager with the key is past the guard", async () => {
    // A non-existent order id: the point is the AUTHORIZATION verdict, so
    // anything other than 403 means the guard let them through.
    const res = await as(fx.manager.email, "/api/orders/not-a-real-order/refund", {
      method: "POST",
      body: JSON.stringify({ reason: "SEC-005 probe" }),
    });
    assert.notEqual(res.status, 403, `manager must pass the refund guard: ${res.text}`);
    assert.equal(res.status, 404, res.text);
  });

  test("a waiter without the key is refused", async () => {
    const res = await as(fx.waiter.email, "/api/orders/not-a-real-order/refund", {
      method: "POST",
      body: JSON.stringify({ reason: "SEC-005 probe" }),
    });
    assert.equal(res.status, 403, res.text);
  });

  test("REVOKING the key from a manager now actually revokes refunds", async () => {
    // The defect, stated as a test: before this stage the override was
    // ignored because the route consulted the legacy role instead.
    await override(fx.manager.id, "orders.refund", false);
    await login(fx.manager.email, COUNT_PASSWORD);

    const order = await as(fx.manager.email, "/api/orders/not-a-real-order/refund", {
      method: "POST",
      body: JSON.stringify({ reason: "SEC-005 probe" }),
    });
    assert.equal(order.status, 403, `order refund must now be refused: ${order.text}`);

    const payment = await as(fx.manager.email, "/api/payments/not-a-real-payment/refund", {
      method: "POST",
    });
    assert.equal(
      payment.status,
      403,
      `the payment-level refund must be refused too: ${payment.text}`
    );

    // And the legacy role is still BRANCH_MANAGER — proving the refusal came
    // from the effective permission rather than from a role change.
    const row = await db.user.findUniqueOrThrow({
      where: { id: fx.manager.id },
      select: { role: true },
    });
    assert.equal(row.role, "BRANCH_MANAGER");

    await db.userPermissionOverride.deleteMany({
      where: { userId: fx.manager.id, permissionKey: "orders.refund" },
    });
    await login(fx.manager.email, COUNT_PASSWORD);
  });

  test("GRANTING the key to a cashier now actually grants refunds", async () => {
    const before = await as(fx.cashier.email, "/api/orders/not-a-real-order/refund", {
      method: "POST",
      body: JSON.stringify({ reason: "SEC-005 probe" }),
    });
    assert.equal(before.status, 403, "a cashier starts without refund authority");

    await override(fx.cashier.id, "orders.refund", true);
    await login(fx.cashier.email, COUNT_PASSWORD);

    const after = await as(fx.cashier.email, "/api/orders/not-a-real-order/refund", {
      method: "POST",
      body: JSON.stringify({ reason: "SEC-005 probe" }),
    });
    assert.notEqual(after.status, 403, `the grant must bind: ${after.text}`);

    await db.userPermissionOverride.deleteMany({
      where: { userId: fx.cashier.id, permissionKey: "orders.refund" },
    });
    await login(fx.cashier.email, COUNT_PASSWORD);
  });
});

describe("SEC-005 no legacy-role authority survives on these routes", () => {
  test("the repaired routes read effective keys, not the static role table", () => {
    // Source-read, because the absence of a call is the property under test.
    const files = [
      "src/app/api/orders/[id]/refund/route.ts",
      "src/app/api/payments/[id]/refund/route.ts",
      "src/app/api/shifts/route.ts",
      "src/app/api/shifts/[id]/route.ts",
    ];
    for (const file of files) {
      const source = require("node:fs").readFileSync(file, "utf8") as string;
      assert.doesNotMatch(
        source,
        /hasPermission\(session\.role/,
        `${file} must not decide authority from the legacy role table`
      );
    }
  });

  test("the one remaining bypass is named in place, not left silent", () => {
    // A bypass that stays must say why it stays, or the next reader repeats
    // the mistake this stage made: switching the guard and breaking the
    // manager's end-of-day close.
    const source = require("node:fs").readFileSync(
      "src/app/api/shifts/[id]/close/route.ts",
      "utf8"
    ) as string;
    assert.match(source, /DELIBERATELY STILL THE LEGACY CHECK/);
    assert.match(source, /shifts\.close_others/);
  });
});
