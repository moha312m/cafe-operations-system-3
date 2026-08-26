import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireKey, handleApiError, ApiError } from "@/lib/api";
import { unitPrice } from "@/lib/pricing";
import {
  configurationFinancials,
  sellableGate,
  resolveAddOnRecipe,
  type GateStatus,
} from "@/lib/recipes";

type NextAction = "CREATE_RECIPE" | "EDIT_RECIPE" | "CONFIRM" | "ENTER_COST" | null;

function nextActionFor(args: {
  costStatus: "AVAILABLE" | "RECIPE_INCOMPLETE" | "NOT_APPLICABLE";
  issues: string[];
  structurallyValid: boolean;
  confirmed: boolean;
}): NextAction {
  if (args.costStatus === "AVAILABLE" || args.costStatus === "NOT_APPLICABLE") return null;
  if (args.issues.includes("MISSING_COST")) return "ENTER_COST";
  if (args.structurallyValid && !args.confirmed) return "CONFIRM";
  if (args.issues.some((issue) => issue === "MISSING_RECIPE" || issue === "MISSING_VARIANT_RECIPE")) {
    return "CREATE_RECIPE";
  }
  return "EDIT_RECIPE";
}

// The recipe accuracy board.
//
// It lists SELLABLE CONFIGURATIONS rather than products, because that is what
// a customer buys and what stock is deducted against. A latte is not one row;
// a small, a medium and a large are three, and they can disagree about
// whether they are ready.
export async function GET(request: NextRequest) {
  try {
    // This board reports profit and margin, not just cost. "cost:read" is
    // satisfied by ANY of finance.view_revenue / finance.view_profit /
    // sales.view, so someone allowed to see turnover but explicitly denied
    // profit would still have passed it. Profitability needs the key that
    // actually means profitability.
    const session = await requireKey("finance.view_profit");
    const cafeId = session.cafeId;
    if (!cafeId) throw new ApiError(400, "المستخدم غير مرتبط بكافيه");

    // Costing follows one branch's own prices and stock, because that is what
    // a branch manager is answerable for. A pinned user never escapes theirs.
    const requestedBranchId = request.nextUrl.searchParams.get("branchId");
    const selectedBranchId = session.branchId ?? requestedBranchId ?? null;
    if (selectedBranchId) {
      const branch = await db.branch.findUnique({
        where: { id: selectedBranchId },
        select: { cafeId: true },
      });
      if (!branch || (session.role !== "SUPER_ADMIN" && branch.cafeId !== cafeId)) {
        throw new ApiError(403, "ليس لديك صلاحية على هذا الفرع");
      }
    }

    const [products, addOns] = await Promise.all([
      db.product.findMany({
        where: { cafeId, isActive: true },
        include: {
          variants: { where: { isActive: true }, orderBy: { sortOrder: "asc" } },
          category: { select: { name: true } },
          branchPrices: true,
        },
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
      sellingPrice: number; costStatus: "AVAILABLE" | "RECIPE_INCOMPLETE" | "NOT_APPLICABLE";
      cost: number | null; profit: number | null; margin: number | null; tier: string | null;
      nextAction: NextAction;
    };
    const rows: Row[] = [];
    for (const p of products) {
      // Prisma Decimals -> the plain shape the pricing helper expects.
      const priceable = {
        basePrice: Number(p.basePrice),
        branchPrices: p.branchPrices.map((bp) => ({
          branchId: bp.branchId,
          price: Number(bp.price),
        })),
      };
      const sellables = p.variants.length
        ? p.variants.map((v) => ({
            id: v.id as string | null,
            name: v.name,
            price: unitPrice(priceable, { price: Number(v.price) }, selectedBranchId),
          }))
        : [{ id: null as string | null, name: null, price: unitPrice(priceable, null, selectedBranchId) }];
      for (const s of sellables) {
        const [gate, financials] = await Promise.all([
          sellableGate(p.id, s.id),
          configurationFinancials({
            productId: p.id,
            variantId: s.id,
            sellingPrice: s.price,
            branchId: selectedBranchId,
          }),
        ]);
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
          recipeId: own?.id ?? (gate.source === "PRODUCT_DEFAULT_ALL_VARIANTS" ? dflt?.id ?? null : null),
          defaultRecipeId: dflt?.id ?? null,
          status: gate.status,
          source: gate.source,
          structurallyValid: gate.structurallyValid,
          confirmed: gate.confirmed,
          costAvailable: gate.costAvailable,
          varianceEligible: gate.status === "VERIFIED",
          sellingPrice: s.price,
          ...financials,
          issues: financials.issues,
          nextAction: nextActionFor({
            costStatus: financials.costStatus,
            issues: financials.issues,
            structurallyValid: gate.structurallyValid,
            confirmed: gate.confirmed,
          }),
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
      selectedBranchId,
      rows,
      addOns: addOnRows,
      summary: {
        products: products.length,
        sellableConfigurations: total,
        verified: count("VERIFIED"),
        incomplete: count("INCOMPLETE"),
        notApplicable: count("NOT_APPLICABLE"),
        costAvailable: rows.filter((r) => r.costStatus === "AVAILABLE").length,
        needsReview: rows.filter((r) => r.costStatus === "RECIPE_INCOMPLETE").length,
        varianceEligiblePct: total ? Math.round((count("VERIFIED") / total) * 100) : 0,
        addOnsTotal: addOnRows.length,
        addOnsVerified: addOnRows.filter((a) => a.status === "VERIFIED").length,
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
