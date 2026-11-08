import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { rebaseFromCountInTransaction } from "@/lib/stock-rebase";
import { lockCountSession } from "@/lib/stock-count";
import { releaseInventoryFreeze } from "@/lib/inventory-freeze";
import { applyDeferredDeductions } from "@/lib/deferred-deduction";
import { buildStockBoundary, persistStockBoundary } from "@/lib/handover-boundary";
import { openHandoverVarianceCases } from "@/lib/stock-variance-attribution";
import { settleRequiredItems } from "@/lib/handover-required-items";
import { ensureCustodyForShift } from "@/lib/custody";

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
    select: { id: true, name: true, role: true, cafeId: true, branchId: true, isActive: true, archivedAt: true },
  });
  if (!manager || !manager.isActive || manager.archivedAt) {
    throw new ApiError(403, "حساب المستخدم غير نشط");
  }
  if (manager.role !== "SUPER_ADMIN" && manager.cafeId !== args.cafeId) {
    throw new ApiError(403, "ليس لديك صلاحية على هذا الكافيه");
  }
  if (args.viewerBranchId && manager.branchId && manager.branchId !== args.viewerBranchId) {
    throw new ApiError(403, "ليس لديك صلاحية على هذا الفرع");
  }

  // 2. Execute inside a transaction with row lock on HandoverSession
  return await db.$transaction(
    async (tx) => {
      const lockedRows = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "HandoverSession" WHERE "id" = ${args.handoverId} FOR UPDATE
      `;
      if (lockedRows.length === 0) {
        throw new ApiError(404, "التسليم غير موجود");
      }

      const handover = await tx.handoverSession.findUnique({
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
          message: "تم اعتماد هذا التسليم وتحديث المخزون مسبقاً",
        };
      }

      const acceptedSessionId = handover.stockCountSessionId;
      let itemsRebased = 0;
      let rebaseLines: { inventoryItemId: string; stockBefore: number; stockAfter: number }[] = [];

      if (acceptedSessionId) {
        await tx.$queryRaw`
          SELECT "id" FROM "StockCountSession" WHERE "id" = ${acceptedSessionId} FOR UPDATE
        `;

        const countSession = await tx.stockCountSession.findUnique({
          where: { id: acceptedSessionId },
          select: {
            id: true,
            status: true,
            lines: {
              select: {
                id: true,
                disposition: true,
                countedQuantity: true,
                effectiveCountedQuantity: true,
                varianceQuantity: true,
              },
            },
          },
        });

        if (countSession) {
          const countedLines = countSession.lines.filter(
            (l) => l.countedQuantity !== null || l.effectiveCountedQuantity !== null
          );
          if (countSession.lines.length > 0 && countedLines.length === 0) {
            throw new ApiError(409, "لم يتم إدخال كميات الجرد بعد — يجب عدّ الأصناف أولاً قبل الاعتماد");
          }

          // Ensure all counted lines have a terminal disposition and effectiveCountedQuantity
          for (const line of countedLines) {
            const isTerm = [
              "WITHIN_TOLERANCE",
              "RESOLVED_WITHIN_TOLERANCE",
              "VARIANCE_CONFIRMED",
              "VARIANCE_RECORDED",
            ].includes(line.disposition);
            const needsEffective = line.effectiveCountedQuantity === null && line.countedQuantity !== null;

            if (!isTerm || needsEffective) {
              const nextDisp = isTerm
                ? line.disposition
                : line.varianceQuantity !== null && Number(line.varianceQuantity) === 0
                  ? "WITHIN_TOLERANCE"
                  : "VARIANCE_RECORDED";
              await tx.stockCountLine.update({
                where: { id: line.id },
                data: {
                  disposition: nextDisp,
                  ...(needsEffective ? { effectiveCountedQuantity: line.countedQuantity } : {}),
                },
              });
            }
          }

          if (countSession.status !== "CONFIRMED" && countSession.status !== "LOCKED") {
            await tx.stockCountSession.update({
              where: { id: acceptedSessionId },
              data: { status: "CONFIRMED", confirmedById: args.managerId, confirmedAt: new Date() },
            });
          }

          // Settle required items if configured
          try {
            await settleRequiredItems(tx, {
              handoverId: handover.id,
              acceptedSessionId,
              omissionNote: args.note || "اعتماد المدير / المالك",
            });
          } catch (e) {
            console.warn("settleRequiredItems note:", e);
          }

          // Run rebase!
          if (countSession.status !== "LOCKED") {
            const rebase = await rebaseFromCountInTransaction(tx, {
              sessionId: acceptedSessionId,
              actorId: args.managerId,
              idempotencyKey: `${handover.id}:manager-approve`,
              freezeToken: handover.id,
            });
            itemsRebased = rebase.itemsRebased;
            rebaseLines = rebase.lines.map((l) => ({
              inventoryItemId: l.inventoryItemId,
              stockBefore: l.stockBefore,
              stockAfter: l.stockAfter,
            }));
          }

          // Stock boundary & Variance cases
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

          // Lock count session if not already locked
          if (countSession.status !== "LOCKED") {
            await lockCountSession(tx, {
              sessionId: acceptedSessionId,
              handoverId: handover.id,
              actorId: args.managerId,
            });
          }
        }
      }

      // 3. Release any inventory freeze & apply deferred deductions while outgoing stock custody is still open
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

      // Capture timestamp after variance cases so span timestamps are never after acceptedAt
      const acceptedAt = new Date();

      // 4. Finalize outgoing shift if still AWAITING_HANDOVER
      if (handover.outgoingShiftId) {
        await tx.shift.updateMany({
          where: { id: handover.outgoingShiftId, status: "AWAITING_HANDOVER" },
          data: {
            status: "CLOSED",
            stockClosedAt: acceptedAt,
            closedAt: acceptedAt,
            closedById: args.managerId,
          },
        });
      }

      // 5. Retire/close outgoing CASH and STOCK CustodyPeriods if no other shift is active on them
      const shiftCustodies = handover.outgoingShiftId
        ? await tx.shiftCustody.findMany({
            where: { shiftId: handover.outgoingShiftId },
            select: { custodyPeriodId: true },
          })
        : [];
      const periodIds = new Set<string>(shiftCustodies.map((sc) => sc.custodyPeriodId));
      if (handover.outgoingCashCustodyId) periodIds.add(handover.outgoingCashCustodyId);
      if (handover.outgoingStockCustodyId) periodIds.add(handover.outgoingStockCustodyId);

      for (const periodId of periodIds) {
        const period = await tx.custodyPeriod.findUnique({ where: { id: periodId } });
        if (!period || period.status !== "OPEN") continue;
        const activeOtherShifts = await tx.shiftCustody.count({
          where: {
            custodyPeriodId: period.id,
            ...(handover.outgoingShiftId ? { shiftId: { not: handover.outgoingShiftId } } : {}),
            shift: { status: { in: ["OPEN", "AWAITING_HANDOVER"] } },
          },
        });
        if (activeOtherShifts > 0) continue;
        await tx.custodyPeriod.update({
          where: { id: period.id },
          data: {
            status: "CLOSED",
            endedAt: acceptedAt,
            acceptedById: args.managerId,
            acceptedAt,
            ...(period.scope === "CASH" && handover.outgoingShift?.actualCashAmount != null
              ? { closingCashAmount: handover.outgoingShift.actualCashAmount }
              : {}),
          },
        });
      }

      // 6. Update handover session to COMPLETED
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

      // 7. Unblock any incoming shift in this branch that was waiting on AWAITING_CUSTODY_TRANSFER
      const waitingShifts = await tx.shift.findMany({
        where: {
          cafeId: handover.cafeId,
          branchId: handover.branchId,
          status: "OPEN",
          custodyGateReason: "AWAITING_CUSTODY_TRANSFER",
        },
        orderBy: { shiftNumber: "asc" },
        select: { id: true, cashierId: true, openingCashAmount: true },
      });
      for (const ws of waitingShifts) {
        try {
          await ensureCustodyForShift(tx, {
            cafeId: handover.cafeId,
            branchId: handover.branchId,
            shiftId: ws.id,
            userId: ws.cashierId,
            openingCashAmount: Number(ws.openingCashAmount),
          });
        } catch (err) {
          console.warn("Waiting shift custody bootstrap note:", err);
        }
      }

      // 8. Record audit log
      await tx.auditLog.create({
        data: {
          cafeId: handover.cafeId,
          userId: args.managerId,
          entity: "HandoverSession",
          entityId: handover.id,
          action: "HANDOVER_MANAGER_APPROVED",
          details: {
            branchId: handover.branchId,
            handoverId: handover.id,
            outgoingShiftId: handover.outgoingShiftId,
            acceptedSessionId,
            itemsRebased,
            note: args.note ?? null,
          },
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
