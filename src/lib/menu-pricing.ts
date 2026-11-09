// ── Core Pricing Engine & Margin Math ──────────────────────────────────
// Pure calculation engine for cost-based menu pricing, rounding modes,
// profit/margin analysis, and preview security fingerprinting.

import { Decimal, decimal, type Numeric } from "@/lib/money";

export type RoundingMode = "NONE" | "NEAREST" | "UP";
export type MarginTier = "high" | "medium" | "low" | "loss";

export interface PricingCalculationResult {
  rawPrice: Decimal;
  suggestedPrice: Decimal;
  profit: Decimal;
  margin: Decimal;
  tier: MarginTier;
}

export function isValidMultiplier(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  try {
    const d = decimal(value as Numeric);
    return d.isFinite() && d.gt(0) && d.lte(100) && d.decimalPlaces() <= 3;
  } catch {
    return false;
  }
}

export function validateMultiplier(value: unknown): Decimal {
  if (value === null || value === undefined) {
    throw new RangeError("Multiplier is required");
  }
  const d = decimal(value as Numeric);
  if (!d.isFinite() || d.lte(0) || d.gt(100)) {
    throw new RangeError("Multiplier must be a finite positive number between 0 and 100");
  }
  if (d.decimalPlaces() > 3) {
    throw new RangeError("Multiplier cannot have more than 3 decimal places");
  }
  return d;
}

export function isValidRoundingStep(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  try {
    const d = decimal(value as Numeric);
    return d.isFinite() && d.gt(0) && d.lte(1000) && d.decimalPlaces() <= 2;
  } catch {
    return false;
  }
}

export function validateRoundingStep(value: unknown, mode: RoundingMode): Decimal | null {
  if (mode === "NONE") return null;
  if (value === null || value === undefined) {
    throw new RangeError(`Rounding step is required for mode ${mode}`);
  }
  const d = decimal(value as Numeric);
  if (!d.isFinite() || d.lte(0) || d.gt(1000)) {
    throw new RangeError("Rounding step must be a positive number up to 1000");
  }
  if (d.decimalPlaces() > 2) {
    throw new RangeError("Rounding step cannot have more than 2 decimal places");
  }
  return d;
}

/**
 * Calculates raw price = unitCost * multiplier
 */
export function calculateRawPrice(unitCost: Numeric, multiplier: Numeric): Decimal {
  const cost = decimal(unitCost);
  if (!cost.isFinite() || cost.lt(0)) {
    throw new RangeError("Unit cost must be a finite non-negative number");
  }
  const mult = validateMultiplier(multiplier);
  return cost.times(mult);
}

/**
 * Applies rounding according to the specified mode and increment step:
 * - NONE: exact half-up to 2 decimals (standard currency precision).
 * - NEAREST: step rounding with ties rounding toward positive infinity for nonnegative values.
 * - UP: mathematical ceiling to the step.
 */
export function applyRounding(
  rawPrice: Numeric,
  mode: RoundingMode,
  step?: Numeric | null
): Decimal {
  const raw = decimal(rawPrice);
  if (!raw.isFinite() || raw.lt(0)) {
    throw new RangeError("Price must be a finite non-negative number");
  }
  if (mode === "NONE") {
    return raw.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  }

  const s = validateRoundingStep(step, mode);
  if (!s) {
    throw new RangeError(`Rounding step is required for mode ${mode}`);
  }

  if (mode === "UP") {
    // Mathematical ceiling to step: ceil(raw / step) * step
    return raw.dividedBy(s).ceil().times(s).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  }

  if (mode === "NEAREST") {
    // Round to nearest multiple of step; ties round toward +infinity.
    // In Decimal, ROUND_HALF_UP for positive numbers rounds ties away from zero (towards +inf).
    return raw
      .dividedBy(s)
      .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
      .times(s)
      .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  }

  throw new Error(`Unsupported rounding mode: ${mode}`);
}

/**
 * Calculates profit and margin percentage:
 * - profit = sellingPrice - unitCost
 * - margin = (profit / sellingPrice) * 100
 * Tiers:
 * - high: >= 60%
 * - medium: 40% - 59.99%
 * - low: 20% - 39.99%
 * - loss: < 20%
 */
export function calculateMarginAndProfit(
  sellingPrice: Numeric,
  unitCost: Numeric
): {
  profit: Decimal;
  margin: Decimal;
  tier: MarginTier;
} {
  const price = decimal(sellingPrice).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const cost = decimal(unitCost).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  if (!price.isFinite() || !cost.isFinite()) {
    throw new RangeError("Price and cost must be finite numbers");
  }
  const profit = price.minus(cost);

  let margin = new Decimal(0);
  if (price.gt(0)) {
    margin = profit.dividedBy(price).times(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  }

  const m = margin.toNumber();
  let tier: MarginTier;
  if (m >= 60) {
    tier = "high";
  } else if (m >= 40) {
    tier = "medium";
  } else if (m >= 20) {
    tier = "low";
  } else {
    tier = "loss";
  }

  return { profit, margin, tier };
}

/**
 * Combines price suggestion and margin calculation into one unified result.
 */
export function suggestPrice(
  unitCost: Numeric,
  multiplier: Numeric,
  mode: RoundingMode = "NONE",
  step?: Numeric | null
): PricingCalculationResult {
  const rawPrice = calculateRawPrice(unitCost, multiplier);
  const suggestedPrice = applyRounding(rawPrice, mode, step);
  const { profit, margin, tier } = calculateMarginAndProfit(suggestedPrice, unitCost);

  return {
    rawPrice,
    suggestedPrice,
    profit,
    margin,
    tier,
  };
}


