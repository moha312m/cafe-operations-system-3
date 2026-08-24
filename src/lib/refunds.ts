// ── Payment reversal service ─────────────────────────────────────────
// The single place a payment is reversed, so the period a reversal lands in
// is decided once.
//
// A refund is recorded as its own transaction: a REFUND-typed row carrying a
// positive magnitude, linked to the payment it reverses. The original
// collection is never rewritten — what was taken stays on the books, and
// what was returned sits beside it. Reporting can then group by intent
// rather than by the sign of a column (REFUND-001).
//
// Which period the refund lands in still depends on the original shift,
// because a shift close is a historical snapshot (SHIFT-002):
//
//   • Original shift still OPEN — the refund posts to that same shift, which
//     can still absorb its own reversal.
//
//   • Original shift already CLOSED — the closed period keeps the figures its
//     cashier accepted, and the refund posts to the refunder's own open shift,
//     where the money actually leaves the drawer.
//
// Cash never leaves a drawer nobody is holding: a CASH refund requires the
// person issuing it to hold an open shift at that branch, in either period.
// Being a manager is not a substitute for holding the drawer.

import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { ApiError } from "@/lib/api";
import { recomputeShiftTotals, requireCashCustody } from "@/lib/shifts";
import { recomputeSessionTotals } from "@/lib/table-sessions";
import { applyRefundToOrderSettlement } from "@/lib/payments";
import type { SessionUser } from "@/lib/auth";

export async function refundPayment(
  paymentId: string,
  session: SessionUser,
  reason?: string
) {
  const payment = await db.payment.findUnique({
    where: { id: paymentId },
    include: {
      order: { select: { orderNumber: true, tableSessionId: true } },
      shift: { select: { id: true, status: true, shiftNumber: true } },
      reversedBy: { select: { id: true } },
    },
  });
  if (!payment) throw new ApiError(404, "عملية الدفع مش موجودة");
  if (payment.type === "REFUND") throw new ApiError(400, "دي عملية عكسية مش دفعة");
  if (payment.status === "REFUNDED") throw new ApiError(400, "الدفعة مرتجعة بالفعل");
  if (payment.reversalOfPaymentId) throw new ApiError(400, "دي عملية عكسية مش دفعة");
  if (payment.reversedBy.length > 0) throw new ApiError(400, "الدفعة مرتجعة بالفعل");

  const closedPeriod = payment.shift?.status === "CLOSED";
  const amount = Number(payment.amount);

  // Where the refund posts. Cash requires custody either way — the difference
  // is only which shift can legitimately carry it.
  let targetShiftId: string | null;
  if (payment.method === "CASH") {
    if (!payment.branchId) {
      throw new ApiError(400, "الدفعة مش مربوطة بفرع — كلّم الدعم");
    }
    const custody = await requireCashCustody(
      payment.branchId,
      session.id,
      closedPeriod
        ? "الشيفت الأصلي مقفول — لازم تفتح شيفت لصرف المرتجع النقدي منه"
        : "لازم تفتح شيفت علشان تصرف المرتجع النقدي من الدرج"
    );
    // In period, the money goes back into the drawer that took it; the
    // refunder still had to be holding one to hand it over.
    targetShiftId = closedPeriod ? custody.id : payment.shiftId ?? custody.id;
  } else if (closedPeriod) {
    // Non-cash after close: attach to the refunder's open shift when they
    // have one, but never require a drawer for money that never touched one.
    const open = payment.branchId
      ? await db.shift.findFirst({
          where: { branchId: payment.branchId, cashierId: session.id, status: "OPEN" },
          select: { id: true },
        })
      : null;
    targetShiftId = open?.id ?? null;
  } else {
    targetShiftId = payment.shiftId;
  }

  const refund = await db.$transaction(async (tx) => {
    const row = await tx.payment.create({
      data: {
        cafeId: payment.cafeId,
        branchId: payment.branchId,
        orderId: payment.orderId,
        shiftId: targetShiftId,
        cashierId: session.id,
        amount, // positive magnitude — direction lives in `type`
        method: payment.method,
        type: "REFUND",
        status: "PAID",
        receivedById: session.id,
        tableSessionId: payment.tableSessionId,
        reversalOfPaymentId: payment.id,
        refundReason: reason,
        note: closedPeriod
          ? `عكس دفعة من شيفت مقفول #${payment.shift?.shiftNumber ?? "?"}`
          : undefined,
      },
    });
    // The order is owed again — paidAmount is a live balance, not a record of
    // what was once collected (REFUND-002).
    await applyRefundToOrderSettlement(tx, payment.orderId, amount);
    return row;
  });

  if (targetShiftId) await recomputeShiftTotals(targetShiftId);
  if (payment.order?.tableSessionId) {
    await recomputeSessionTotals(payment.order.tableSessionId);
  }
  await auditRefund(payment, session, {
    mode: closedPeriod ? "POST_CLOSE_REVERSAL" : "IN_PERIOD",
    refundPaymentId: refund.id,
    postedToShiftId: targetShiftId,
    closedShiftId: closedPeriod ? payment.shift?.id : undefined,
    reason,
  });
  return refund;
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
