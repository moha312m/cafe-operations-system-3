import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  requireKey,
  requireFeature,
  resolveCafeId,
  handleApiError,
  ApiError,
} from "@/lib/api";
import { VARIANCE_CASE_DETAIL_SELECT } from "@/lib/variance-case";

type Params = { params: Promise<{ id: string }> };

// GET /api/variances/:id — one case, with what caused it.
//
// The source resolves through its relation rather than coming back as a bare
// id: a case exists because something happened, and a reader holding only
// `stockCountLineId` cannot see what that was.
//
// Another café's case is 404, not 403 — consistent with the count surfaces. A
// 403 would confirm the id exists, which is itself a disclosure. Another
// BRANCH of the caller's own café is 403, because the café is theirs and the
// branch is not.
export async function GET(request: NextRequest, { params }: Params) {
  try {
    const session = await requireKey("variance.view");
    await requireFeature(session, "shiftManagementEnabled");

    const { id } = await params;
    const cafeId = resolveCafeId(session, request.nextUrl.searchParams.get("cafeId"));

    const found = await db.varianceCase.findUnique({
      where: { id },
      select: VARIANCE_CASE_DETAIL_SELECT,
    });
    if (!found || found.cafeId !== cafeId) {
      throw new ApiError(404, "حالة الفرق غير موجودة");
    }
    if (session.branchId && found.branchId !== session.branchId) {
      throw new ApiError(403, "ليس لديك صلاحية على فرع تاني");
    }

    return NextResponse.json({ case: found });
  } catch (error) {
    return handleApiError(error);
  }
}
