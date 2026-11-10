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

    // Owner, super admin, branch manager, the shift custodian, or staff with permissions can cancel
    const isOwner = session.role === "CAFE_OWNER" || session.role === "SUPER_ADMIN" || session.role === "BRANCH_MANAGER";
    const isCustodian = session.id === handover.outgoingUserId || session.branchId === handover.branchId;
    const hasPermission = session.permissions?.some((p: string) =>
      p === "handover.override" || p === "handover.exception" || p === "handover.cancel" || p === "shift.close"
    );

    if (!isOwner && !isCustodian && !hasPermission) {
      throw new ApiError(403, "صلاحية إلغاء جلسات التسليم مخصصة للمالك أو المدير أو كاشير الشيفت فقط");
    }

    if (handover.status === "COMPLETED" || handover.status === "ACCEPTED") {
      throw new ApiError(400, "لا يمكن إلغاء جلسة تسليم مكتملة أو معتمدة بالفعل");
    }

    // Atomically cancel the handover and unlock any linked stock count
    await db.$transaction(async (tx) => {
      // 1. If there's an associated stock count session in draft or in progress, lock and release it
      if (handover.stockCountSessionId) {
        await tx.stockCountSession.updateMany({
          where: {
            id: handover.stockCountSessionId,
            status: { in: ["DRAFT", "IN_PROGRESS", "SUBMITTED", "RECOUNT_REQUIRED"] },
          },
          data: {
            status: "LOCKED",
            lockedAt: new Date(),
            lockedByHandoverId: null,
          },
        });
      }

      // Unlock any count sessions locked by this handover
      await tx.stockCountSession.updateMany({
        where: { lockedByHandoverId: handover.id },
        data: { lockedByHandoverId: null },
      });

      // 2. Release any inventory freeze for this handover or dangling on this branch
      await tx.inventoryFreeze.updateMany({
        where: {
          branchId: handover.branchId,
          releasedAt: null,
        },
        data: {
          releasedAt: new Date(),
          releasedById: session.id,
        },
      });

      // 3. Mark handover as COMPLETED with target BRANCH_CUSTODY and exception reason
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
