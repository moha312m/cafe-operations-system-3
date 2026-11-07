// Owner override for discounts: the decision and the code check, without a database.
import { test } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { ApiError } from "../src/lib/api";
import {
  OWNER_OVERRIDE_REFUSED, discountDecision, discountExceedsLimit, overrideCodeMatches, overrideRefusal,
} from "../src/lib/owner-override";

const limit = { maxAmount: "5.00", maxPercent: "10.00" };

test("a manager may apply a large discount without a code", () => {
  for (const role of ["CAFE_OWNER", "BRANCH_MANAGER"]) {
    assert.deepEqual(discountDecision({ role, hasDiscountKey: true, discount: "50.00", subtotal: "90.00", limit: null, override: "NONE" }),
      { allowed: true, reasons: [] });
  }
});

test("a cashier over the limit without a code is refused; a valid code allows it", () => {
  const args = { role: "CASHIER", hasDiscountKey: true, discount: "20.00", subtotal: "90.00", limit };
  assert.deepEqual(discountDecision({ ...args, override: "NONE" }), { allowed: false, reasons: ["DISCOUNT_LIMIT"] });
  assert.deepEqual(discountDecision({ ...args, override: "INVALID" }), { allowed: false, reasons: ["DISCOUNT_LIMIT"] });
  assert.deepEqual(discountDecision({ ...args, override: "LOCKED" }), { allowed: false, reasons: ["DISCOUNT_LIMIT"] });
  assert.deepEqual(discountDecision({ ...args, override: "VALID" }), { allowed: true, reasons: ["DISCOUNT_LIMIT"] });
});

test("a cashier within the limit needs no code; no discount key needs one", () => {
  assert.deepEqual(discountDecision({ role: "CASHIER", hasDiscountKey: true, discount: "5.00", subtotal: "90.00", limit, override: "NONE" }),
    { allowed: true, reasons: [] });
  assert.deepEqual(discountDecision({ role: "WAITER", hasDiscountKey: false, discount: "1.00", subtotal: "90.00", limit, override: "NONE" }),
    { allowed: false, reasons: ["DISCOUNT_PERMISSION"] });
  assert.deepEqual(discountDecision({ role: "WAITER", hasDiscountKey: false, discount: "0", subtotal: "90.00", limit: null, override: "NONE" }),
    { allowed: true, reasons: [] });
});

test("the limit is in currency units and percent, both enforced; no limit row means zero", () => {
  assert.equal(discountExceedsLimit({ discount: "5.00", subtotal: "100.00", limit }), false);
  assert.equal(discountExceedsLimit({ discount: "5.01", subtotal: "100.00", limit }), true);
  assert.equal(discountExceedsLimit({ discount: "5.00", subtotal: "40.00", limit }), true, "12.5% exceeds 10%");
  assert.equal(discountExceedsLimit({ discount: "0.01", subtotal: "100.00", limit: null }), true);
});

test("the code is compared with bcrypt and a malformed code never matches", async () => {
  const hash = await bcrypt.hash("246810", 4);
  assert.equal(await overrideCodeMatches("246810", hash), true);
  assert.equal(await overrideCodeMatches("246811", hash), false);
  assert.equal(await overrideCodeMatches("24681", hash), false);
  assert.equal(await overrideCodeMatches("abcdef", hash), false);
});

test("a refusal is unchanged without a code, and generic with a wrong one", () => {
  const original = new ApiError(403, "original");
  assert.equal(overrideRefusal({ status: "NONE" }, original), original);
  const invalid = overrideRefusal({ status: "INVALID" }, original);
  assert.equal(invalid.status, 403);
  assert.equal(invalid.message, OWNER_OVERRIDE_REFUSED);
  assert.equal(overrideRefusal({ status: "LOCKED" }, original).status, 429);
});
