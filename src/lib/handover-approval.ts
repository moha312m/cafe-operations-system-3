import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { rebaseFromCountInTransaction } from "@/lib/stock-rebase";
import { lockCountSession } from "@/lib/stock-count";
import { releaseInventoryFreeze } from "@/lib/inventory-freeze";
import { applyDeferredDeductions } from "@/lib/deferred-deduction";
import { buildStockBoundary, persistStockBoundary } from "@/lib/handover-boundary";
import { openHandoverVarianceCases } from "@/lib/stock-variance-attribution";

export type ApproveHandoverArgs = {
  handoverId: string;
  managerId: string;
  cafeId: string;
  viewerBranchId?: string | null;
  note?: string;
};

export async function approveHandoverAsManager(args: ApproveHandoverArgs) {
  // 1. Check user authority
  const manager = await db.user.findUnique({
    where: { id: args.managerId },
    select: { id: true, name: true, role: true, cafeId: true, branchId: true },
  });
  if (!manager) throw new ApiError(404, "المستخدم غير موجود");
  if (manager.role !== "SUPER_ADMIN" && manager.cafeId !== args.cafeId) {
    throw new ApiError(403, "ليس لديك صلاحية على هذا الكافيه");
  }
  if (args.viewerBranchId && manager.branchId && manager.branchId !== args.viewerBranchId) {
    throw new ApiError(403, "ليس لديك صلاحية على هذا الفرع");
  }

  // 2. Load handover session
  const handover = await db.handoverSession.findUnique({
    where: { id: args.handoverId },
    include: {
      outgoingShift: true,
      stockCountSession: {
        include: {
          lines: true,
        },
      },
    },
  });
  if (!handover || handover.cafeId !== args.cafeId) {
    throw new ApiError(404, "التسليم غير موجود");
  }
  if (args.viewerBranchId && handover.branchId !== args.viewerBranchId) {
    throw new ApiError(403, "التسليم يتبع فرعاً آخر");
  }

  if (handover.status === "COMPLETED") {
    return {
      alreadyApproved: true,
      handoverId: handover.id,
      itemsRebased: 0,
      message: "تم اعتماد هذا التسليم مسبقاً",
    };
  }

  const acceptedSessionId = handover.stockCountSessionId;

  // 3. Execute inside a transaction
  return await db.$transaction(
    async (tx) => {
      let itemsRebased = 0;
      let rebaseLines: { inventoryItemId: string; stockBefore: number; stockAfter: number }[] = [];

      if (acceptedSessionId) {
        // Ensure session is in a valid state
        const countSession = await tx.stockCountSession.findUnique({
          where: { id: acceptedSessionId },
          select: {
            id: true,
            status: true,
            lines: { select: { id: true, disposition: true, countedQuantity: true } },
          },
        });

        if (countSession) {
          // If lines are not terminal, mark COUNTED/OUTSIDE_TOLERANCE lines as VARIANCE_RECORDED so rebase acts on them
          const nonTerminal = countSession.lines.filter(
            (l) =>
              l.countedQuantity !== null &&
              !["WITHIN_TOLERANCE", "RESOLVED_WITHIN_TOLERANCE", "VARIANCE_CONFIRMED", "VARIANCE_RECORDED"].includes(
                l.disposition
              )
          );
          if (nonTerminal.length > 0) {
            await tx.stockCountLine.updateMany({
              where: { id: { in: nonTerminal.map((l) => l.id) } },
              data: { disposition: "VARIANCE_RECORDED" },
            });
          }

          if (countSession.status !== "CONFIRMED" && countSession.status !== "LOCKED") {
            await tx.stockCountSession.update({
              where: { id: acceptedSessionId },
              data: { status: "CONFIRMED", confirmedById: args.managerId, confirmedAt: new Date() },
            });
          }

          // Run rebase!
          const rebase = await rebaseFromCountInTransaction(tx, {
            sessionId: acceptedSessionId,
            actorId: args.managerId,
            idempotencyKey: `${handover.id}:manager-approve:${args.managerId}`,
            freezeToken: handover.id,
          });
          itemsRebased = rebase.itemsRebased;
          rebaseLines = rebase.lines.map((l) => ({
            inventoryItemId: l.inventoryItemId,
            stockBefore: l.stockBefore,
            stockAfter: l.stockAfter,
          }));

          // Stock boundary
          try {
            const boundary = await buildStockBoundary(tx, {
              cafeId: handover.cafeId,
              branchId: handover.branchId,
              handoverId: handover.id,
              acceptedSessionId,
            });
            await persistStockBoundary(tx, {
              handoverId: handover.id,
              lines: boundary.lines,
            });
            const boundaryRows = await tx.handoverStockBoundary.findMany({
              where: { handoverId: handover.id },
              select: { id: true, inventoryItemId: true },
            });
            const boundaryByItemId = new Map(boundaryRows.map((r) => [r.inventoryItemId, r.id]));

            // Variance cases
            await openHandoverVarianceCases(tx, {
              cafeId: handover.cafeId,
              branchId: handover.branchId,
              handoverId: handover.id,
              acceptedSessionId,
              outgoingCustodyPeriodId: handover.outgoingStockCustodyId,
              boundaryByItemId,
              openedById: args.managerId,
            });
          } catch (e) {
            console.warn("Boundary/variance case creation note:", e);
          }

          // Lock count session
          await lockCountSession(tx, {
            sessionId: acceptedSessionId,
            handoverId: handover.id,
            actorId: args.managerId,
          });
        }
      }

      const acceptedAt = new Date();

      // 4. Update handover session to COMPLETED
      await tx.handoverSession.update({
        where: { id: handover.id },
        data: {
          status: "COMPLETED",
          resolvedTarget: handover.target ?? "SHIFT_TO_SHIFT",
          acceptedStockCountSessionId: acceptedSessionId ?? undefined,
          acceptedAt,
          completedAt: acceptedAt,
          directAcknowledgedAt: handover.directAcknowledgedAt ?? acceptedAt,
          directAcknowledgedById: handover.directAcknowledgedById ?? args.managerId,
          incomingUserId: handover.incomingUserId ?? args.managerId,
          exceptionById: args.managerId,
          exceptionReason: args.note || "اعتماد جرد وتعديل أرصدة المخزون من المدير / المالك",
          exceptionAt: acceptedAt,
        },
      });

      // 5. Finalize outgoing shift if waiting
      if (handover.outgoingShiftId) {
        await tx.shift.updateMany({
          where: { id: handover.outgoingShiftId, status: "AWAITING_HANDOVER" },
          data: {
            status: "CLOSED",
            closedById: args.managerId,
            financiallyClosedAt: acceptedAt,
          },
        });
      }

      // 6. Release any inventory freeze
      const freeze = await tx.inventoryFreeze.findUnique({
        where: { handoverId: handover.id },
        select: { id: true, releasedAt: true, branchId: true },
      });
      if (freeze && !freeze.releasedAt) {
        try {
          await releaseInventoryFreeze(tx, { handoverId: handover.id, actorId: args.managerId });
          await applyDeferredDeductions(tx, { handoverId: handover.id, actorId: args.managerId });
        } catch (err) {
          console.warn("Inventory freeze release warning:", err);
        }
      }

      // 7. Record audit log
      await tx.auditLog.create({
        data: {
          cafeId: handover.cafeId,
          branchId: handover.branchId,
          userId: args.managerId,
          entity: "HandoverSession",
          entityId: handover.id,
          action: "HANDOVER_MANAGER_APPROVED",
          note: args.note
            ? `اعتماد المدير: ${args.note}`
            : `تم اعتماد الجرد وتحديث أرصدة المخزون (${itemsRebased} صنف)`,
        },
      });

      return {
        success: true,
        handoverId: handover.id,
        itemsRebased,
        lines: rebaseLines,
        message: `تم اعتماد الجرد بنجاح وتحديث أرصدة المخزون (${itemsRebased} صنف)`,
      };
    },
    { timeout: 30000 }
  );
}
