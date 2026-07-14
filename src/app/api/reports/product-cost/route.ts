import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requirePermission, resolveCafeId, handleApiError } from "@/lib/api";
import { productCost, profitFor } from "@/lib/costing";

// تقرير تكلفة المنتجات — cost, profit, margin, and profitability tier for
// every product, with the recipe status. Gated by cost:read.
export async function GET(request: NextRequest) {
  try {
    const session = await requirePermission("cost:read");
    const params = request.nextUrl.searchParams;
    const cafeId = resolveCafeId(session, params.get("cafeId"));
    const categoryId = params.get("categoryId") ?? undefined;

    const products = await db.product.findMany({
      where: { cafeId, isActive: true, ...(categoryId ? { categoryId } : {}) },
      include: {
        category: { select: { id: true, name: true } },
        recipeItems: {
          include: { inventoryItem: { select: { unit: true, costPerUnit: true } } },
        },
      },
      orderBy: [{ name: "asc" }],
    });

    const rows = products.map((p) => {
      const hasRecipe = p.recipeItems.length > 0;
      const cost = productCost(p.recipeItems);
      const profit = profitFor(Number(p.basePrice), cost, hasRecipe);
      return {
        id: p.id,
        name: p.name,
        category: p.category.name,
        sellingPrice: Number(p.basePrice),
        hasRecipe,
        ...profit,
      };
    });

    const withRecipe = rows.filter((r) => r.hasRecipe);
    const summary = {
      total: rows.length,
      withoutRecipe: rows.filter((r) => !r.hasRecipe).length,
      lowMargin: withRecipe.filter((r) => r.tier === "loss").length,
      topProfit: [...withRecipe].sort((a, b) => b.profit - a.profit).slice(0, 5),
      lowestProfit: [...withRecipe].sort((a, b) => a.margin - b.margin).slice(0, 5),
    };

    return NextResponse.json({ rows, summary });
  } catch (error) {
    return handleApiError(error);
  }
}
