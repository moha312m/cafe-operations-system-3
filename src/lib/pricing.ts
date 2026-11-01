// Pure pricing math shared by the server (order creation, customer
// menu loader) and the client (POS display). One rule everywhere:
//
//   effectiveBase  = branch override ?? basePrice
//   shift          = effectiveBase − basePrice
//   unit price     = variant ? variant.price + shift : effectiveBase
//   line total     = (unit + Σ add-ons) × quantity
//
// The shift means a branch override moves ALL variant prices of that
// product by the same amount, so one override per branch is enough.

import { decimal, money } from "@/lib/money";
export const round2 = (n: number) => money(n).toNumber();

type Priceable = {
  basePrice: number | string;
  branchPrices?: { branchId: string; price: number | string }[];
};

export function effectiveBasePrice(
  product: Priceable,
  branchId: string | null | undefined
): number {
  const base = Number(product.basePrice);
  if (!branchId) return base;
  const override = product.branchPrices?.find((bp) => bp.branchId === branchId);
  return override ? Number(override.price) : base;
}

export function branchShift(
  product: Priceable,
  branchId: string | null | undefined
): number {
  return money(decimal(effectiveBasePrice(product, branchId)).minus(decimal(product.basePrice))).toNumber();
}

export function unitPrice(
  product: Priceable,
  variant: { price: number | string } | null,
  branchId: string | null | undefined
): number {
  return unitPriceExact(product, variant, branchId).toNumber();
}

export function unitPriceExact(product: Priceable, variant: { price: number | string } | null, branchId: string | null | undefined) {
  const base = decimal(product.basePrice);
  const override = product.branchPrices?.find(bp => bp.branchId === branchId);
  const effective = override ? decimal(override.price) : base;
  return money(variant ? decimal(variant.price).plus(effective.minus(base)) : effective);
}
