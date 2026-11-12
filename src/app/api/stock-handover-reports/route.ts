import { NextResponse, type NextRequest } from "next/server";
import type { StockHandoverClassification, StockHandoverReviewStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { ApiError, handleApiError, requireActiveSession, requireFeature, resolveBranchId, resolveCafeId } from "@/lib/api";
import { resolvePermissions } from "@/lib/perms/effective";
import { CLASSIFICATIONS, listStockHandoverReports, mayReadStockHandoverReports, REVIEW_STATUSES, stockHandoverReportXlsx, type ReportFilter } from "@/lib/stock-handover-review";

const RESULTS = ["UNEXPLAINED", "EXPLAINED", "MISSING", "NONE"] as const;

function filterFrom(params: URLSearchParams, cafeId: string, branchId: string | null): ReportFilter {
  const status = params.get("status");
  const classification = params.get("classification");
  const result = params.get("result");
  const date = (v: string | null) => {
    if (!v) return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw new ApiError(400, "تاريخ غير صحيح");
    return d;
  };
  if (status && !REVIEW_STATUSES.includes(status as StockHandoverReviewStatus)) throw new ApiError(400, "حالة غير معروفة");
  if (classification && !CLASSIFICATIONS.includes(classification as StockHandoverClassification)) throw new ApiError(400, "تصنيف غير معروف");
  if (result && !RESULTS.includes(result as (typeof RESULTS)[number])) throw new ApiError(400, "نتيجة غير معروفة");
  return {
    cafeId, branchId,
    status: (status as StockHandoverReviewStatus) || null,
    classification: (classification as StockHandoverClassification) || null,
    result: (result as ReportFilter["result"]) || null,
    from: date(params.get("from")),
    to: date(params.get("to")),
  };
}

// GET /api/stock-handover-reports — the list, filterable; ?format=xlsx exports it.
export async function GET(request: NextRequest) {
  try {
    const session = await requireActiveSession();
    const { keys } = await resolvePermissions(session);
    if (!mayReadStockHandoverReports(keys)) throw new ApiError(403, "ليس لديك صلاحية");
    await requireFeature(session, "inventoryEnabled");
    const p = request.nextUrl.searchParams;
    const cafeId = resolveCafeId(session, p.get("cafeId"));
    // Owners read every branch unless they pick one; branch staff read only their own.
    const branchId = session.branchId || p.get("branchId") ? resolveBranchId(session, p.get("branchId")) : null;
    const filter = filterFrom(p, cafeId, branchId);
    if (p.get("format") === "xlsx") {
      const file = await stockHandoverReportXlsx(db, filter);
      const name = `stock-handover-report-${new Date().toISOString().slice(0, 10)}.xlsx`;
      return new NextResponse(new Uint8Array(file), {
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="${name}"`,
          "Cache-Control": "no-store",
        },
      });
    }
    return NextResponse.json({ rows: await listStockHandoverReports(db, filter) });
  } catch (error) {
    return handleApiError(error);
  }
}
