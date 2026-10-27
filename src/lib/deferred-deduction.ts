import { hasPendingConsumption } from "@/lib/sale-consumption";
import type { Prisma } from "@prisma/client";
import { ApiError } from "@/lib/api";
import { auditInTransaction } from "@/lib/audit";
import { resolveStockAttribution } from "@/lib/ledger";
import { deductStockForOrder } from "@/lib/stock-deduction";

// Serving during a stock handover.
//
// While a handover's count is in progress the branch's inventory is frozen:
// no stock moves, so the count and the ledger describe the same shelf. An
// order served in that window — typically one the incoming shift took over —
// is still served; its recipe is recorded here and deducted when the freeze
// is released, inside the releasing transaction, against the STOCK custody
// open at that moment (the incoming custodian, or the branch).

type Tx = Prisma.TransactionClient;

export const STOCK_DEDUCTION_DEFERRED_AUDIT_ACTION = "STOCK_DEDUCTION_DEFERRED";
export const DEFERRED_DEDUCTION_APPLIED_AUDIT_ACTION = "DEFERRED_STOCK_DEDUCTION_APPLIED";

export async function recordDeferredDeduction(
  tx: Tx,
  args: {
    cafeId: string;
    branchId: string;
    orderId: string;
    orderNumber: number;
    freeze: { freezeId: string; handoverId: string };
    servedById: string;
    servedAt: Date;
  }
) {
  await tx.deferredStockDeduction.create({
    data: {
      cafeId: args.cafeId,
      branchId: args.branchId,
      orderId: args.orderId,
      freezeId: args.freeze.freezeId,
      handoverId: args.freeze.handoverId,
      servedById: args.servedById,
      servedAt: args.servedAt,
    },
  });
  await auditInTransaction(tx, {
    cafeId: args.cafeId,
    userId: args.servedById,
    action: STOCK_DEDUCTION_DEFERRED_AUDIT_ACTION,
    entity: "Order",
    entityId: args.orderId,
    details: {
      orderNumber: args.orderNumber,
      branchId: args.branchId,
      handoverId: args.freeze.handoverId,
      freezeId: args.freeze.freezeId,
    },
  });
}

/**
 * Deducts every pending deferred order of this handover. Call it right after
 * `releaseInventoryFreeze`, in the same transaction, once STOCK custody has
 * moved. Idempotent: applied rows are skipped, so a replayed release is a
 * no-op. A shortage is recorded (the drinks were already served), never
 * refused — refusing would block the handover over stock that is gone.
 */
export async function applyDeferredDeductions(
  tx: Tx,
  args: { handoverId: string; actorId: string }
): Promise<{ applied: number }> {
  const pending = await tx.deferredStockDeduction.findMany({
    where: { handoverId: args.handoverId, appliedAt: null },
    orderBy: { servedAt: "asc" },
    include: { order: { select: { orderNumber: true, stockDeductedAt: true } } },
  });
  if (pending.length === 0) return { applied: 0 };

  const appliedAt = new Date();
  for (const row of pending) {
    const attribution = await resolveStockAttribution(tx, row.branchId);
    if (!attribution.custodyPeriodId) {
      throw new ApiError(409, "مفيش عهدة مخزون مفتوحة في الفرع تتخصم منها الأوردرات اللي اتقدمت أثناء التسليم");
    }
    const deduction = !await hasPendingConsumption(tx, row.orderId)
      ? null
      : await deductStockForOrder(tx, row.orderId, args.actorId, attribution, { boundary: "DEFERRED", forceAllowNegative: true });
    if (deduction && !row.order.stockDeductedAt) {
      await tx.order.update({ where: { id: row.orderId }, data: { stockDeductedAt: appliedAt } });
    }
    await tx.deferredStockDeduction.update({
      where: { id: row.id },
      data: {
        appliedAt,
        appliedCustodyPeriodId: attribution.custodyPeriodId,
        appliedShiftId: attribution.shiftId,
      },
    });
    await auditInTransaction(tx, {
      cafeId: row.cafeId,
      userId: args.actorId,
      action: DEFERRED_DEDUCTION_APPLIED_AUDIT_ACTION,
      entity: "Order",
      entityId: row.orderId,
      details: {
        orderNumber: row.order.orderNumber,
        branchId: row.branchId,
        handoverId: row.handoverId,
        custodyPeriodId: attribution.custodyPeriodId,
        shiftId: attribution.shiftId,
        deducted: deduction?.deducted ?? [],
        productsWithoutRecipe: deduction?.productsWithoutRecipe ?? [],
        alreadyDeducted: deduction === null,
      },
    });
  }
  return { applied: pending.length };
}
