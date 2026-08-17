import { db } from "@/lib/db";
import type { Branch, Cafe } from "@prisma/client";
import type { MenuData } from "@/components/customer-menu/types";
import { branchShift, round2 } from "@/lib/pricing";
import { getCafeSettings } from "@/lib/cafe-settings";
import { getBranchFinancialSettings } from "@/lib/financials";
import { getLoyaltySettingsSafe } from "@/lib/loyalty";

export type CustomerMenuResult =
  | { status: "ok"; menu: MenuData }
  | { status: "disabled" }
  | { status: "qr-disabled" } // qrMenuEnabled feature flag off
  | { status: "suspended" }
  | { status: "not-found" }
  | { status: "invalid-qr" } // /qr/[code] didn't resolve to a branch
  | { status: "error" }; // unexpected server failure — friendly page, never a crash

// Loads the public menu for a branch, exposing only customer-safe fields.
// NEVER throws: public QR pages must always render an Arabic message, so
// any unexpected failure resolves to { status: "error" }.
export async function loadCustomerMenu(
  branch: (Branch & { cafe: Cafe }) | null
): Promise<CustomerMenuResult> {
  try {
    return await loadCustomerMenuInner(branch);
  } catch (e) {
    console.error("customer menu load failed", e);
    return { status: "error" };
  }
}

async function loadCustomerMenuInner(
  branch: (Branch & { cafe: Cafe }) | null
): Promise<CustomerMenuResult> {
  if (!branch || !branch.isActive) {
    return { status: "not-found" };
  }
  // Cafe suspended by the platform owner — public menu goes dark.
  if (!branch.cafe.isActive) return { status: "suspended" };
  if (!branch.publicMenuEnabled) return { status: "disabled" };

  // Super-admin feature flag: the whole QR menu can be turned off per cafe.
  const settings = await getCafeSettings(branch.cafeId);
  if (!settings.qrMenuEnabled) return { status: "qr-disabled" };

  const [categories, products, finSettings] = await Promise.all([
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
    getBranchFinancialSettings(branch.id),
  ]);
  // Never crashes the public page — falls back to "loyalty disabled" when
  // the loyalty tables are unreachable (e.g. migration not applied yet).
  const loyalty = await getLoyaltySettingsSafe(branch.cafeId);

  return {
    status: "ok",
    menu: {
      cafe: {
        name: branch.cafe.name,
        currency: branch.cafe.currency,
        taxRate: Number(branch.cafe.taxRate),
      },
      branch: { id: branch.id, name: branch.name },
      features: {
        aiAssistant: settings.aiAssistantEnabled,
        enableTables: settings.enableTables,
      },
      // Same settings + order type the QR order route uses, so the totals the
      // customer sees (service + tax) match the server-computed order exactly.
      charges: {
        taxEnabled: finSettings.taxEnabled,
        taxRate: Number(finSettings.taxRate),
        applyTaxTo: finSettings.applyTaxTo,
        serviceChargeEnabled: finSettings.serviceChargeEnabled,
        serviceChargeType: finSettings.serviceChargeType,
        serviceChargeRate: Number(finSettings.serviceChargeRate),
        serviceChargeFixedAmount: Number(finSettings.serviceChargeFixedAmount),
        applyServiceTo: finSettings.applyServiceTo,
      },
      orderType:
        settings.workflowMode === "TAKEAWAY_ONLY" || !settings.enableTables
          ? "TAKEAWAY"
          : "DINE_IN",
      loyalty: {
        enabled: loyalty.enabled,
        phoneRequired: loyalty.enabled && loyalty.customerPhoneRequiredForQr,
        earnPointsPerAmount: loyalty.earnPointsPerAmount,
        earnAmountStep: Number(loyalty.earnAmountStep),
      },
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

const UNAVAILABLE_COPY: Record<
  "disabled" | "qr-disabled" | "suspended" | "not-found" | "invalid-qr" | "error",
  { title: string; sub: string }
> = {
  disabled: { title: "المنيو غير متاح حاليًا", sub: "اسأل الويتر أو اطلب من الكاشير مباشرة." },
  "qr-disabled": { title: "منيو QR غير متاح حاليًا", sub: "اطلب من الكاشير مباشرة." },
  suspended: { title: "المنيو غير متاح حاليًا", sub: "الكافيه ده متوقف مؤقتًا." },
  "not-found": { title: "الرابط ده مش صحيح", sub: "اتأكد من الكود اللي على الترابيزة." },
  "invalid-qr": { title: "رابط QR غير صحيح أو غير مفعل", sub: "اتأكد من الكود اللي على الترابيزة أو اسأل الويتر." },
  error: { title: "حصل خطأ مؤقت", sub: "جرب تاني بعد لحظات، أو اطلب من الكاشير مباشرة." },
};

export function MenuUnavailable({
  reason,
}: {
  reason: keyof typeof UNAVAILABLE_COPY;
}) {
  const copy = UNAVAILABLE_COPY[reason] ?? UNAVAILABLE_COPY.error;
  return (
    <main className="flex min-h-dvh items-center justify-center bg-muted/40 p-6">
      <div className="max-w-sm space-y-2 rounded-2xl border bg-card p-8 text-center shadow-sm">
        <p className="text-4xl">☕</p>
        <p className="text-lg font-semibold">{copy.title}</p>
        <p className="text-sm text-muted-foreground">{copy.sub}</p>
      </div>
    </main>
  );
}
