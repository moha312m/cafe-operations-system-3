import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireKey, resolveCafeId, handleApiError, ApiError, resolveReadScope } from "@/lib/api";
import { configurationFinancials } from "@/lib/recipes";

// تقرير تكلفة المنتجات — cost, profit, margin, and profitability tier for
// every product, with the recipe status. Gated by cost:read.
export async function GET(request: NextRequest) {
  try {
    const session = await requireKey("finance.view_profit");
    const params = request.nextUrl.searchParams;
    const cafeId = resolveCafeId(session, params.get("cafeId"));
    const requestedBranch = params.get("branchId");
    const branchId = resolveReadScope(session).branchId ?? requestedBranch;
    if (session.branchId && requestedBranch && requestedBranch !== session.branchId) throw new ApiError(403, "الفرع خارج نطاقك");
    if (branchId && !await db.branch.findFirst({ where: { id: branchId, cafeId } })) throw new ApiError(404, "الفرع مش موجود في نطاقك");
    const categoryId = params.get("categoryId") ?? undefined;

    const products = await db.product.findMany({
      where: { cafeId, isActive: true, ...(categoryId ? { categoryId } : {}) },
      include: {
        category: { select: { id: true, name: true } },
        variants: { where: { isActive: true }, orderBy: [{ sortOrder: "asc" }, { price: "asc" }] },
      },
      orderBy: [{ name: "asc" }],
    });

    const rows = (await Promise.all(products.flatMap((p) => {
      const configurations = p.variants.length > 0 ? p.variants : [null];
      return configurations.map(async (variant) => {
        const sellingPrice = Number(variant?.price ?? p.basePrice);
        const financials = await configurationFinancials({
          productId: p.id, variantId: variant?.id ?? null, sellingPrice, branchId,
        });
        return {
          id: variant ? `${p.id}:${variant.id}` : p.id,
          stockMode: p.stockMode,
          productId: p.id,
          variantId: variant?.id ?? null,
          name: variant ? `${p.name} — ${variant.name}` : p.name,
          productName: p.name,
          variantName: variant?.name ?? null,
          category: p.category.name,
          sellingPrice,
          hasRecipe: financials.costStatus === "AVAILABLE",
          ...financials,
        };
      });
    }))).flat();

    const costable = rows.filter((r) => r.costStatus === "AVAILABLE");
    const summary = {
      total: rows.length,
      withoutRecipe: rows.filter((r) => r.costStatus === "RECIPE_INCOMPLETE").length,
      lowMargin: costable.filter((r) => r.tier === "loss").length,
      topProfit: [...costable].sort((a, b) => (b.profit ?? 0) - (a.profit ?? 0)).slice(0, 5),
      lowestProfit: [...costable].sort((a, b) => (a.margin ?? 0) - (b.margin ?? 0)).slice(0, 5),
    };

    return NextResponse.json({ rows, summary, valuationBasis: "CURRENT_BRANCH_REFERENCE_ESTIMATE", limitation: "Catalog margins are current estimates, not realized order profit. Physical returns reverse original recorded usage cost; money refunds are accounted separately." });
  } catch (error) {
    return handleApiError(error);
  }
}
