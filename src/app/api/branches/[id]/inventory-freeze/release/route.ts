import { NextResponse, type NextRequest } from "next/server";
import { requireActiveSession, handleApiError, ApiError } from "@/lib/api";
import { resolvePermissions } from "@/lib/perms/effective";
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

    const { keys } = await resolvePermissions(session);
    const isOwner = session.role === "CAFE_OWNER" || session.role === "SUPER_ADMIN";
    const isBranchManager = session.role === "BRANCH_MANAGER" && session.branchId === branchId;
    const isBranchStaff = session.branchId === branchId && (keys.has("shift.close") || keys.has("handover.cancel"));
    const hasPermission = keys.has("handover.override") || keys.has("handover.exception") || keys.has("handover.cancel");

    if (!isOwner && !isBranchManager && !isBranchStaff && !hasPermission) {
      throw new ApiError(403, "صلاحية فك تجميد المخزون مخصصة للمالك أو مدير هذا الفرع أو كادر الفرع المصرح لهم فقط");
    }

    const releasedCount = await db.$transaction(async (tx) => {
      // 1. Release any eligible inventory freezes on this branch (excluding submitted handovers)
      const count = await forceReleaseBranchFreezes(tx, branchId, session.id);

      // 2. Identify orphaned DRAFT or REJECTED handovers on this branch
      const orphanedHandovers = await tx.handoverSession.findMany({
        where: {
          branchId,
          status: { in: ["DRAFT", "REJECTED"] },
        },
        select: { id: true, stockCountSessionId: true, outgoingShiftId: true },
      });

      // 3. Mark orphaned handovers as COMPLETED
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

      // 4. Lock any linked stock count sessions to prevent dangling foreign counts
      const countIds = orphanedHandovers
        .map((o) => o.stockCountSessionId)
        .filter((id): id is string => Boolean(id));

      if (countIds.length > 0) {
        await tx.stockCountSession.updateMany({
          where: {
            id: { in: countIds },
            status: { notIn: ["LOCKED"] },
          },
          data: {
            status: "LOCKED",
            lockedAt: new Date(),
            lockedByHandoverId: null,
          },
        });

        await tx.stockCountCorrection.updateMany({
          where: {
            line: { sessionId: { in: countIds } },
            status: "PENDING_APPROVAL",
          },
          data: {
            status: "REJECTED",
            rejectedReason: "تم إلغاء طلب التصحيح تلقائياً بسبب إنهاء جلسة التسليم وفك أقفال الفرع",
          },
        });
      }

      // 5. Ensure outgoing shifts do not get stranded in AWAITING_HANDOVER
      const shiftIds = orphanedHandovers.map((o) => o.outgoingShiftId);
      if (shiftIds.length > 0) {
        await tx.shift.updateMany({
          where: {
            id: { in: shiftIds },
            status: "AWAITING_HANDOVER",
          },
          data: {
            status: "CLOSED",
            stockClosedAt: new Date(),
            closedAt: new Date(),
            closedById: session.id,
          },
        });
      }

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
