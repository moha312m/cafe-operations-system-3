import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requirePermission, handleApiError, ApiError } from "@/lib/api";
import { sellableGate, resolveAddOnRecipe, type GateStatus } from "@/lib/recipes";

// The recipe accuracy board.
//
// It lists SELLABLE CONFIGURATIONS rather than products, because that is what
// a customer buys and what stock is deducted against. A latte is not one row;
// a small, a medium and a large are three, and they can disagree about
// whether they are ready.
export async function GET() {
  try {
    // Reading recipe accuracy exposes ingredient cost, so it sits behind the
    // same key the rest of the costing surfaces use.
    const session = await requirePermission("cost:read");
    const cafeId = session.cafeId;
    if (!cafeId) throw new ApiError(400, "المستخدم غير مرتبط بكافيه");

    const [products, addOns] = await Promise.all([
      db.product.findMany({
        where: { cafeId, isActive: true },
        include: { variants: { orderBy: { sortOrder: "asc" } }, category: { select: { name: true } } },
        orderBy: [{ name: "asc" }],
      }),
      db.addOn.findMany({ where: { cafeId, isActive: true }, orderBy: { name: "asc" } }),
    ]);

    type Row = {
      kind: "PRODUCT"; productId: string; productName: string; category: string | null;
      variantId: string | null; variantName: string | null;
      recipeId: string | null; defaultRecipeId: string | null;
      status: GateStatus; source: string; structurallyValid: boolean; confirmed: boolean;
      costAvailable: boolean; varianceEligible: boolean; issues: string[]; verifiedAt: Date | null;
    };
    const rows: Row[] = [];
    for (const p of products) {
      const sellables = p.variants.length
        ? p.variants.map((v) => ({ id: v.id as string | null, name: v.name }))
        : [{ id: null as string | null, name: null }];
      for (const s of sellables) {
        const gate = await sellableGate(p.id, s.id);
        // The row needs its own recipe id so the screen can edit or confirm
        // exactly the thing it is showing.
        const own = await db.recipe.findFirst({
          where: { productId: p.id, variantId: s.id },
          select: { id: true },
        });
        const dflt = await db.recipe.findFirst({
          where: { productId: p.id, variantId: null, addOnId: null },
          select: { id: true },
        });
        rows.push({
          kind: "PRODUCT" as const,
          productId: p.id,
          productName: p.name,
          category: p.category?.name ?? null,
          variantId: s.id,
          variantName: s.name,
          recipeId: own?.id ?? null,
          defaultRecipeId: dflt?.id ?? null,
          status: gate.status,
          source: gate.source,
          structurallyValid: gate.structurallyValid,
          confirmed: gate.confirmed,
          costAvailable: gate.costAvailable,
          varianceEligible: gate.status === "VERIFIED",
          issues: gate.issues,
          verifiedAt: gate.verifiedAt,
        });
      }
    }

    const addOnRows = [];
    for (const a of addOns) {
      const r = await resolveAddOnRecipe(a.id);
      const status: GateStatus =
        r.source === "NOT_APPLICABLE"
          ? "NOT_APPLICABLE"
          : r.source !== "NONE" && r.issues.length === 0 && r.confirmed
            ? "VERIFIED"
            : "INCOMPLETE";
      addOnRows.push({
        kind: "ADDON" as const,
        addOnId: a.id,
        addOnName: a.name,
        recipeId: r.recipeId,
        status,
        confirmed: r.confirmed,
        issues: r.source === "NONE" ? ["MISSING_ADDON_RECIPE"] : r.issues,
        verifiedAt: r.verifiedAt,
      });
    }

    const total = rows.length;
    const count = (s: GateStatus) => rows.filter((r) => r.status === s).length;
    return NextResponse.json({
      rows,
      addOns: addOnRows,
      summary: {
        products: products.length,
        sellableConfigurations: total,
        verified: count("VERIFIED"),
        incomplete: count("INCOMPLETE"),
        notApplicable: count("NOT_APPLICABLE"),
        varianceEligiblePct: total ? Math.round((count("VERIFIED") / total) * 100) : 0,
        addOnsTotal: addOnRows.length,
        addOnsVerified: addOnRows.filter((a) => a.status === "VERIFIED").length,
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
