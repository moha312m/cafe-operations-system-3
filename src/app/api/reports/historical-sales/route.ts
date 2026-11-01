import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ApiError, handleApiError, requireAllKeys, resolveCafeId } from "@/lib/api";

// The source export has sales lines, but no trustworthy branch/shift linkage.
// Keep this report owner-scoped and separate from operational POS financials.
export async function GET(request: NextRequest) {
  try {
    const session = await requireAllKeys("reports.view", "finance.view_revenue");
    if (session.role !== "CAFE_OWNER" && session.role !== "SUPER_ADMIN") {
      throw new ApiError(403, "تقرير المبيعات المستوردة متاح للمالك فقط");
    }
    const cafeId = resolveCafeId(session, request.nextUrl.searchParams.get("cafeId"));
    const yearText = request.nextUrl.searchParams.get("year") ?? String(new Date().getFullYear());
    if (!/^20\d{2}$/.test(yearText)) throw new ApiError(400, "سنة غير صالحة");
    const year = Number(yearText);
    const where = { cafeId, saleMonth: { gte: `${year}-01`, lte: `${year}-12` } };
    const [totals, monthly, products, methods, dates] = await Promise.all([
      db.historicalSaleLine.aggregate({ where, _count: true, _sum: { total: true, discount: true } }),
      db.historicalSaleLine.groupBy({ by: ["saleMonth"], where, _count: true,
        _sum: { total: true, quantity: true, discount: true }, orderBy: { saleMonth: "asc" } }),
      db.historicalSaleLine.groupBy({ by: ["sku", "productName", "quantityUnit"], where, _count: true,
        _sum: { total: true, quantity: true }, orderBy: { _sum: { total: "desc" } }, take: 30 }),
      db.historicalSaleLine.groupBy({ by: ["paymentMethod"], where, _count: true,
        _sum: { total: true }, orderBy: { _sum: { total: "desc" } } }),
      db.historicalSaleLine.aggregate({ where, _min: { saleDate: true }, _max: { saleDate: true } }),
    ]);
    return NextResponse.json({
      year, source: "Product Sell Report - Next Cup.csv", granularity: "sale_line",
      separateFromLivePOS: true,
      totals: { lines: totals._count, revenue: Number(totals._sum.total ?? 0),
        discount: Number(totals._sum.discount ?? 0),
        firstDate: dates._min.saleDate, lastDate: dates._max.saleDate },
      monthly: monthly.map(row => ({ month: row.saleMonth, lines: row._count,
        revenue: Number(row._sum.total ?? 0), discount: Number(row._sum.discount ?? 0) })),
      products: products.map(row => ({ sku: row.sku, name: row.productName, unit: row.quantityUnit,
        lines: row._count, quantity: Number(row._sum.quantity ?? 0), revenue: Number(row._sum.total ?? 0) })),
      methods: methods.map(row => ({ method: row.paymentMethod || "غير محدد",
        lines: row._count, revenue: Number(row._sum.total ?? 0) })),
    });
  } catch (error) {
    return handleApiError(error);
  }
}
