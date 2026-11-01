import { decimal, money, type Numeric } from "@/lib/money";
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



// floor(total / step) * pointsPerStep — e.g. 250 EGP @ 1pt/10EGP = 25 points.
export function computeEarnedPoints(
  total: Numeric,
  s: { earnPointsPerAmount: number; earnAmountStep: Numeric }
): number {
  const step = decimal(s.earnAmountStep);
  if (step.lte(0) || decimal(total).lte(0)) return 0;
  return decimal(total).div(step).floor().times(Math.max(s.earnPointsPerAmount, 0)).toNumber();
}

// EGP discount value of a number of points.
export function pointsValue(points: number, s: Pick<LoyaltyCalcSettings, "pointValueAmount">): number {
  return pointsValueExact(points, s).toNumber();
}
export function pointsValueExact(points: number, s: { pointValueAmount: Numeric }) {
  return money(decimal(s.pointValueAmount).times(points));
}
export type ExactLoyaltySettings = Omit<LoyaltyCalcSettings, "earnAmountStep" | "pointValueAmount"> & { earnAmountStep: Numeric; pointValueAmount: Numeric };

// The most points a customer may redeem on an order, respecting balance,
// the minimum-to-redeem threshold and the max-%-of-order cap.
export function maxRedeemablePoints(
  balance: number,
  orderTotalBeforeLoyalty: number,
  s: LoyaltyCalcSettings
): number {
  if (!s.enabled || balance < s.minPointsToRedeem) return 0;
  const pointValue = decimal(s.pointValueAmount);
  if (pointValue.lte(0)) return 0;
  const capAmount = money(decimal(orderTotalBeforeLoyalty).times(s.maxRedeemPercentageOfOrder).div(100));
  const byCap = capAmount.div(pointValue).floor().toNumber();
  return Math.max(Math.min(balance, byCap), 0);
}

// Validates a requested redemption. Returns the discount amount or an
// Arabic error string.
export function validateRedemptionExact(
  points: number,
  balance: number,
  orderTotalBeforeLoyalty: Numeric,
  s: ExactLoyaltySettings
): { ok: true; amount: ReturnType<typeof money> } | { ok: false; error: string } {
  if (!s.enabled) return { ok: false, error: "برنامج الولاء غير مفعل" };
  if (!Number.isInteger(points) || points <= 0)
    return { ok: false, error: "عدد النقاط غير صحيح" };
  if (points > balance) return { ok: false, error: "لا يوجد رصيد نقاط كافي" };
  if (points < s.minPointsToRedeem)
    return { ok: false, error: `أقل عدد نقاط للاستخدام هو ${s.minPointsToRedeem} نقطة` };
  const amount = pointsValueExact(points, s);
  const capAmount = money(decimal(orderTotalBeforeLoyalty).times(s.maxRedeemPercentageOfOrder).div(100));
  if (amount.gt(capAmount))
    return { ok: false, error: `أقصى خصم بالنقاط هو ${s.maxRedeemPercentageOfOrder}٪ من الطلب` };
  return { ok: true, amount };
}

export function validateRedemption(points: number, balance: number, total: number, settings: LoyaltyCalcSettings): {ok:true;amount:number}|{ok:false;error:string} { const result=validateRedemptionExact(points,balance,total,settings); return result.ok ? {ok:true,amount:result.amount.toNumber()} : result; }
