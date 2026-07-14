// Types for the public customer QR menu (mobile-first, no auth).

export type MenuVariant = { id: string; name: string; price: string }; // absolute, branch-effective
export type MenuAddOn = { id: string; name: string; price: string };

export type MenuProduct = {
  id: string;
  name: string;
  description: string | null;
  basePrice: string;
  imageUrl: string | null;
  isAvailable: boolean;
  category: { id: string; name: string };
  variants: MenuVariant[];
  addOns: { addOn: MenuAddOn }[];
};

export type MenuData = {
  cafe: { name: string; currency: string; taxRate: number };
  branch: { id: string; name: string };
  categories: { id: string; name: string }[];
  products: MenuProduct[];
};

export type CustomerCartLine = {
  key: string;
  product: MenuProduct;
  variant: MenuVariant | null;
  addOns: MenuAddOn[];
  quantity: number;
  unitPrice: number;
  note: string;
};

export function customerLineKey(
  productId: string,
  variantId: string | null,
  addOnIds: string[],
  note: string
): string {
  return `${productId}|${variantId ?? ""}|${[...addOnIds].sort().join(",")}|${note.trim()}`;
}

export function customerUnitPrice(
  product: MenuProduct,
  variant: MenuVariant | null,
  addOns: MenuAddOn[]
): number {
  const raw =
    (variant ? Number(variant.price) : Number(product.basePrice)) +
    addOns.reduce((sum, a) => sum + Number(a.price), 0);
  return Math.round(raw * 100) / 100;
}

const CATEGORY_ICONS: [RegExp, string][] = [
  [/coffee|espresso|قهوة|قهوه/i, "☕"],
  [/tea|شاي/i, "🍵"],
  [/pastr|bak|dessert|sweet|مخبوزات|حلويات/i, "🥐"],
  [/sandwich|panini|food|ساندوتش|ساندويتش/i, "🥪"],
  [/juice|drink|smoothie|عصير|مشروبات/i, "🥤"],
];

export function menuCategoryIcon(name: string): string {
  for (const [pattern, icon] of CATEGORY_ICONS) {
    if (pattern.test(name)) return icon;
  }
  return "🍽️";
}
