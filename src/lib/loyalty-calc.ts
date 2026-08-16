// Pure loyalty math — safe for client (POS live preview) and server.

export type LoyaltyCalcSettings = {
  enabled: boolean;
  earnPointsPerAmount: number;
  earnAmountStep: number;
  pointValueAmount: number;
  minPointsToRedeem: number;
  maxRedeemPercentageOfOrder: number;
  earnOnPaidOrdersOnly: boolean;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

// floor(total / step) * pointsPerStep — e.g. 250 EGP @ 1pt/10EGP = 25 points.
export function computeEarnedPoints(
  total: number,
  s: Pick<LoyaltyCalcSettings, "earnPointsPerAmount" | "earnAmountStep">
): number {
  const step = Number(s.earnAmountStep);
  if (step <= 0 || total <= 0) return 0;
  return Math.floor(total / step) * Math.max(Number(s.earnPointsPerAmount), 0);
}

// EGP discount value of a number of points.
export function pointsValue(points: number, s: Pick<LoyaltyCalcSettings, "pointValueAmount">): number {
  return round2(points * Number(s.pointValueAmount));
}

// The most points a customer may redeem on an order, respecting balance,
// the minimum-to-redeem threshold and the max-%-of-order cap.
export function maxRedeemablePoints(
  balance: number,
  orderTotalBeforeLoyalty: number,
  s: LoyaltyCalcSettings
): number {
  if (!s.enabled || balance < s.minPointsToRedeem) return 0;
  const pointValue = Number(s.pointValueAmount);
  if (pointValue <= 0) return 0;
  const capAmount = round2((orderTotalBeforeLoyalty * s.maxRedeemPercentageOfOrder) / 100);
  const byCap = Math.floor(capAmount / pointValue);
  return Math.max(Math.min(balance, byCap), 0);
}

// Validates a requested redemption. Returns the discount amount or an
// Arabic error string.
export function validateRedemption(
  points: number,
  balance: number,
  orderTotalBeforeLoyalty: number,
  s: LoyaltyCalcSettings
): { ok: true; amount: number } | { ok: false; error: string } {
  if (!s.enabled) return { ok: false, error: "برنامج الولاء غير مفعل" };
  if (!Number.isInteger(points) || points <= 0)
    return { ok: false, error: "عدد النقاط غير صحيح" };
  if (points > balance) return { ok: false, error: "لا يوجد رصيد نقاط كافي" };
  if (points < s.minPointsToRedeem)
    return { ok: false, error: `أقل عدد نقاط للاستخدام هو ${s.minPointsToRedeem} نقطة` };
  const amount = pointsValue(points, s);
  const capAmount = round2((orderTotalBeforeLoyalty * s.maxRedeemPercentageOfOrder) / 100);
  if (amount > capAmount + 0.001)
    return { ok: false, error: `أقصى خصم بالنقاط هو ${s.maxRedeemPercentageOfOrder}٪ من الطلب` };
  return { ok: true, amount };
}
