// ── Central payment-collection service ───────────────────────────────
// THE single source of truth for collecting money against an order.
// Every collection path (POS single-order collect, POS table invoices,
// table-session FIFO allocations) funnels through applyOrderPaymentInTx,
// so remaining-amount math, duplicate guards, and denormalised status
// updates exist exactly once.

import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { ApiError } from "@/lib/api";
import { getActiveShift, recomputeShiftTotals } from "@/lib/shifts";
import { recomputeSessionTotals } from "@/lib/table-sessions";
import { maybeAwardLoyaltyPoints } from "@/lib/loyalty";
import type { Prisma, PaymentMethod } from "@prisma/client";
import type { SessionUser } from "@/lib/auth";

const round2 = (n: number) => Math.round(n * 100) / 100;

export type PaymentSplit = { method: Exclude<PaymentMethod, "MIXED">; amount: number };

// Applies one payment (possibly split across methods) to an order INSIDE
// an existing transaction. Re-reads the order via the tx client so the
// remaining amount is checked against committed state — the duplicate-
// payment guard. Throws ApiError(400) when the account is already settled
// or the amount exceeds what's left.
export async function applyOrderPaymentInTx(
  tx: Prisma.TransactionClient,
  {
    orderId,
    splits,
    cashierId,
    shiftId,
    tableSessionId,
    note,
  }: {
    orderId: string;
    splits: PaymentSplit[];
    cashierId: string;
    shiftId: string | null;
    tableSessionId?: string | null;
    note?: string | null;
  }
) {
  // Fresh read inside the transaction — concurrent collections serialize
  // here and the second one sees the updated remaining.
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: {
      id: true, cafeId: true, branchId: true, orderNumber: true,
      total: true, paidAmount: true, paymentStatus: true, tableSessionId: true,
    },
  });
  if (!order) throw new ApiError(404, "الطلب مش موجود");

  const oldRemaining = round2(Number(order.total) - Number(order.paidAmount));
  if (oldRemaining <= 0.001) {
    throw new DuplicatePaymentError(order.id, order.orderNumber, order.cafeId);
  }

  const payAmount = round2(splits.reduce((s, p) => s + p.amount, 0));
  if (payAmount <= 0) throw new ApiError(400, "مبلغ الدفع يجب أن يكون أكبر من صفر");
  if (payAmount > oldRemaining + 0.001) {
    throw new ApiError(400, "مبلغ الدفع أكبر من المتبقي على الطلب");
  }

  const sessionId = tableSessionId ?? order.tableSessionId;
  const payments = [];
  for (const s of splits) {
    payments.push(
      await tx.payment.create({
        data: {
          cafeId: order.cafeId,
          branchId: order.branchId,
          orderId: order.id,
          shiftId,
          cashierId,
          amount: s.amount,
          method: s.method,
          status: "PAID",
          receivedById: cashierId,
          tableSessionId: sessionId,
          note: note ?? undefined,
        },
      })
    );
  }

  const newPaid = round2(Number(order.paidAmount) + payAmount);
  const newRemaining = Math.max(round2(Number(order.total) - newPaid), 0);
  const newStatus = newRemaining <= 0.001 ? ("PAID" as const) : ("PARTIAL" as const);
  await tx.order.update({
    where: { id: order.id },
    data: { paidAmount: newPaid, remainingAmount: newRemaining, paymentStatus: newStatus },
  });

  return {
    order,
    payments,
    payAmount,
    oldRemaining,
    newRemaining,
    oldStatus: order.paymentStatus,
    newStatus,
    tableSessionId: sessionId,
  };
}

// Typed duplicate-payment failure so callers can audit it distinctly.
export class DuplicatePaymentError extends ApiError {
  orderId: string;
  orderNumber: number;
  cafeId: string;
  constructor(orderId: string, orderNumber: number, cafeId: string) {
    super(400, "تم تحصيل هذا الحساب بالفعل");
    this.orderId = orderId;
    this.orderNumber = orderNumber;
    this.cafeId = cafeId;
  }
}

// Full single-order collection flow used by the POS collection panel:
// shift gate → transaction (guarded payment) → totals recompute → loyalty
// earn → audits. The caller has already authorised the user and verified
// tenant scope on the order.
export async function collectOrderPayment({
  session,
  orderId,
  branchId,
  splits,
}: {
  session: SessionUser;
  orderId: string;
  branchId: string;
  splits: PaymentSplit[];
}) {
  // Cashiers must be on an open shift to touch the drawer.
  const shift = await getActiveShift(branchId, session.id);
  if (session.role === "CASHIER" && !shift) {
    throw new ApiError(400, "لا يمكن تحصيل الدفع بدون شيفت مفتوح");
  }

  let result;
  try {
    result = await db.$transaction((tx) =>
      applyOrderPaymentInTx(tx, {
        orderId,
        splits,
        cashierId: session.id,
        shiftId: shift?.id ?? null,
      })
    );
  } catch (e) {
    if (e instanceof DuplicatePaymentError) {
      await audit({
        cafeId: e.cafeId, userId: session.id,
        action: "DUPLICATE_PAYMENT_BLOCKED",
        entity: "Order", entityId: e.orderId,
        details: { orderId: e.orderId, orderNumber: e.orderNumber, branchId },
      });
    }
    throw e;
  }

  if (shift) await recomputeShiftTotals(shift.id);
  if (result.tableSessionId) await recomputeSessionTotals(result.tableSessionId);
  // Fully-paid orders earn their loyalty points exactly once (never throws).
  if (result.newStatus === "PAID") await maybeAwardLoyaltyPoints(orderId);

  const meta = {
    branchId,
    shiftId: shift?.id ?? null,
    orderId,
    orderNumber: result.order.orderNumber,
    tableSessionId: result.tableSessionId,
  };
  await audit({
    cafeId: result.order.cafeId, userId: session.id,
    action: "PAYMENT_COLLECTED_FROM_POS",
    entity: "Payment", entityId: result.payments[0]?.id ?? null,
    details: {
      ...meta,
      amount: result.payAmount,
      paymentMethod: splits.length > 1 ? "MIXED" : splits[0]?.method,
      oldRemainingAmount: result.oldRemaining,
      newRemainingAmount: result.newRemaining,
    },
  });
  if (result.oldStatus !== result.newStatus) {
    await audit({
      cafeId: result.order.cafeId, userId: session.id,
      action: "ORDER_PAYMENT_STATUS_CHANGED",
      entity: "Order", entityId: orderId,
      details: { ...meta, oldValue: result.oldStatus, newValue: result.newStatus },
    });
  }

  return { ...result, shift };
}
