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

export const round2 = (n: number) => Math.round(n * 100) / 100;

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
  return round2(effectiveBasePrice(product, branchId) - Number(product.basePrice));
}

export function unitPrice(
  product: Priceable,
  variant: { price: number | string } | null,
  branchId: string | null | undefined
): number {
  if (variant) {
    return round2(Number(variant.price) + branchShift(product, branchId));
  }
  return round2(effectiveBasePrice(product, branchId));
}
