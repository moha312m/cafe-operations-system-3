// POLICY-001 — payment & serving policy is configuration, not a per-order choice.
//
// The owner decides whether food may reach a customer before it is paid, per
// order type. Staff never pick this on an order. That makes two things
// load-bearing and worth testing directly:
//
//   1. Rollout safety. Every café that already existed was pay-before-serving.
//      Shipping a column whose DEFAULT is "allow before payment" would flip
//      real cafés to pay-later the moment they upgraded, silently, with money
//      walking out of the door. The migration has to pin existing rows back.
//
//   2. Resolution. A branch may override the café, and NULL means inherit.
//      The fallback is expressed in exactly one place, so a branch cannot obey
//      one rule in the API and another on screen.
//
// Isolation matters too: this is tenant configuration, so one café or branch
// changing its mind must not move anyone else.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { getEffectiveServingPolicy, policyForOrderType } from "@/lib/serving-policy";
import { db, fixture } from "./helpers/db";
import { requireServer, login, as } from "./helpers/http";

const OWNER = "owner@demo.com", CASHIER = "cashier@demo.com";

after(async () => { await db.$disconnect(); });
before(async () => {
  await requireServer();
  await login(OWNER, "owner1234");
  await login(CASHIER, "cashier123");
});

/** Restore a branch to "inherit" so a failed run cannot leak into the next. */
async function clearOverrides(branchId: string) {
  await db.branch.update({
    where: { id: branchId },
    data: { dineInServingPolicyOverride: null, takeawayServingPolicyOverride: null },
  });
}

describe("POLICY-001 configuration and resolution", () => {
  // ── A: the upgrade must not change how an existing café behaves ──
  test("A: a café that existed before the feature stays payment-first", async () => {
    const fx = await fixture();
    const s = await db.cafeSettings.findUniqueOrThrow({ where: { cafeId: fx.cafeId } });
    assert.equal(
      s.dineInServingPolicy, "REQUIRE_PAYMENT_FIRST",
      "the migration must pin existing cafés back — a column default would have flipped them to pay-later"
    );
    assert.equal(s.takeawayServingPolicy, "REQUIRE_PAYMENT_FIRST");
  });

  // ── B: a café created from now on gets the new product default ──
  test("B: a newly created café defaults to dine-in pay-later, takeaway pay-first", async () => {
    const cafe = await db.cafe.create({
      data: { name: "POLICY-001 new", slug: `policy-001-new-${Date.now()}` },
    });
    try {
      const s = await db.cafeSettings.create({ data: { cafeId: cafe.id } });
      assert.equal(s.dineInServingPolicy, "ALLOW_BEFORE_PAYMENT");
      assert.equal(s.takeawayServingPolicy, "REQUIRE_PAYMENT_FIRST");
    } finally {
      await db.cafe.delete({ where: { id: cafe.id } });
    }
  });

  // ── C: no override means inherit ──
  test("C: a branch with no override inherits the café policy", async () => {
    const fx = await fixture();
    await clearOverrides(fx.branchId);
    await db.cafeSettings.update({
      where: { cafeId: fx.cafeId },
      data: { dineInServingPolicy: "ALLOW_BEFORE_PAYMENT", takeawayServingPolicy: "REQUIRE_PAYMENT_FIRST" },
    });
    try {
      const p = await getEffectiveServingPolicy(fx.branchId);
      assert.equal(p.dineIn, "ALLOW_BEFORE_PAYMENT");
      assert.equal(p.takeaway, "REQUIRE_PAYMENT_FIRST");
      assert.equal(p.dineInInherited, true, "the UI needs to say this came from the café");
      assert.equal(policyForOrderType(p, "DINE_IN"), "ALLOW_BEFORE_PAYMENT");
      assert.equal(policyForOrderType(p, "TAKEAWAY"), "REQUIRE_PAYMENT_FIRST");
      assert.equal(
        policyForOrderType(p, "DELIVERY"), "REQUIRE_PAYMENT_FIRST",
        "delivery is not configurable yet and must keep the old behaviour"
      );
    } finally {
      await db.cafeSettings.update({
        where: { cafeId: fx.cafeId },
        data: { dineInServingPolicy: "REQUIRE_PAYMENT_FIRST" },
      });
    }
  });

  // ── D: an override is the whole point ──
  test("D: a branch override beats the café default", async () => {
    const fx = await fixture();
    await db.cafeSettings.update({
      where: { cafeId: fx.cafeId },
      data: { dineInServingPolicy: "ALLOW_BEFORE_PAYMENT" },
    });
    await db.branch.update({
      where: { id: fx.branchId },
      data: { dineInServingPolicyOverride: "REQUIRE_PAYMENT_FIRST" },
    });
    try {
      const p = await getEffectiveServingPolicy(fx.branchId);
      assert.equal(p.dineIn, "REQUIRE_PAYMENT_FIRST");
      assert.equal(p.dineInInherited, false);
    } finally {
      await clearOverrides(fx.branchId);
      await db.cafeSettings.update({
        where: { cafeId: fx.cafeId },
        data: { dineInServingPolicy: "REQUIRE_PAYMENT_FIRST" },
      });
    }
  });

  // ── E: branches are independent ──
  test("E: overriding one branch does not move another", async () => {
    const fx = await fixture();
    const other = await db.branch.findFirstOrThrow({
      where: { cafeId: fx.cafeId, id: { not: fx.branchId } },
    });
    await clearOverrides(fx.branchId);
    await clearOverrides(other.id);
    await db.branch.update({
      where: { id: fx.branchId },
      data: { dineInServingPolicyOverride: "ALLOW_BEFORE_PAYMENT" },
    });
    try {
      const a = await getEffectiveServingPolicy(fx.branchId);
      const b = await getEffectiveServingPolicy(other.id);
      assert.equal(a.dineIn, "ALLOW_BEFORE_PAYMENT");
      assert.equal(b.dineIn, "REQUIRE_PAYMENT_FIRST", "branch B must be untouched");
      assert.equal(b.dineInInherited, true);
    } finally {
      await clearOverrides(fx.branchId);
      await clearOverrides(other.id);
    }
  });

  // ── F: cafés are independent ──
  test("F: changing one café does not move another café's branches", async () => {
    const fx = await fixture();
    const cafe = await db.cafe.create({
      data: { name: "POLICY-001 other", slug: `policy-001-other-${Date.now()}` },
    });
    try {
      await db.cafeSettings.create({
        data: { cafeId: cafe.id, dineInServingPolicy: "ALLOW_BEFORE_PAYMENT" },
      });
      const otherBranch = await db.branch.create({
        data: { cafeId: cafe.id, name: "POLICY-001 branch" },
      });

      const mine = await getEffectiveServingPolicy(fx.branchId);
      const theirs = await getEffectiveServingPolicy(otherBranch.id);
      assert.equal(theirs.dineIn, "ALLOW_BEFORE_PAYMENT");
      assert.equal(
        mine.dineIn, "REQUIRE_PAYMENT_FIRST",
        "another tenant's setting must not reach this café"
      );
    } finally {
      await db.cafe.delete({ where: { id: cafe.id } });
    }
  });

  // ── G: this is a sensitive setting ──
  test("G: a cashier cannot change the serving policy", async () => {
    const fx = await fixture();
    const res = await as(CASHIER, `/api/branches/${fx.branchId}/serving-policy`, {
      method: "PATCH",
      body: JSON.stringify({ dineInServingPolicyOverride: "ALLOW_BEFORE_PAYMENT" }),
    });
    assert.equal(res.status, 403, `a cashier must be refused, got ${res.status}`);
    const after = await db.branch.findUniqueOrThrow({ where: { id: fx.branchId } });
    assert.equal(after.dineInServingPolicyOverride, null, "the refused call must not have written");
  });

  // ── The platform owner sits above tenant configuration ──
  test("client policy cannot touch SUPER_ADMIN capability", async () => {
    const { resolvePermissions } = await import("@/lib/perms/effective");
    const fx = await fixture();
    await db.cafeSettings.update({
      where: { cafeId: fx.cafeId },
      data: { dineInServingPolicy: "ALLOW_BEFORE_PAYMENT" },
    });
    try {
      const su = await db.user.findFirstOrThrow({ where: { role: "SUPER_ADMIN" } });
      const { keys } = await resolvePermissions({
        id: su.id, role: "SUPER_ADMIN", cafeId: null, branchId: null,
        name: su.name, email: su.email,
      } as Parameters<typeof resolvePermissions>[0]);
      assert.ok(keys.has("platform.manage"), "a café setting must never remove platform access");
    } finally {
      await db.cafeSettings.update({
        where: { cafeId: fx.cafeId },
        data: { dineInServingPolicy: "REQUIRE_PAYMENT_FIRST" },
      });
    }
  });
});
