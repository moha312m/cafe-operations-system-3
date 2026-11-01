// Exact integer arithmetic for cost valuation, on bigint only.
//
// Quantities are counted in thousandths, unit costs in millionths and line
// totals in cents, so every step is an integer product, sum or quotient and
// nothing here can lose a digit to floating point. These helpers do arithmetic
// and nothing else: no input parsing, range limits, error mapping or
// formatting, and no rule about unknown or free cost.
//
// The project targets ES2017, which has no bigint literals, so constants are
// built with BigInt(...).

const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);
// quantity (10^-3) x unit cost (10^-6) is in 10^-9 currency units; one cent is 10^7 of them.
const CENT_DIVISOR = BigInt("10000000");

/**
 * numerator / denominator rounded to the nearest integer, an exact tie going
 * away from zero. Works for any signs and any size. A zero denominator is a
 * RangeError.
 */
export function roundHalf(numerator: bigint, denominator: bigint): bigint {
  if (denominator === ZERO) throw new RangeError("roundHalf: the denominator must not be zero");
  // Divide magnitudes (bigint division truncates toward zero), then restore the sign.
  const negative = (numerator < ZERO) !== (denominator < ZERO);
  const n = numerator < ZERO ? -numerator : numerator;
  const d = denominator < ZERO ? -denominator : denominator;
  const quotient = n / d;
  const remainder = n % d;
  // remainder / d >= 1/2 exactly when 2 x remainder >= d; equality is the tie.
  const rounded = remainder * TWO >= d ? quotient + ONE : quotient;
  return negative ? -rounded : rounded;
}

/**
 * The value of a line in cents: quantity (thousandths) x unit cost
 * (millionths), rounded half away from zero. The sign of the product is
 * kept; callers apply their own movement-sign conventions.
 */
export function lineTotalCents(quantityMilli: bigint, unitCostMicro: bigint): bigint {
  return roundHalf(quantityMilli * unitCostMicro, CENT_DIVISOR);
}

/**
 * The weighted average unit cost in millionths after adding a receipt:
 * (oldQuantity x oldCost + newQuantity x newCost) / (oldQuantity + newQuantity).
 * When the combined quantity is zero or negative there is nothing to weigh,
 * and the incoming cost is returned unchanged. Quantities and costs may be
 * negative. Each call stands alone: a caller valuing several lines applies
 * it line by line.
 */
export function weightedAverageMicro(
  oldQuantityMilli: bigint,
  oldCostMicro: bigint,
  newQuantityMilli: bigint,
  newCostMicro: bigint,
): bigint {
  const combinedQuantity = oldQuantityMilli + newQuantityMilli;
  if (combinedQuantity <= ZERO) return newCostMicro;
  return roundHalf(oldQuantityMilli * oldCostMicro + newQuantityMilli * newCostMicro, combinedQuantity);
}
