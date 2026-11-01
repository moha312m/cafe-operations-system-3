import { PaymentMethod } from "@prisma/client";
import { db } from "@/lib/db";
import { paymentOverview } from "./handover-overview-model";

// Called only after incomingHandoverView has enforced the handover's scope and
// draft/disclosure policy. Full money and order details retain their existing
// oversight/order permissions; handover.view is not a financial-report grant.
export async function handoverOverview(id: string, cafeId: string, branchId: string, keys: Set<string>) {
  return db.$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const h = await tx.handoverSession.findFirstOrThrow({ where: { id, cafeId, branchId }, select: {
      submittedAt: true, acceptedAt: true, completedAt: true, countedOpeningCash: true,
      proposedOpeningCash: true, cashVarianceAmount: true, cashVerifiedAt: true,
      outgoingUser: { select: { name: true } }, incomingUser: { select: { name: true } },
      cashVerifiedBy: { select: { name: true } },
      outgoingShift: { select: { id: true, shiftNumber: true, financiallyClosedAt: true,
        openingCashAmount: true, expectedCashAmount: true, actualCashAmount: true, cashDifference: true,
        totalSales: true, totalCashSales: true, totalCardSales: true, totalWalletSales: true, totalRefunds: true,
        totalDiscounts: true, orderCount: true, cashReasonNote: true,
        tenderReconciliations: { select: { method: true, expectedAmount: true, actualAmount: true, varianceAmount: true, status: true, reasonNote: true } },
      } },
      cashStorage: { select: { closingAmount: true, leftInDrawer: true, toTreasury: true, declaredAt: true,
        movements: { orderBy: { createdAt: "asc" }, select: { id: true, amount: true, reason: true, createdAt: true, actor: { select: { name: true } } } } } },
      carriedOrders: { orderBy: { createdAt: "asc" }, select: { orderNumber: true, statusAtHandover: true, paymentStatusAtHandover: true, remainingAtHandover: true,
        order: { select: { status: true, paymentStatus: true, total: true, paidAmount: true } } } },
    } });
    const s = h.outgoingShift;
    const money = keys.has("shifts.view_reports") && s.financiallyClosedAt !== null ? {
      closedAt: s.financiallyClosedAt, sales: s.totalSales.toString(), refunds: s.totalRefunds.toString(), discounts: s.totalDiscounts.toString(), orderCount: s.orderCount,
      openingCash: s.openingCashAmount.toString(), expectedDrawer: s.expectedCashAmount.toString(), closingCount: s.actualCashAmount?.toString() ?? null,
      closingDifference: s.cashDifference?.toString() ?? null, closingReason: s.cashReasonNote,
      payments: paymentOverview(Object.values(PaymentMethod), { CASH: s.totalCashSales.toString(), CARD: s.totalCardSales.toString(), WALLET: s.totalWalletSales.toString() },
        s.tenderReconciliations.map(t => ({ ...t, expectedAmount: t.expectedAmount.toString(), actualAmount: t.actualAmount?.toString() ?? null, varianceAmount: t.varianceAmount?.toString() ?? null }))),
      storage: h.cashStorage,
      proposedTransfer: h.proposedOpeningCash?.toString() ?? null, receivedCash: h.countedOpeningCash?.toString() ?? null,
      receiptDifference: h.cashVarianceAmount?.toString() ?? null,
    } : null;
    return { shiftId: s.id, shiftNumber: s.shiftNumber, financiallyClosedAt: s.financiallyClosedAt,
      money, financialAccess: keys.has("shifts.view_reports"),
      operations: keys.has("orders.view") ? h.carriedOrders : null,
      signatures: { outgoingName: h.outgoingUser.name, submittedAt: h.submittedAt,
        incomingName: h.incomingUser?.name ?? null, acceptedAt: h.acceptedAt, completedAt: h.completedAt,
        cashVerifiedBy: h.cashVerifiedBy?.name ?? null, cashVerifiedAt: h.cashVerifiedAt },
    };
  }, { isolationLevel: "RepeatableRead" });
}
