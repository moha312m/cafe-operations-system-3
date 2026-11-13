import { NextResponse, type NextRequest } from "next/server";
import { ApiError, handleApiError, requireFeature, requireKey, resolveBranchId, resolveCafeId, resolveReadScope } from "@/lib/api";
import { dateStrInTz } from "@/lib/date-range";
import { loadVarianceSheet, varianceSheetFileName, varianceSheetXlsx } from "@/lib/reports/stock-variance-sheet";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

// GET /api/stock-counts/variances/export — the variances workbook for
// confirmed counts. `from`/`to` are local business dates (default: this month
// so far); `sessionId` narrows it to one count. A pinned account gets its own
// branch; an unpinned owner may name one or leave it out for every branch.
export async function GET(request: NextRequest) {
  try {
    const session = await requireKey("stock_count.view");
    await requireFeature(session, "inventoryEnabled");
    const p = request.nextUrl.searchParams;
    const cafeId = resolveCafeId(session, p.get("cafeId"));
    // Every branch only for an unpinned owner; resolveReadScope refuses anyone else.
    const branchId = session.branchId || p.get("branchId") ? resolveBranchId(session, p.get("branchId")) : (resolveReadScope(session), null);
    const today = dateStrInTz(new Date());
    const from = p.get("from") ?? `${today.slice(0, 7)}-01`, to = p.get("to") ?? today;
    if (!DAY.test(from) || !DAY.test(to) || from > to) throw new ApiError(400, "الفترة غير صحيحة — اختار من تاريخ لحد تاريخ");

    const sheet = await loadVarianceSheet({ cafeId, branchId, from, to, sessionId: p.get("sessionId") });
    const name = varianceSheetFileName(sheet);
    return new NextResponse(new Uint8Array(varianceSheetXlsx(sheet)), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="variances.xlsx"; filename*=UTF-8''${encodeURIComponent(name)}`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
