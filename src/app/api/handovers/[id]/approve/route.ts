import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireActiveSession, handleApiError, ApiError, resolveCafeId } from "@/lib/api";
import { resolvePermissions } from "@/lib/perms/effective";
import { approveHandoverAsManager } from "@/lib/handover-approval";
import { db } from "@/lib/db";

type Params = { params: Promise<{ id: string }> };

const approveSchema = z
  .object({
    note: z.string().max(1000).optional(),
    cafeId: z.string().optional(),
  })
  .strip();

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const session = await requireActiveSession();
    const { id } = await params;

    const handover = await db.handoverSession.findUnique({
      where: { id },
      select: { branchId: true, cafeId: true, stockCountSessionId: true, status: true },
    });

    if (!handover || (session.cafeId && handover.cafeId !== session.cafeId)) {
      throw new ApiError(404, "جلسة التسليم غير موجودة");
    }

    const { keys } = await resolvePermissions(session);
    const isOwner = session.role === "CAFE_OWNER" || session.role === "SUPER_ADMIN";
    const isBranchManager = session.role === "BRANCH_MANAGER" && session.branchId === handover.branchId;
    const hasHandoverException = keys.has("handover.exception");

    if (!isOwner && !isBranchManager && !hasHandoverException) {
      throw new ApiError(403, "صلاحية الاعتماد الاستثنائي للتسليم مخصصة للمالك أو مدير هذا الفرع فقط");
    }

    // Require an actual bound stock count session before allowing manager approval
    if (!handover.stockCountSessionId) {
      throw new ApiError(400, "لا يمكن اعتماد تسليم لا يحتوي على جلسة جرد خامات");
    }

    const body = approveSchema.parse(await request.json().catch(() => ({})));
    const cafeId = resolveCafeId(session, body.cafeId);

    const result = await approveHandoverAsManager({
      handoverId: id,
      managerId: session.id,
      cafeId,
      viewerBranchId: session.branchId,
      note: body.note,
    });

    return NextResponse.json(result);
  } catch (error) {
    return handleApiError(error);
  }
}
