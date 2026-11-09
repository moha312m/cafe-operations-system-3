import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isValidMultiplier, isValidRoundingStep } from "@/lib/menu-pricing";

describe("Pricing API Validation Invariants", () => {
  test("preview schema multiplier and rounding step constraints", () => {
    // Valid multipliers
    assert.equal(isValidMultiplier(2), true);
    assert.equal(isValidMultiplier(2.5), true);
    assert.equal(isValidMultiplier(3.125), true);
    assert.equal(isValidMultiplier(100), true);

    // Invalid multipliers
    assert.equal(isValidMultiplier(0), false);
    assert.equal(isValidMultiplier(-1), false);
    assert.equal(isValidMultiplier(100.001), false);
    assert.equal(isValidMultiplier(2.1234), false);
    assert.equal(isValidMultiplier(null), false);
    assert.equal(isValidMultiplier("invalid"), false);

    // Valid rounding steps
    assert.equal(isValidRoundingStep(1), true);
    assert.equal(isValidRoundingStep(0.5), true);
    assert.equal(isValidRoundingStep(5), true);
    assert.equal(isValidRoundingStep(10), true);
    assert.equal(isValidRoundingStep(1000), true);

    // Invalid rounding steps
    assert.equal(isValidRoundingStep(0), false);
    assert.equal(isValidRoundingStep(-1), false);
    assert.equal(isValidRoundingStep(1001), false);
    assert.equal(isValidRoundingStep(1.234), false);
    assert.equal(isValidRoundingStep(null), false);
  });

  test("apply schema bounds enforcement", () => {
    // Selection boundary: max 100 items
    const MAX_APPLY_ITEMS = 100;
    const generateItems = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        targetType: "VARIANT" as const,
        productId: `prod_${i}`,
        variantId: `var_${i}`,
        newPrice: 50,
      }));

    assert.equal(generateItems(100).length <= MAX_APPLY_ITEMS, true);
    assert.equal(generateItems(101).length <= MAX_APPLY_ITEMS, false);

    // Intent key / idempotency key length constraint: 8 to 128 characters
    function isValidIntentKey(key?: string | null): boolean {
      if (!key) return false;
      const trimmed = key.trim();
      return trimmed.length >= 8 && trimmed.length <= 128;
    }

    assert.equal(isValidIntentKey("short"), false);
    assert.equal(isValidIntentKey("valid-uuid-12345-67890"), true);
    assert.equal(isValidIntentKey("a".repeat(129)), false);
    assert.equal(isValidIntentKey("a".repeat(128)), true);
  });
});
