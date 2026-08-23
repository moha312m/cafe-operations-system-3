// ── Payment reversal service ─────────────────────────────────────────
// The single place a payment is reversed, so the period a reversal lands in
// is decided once.
//
// Two cases, because a shift close is a historical snapshot (SHIFT-002):
//
//   • Original shift still OPEN (or unattached) — flip the row to REFUNDED
//     as before. The reversal belongs to the same period it was taken in.
//
//   • Original shift already CLOSED — leave the original row exactly as
//     posted and write a linked reversal row (negative amount, same method
//     and order) against the refunder's own open shift. The closed period
//     keeps the figures its cashier accepted; the cash impact lands in the
//     period where the money actually left the drawer.
//
// This reuses the existing Payment table rather than introducing a parallel
// ledger: reporting nets sale + reversal to zero across the two periods, and
// reversalOfPaymentId keeps the later event traceable to the original.

import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { ApiError } from "@/lib/api";
import { recomputeShiftTotals, requireCashCustody } from "@/lib/shifts";
import { recomputeSessionTotals } from "@/lib/table-sessions";
import type { SessionUser } from "@/lib/auth";

export async function refundPayment(paymentId: string, session: SessionUser) {
  const payment = await db.payment.findUnique({
    where: { id: paymentId },
    include: {
      order: { select: { orderNumber: true, tableSessionId: true } },
      shift: { select: { id: true, status: true, shiftNumber: true } },
      reversedBy: { select: { id: true } },
    },
  });
  if (!payment) throw new ApiError(404, "عملية الدفع مش موجودة");
  if (payment.status === "REFUNDED") throw new ApiError(400, "الدفعة مرتجعة بالفعل");
  if (payment.reversalOfPaymentId) throw new ApiError(400, "دي عملية عكسية مش دفعة");
  if (payment.reversedBy.length > 0) throw new ApiError(400, "الدفعة مرتجعة بالفعل");

  const closedPeriod = payment.shift?.status === "CLOSED";

  if (!closedPeriod) {
    // Same period: the original shift can still absorb its own reversal.
    const refunded = await db.payment.update({
      where: { id: payment.id },
      data: { status: "REFUNDED" },
    });
    if (payment.shiftId) await recomputeShiftTotals(payment.shiftId);
    if (payment.order?.tableSessionId) {
      await recomputeSessionTotals(payment.order.tableSessionId);
    }
    await auditRefund(payment, session, {
      mode: "IN_PERIOD",
      oldValue: "PAID",
      newValue: "REFUNDED",
    });
    return refunded;
  }

  // Closed period: never touch the accepted snapshot. Cash leaving the
  // drawer now needs a drawer to leave — non-cash reversals attach to the
  // refunder's open shift when they have one, but do not require it.
  let targetShiftId: string | null = null;
  if (payment.method === "CASH") {
    if (!payment.branchId) {
      throw new ApiError(400, "الدفعة مش مربوطة بفرع — كلّم الدعم");
    }
    const shift = await requireCashCustody(
      payment.branchId,
      session.id,
      "الشيفت الأصلي مقفول — لازم تفتح شيفت لصرف المرتجع النقدي منه"
    );
    targetShiftId = shift.id;
  } else if (payment.branchId) {
    const open = await db.shift.findFirst({
      where: { branchId: payment.branchId, cashierId: session.id, status: "OPEN" },
      select: { id: true },
    });
    targetShiftId = open?.id ?? null;
  }

  const reversal = await db.payment.create({
    data: {
      cafeId: payment.cafeId,
      branchId: payment.branchId,
      orderId: payment.orderId,
      shiftId: targetShiftId,
      cashierId: session.id,
      amount: -Number(payment.amount),
      method: payment.method,
      status: "PAID",
      receivedById: session.id,
      tableSessionId: payment.tableSessionId,
      reversalOfPaymentId: payment.id,
      note: `عكس دفعة من شيفت مقفول #${payment.shift?.shiftNumber ?? "?"}`,
    },
  });

  if (targetShiftId) await recomputeShiftTotals(targetShiftId);
  if (payment.order?.tableSessionId) {
    await recomputeSessionTotals(payment.order.tableSessionId);
  }
  await auditRefund(payment, session, {
    mode: "POST_CLOSE_REVERSAL",
    // The original row is deliberately left as posted, so record no status
    // transition on it — the reversal row carries the event instead.
    oldValue: payment.status,
    newValue: payment.status,
    reversalPaymentId: reversal.id,
    closedShiftId: payment.shift?.id,
    postedToShiftId: targetShiftId,
  });
  return reversal;
}

type RefundAuditExtra = Record<string, unknown>;

async function auditRefund(
  payment: {
    id: string; cafeId: string; branchId: string | null; shiftId: string | null;
    orderId: string; amount: unknown; method: string;
    order: { orderNumber: number } | null;
  },
  session: SessionUser,
  extra: RefundAuditExtra
) {
  await audit({
    cafeId: payment.cafeId,
    userId: session.id,
    action: "PAYMENT_REFUNDED",
    entity: "Payment",
    entityId: payment.id,
    details: {
      branchId: payment.branchId,
      shiftId: payment.shiftId,
      orderId: payment.orderId,
      orderNumber: payment.order?.orderNumber,
      amount: Number(payment.amount),
      method: payment.method,
      ...extra,
    },
  });
}
