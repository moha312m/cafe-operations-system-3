// Pure charge engine — no DB, safe to import in client components (POS
// live totals) and on the server (authoritative order creation).
import { decimal, money, moneyMin, moneyMax, type Numeric } from "@/lib/money";

export type ChargeScope = "ALL_ORDERS" | "DINE_IN_ONLY" | "TAKEAWAY_ONLY" | "DELIVERY_ONLY";
export type ChargeOrderType = "DINE_IN" | "TAKEAWAY" | "DELIVERY";

// Accepts numbers (client JSON), strings, or Prisma Decimals (server).

export type ChargeSettings = {
  taxEnabled: boolean;
  taxRate: Numeric;
  applyTaxTo: ChargeScope;
  serviceChargeEnabled: boolean;
  serviceChargeType: "PERCENTAGE" | "FIXED";
  serviceChargeRate: Numeric;
  serviceChargeFixedAmount: Numeric;
  applyServiceTo: ChargeScope;
};

export type ChargeResult = {
  subtotal: number;
  discountAmount: number;
  serviceChargeAmount: number;
  taxAmount: number;
  total: number;
  taxRateSnapshot: number;
  serviceRateSnapshot: number;
};


function scopeMatches(scope: ChargeScope, orderType: ChargeOrderType): boolean {
  switch (scope) {
    case "ALL_ORDERS":
      return true;
    case "DINE_IN_ONLY":
      return orderType === "DINE_IN";
    case "TAKEAWAY_ONLY":
      return orderType === "TAKEAWAY";
    case "DELIVERY_ONLY":
      return orderType === "DELIVERY";
  }
}

// Tax applies AFTER service (service is part of the taxable base).
export function computeChargesExact({
  subtotal,
  discount,
  orderType,
  settings,
}: {
  subtotal: Numeric;
  discount: Numeric;
  orderType: ChargeOrderType;
  settings: ChargeSettings;
}) {
  const discountAmount = money(moneyMin(moneyMax(discount, 0), subtotal));
  const afterDiscount = money(decimal(subtotal).minus(discountAmount));

  let serviceChargeAmount = decimal(0);
  let serviceRateSnapshot = decimal(0);
  if (settings.serviceChargeEnabled && scopeMatches(settings.applyServiceTo, orderType)) {
    if (settings.serviceChargeType === "PERCENTAGE") {
      const rate = decimal(settings.serviceChargeRate);
      serviceChargeAmount = money(afterDiscount.times(rate).div(100));
      serviceRateSnapshot = rate;
    } else {
      serviceChargeAmount = money(settings.serviceChargeFixedAmount);
    }
  }

  let taxAmount = decimal(0);
  let taxRateSnapshot = decimal(0);
  if (settings.taxEnabled && scopeMatches(settings.applyTaxTo, orderType)) {
    const rate = decimal(settings.taxRate);
    taxAmount = money(afterDiscount.plus(serviceChargeAmount).times(rate).div(100));
    taxRateSnapshot = rate;
  }

  return {
    subtotal: money(subtotal),
    discountAmount,
    serviceChargeAmount,
    taxAmount,
    total: money(afterDiscount.plus(serviceChargeAmount).plus(taxAmount)),
    taxRateSnapshot,
    serviceRateSnapshot,
  };
}

export function computeCharges(args: Parameters<typeof computeChargesExact>[0]): ChargeResult {
  const result = computeChargesExact(args);
  return Object.fromEntries(Object.entries(result).map(([key, value]) => [key, value.toNumber()])) as ChargeResult;
}
