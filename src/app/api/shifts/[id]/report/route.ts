import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { resolvePermissions } from "@/lib/perms/effective";
import { handleApiError, ApiError, requireActiveSession, resolveReadScope } from "@/lib/api";
import { buildShiftReport } from "@/lib/shift-report";

type Params = { params: Promise<{ id: string }> };

// GET /api/shifts/[id]/report — the printable financial close report.
// Only oversight may read it, even when the shift belongs to the requester.
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const session = await requireActiveSession();
    const { id } = await params;
    const scope = resolveReadScope(session);
    const { keys } = await resolvePermissions(session);
    if (!keys.has("shifts.view_reports")) throw new ApiError(403, "Not allowed");
    const shift = await db.shift.findFirst({
      where: { id, ...scope },
      select: { cafeId: true, branchId: true, cashierId: true },
    });
    if (!shift) throw new ApiError(404, "الشيفت مش موجود");

    const report = await buildShiftReport(id, shift.cafeId);
    if (!report) throw new ApiError(409, "التقرير بيجهز بعد قفل الشيفت");
    return NextResponse.json({ report });
  } catch (error) {
    return handleApiError(error);
  }
}
