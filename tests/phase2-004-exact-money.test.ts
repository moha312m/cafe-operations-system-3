import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCharges } from "@/lib/charges";
import { computeEarnedPoints, validateRedemption } from "@/lib/loyalty-calc";

test("tax at a cent boundary rounds half up before adding to the total", () => {
  const result = computeCharges({ subtotal: 0.29, discount: 0, orderType: "TAKEAWAY", settings: {
    taxEnabled: true, taxRate: 50, applyTaxTo: "ALL_ORDERS", serviceChargeEnabled: false,
    serviceChargeType: "PERCENTAGE", serviceChargeRate: 0, serviceChargeFixedAmount: 0, applyServiceTo: "ALL_ORDERS",
  } });
  assert.equal(result.taxAmount, 0.15);
  assert.equal(result.total, 0.44);
});

test("earned points use exact division at a monetary step boundary", () => {
  assert.equal(computeEarnedPoints(0.3, { earnAmountStep: 0.1, earnPointsPerAmount: 1 }), 3);
});

test("loyalty percentage cap uses the same exact currency rounding", () => {
  assert.deepEqual(validateRedemption(15, 15, 0.29, {
    enabled: true, earnPointsPerAmount: 1, earnAmountStep: 0.1, pointValueAmount: 0.01,
    minPointsToRedeem: 1, maxRedeemPercentageOfOrder: 50, earnOnPaidOrdersOnly: true,
  }), { ok: true, amount: 0.15 });
});

import { tenderVariance } from "@/lib/tender-settlement";

test("processor settlement rounds decimal half cents consistently", () => {
  assert.equal(tenderVariance(0.145, 0), 0.15);
});
