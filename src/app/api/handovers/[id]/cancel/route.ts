import { NextResponse, type NextRequest } from "next/server";
import { requireActiveSession, handleApiError, ApiError } from "@/lib/api";
import { resolvePermissions } from "@/lib/perms/effective";
import { db } from "@/lib/db";
import { transferCustody } from "@/lib/custody";
import { finalizeCashCustodyAtFinancialClose } from "@/lib/handover";
import { acquireInventoryExclusiveLock, invalidateFreeze } from "@/lib/inventory-freeze";
import { auditInTransaction } from "@/lib/audit";

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
      // 1. Acquire branch advisory exclusive lock first to protect the cancellation boundary
      await acquireInventoryExclusiveLock(tx, handover.branchId);

      // 2. Re-read the fresh state inside transaction under lock to prevent concurrent races
      const currentHandover = await tx.handoverSession.findUnique({
        where: { id: handover.id },
        include: {
          outgoingShift: {
            select: { id: true, actualCashAmount: true, status: true },
          },
        },
      });

      if (!currentHandover) {
        throw new ApiError(404, "جلسة التسليم غير موجودة");
      }

      // 3. Conditional CAS: Only cancel if still in an open, uncompleted state
      const moved = await tx.handoverSession.updateMany({
        where: {
          id: currentHandover.id,
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

      // 4. Collect all count session IDs linked to this handover or shift
      const countSessionIds = new Set<string>();
      if (currentHandover.stockCountSessionId) {
        countSessionIds.add(currentHandover.stockCountSessionId);
      }
      const lockedByThis = await tx.stockCountSession.findMany({
        where: { lockedByHandoverId: currentHandover.id },
        select: { id: true },
      });
      for (const s of lockedByThis) {
        countSessionIds.add(s.id);
      }
      if (currentHandover.outgoingShiftId) {
        const byShift = await tx.stockCountSession.findMany({
          where: { shiftId: currentHandover.outgoingShiftId },
          select: { id: true },
        });
        for (const s of byShift) {
          countSessionIds.add(s.id);
        }
      }

      const allCountIds = Array.from(countSessionIds);
      if (allCountIds.length > 0) {
        // Lock all linked count sessions
        await tx.stockCountSession.updateMany({
          where: {
            id: { in: allCountIds },
            status: { not: "LOCKED" },
          },
          data: {
            status: "LOCKED",
            lockedAt: new Date(),
            lockedByHandoverId: null,
          },
        });

        // Auto-reject any pending corrections on these sessions to clear preflight blockers
        await tx.stockCountCorrection.updateMany({
          where: {
            line: { sessionId: { in: allCountIds } },
            status: "PENDING_APPROVAL",
          },
          data: {
            status: "REJECTED",
            rejectedReason: "تم إلغاء طلب التصحيح تلقائياً بسبب إلغاء جلسة التسليم المعلقة",
          },
        });
      }

      await tx.stockCountSession.updateMany({
        where: { lockedByHandoverId: currentHandover.id },
        data: { lockedByHandoverId: null },
      });

      // 5. Transfer STOCK custody to BRANCH if an outgoing stock custody period is still open
      if (currentHandover.outgoingStockCustodyId) {
        const stockPeriod = await tx.custodyPeriod.findUnique({
          where: { id: currentHandover.outgoingStockCustodyId },
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

      // 6. Finalize CASH custody at financial close if not already closed
      if (currentHandover.outgoingShiftId) {
        await finalizeCashCustodyAtFinancialClose(tx, {
          cafeId: currentHandover.cafeId,
          branchId: currentHandover.branchId,
          outgoingShiftId: currentHandover.outgoingShiftId,
          actualCash: Number(currentHandover.outgoingShift?.actualCashAmount ?? 0),
        });
      }

      // 7. Complete the outgoing shift lifecycle (set stockClosedAt and status to CLOSED)
      await tx.shift.updateMany({
        where: {
          id: currentHandover.outgoingShiftId,
          status: "AWAITING_HANDOVER",
        },
        data: {
          status: "CLOSED",
          stockClosedAt: new Date(),
          closedAt: new Date(),
          closedById: session.id,
        },
      });

      // 8. Release active inventory freeze on this branch and write transactional audit logs
      const releasedAt = new Date();
      const activeFreezes = await tx.inventoryFreeze.findMany({
        where: {
          branchId: currentHandover.branchId,
          releasedAt: null,
        },
        select: { id: true, cafeId: true, handoverId: true },
      });

      if (activeFreezes.length > 0) {
        await tx.inventoryFreeze.updateMany({
          where: {
            branchId: currentHandover.branchId,
            releasedAt: null,
          },
          data: {
            releasedAt,
            releasedById: session.id,
          },
        });

        invalidateFreeze(tx, currentHandover.branchId);

        for (const f of activeFreezes) {
          await auditInTransaction(tx, {
            cafeId: f.cafeId,
            userId: session.id,
            action: "INVENTORY_FREEZE_RELEASED",
            entity: "InventoryFreeze",
            entityId: f.id,
            details: {
              branchId: currentHandover.branchId,
              handoverId: f.handoverId,
              releasedAt: releasedAt.toISOString(),
              cancelledByHandover: currentHandover.id,
            },
          });
        }
      }

      // 9. Re-evaluate waiting shifts that were waiting for custody transfer
      await tx.shift.updateMany({
        where: {
          branchId: currentHandover.branchId,
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
