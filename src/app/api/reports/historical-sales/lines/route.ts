import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ApiError, handleApiError, requireAllKeys, resolveCafeId } from "@/lib/api";

export async function GET(request: NextRequest) {
  try {
    const session = await requireAllKeys("reports.view", "finance.view_revenue");
    if (session.role !== "CAFE_OWNER" && session.role !== "SUPER_ADMIN") {
      throw new ApiError(403, "تفاصيل المبيعات المستوردة متاحة للمالك فقط");
    }
    const cafeId = resolveCafeId(session, request.nextUrl.searchParams.get("cafeId"));
    const params = request.nextUrl.searchParams;
    const year = params.get("year") ?? String(new Date().getFullYear());
    if (!/^20\d{2}$/.test(year)) throw new ApiError(400, "سنة غير صالحة");
    const month = params.get("month") ?? "";
    if (month && (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month) || !month.startsWith(year))) {
      throw new ApiError(400, "شهر غير صالح");
    }
    const pageText = params.get("page") ?? "1";
    if (!/^[1-9]\d{0,3}$/.test(pageText)) throw new ApiError(400, "صفحة غير صالحة");
    const page = Number(pageText);
    const query = (params.get("q") ?? "").trim();
    if (query.length > 100) throw new ApiError(400, "البحث طويل جدًا");
    const where = {
      cafeId,
      saleMonth: month ? month : { gte: `${year}-01`, lte: `${year}-12` },
      ...(query ? { OR: [
        { sku: { contains: query, mode: "insensitive" as const } },
        { productName: { contains: query, mode: "insensitive" as const } },
        { invoiceNo: { contains: query, mode: "insensitive" as const } },
      ] } : {}),
    };
    const pageSize = 50;
    const [total, rows] = await Promise.all([
      db.historicalSaleLine.count({ where }),
      db.historicalSaleLine.findMany({ where, orderBy: [{ saleDate: "desc" }, { sourceRow: "desc" }],
        skip: (page - 1) * pageSize, take: pageSize,
        select: { sourceRow: true, saleLocalDate: true, invoiceNo: true, sku: true,
          productName: true, quantity: true, quantityUnit: true, unitPrice: true,
          discount: true, total: true, paymentMethod: true, customerName: true } }),
    ]);
    return NextResponse.json({ page, pageSize, total,
      rows: rows.map(row => ({ ...row, quantity: Number(row.quantity), unitPrice: Number(row.unitPrice),
        discount: Number(row.discount), total: Number(row.total) })) });
  } catch (error) {
    return handleApiError(error);
  }
}
