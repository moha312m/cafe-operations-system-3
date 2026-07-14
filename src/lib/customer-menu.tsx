import { db } from "@/lib/db";
import type { Branch, Cafe } from "@prisma/client";
import type { MenuData } from "@/components/customer-menu/types";
import { branchShift, round2 } from "@/lib/pricing";

export type CustomerMenuResult =
  | { status: "ok"; menu: MenuData }
  | { status: "disabled" }
  | { status: "not-found" };

// Loads the public menu for a branch, exposing only customer-safe
// fields. Prices are already branch-effective (base override applied,
// variant prices shifted), so the client never does pricing math
// beyond summing add-ons.
export async function loadCustomerMenu(
  branch: (Branch & { cafe: Cafe }) | null
): Promise<CustomerMenuResult> {
  if (!branch || !branch.isActive || !branch.cafe.isActive) {
    return { status: "not-found" };
  }
  if (!branch.publicMenuEnabled) return { status: "disabled" };

  const [categories, products] = await Promise.all([
    db.menuCategory.findMany({
      where: {
        cafeId: branch.cafeId,
        isActive: true,
        showInCustomerMenu: true, // hidden categories hide their products too
      },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { id: true, name: true },
    }),
    db.product.findMany({
      where: {
        cafeId: branch.cafeId,
        isActive: true,
        showInCustomerMenu: true,
        category: { isActive: true, showInCustomerMenu: true },
      },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: {
        id: true,
        name: true,
        description: true,
        basePrice: true,
        imageUrl: true,
        isAvailable: true,
        category: { select: { id: true, name: true } },
        branchPrices: {
          where: { branchId: branch.id },
          select: { branchId: true, price: true },
        },
        variants: {
          where: { isActive: true },
          select: { id: true, name: true, price: true },
          orderBy: [{ sortOrder: "asc" }, { price: "asc" }],
        },
        addOns: {
          where: { addOn: { isActive: true } },
          select: { addOn: { select: { id: true, name: true, price: true } } },
        },
      },
    }),
  ]);

  return {
    status: "ok",
    menu: {
      cafe: {
        name: branch.cafe.name,
        currency: branch.cafe.currency,
        taxRate: Number(branch.cafe.taxRate),
      },
      branch: { id: branch.id, name: branch.name },
      categories,
      products: products.map((p) => {
        const priceable = {
          basePrice: p.basePrice.toString(),
          branchPrices: p.branchPrices.map((bp) => ({
            branchId: bp.branchId,
            price: bp.price.toString(),
          })),
        };
        const shift = branchShift(priceable, branch.id);
        return {
          id: p.id,
          name: p.name,
          description: p.description,
          imageUrl: p.imageUrl,
          isAvailable: p.isAvailable,
          category: p.category,
          basePrice: round2(Number(p.basePrice) + shift).toString(),
          variants: p.variants.map((v) => ({
            id: v.id,
            name: v.name,
            price: round2(Number(v.price) + shift).toString(),
          })),
          addOns: p.addOns.map((a) => ({
            addOn: { ...a.addOn, price: a.addOn.price.toString() },
          })),
        };
      }),
    },
  };
}

export function MenuUnavailable({ reason }: { reason: "disabled" | "not-found" }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/40 p-6">
      <div className="max-w-sm space-y-2 rounded-2xl border bg-card p-8 text-center shadow-sm">
        <p className="text-4xl">☕</p>
        <p className="text-lg font-semibold">
          {reason === "disabled" ? "المنيو غير متاح حاليًا" : "الرابط ده مش صحيح"}
        </p>
        <p className="text-sm text-muted-foreground">
          {reason === "disabled"
            ? "اسأل الويتر أو اطلب من الكاشير مباشرة."
            : "اتأكد من الكود اللي على الترابيزة."}
        </p>
      </div>
    </main>
  );
}
