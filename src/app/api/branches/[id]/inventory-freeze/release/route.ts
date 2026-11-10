import { NextResponse, type NextRequest } from "next/server";
import { requireActiveSession, handleApiError, ApiError } from "@/lib/api";
import { db } from "@/lib/db";
import { forceReleaseBranchFreezes } from "@/lib/inventory-freeze";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const session = await requireActiveSession();
    const { id: branchId } = await params;

    const branch = await db.branch.findUnique({
      where: { id: branchId },
      select: { id: true, cafeId: true },
    });

    if (!branch || (session.cafeId && branch.cafeId !== session.cafeId)) {
      throw new ApiError(404, "الفرع غير موجود");
    }

    const isOwner = session.role === "CAFE_OWNER" || session.role === "SUPER_ADMIN" || session.role === "BRANCH_MANAGER";
    const isBranchStaff = session.branchId === branchId;
    const hasPermission = session.permissions?.some((p: string) =>
      p === "handover.override" || p === "handover.exception" || p === "handover.cancel" || p === "shift.close"
    );

    if (!isOwner && !isBranchStaff && !hasPermission) {
      throw new ApiError(403, "صلاحية فك تجميد المخزون مخصصة للمالك أو المدير أو كادر الفرع فقط");
    }

    const releasedCount = await db.$transaction(async (tx) => {
      // 1. Release any active inventory freezes on this branch
      const count = await forceReleaseBranchFreezes(tx, branchId, session.id);

      // 2. Also resolve any orphaned DRAFT/REJECTED handovers in this branch
      await tx.handoverSession.updateMany({
        where: {
          branchId,
          status: { in: ["DRAFT", "REJECTED"] },
        },
        data: {
          status: "COMPLETED",
          resolvedTarget: "BRANCH_CUSTODY",
          completedAt: new Date(),
          exceptionById: session.id,
          exceptionReason: "تم فك التجميد وإنهاء المسودات المعلقة تلقائياً لتحرير الشيفت",
        },
      });

      return count;
    });

    return NextResponse.json({
      success: true,
      releasedCount,
      message: `تم فك تجميد المخزون وتحرير جلسات التسليم المعلقة بنجاح (${releasedCount} تجميد تم فكه)`,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
