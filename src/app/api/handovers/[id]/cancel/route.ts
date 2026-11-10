import { NextResponse, type NextRequest } from "next/server";
import { requireActiveSession, handleApiError, ApiError } from "@/lib/api";
import { resolvePermissions } from "@/lib/perms/effective";
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

    const { keys } = await resolvePermissions(session);
    const isOwner = session.role === "CAFE_OWNER" || session.role === "SUPER_ADMIN";
    const isBranchManager = session.role === "BRANCH_MANAGER" && session.branchId === handover.branchId;
    const isCustodian = session.id === handover.outgoingUserId && session.branchId === handover.branchId;
    const hasPermission = keys.has("handover.override") || keys.has("handover.exception") || keys.has("handover.cancel");

    if (!isOwner && !isBranchManager && !isCustodian && !hasPermission) {
      throw new ApiError(403, "صلاحية إلغاء جلسات التسليم مخصصة للمالك أو مدير هذا الفرع أو كاشير الشيفت فقط");
    }

    // Atomically cancel the handover, close the outgoing shift, and unlock stock counts
    await db.$transaction(async (tx) => {
      // 1. Conditional optimistic claim: only cancel if still in an open state
      const claimed = await tx.handoverSession.updateMany({
        where: {
          id: handover.id,
          status: { in: ["DRAFT", "PENDING_REVIEW", "REJECTED"] },
        },
        data: {
          status: "COMPLETED",
          resolvedTarget: "BRANCH_CUSTODY",
          completedAt: new Date(),
          exceptionById: session.id,
          exceptionReason: "تم إلغاء/إنهاء الجلسة يدوياً لتحرير الشيفت",
        },
      });

      if (claimed.count === 0) {
        throw new ApiError(409, "لا يمكن إلغاء جلسة تسليم مكتملة أو معتمدة بالفعل");
      }

      // 2. Complete the shift lifecycle so it does not stay in AWAITING_HANDOVER
      await tx.shift.updateMany({
        where: {
          id: handover.outgoingShiftId,
          status: "AWAITING_HANDOVER",
        },
        data: {
          status: "CLOSED",
          stockClosedAt: new Date(),
          closedAt: new Date(),
          closedById: session.id,
        },
      });

      // 3. Lock associated stock count session
      if (handover.stockCountSessionId) {
        await tx.stockCountSession.updateMany({
          where: {
            id: handover.stockCountSessionId,
            status: { notIn: ["LOCKED"] },
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

      // 4. Release any inventory freeze for this handover or dangling on this branch
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
    });

    return NextResponse.json({
      success: true,
      message: "تم إلغاء جلسة التسليم المعلقة بنجاح وإنهاء الشيفت",
    });
  } catch (error) {
    return handleApiError(error);
  }
}
