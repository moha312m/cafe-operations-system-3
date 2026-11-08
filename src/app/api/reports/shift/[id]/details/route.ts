import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { resolvePermissions } from "@/lib/perms/effective";
import { handleApiError, ApiError, requireActiveSession, resolveReadScope } from "@/lib/api";
import { buildShiftReport } from "@/lib/shift-report";

type Params = { params: Promise<{ id: string }> };

// GET /api/reports/shift/[id]/details — Vendora-style Register Details JSON
// for both open and closed shifts, restricted to cafe/branch scope and
// shifts.view_reports permission.
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const session = await requireActiveSession();
    const { id } = await params;
    const scope = resolveReadScope(session);
    const { keys } = await resolvePermissions(session);
    if (!keys.has("shifts.view_reports") && session.role !== "CAFE_OWNER" && session.role !== "BRANCH_MANAGER") {
      throw new ApiError(403, "ليس لديك صلاحية عرض تفاصيل الوردية");
    }
    const shift = await db.shift.findFirst({
      where: { id, ...scope },
      select: { cafeId: true },
    });
    if (!shift) throw new ApiError(404, "الوردية غير موجودة");

    const report = await buildShiftReport(id, shift.cafeId, { allowOpen: true });
    if (!report) throw new ApiError(404, "الوردية غير موجودة");
    return NextResponse.json({ report }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
