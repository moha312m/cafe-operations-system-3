import { NextResponse, type NextRequest } from "next/server";
import { requireActiveSession, handleApiError, ApiError } from "@/lib/api";
import { db } from "@/lib/db";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const session = await requireActiveSession();
    const { id } = await params;

    const handover = await db.handoverSession.findUnique({
      where: { id },
      include: { stockCountSession: true },
    });

    if (!handover || (session.cafeId && handover.cafeId !== session.cafeId)) {
      throw new ApiError(404, "جلسة التسليم غير موجودة");
    }

    // Only owner, super admin, or staff with handover.override / handover.exception can cancel a handover
    const isOwner = session.role === "CAFE_OWNER" || session.role === "SUPER_ADMIN";
    const hasPermission = session.permissions?.some((p: string) =>
      p === "handover.override" || p === "handover.exception" || p === "handover.cancel"
    );

    if (!isOwner && !hasPermission) {
      throw new ApiError(403, "صلاحية إلغاء جلسات التسليم مخصصة للمالك أو المدير فقط");
    }

    if (handover.status === "COMPLETED" || handover.status === "ACCEPTED") {
      throw new ApiError(400, "لا يمكن إلغاء جلسة تسليم مكتملة أو معتمدة بالفعل");
    }

    // Atomically cancel the handover and unlock any linked stock count
    await db.$transaction(async (tx) => {
      // 1. If there's an associated stock count session in draft or in progress, cancel it or unlock it
      if (handover.stockCountSessionId) {
        await tx.stockCountSession.updateMany({
          where: {
            id: handover.stockCountSessionId,
            status: { in: ["DRAFT", "IN_PROGRESS", "SUBMITTED", "RECOUNT_REQUIRED"] },
          },
          data: {
            status: "CANCELLED",
            lockedByHandoverId: null,
          },
        });
      }

      // Unlock any count sessions locked by this handover
      await tx.stockCountSession.updateMany({
        where: { lockedByHandoverId: handover.id },
        data: { lockedByHandoverId: null },
      });

      // 2. Mark handover as COMPLETED with target BRANCH_CUSTODY and exception reason
      await tx.handoverSession.update({
        where: { id: handover.id },
        data: {
          status: "COMPLETED",
          resolvedTarget: "BRANCH_CUSTODY",
          completedAt: new Date(),
          exceptionById: session.id,
          exceptionReason: "تم إلغاء/إنهاء الجلسة يدوياً بواسطة الإدارة لتحرير الشيفت",
        },
      });
    });

    return NextResponse.json({
      success: true,
      message: "تم إلغاء جلسة التسليم المعلقة بنجاح وتحرير الشيفت",
    });
  } catch (error) {
    return handleApiError(error);
  }
}
