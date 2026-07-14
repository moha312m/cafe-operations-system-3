// Shared types for the POS screen. API prices arrive as strings
// (Prisma Decimal serialization); convert with Number() at the edges.

export type Variant = {
  id: string;
  name: string;
  price: string; // absolute سعر الحجم
  isActive: boolean;
};

export type AddOn = {
  id: string;
  name: string;
  price: string;
  isActive: boolean;
};

export type Product = {
  id: string;
  name: string;
  description: string | null;
  basePrice: string;
  isActive: boolean;
  isAvailable?: boolean; // false = out of stock, disabled everywhere
  showInPOS?: boolean;
  category: { id: string; name: string };
  variants: Variant[];
  addOns: { addOn: AddOn }[];
  branchPrices?: { branchId: string; price: string }[];
};

export type Category = { id: string; name: string; isActive: boolean };

export type Branch = { id: string; name: string };

export type CartLine = {
  key: string; // product|variant|addOns|note — identical configs merge
  product: Product;
  variant: Variant | null;
  addOns: AddOn[];
  quantity: number;
  unitPrice: number; // base + variant delta + add-ons, per unit
  note: string;
};

export type OrderType = "DINE_IN" | "TAKEAWAY" | "DELIVERY";

export type PaymentMethod = "CASH" | "CARD" | "WALLET" | "MIXED";
export type SplitMethod = "CASH" | "CARD" | "WALLET";

export function lineKey(
  productId: string,
  variantId: string | null,
  addOnIds: string[],
  note: string
): string {
  return `${productId}|${variantId ?? ""}|${[...addOnIds].sort().join(",")}|${note.trim()}`;
}

export function computeUnitPrice(
  product: Product,
  variant: Variant | null,
  addOns: AddOn[]
): number {
  return (
    (variant ? Number(variant.price) : Number(product.basePrice)) +
    addOns.reduce((sum, a) => sum + Number(a.price), 0)
  );
}

// Category name → tile emoji for the image placeholder.
const CATEGORY_ICONS: [RegExp, string][] = [
  [/coffee|espresso|قهوة|قهوه/i, "☕"],
  [/tea|شاي/i, "🍵"],
  [/pastr|bak|dessert|sweet|مخبوزات|حلويات/i, "🥐"],
  [/sandwich|panini|food|ساندوتش|ساندويتش/i, "🥪"],
  [/juice|drink|smoothie|عصير|مشروبات/i, "🥤"],
];

export function categoryIcon(name: string): string {
  for (const [pattern, icon] of CATEGORY_ICONS) {
    if (pattern.test(name)) return icon;
  }
  return "🍽️";
}
