// Pure charge engine — no DB, safe to import in client components (POS
// live totals) and on the server (authoritative order creation).

export type ChargeScope = "ALL_ORDERS" | "DINE_IN_ONLY" | "TAKEAWAY_ONLY" | "DELIVERY_ONLY";
export type ChargeOrderType = "DINE_IN" | "TAKEAWAY" | "DELIVERY";

// Accepts numbers (client JSON), strings, or Prisma Decimals (server).
type Numeric = number | string | { toString(): string };

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

const round2 = (n: number) => Math.round(n * 100) / 100;

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
export function computeCharges({
  subtotal,
  discount,
  orderType,
  settings,
}: {
  subtotal: number;
  discount: number;
  orderType: ChargeOrderType;
  settings: ChargeSettings;
}): ChargeResult {
  const discountAmount = round2(Math.min(Math.max(discount, 0), subtotal));
  const afterDiscount = round2(subtotal - discountAmount);

  let serviceChargeAmount = 0;
  let serviceRateSnapshot = 0;
  if (settings.serviceChargeEnabled && scopeMatches(settings.applyServiceTo, orderType)) {
    if (settings.serviceChargeType === "PERCENTAGE") {
      const rate = Number(settings.serviceChargeRate) || 0;
      serviceChargeAmount = round2(afterDiscount * (rate / 100));
      serviceRateSnapshot = rate;
    } else {
      serviceChargeAmount = round2(Number(settings.serviceChargeFixedAmount) || 0);
    }
  }

  let taxAmount = 0;
  let taxRateSnapshot = 0;
  if (settings.taxEnabled && scopeMatches(settings.applyTaxTo, orderType)) {
    const rate = Number(settings.taxRate) || 0;
    taxAmount = round2((afterDiscount + serviceChargeAmount) * (rate / 100));
    taxRateSnapshot = rate;
  }

  return {
    subtotal: round2(subtotal),
    discountAmount,
    serviceChargeAmount,
    taxAmount,
    total: round2(afterDiscount + serviceChargeAmount + taxAmount),
    taxRateSnapshot,
    serviceRateSnapshot,
  };
}
