import { NextResponse, type NextRequest } from "next/server";
import { requireActiveSession, handleApiError, ApiError } from "@/lib/api";
import { resolvePermissions } from "@/lib/perms/effective";
import { db } from "@/lib/db";
import { transferCustody } from "@/lib/custody";
import { finalizeCashCustodyAtFinancialClose } from "@/lib/handover";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const session = await requireActiveSession();
    const { id } = await params;

    const handover = await db.handoverSession.findUnique({
      where: { id },
      include: {
        outgoingShift: {
          select: { id: true, actualCashAmount: true, status: true },
        },
      },
    });

    if (!handover || (session.cafeId && handover.cafeId !== session.cafeId)) {
      throw new ApiError(404, "جلسة التسليم غير موجودة");
    }

    const { keys } = await resolvePermissions(session);
    const isOwner = session.role === "CAFE_OWNER" || session.role === "SUPER_ADMIN";
    const isBranchManager = session.role === "BRANCH_MANAGER" && session.branchId === handover.branchId;
    const isCustodian = session.id === handover.outgoingUserId && session.branchId === handover.branchId;
    const hasPermission = keys.has("handover.cancel") || keys.has("handover.exception");

    if (!isOwner && !isBranchManager && !isCustodian && !hasPermission) {
      throw new ApiError(403, "صلاحية إلغاء جلسات التسليم مخصصة للمالك أو مدير هذا الفرع أو كاشير الشيفت فقط");
    }

    // Atomically cancel the handover, discharge custody, close the outgoing shift, and unlock stock counts
    await db.$transaction(async (tx) => {
      // 1. Conditional CAS: Only cancel if still in an open, uncompleted state
      const moved = await tx.handoverSession.updateMany({
        where: {
          id: handover.id,
          status: { in: ["DRAFT", "OUTGOING_SUBMITTED", "INCOMING_REVIEW", "REJECTED"] },
        },
        data: {
          status: "COMPLETED",
          resolvedTarget: "BRANCH_CUSTODY",
          completedAt: new Date(),
          exceptionById: session.id,
          exceptionReason: "تم إلغاء/إنهاء الجلسة يدوياً بواسطة الإدارة لتحرير الشيفت",
        },
      });

      if (moved.count !== 1) {
        throw new ApiError(409, "حالة التسليم تغيرت — حدّث الصفحة");
      }

      // 2. Transfer STOCK custody to BRANCH if an outgoing stock custody period is still open
      if (handover.outgoingStockCustodyId) {
        const stockPeriod = await tx.custodyPeriod.findUnique({
          where: { id: handover.outgoingStockCustodyId },
          select: { id: true, status: true },
        });

        if (stockPeriod && stockPeriod.status === "OPEN") {
          await transferCustody(tx, {
            outgoingPeriodId: stockPeriod.id,
            scope: "STOCK",
            incoming: {
              participants: [],
              shiftId: null,
              responsibleShiftId: null,
              holderType: "BRANCH",
              openedById: session.id,
            },
            actorId: session.id,
            acceptedById: session.id,
            acceptedAt: new Date(),
          });
        }
      }

      // 3. Finalize CASH custody at financial close if not already closed
      if (handover.outgoingShiftId) {
        await finalizeCashCustodyAtFinancialClose(tx, {
          cafeId: handover.cafeId,
          branchId: handover.branchId,
          outgoingShiftId: handover.outgoingShiftId,
          actualCash: Number(handover.outgoingShift?.actualCashAmount ?? 0),
        });
      }

      // 4. Complete the outgoing shift lifecycle (set stockClosedAt and status to CLOSED)
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

      // 5. Lock any linked stock count sessions (including CONFIRMED, SUBMITTED, DRAFT)
      if (handover.stockCountSessionId) {
        await tx.stockCountSession.updateMany({
          where: {
            id: handover.stockCountSessionId,
            status: { not: "LOCKED" },
          },
          data: {
            status: "LOCKED",
            lockedAt: new Date(),
            lockedByHandoverId: null,
          },
        });
      }

      await tx.stockCountSession.updateMany({
        where: { lockedByHandoverId: handover.id },
        data: { lockedByHandoverId: null },
      });

      // 6. Release active inventory freeze on this branch
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

      // 7. Re-evaluate waiting shifts that were waiting for custody transfer
      await tx.shift.updateMany({
        where: {
          branchId: handover.branchId,
          status: "OPEN",
          custodyGateReason: "AWAITING_CUSTODY_TRANSFER",
        },
        data: {
          custodyGateReason: "AWAITING_OPENING_VERIFICATION",
        },
      });
    });

    return NextResponse.json({
      success: true,
      message: "تم إلغاء جلسة التسليم المعلقة بنجاح وإنهاء عهدة الشيفت للفرع",
    });
  } catch (error) {
    return handleApiError(error);
  }
}
