import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  calculateRawPrice,
  applyRounding,
  calculateMarginAndProfit,
  suggestPrice,
  isValidMultiplier,
  isValidRoundingStep,
} from "@/lib/menu-pricing";
import {
  generatePreviewFingerprint,
  verifyPreviewFingerprint,
  type PreviewFingerprintPayload,
} from "@/lib/menu-pricing-fingerprint";

describe("Pricing Engine - calculateRawPrice", () => {
  test("calculates raw price from unit cost and multiplier", () => {
    // Basic scenario: 16.25 * 2 = 32.50
    const res1 = calculateRawPrice(16.25, 2);
    assert.equal(res1.toFixed(2), "32.50");

    // Fractional multiplier: 16.25 * 2.5 = 40.625
    const res2 = calculateRawPrice(16.25, 2.5);
    assert.equal(res2.toFixed(3), "40.625");

    // Multiplier with 3 decimal places
    const res3 = calculateRawPrice(10, 2.125);
    assert.equal(res3.toFixed(3), "21.250");

    // Boundary multiplier 100
    const res4 = calculateRawPrice(5, 100);
    assert.equal(res4.toFixed(2), "500.00");

    // Zero cost is valid (raw price = 0)
    const res5 = calculateRawPrice(0, 2.5);
    assert.equal(res5.toFixed(2), "0.00");
  });

  test("rejects invalid multipliers and negative costs", () => {
    // Negative cost
    assert.throws(() => calculateRawPrice(-5, 2), RangeError);
    assert.throws(() => calculateRawPrice(Number.NEGATIVE_INFINITY, 2), RangeError);

    // Multiplier <= 0
    assert.throws(() => calculateRawPrice(10, 0), RangeError);
    assert.throws(() => calculateRawPrice(10, -2), RangeError);

    // Multiplier > 100
    assert.throws(() => calculateRawPrice(10, 100.001), RangeError);
    assert.throws(() => calculateRawPrice(10, 105), RangeError);

    // Multiplier with more than 3 decimal places
    assert.throws(() => calculateRawPrice(10, 2.1234), RangeError);

    // NaN / Infinity
    assert.throws(() => calculateRawPrice(10, Number.NaN), RangeError);
    assert.throws(() => calculateRawPrice(10, Number.POSITIVE_INFINITY), RangeError);
    assert.throws(() => calculateRawPrice(Number.NaN, 2), RangeError);
    assert.throws(() => calculateRawPrice(Number.POSITIVE_INFINITY, 2), RangeError);
  });

  test("isValidMultiplier helper validates properly", () => {
    assert.equal(isValidMultiplier(2), true);
    assert.equal(isValidMultiplier(2.5), true);
    assert.equal(isValidMultiplier(3.125), true);
    assert.equal(isValidMultiplier(100), true);
    assert.equal(isValidMultiplier(0.001), true);

    assert.equal(isValidMultiplier(0), false);
    assert.equal(isValidMultiplier(-1), false);
    assert.equal(isValidMultiplier(100.001), false);
    assert.equal(isValidMultiplier(2.1234), false);
    assert.equal(isValidMultiplier(null), false);
    assert.equal(isValidMultiplier("invalid"), false);
  });
});

describe("Pricing Engine - applyRounding", () => {
  test("mode NONE: rounds half-up to 2 decimal places", () => {
    assert.equal(applyRounding(32.5, "NONE").toFixed(2), "32.50");
    assert.equal(applyRounding(32.505, "NONE").toFixed(2), "32.51");
    assert.equal(applyRounding(32.504, "NONE").toFixed(2), "32.50");
    assert.equal(applyRounding(16.25, "NONE").toFixed(2), "16.25");
  });

  test("mode UP: mathematical ceiling to step", () => {
    // Step 5: 32.50 -> 35.00
    assert.equal(applyRounding(32.5, "UP", 5).toFixed(2), "35.00");
    // Exact multiple 30.00 -> 30.00
    assert.equal(applyRounding(30.0, "UP", 5).toFixed(2), "30.00");
    // Just above multiple 30.01 -> 35.00
    assert.equal(applyRounding(30.01, "UP", 5).toFixed(2), "35.00");
    // Just below multiple 34.99 -> 35.00
    assert.equal(applyRounding(34.99, "UP", 5).toFixed(2), "35.00");

    // Step 1: 32.10 -> 33.00, 32.00 -> 32.00
    assert.equal(applyRounding(32.1, "UP", 1).toFixed(2), "33.00");
    assert.equal(applyRounding(32.0, "UP", 1).toFixed(2), "32.00");

    // Step 10: 32.50 -> 40.00, 30.00 -> 30.00
    assert.equal(applyRounding(32.5, "UP", 10).toFixed(2), "40.00");
    assert.equal(applyRounding(30.0, "UP", 10).toFixed(2), "30.00");
  });

  test("mode NEAREST: step rounding with ties rounding to positive infinity", () => {
    // Step 5: 32.50 is an exact tie (32.5 / 5 = 6.5) -> rounds to 7 -> 35.00
    assert.equal(applyRounding(32.5, "NEAREST", 5).toFixed(2), "35.00");
    // Just below tie 32.49 -> 30.00
    assert.equal(applyRounding(32.49, "NEAREST", 5).toFixed(2), "30.00");
    // Just above tie 32.51 -> 35.00
    assert.equal(applyRounding(32.51, "NEAREST", 5).toFixed(2), "35.00");
    // Another tie: 37.50 / 5 = 7.5 -> rounds to 8 -> 40.00
    assert.equal(applyRounding(37.5, "NEAREST", 5).toFixed(2), "40.00");

    // Step 1: 32.50 tie -> 33.00
    assert.equal(applyRounding(32.5, "NEAREST", 1).toFixed(2), "33.00");
    assert.equal(applyRounding(32.49, "NEAREST", 1).toFixed(2), "32.00");

    // Step 10: 35.00 tie -> 40.00
    assert.equal(applyRounding(35.0, "NEAREST", 10).toFixed(2), "40.00");
    assert.equal(applyRounding(34.99, "NEAREST", 10).toFixed(2), "30.00");

    // Step 0.5: 32.25 tie -> 32.50
    assert.equal(applyRounding(32.25, "NEAREST", 0.5).toFixed(2), "32.50");
    assert.equal(applyRounding(32.24, "NEAREST", 0.5).toFixed(2), "32.00");
  });

  test("validates rounding step correctly", () => {
    // Missing step for NEAREST / UP throws
    assert.throws(() => applyRounding(32.5, "NEAREST", null), RangeError);
    assert.throws(() => applyRounding(32.5, "UP", undefined), RangeError);

    // Negative or non-finite price throws
    assert.throws(() => applyRounding(-5, "NONE"), RangeError);
    assert.throws(() => applyRounding(Number.NEGATIVE_INFINITY, "NONE"), RangeError);
    assert.throws(() => applyRounding(Number.NaN, "NONE"), RangeError);
    assert.throws(() => applyRounding(Number.POSITIVE_INFINITY, "NONE"), RangeError);

    // Negative or zero step throws
    assert.throws(() => applyRounding(32.5, "NEAREST", 0), RangeError);
    assert.throws(() => applyRounding(32.5, "UP", -1), RangeError);

    // Step with > 2 decimal places throws
    assert.throws(() => applyRounding(32.5, "NEAREST", 1.234), RangeError);

    // isValidRoundingStep helper
    assert.equal(isValidRoundingStep(1), true);
    assert.equal(isValidRoundingStep(0.5), true);
    assert.equal(isValidRoundingStep(5), true);
    assert.equal(isValidRoundingStep(10), true);
    assert.equal(isValidRoundingStep(0), false);
    assert.equal(isValidRoundingStep(-5), false);
    assert.equal(isValidRoundingStep(1.234), false);
    assert.equal(isValidRoundingStep(null), false);
  });
});

describe("Pricing Engine - calculateMarginAndProfit", () => {
  test("calculates profit and margin percentage accurately", () => {
    // Price 100, cost 40 -> profit 60, margin 60%
    const res1 = calculateMarginAndProfit(100, 40);
    assert.equal(res1.profit.toFixed(2), "60.00");
    assert.equal(res1.margin.toFixed(2), "60.00");
    assert.equal(res1.tier, "high");

    // Price 35, cost 16.25 -> profit 18.75, margin 53.57%
    const res2 = calculateMarginAndProfit(35, 16.25);
    assert.equal(res2.profit.toFixed(2), "18.75");
    assert.equal(res2.margin.toFixed(2), "53.57");
    assert.equal(res2.tier, "medium");
  });

  test("margin tiers classification (high, medium, low, loss)", () => {
    // High tier: >= 60%
    assert.equal(calculateMarginAndProfit(100, 35).tier, "high"); // 65%
    assert.equal(calculateMarginAndProfit(100, 40).tier, "high"); // 60% (boundary)

    // Medium tier: 40% - 59.99%
    assert.equal(calculateMarginAndProfit(100, 40.01).tier, "medium"); // 59.99%
    assert.equal(calculateMarginAndProfit(100, 50).tier, "medium"); // 50%
    assert.equal(calculateMarginAndProfit(100, 60).tier, "medium"); // 40% (boundary)

    // Low tier: 20% - 39.99%
    assert.equal(calculateMarginAndProfit(100, 60.01).tier, "low"); // 39.99%
    assert.equal(calculateMarginAndProfit(100, 75).tier, "low"); // 25%
    assert.equal(calculateMarginAndProfit(100, 80).tier, "low"); // 20% (boundary)

    // Loss / weak tier: < 20%
    assert.equal(calculateMarginAndProfit(100, 80.01).tier, "loss"); // 19.99%
    assert.equal(calculateMarginAndProfit(100, 95).tier, "loss"); // 5%
    assert.equal(calculateMarginAndProfit(100, 110).tier, "loss"); // -10% (negative profit)
    assert.equal(calculateMarginAndProfit(0, 50).tier, "loss"); // 0 selling price
  });
});

describe("Pricing Engine - suggestPrice integration", () => {
  test("computes full suggestions matching approved specs", () => {
    // Specs example: 16.25 * 2 = 32.50
    const none = suggestPrice(16.25, 2, "NONE");
    assert.equal(none.rawPrice.toFixed(2), "32.50");
    assert.equal(none.suggestedPrice.toFixed(2), "32.50");
    assert.equal(none.profit.toFixed(2), "16.25");
    assert.equal(none.margin.toFixed(2), "50.00");
    assert.equal(none.tier, "medium");

    // Specs example: UP to 5 -> 35.00
    const up = suggestPrice(16.25, 2, "UP", 5);
    assert.equal(up.rawPrice.toFixed(2), "32.50");
    assert.equal(up.suggestedPrice.toFixed(2), "35.00");
    assert.equal(up.profit.toFixed(2), "18.75");
    assert.equal(up.margin.toFixed(2), "53.57");
    assert.equal(up.tier, "medium");

    // Specs example: NEAREST to 5 at 32.50 -> 35.00
    const nearest = suggestPrice(16.25, 2, "NEAREST", 5);
    assert.equal(nearest.rawPrice.toFixed(2), "32.50");
    assert.equal(nearest.suggestedPrice.toFixed(2), "35.00");
  });
});

describe("Pricing Engine - Preview Fingerprint", () => {
  const samplePayload: PreviewFingerprintPayload = {
    cafeId: "cafe_123",
    referenceBranchId: "branch_main",
    multiplier: 2.5,
    roundingMode: "NEAREST",
    roundingStep: 5,
    items: [
      {
        targetType: "PRODUCT",
        targetId: "prod_1",
        unitCost: 15.0,
        suggestedPrice: 40.0,
      },
      {
        targetType: "VARIANT",
        targetId: "var_2",
        unitCost: 20.0,
        suggestedPrice: 50.0,
      },
    ],
  };

  test("generates deterministic SHA-256 fingerprint regardless of item array order", () => {
    const fp1 = generatePreviewFingerprint(samplePayload);
    assert.equal(typeof fp1, "string");
    assert.equal(fp1.length, 64); // SHA-256 hex string

    // Inverted items order
    const payloadReversed: PreviewFingerprintPayload = {
      ...samplePayload,
      items: [samplePayload.items[1], samplePayload.items[0]],
    };
    const fp2 = generatePreviewFingerprint(payloadReversed);
    assert.equal(fp1, fp2);
  });

  test("fingerprint changes when any critical input is modified", () => {
    const baseline = generatePreviewFingerprint(samplePayload);

    // Multiplier change
    assert.notEqual(
      generatePreviewFingerprint({ ...samplePayload, multiplier: 2.0 }),
      baseline
    );

    // Mode change
    assert.notEqual(
      generatePreviewFingerprint({ ...samplePayload, roundingMode: "UP" }),
      baseline
    );

    // Branch change
    assert.notEqual(
      generatePreviewFingerprint({ ...samplePayload, referenceBranchId: "branch_other" }),
      baseline
    );

    // Item cost change
    assert.notEqual(
      generatePreviewFingerprint({
        ...samplePayload,
        items: [{ ...samplePayload.items[0], unitCost: 16.0 }, samplePayload.items[1]],
      }),
      baseline
    );

    // Item suggestedPrice change
    assert.notEqual(
      generatePreviewFingerprint({
        ...samplePayload,
        items: [{ ...samplePayload.items[0], suggestedPrice: 45.0 }, samplePayload.items[1]],
      }),
      baseline
    );
  });

  test("verifyPreviewFingerprint accurately validates fingerprints", () => {
    const validFp = generatePreviewFingerprint(samplePayload);
    assert.equal(verifyPreviewFingerprint(validFp, samplePayload), true);

    // Tampered payload
    assert.equal(
      verifyPreviewFingerprint(validFp, { ...samplePayload, multiplier: 3.0 }),
      false
    );

    // Tampered fingerprint
    assert.equal(verifyPreviewFingerprint("invalid_hash", samplePayload), false);
    assert.equal(verifyPreviewFingerprint("", samplePayload), false);
  });
});
