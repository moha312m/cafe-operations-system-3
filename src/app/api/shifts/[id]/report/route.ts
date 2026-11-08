import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { resolvePermissions } from "@/lib/perms/effective";
import { handleApiError, ApiError, requireActiveSession, resolveReadScope } from "@/lib/api";
import { buildShiftMaterialsReport, buildShiftReport } from "@/lib/shift-report";

type Params = { params: Promise<{ id: string }> };

// GET /api/shifts/[id]/report — the printable financial close report.
// Only oversight may read it, even when the shift belongs to the requester.
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const session = await requireActiveSession();
    const { id } = await params;
    const scope = resolveReadScope(session);
    const { keys } = await resolvePermissions(session);
    if (!keys.has("shifts.view_reports") && session.role !== "CAFE_OWNER" && session.role !== "BRANCH_MANAGER") throw new ApiError(403, "Not allowed");
    const shift = await db.shift.findFirst({
      where: { id, ...scope },
      select: { cafeId: true, branchId: true, cashierId: true },
    });
    if (!shift) throw new ApiError(404, "الشيفت مش موجود");

    const report = await buildShiftReport(id, shift.cafeId);
    if (!report) throw new ApiError(409, "التقرير بيجهز بعد قفل الشيفت");
    // HND-UX-004: the materials evidence beside the money (oversight only here).
    const materials = await buildShiftMaterialsReport(id, shift.cafeId, { withFigures: true });
    return NextResponse.json({ report, materials });
  } catch (error) {
    return handleApiError(error);
  }
}
