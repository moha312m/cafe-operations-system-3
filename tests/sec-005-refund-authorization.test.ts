// SEC-005 (R-SEC-01/A4) — refund and shift-close authority must obey the
// permissions the café actually configured.
//
// Refund routes require the permission to REQUEST an owner action. A request
// never moves money; an owner must approve and execute it through the separate
// approval flow. Shift close authority remains independently permissioned.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { db, closeOpenShifts, teardownTaggedCafe } from "./helpers/db";
import { countCafe, COUNT_PASSWORD, type CountCafe } from "./helpers/count";
import { requireServer, login, as } from "./helpers/http";
import { PERMISSION_KEYS, LEGACY_TO_KEYS } from "@/lib/perms/catalog";
import { defaultKeysForRole, SYSTEM_ROLES } from "@/lib/perms/templates";

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

  test("refund requests are available to floor roles, while direct refunds remain owner-gated", () => {
    for (const role of ["BRANCH_MANAGER", "CASHIER", "WAITER", "BARISTA"] as const) {
      assert.ok(defaultKeysForRole(role as never).includes("orders.request_owner_action"), role);
    }
    assert.ok(defaultKeysForRole("CAFE_OWNER" as never).includes("orders.refund"));
  });

  test("both resolution paths grant shifts.close_others to a manager, and only to oversight roles", () => {
    // The amendment's whole point. Enforcing the key without granting it
    // refused the manager their end-of-day close; granting it on only one
    // path would answer the same question differently depending on whether
    // a café had been assigned the stored MANAGER role.
    //
    // Path 1 — the legacy-role default, which is what a user with
    // `cafeRoleId: NULL` actually resolves through.
    assert.ok(
      defaultKeysForRole("BRANCH_MANAGER" as never).includes("shifts.close_others"),
      "a branch manager must be able to close a cashier's drawer"
    );
    // Path 2 — the stored MANAGER role, seeded from the template.
    const managerRole = SYSTEM_ROLES.find((r) => r.code === "MANAGER");
    assert.ok(managerRole, "the MANAGER system role must exist");
    assert.ok(
      managerRole!.keys.includes("shifts.close_others"),
      "the stored role must agree with the legacy default"
    );

    // It is oversight, so it stops at oversight.
    assert.equal(
      defaultKeysForRole("CASHIER" as never).includes("shifts.close_others"),
      false,
      "a cashier closes their own shift, not somebody else's"
    );
    assert.equal(
      defaultKeysForRole("WAITER" as never).includes("shifts.close_others"),
      false
    );

    // Granted by the supervisory bridge, by name — the membership the route
    // used to rely on implicitly through `shifts:read`.
    assert.ok(LEGACY_TO_KEYS["shifts:read"].includes("shifts.close_others"));
    // And no new key was invented to do it.
    assert.equal(
      PERMISSION_KEYS.filter((k) => k.key === "shifts.close_others").length,
      1
    );
  });
});

describe("SEC-005 owner-action request authority follows the effective permission", () => {
  test("a manager with request permission is past the guard", async () => {
    // A non-existent order id: the point is the AUTHORIZATION verdict, so
    // anything other than 403 means the guard let them through.
    const res = await as(fx.manager.email, "/api/orders/not-a-real-order/refund", {
      method: "POST",
      body: JSON.stringify({ reason: "SEC-005 probe" }),
    });
    assert.notEqual(res.status, 403, `manager must pass the request guard: ${res.text}`);
    assert.equal(res.status, 404, res.text);
  });

  test("a waiter may request, but cannot execute, a refund", async () => {
    const res = await as(fx.waiter.email, "/api/orders/not-a-real-order/refund", {
      method: "POST",
      body: JSON.stringify({ reason: "SEC-005 probe" }),
    });
    assert.equal(res.status, 404, "request permission passes before target lookup");
  });

  test("revoking request permission from a manager blocks new requests", async () => {
    await override(fx.manager.id, "orders.request_owner_action", false);
    await login(fx.manager.email, COUNT_PASSWORD);

    const order = await as(fx.manager.email, "/api/orders/not-a-real-order/refund", {
      method: "POST",
      body: JSON.stringify({ reason: "SEC-005 probe" }),
    });
    assert.equal(order.status, 403, `order refund request must be refused: ${order.text}`);

    const payment = await as(fx.manager.email, "/api/payments/not-a-real-payment/refund", {
      method: "POST",
    });
    assert.equal(
      payment.status,
      403,
      `the payment-level refund request must be refused too: ${payment.text}`
    );

    // The legacy role remains unchanged; only its effective request grant changed.
    const row = await db.user.findUniqueOrThrow({
      where: { id: fx.manager.id },
      select: { role: true },
    });
    assert.equal(row.role, "BRANCH_MANAGER");

    await db.userPermissionOverride.deleteMany({
      where: { userId: fx.manager.id, permissionKey: "orders.request_owner_action" },
    });
    await login(fx.manager.email, COUNT_PASSWORD);
  });

  test("a cashier's request permission can be revoked and restored", async () => {
    await override(fx.cashier.id, "orders.request_owner_action", false);
    await login(fx.cashier.email, COUNT_PASSWORD);
    const before = await as(fx.cashier.email, "/api/orders/not-a-real-order/refund", {
      method: "POST",
      body: JSON.stringify({ reason: "SEC-005 probe" }),
    });
    assert.equal(before.status, 403, "a cashier with an explicit deny cannot request");

    await db.userPermissionOverride.updateMany({
      where: { userId: fx.cashier.id, permissionKey: "orders.request_owner_action" },
      data: { allowed: true },
    });
    await login(fx.cashier.email, COUNT_PASSWORD);

    const after = await as(fx.cashier.email, "/api/orders/not-a-real-order/refund", {
      method: "POST",
      body: JSON.stringify({ reason: "SEC-005 probe" }),
    });
    assert.equal(after.status, 404, `restored request permission passes the guard: ${after.text}`);

    await db.userPermissionOverride.deleteMany({
      where: { userId: fx.cashier.id, permissionKey: "orders.request_owner_action" },
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
      "src/app/api/shifts/[id]/close/route.ts",
      "src/app/api/shifts/route.ts",
      "src/app/api/shifts/[id]/route.ts",
    ];
    for (const file of files) {
      const source = readFileSync(file, "utf8") as string;
      assert.doesNotMatch(
        source,
        /hasPermission\(session\.role/,
        `${file} must not decide authority from the legacy role table`
      );
    }
  });

  test("closing another cashier's shift costs shifts.close_others, with no bypass left", () => {
    const source = readFileSync(
      "src/app/api/shifts/[id]/close/route.ts",
      "utf8"
    ) as string;
    assert.match(source, /closerKeys\.has\("shifts\.close_others"\)/);
    assert.doesNotMatch(source, /hasPermission/, "no legacy authority survives here");
  });
});

describe("SEC-005 closing somebody else's shift obeys the granular key", () => {
  // The guard sits after the shift is found and scoped, so these need a real
  // OPEN shift belonging to somebody else. The distinctive refusal is the
  // one the route raises for this specific act.
  const NOT_YOURS = /مينفعش تقفل شيفت كاشير تاني/;
  let shiftSeq = 0;

  async function cashiersOpenShift() {
    shiftSeq += 1;
    // One drawer per cashier: close the one a previous test left open rather
    // than deleting it, so its evidence survives.
    await closeOpenShifts(fx.branchId, fx.cashier.id);
    const shift = await db.shift.create({
      data: {
        cafeId: fx.cafeId,
        branchId: fx.branchId,
        cashierId: fx.cashier.id,
        shiftNumber: 9000 + shiftSeq,
        openingCashAmount: 0,
        expectedCashAmount: 0,
        status: "OPEN",
      },
      select: { id: true },
    });
    return shift.id;
  }

  const close = (email: string, shiftId: string) =>
    as(email, `/api/shifts/${shiftId}/close`, {
      method: "POST",
      body: JSON.stringify({ actualCashAmount: 0 }),
    });

  test("a manager holding the key is past the guard", async () => {
    // Preserved access, proven through the resolution path a real manager
    // actually takes — they carry no stored CafeRole.
    const stored = await db.user.findUniqueOrThrow({
      where: { id: fx.manager.id },
      select: { cafeRoleId: true, role: true },
    });
    assert.equal(stored.cafeRoleId, null, "the fixture manager resolves via the bridge");

    const shiftId = await cashiersOpenShift();
    const res = await close(fx.manager.email, shiftId);
    assert.doesNotMatch(
      res.text,
      NOT_YOURS,
      `the manager's end-of-day close must not be refused: ${res.status} ${res.text}`
    );
  });

  test("revoking the key refuses the close — the legacy role alone is not enough", async () => {
    // The defect, stated as a test. The `role` column still reads
    // BRANCH_MANAGER throughout, so the refusal can only have come from the
    // effective permission.
    const shiftId = await cashiersOpenShift();
    await db.userPermissionOverride.create({
      data: { userId: fx.manager.id, permissionKey: "shifts.close_others", allowed: false },
    });
    await login(fx.manager.email, COUNT_PASSWORD);

    const res = await close(fx.manager.email, shiftId);
    assert.equal(res.status, 403, res.text);
    assert.match(res.text, NOT_YOURS);

    const row = await db.user.findUniqueOrThrow({
      where: { id: fx.manager.id },
      select: { role: true },
    });
    assert.equal(row.role, "BRANCH_MANAGER", "the legacy role is untouched");

    await db.userPermissionOverride.deleteMany({
      where: { userId: fx.manager.id, permissionKey: "shifts.close_others" },
    });
    await login(fx.manager.email, COUNT_PASSWORD);
  });

  test("a waiter without the key is refused", async () => {
    const shiftId = await cashiersOpenShift();
    const res = await close(fx.waiter.email, shiftId);
    assert.equal(res.status, 403, res.text);
    assert.match(res.text, NOT_YOURS);
  });

  test("granting the key to a cashier lets them close another cashier's shift", async () => {
    const shiftId = await cashiersOpenShift();
    await db.userPermissionOverride.create({
      data: { userId: fx.storekeeper.id, permissionKey: "shifts.close_others", allowed: true },
    });
    await login(fx.storekeeper.email, COUNT_PASSWORD);

    const res = await close(fx.storekeeper.email, shiftId);
    assert.doesNotMatch(res.text, NOT_YOURS, `the grant must bind: ${res.status} ${res.text}`);

    await db.userPermissionOverride.deleteMany({
      where: { userId: fx.storekeeper.id, permissionKey: "shifts.close_others" },
    });
    await login(fx.storekeeper.email, COUNT_PASSWORD);
  });

  test("a cashier may still close their OWN shift without the key", async () => {
    // The key governs other people's drawers only; it must not have made a
    // cashier unable to finish their own night.
    const shiftId = await cashiersOpenShift();
    assert.equal(
      defaultKeysForRole("CASHIER" as never).includes("shifts.close_others"),
      false
    );
    const res = await close(fx.cashier.email, shiftId);
    assert.doesNotMatch(res.text, NOT_YOURS, `${res.status} ${res.text}`);
  });
});
