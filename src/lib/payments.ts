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

// A loyalty redemption applied during collection. `points` were validated
// against the loyalty settings by the caller; the balance and per-order
// state are re-validated INSIDE the transaction.
export type CollectionRedemption = {
  customerId: string;
  points: number;
  discount: number; // EGP value = points × pointValueAmount
};

// Applies a loyalty discount to orders FIFO (like money allocation) inside
// a transaction: reduces each order's total, stamps its loyalty fields,
// and writes one REDEEM ledger row per affected order — so every order's
// fields always match its own ledger. Decrements the customer balance
// once. Throws ApiError on any safety violation.
export async function applyLoyaltyRedemptionInTx(
  tx: Prisma.TransactionClient,
  {
    orderIds,
    redemption,
    pointValue,
    cashierId,
  }: {
    orderIds: string[]; // FIFO order (oldest first)
    redemption: CollectionRedemption;
    pointValue: number;
    cashierId: string;
  }
) {
  // Re-read the customer inside the tx — concurrent redemptions serialize.
  const customer = await tx.customer.findUnique({
    where: { id: redemption.customerId },
    select: { id: true, cafeId: true, isActive: true, loyaltyPointsBalance: true },
  });
  if (!customer || !customer.isActive) throw new ApiError(400, "يجب اختيار عميل أولًا");
  if (customer.loyaltyPointsBalance < redemption.points) {
    throw new ApiError(400, "لا يوجد رصيد نقاط كافي");
  }

  let discountLeft = redemption.discount;
  let pointsLeft = redemption.points;
  const applied: { orderId: string; orderNumber: number; share: number; points: number }[] = [];

  for (const orderId of orderIds) {
    if (discountLeft <= 0.001) break;
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: {
        id: true, cafeId: true, orderNumber: true, total: true, paidAmount: true,
        discountAmount: true, loyaltyDiscountAmount: true, loyaltyPointsRedeemed: true,
      },
    });
    if (!order) continue;
    if (order.cafeId !== customer.cafeId) {
      throw new ApiError(403, "لا يمكن استخدام نقاط عميل من كافيه آخر");
    }
    const remaining = round2(Number(order.total) - Number(order.paidAmount));
    if (remaining <= 0.001) continue;

    const share = round2(Math.min(discountLeft, remaining));
    // Attribute points proportionally; the last affected order absorbs
    // rounding so points always sum exactly.
    const isLast = round2(discountLeft - share) <= 0.001;
    const sharePoints = isLast ? pointsLeft : Math.min(Math.floor(share / pointValue), pointsLeft);
    discountLeft = round2(discountLeft - share);
    pointsLeft -= sharePoints;

    const newTotal = round2(Number(order.total) - share);
    const newRemaining = Math.max(round2(newTotal - Number(order.paidAmount)), 0);
    await tx.order.update({
      where: { id: order.id },
      data: {
        total: newTotal,
        discountAmount: round2(Number(order.discountAmount) + share),
        loyaltyDiscountAmount: round2(Number(order.loyaltyDiscountAmount) + share),
        loyaltyPointsRedeemed: order.loyaltyPointsRedeemed + sharePoints,
        remainingAmount: newRemaining,
        paymentStatus: newRemaining <= 0.001 ? "PAID" : Number(order.paidAmount) > 0 ? "PARTIAL" : undefined,
        customerId: redemption.customerId, // link (or keep) the redeeming customer
      },
    });
    await tx.loyaltyTransaction.create({
      data: {
        cafeId: order.cafeId,
        customerId: customer.id,
        orderId: order.id,
        type: "REDEEM",
        points: -sharePoints,
        amountValue: share,
        note: `استخدام نقاط عند التحصيل — طلب #${order.orderNumber}`,
        createdByUserId: cashierId,
      },
    });
    applied.push({ orderId: order.id, orderNumber: order.orderNumber, share, points: sharePoints });
  }

  if (discountLeft > 0.001 || applied.length === 0) {
    throw new ApiError(400, "قيمة خصم النقاط أكبر من المتبقي على الحساب");
  }

  await tx.customer.update({
    where: { id: customer.id },
    data: {
      loyaltyPointsBalance: { decrement: redemption.points },
      lifetimePointsRedeemed: { increment: redemption.points },
    },
  });

  return { applied, oldBalance: customer.loyaltyPointsBalance };
}

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
  redemption,
  pointValue,
}: {
  session: SessionUser;
  orderId: string;
  branchId: string;
  splits: PaymentSplit[];
  // Optional loyalty redemption, applied atomically with the payment.
  redemption?: CollectionRedemption;
  pointValue?: number;
}) {
  // Cashiers must be on an open shift to touch the drawer.
  const shift = await getActiveShift(branchId, session.id);
  if (session.role === "CASHIER" && !shift) {
    throw new ApiError(400, "لا يمكن تحصيل الدفع بدون شيفت مفتوح");
  }

  const moneyAmount = Math.round(splits.reduce((s, p) => s + p.amount, 0) * 100) / 100;

  let result;
  let loyaltyResult: { applied: { orderId: string; orderNumber: number; share: number; points: number }[]; oldBalance: number } | null = null;
  try {
    result = await db.$transaction(async (tx) => {
      // Loyalty discount first (reduces the order total), then real money
      // against the reduced remaining — one atomic unit.
      if (redemption) {
        loyaltyResult = await applyLoyaltyRedemptionInTx(tx, {
          orderIds: [orderId],
          redemption,
          pointValue: pointValue ?? 1,
          cashierId: session.id,
        });
      }
      if (moneyAmount > 0) {
        return applyOrderPaymentInTx(tx, {
          orderId,
          splits,
          cashierId: session.id,
          shiftId: shift?.id ?? null,
        });
      }
      // Points covered the whole remaining — no money rows to write.
      const order = await tx.order.findUniqueOrThrow({
        where: { id: orderId },
        select: {
          id: true, cafeId: true, branchId: true, orderNumber: true,
          total: true, paidAmount: true, paymentStatus: true, tableSessionId: true,
          remainingAmount: true,
        },
      });
      const rem = Number(order.remainingAmount);
      return {
        order,
        payments: [] as { id: string }[],
        payAmount: 0,
        oldRemaining: Math.round((rem + (redemption?.discount ?? 0)) * 100) / 100,
        newRemaining: rem,
        oldStatus: order.paymentStatus,
        newStatus: order.paymentStatus,
        tableSessionId: order.tableSessionId,
      };
    });
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

  // (loyaltyResult is assigned inside the transaction callback — TS can't
  // track that, so re-widen the type here.)
  const lr = loyaltyResult as { applied: unknown; oldBalance: number } | null;
  if (redemption && lr) {
    await audit({
      cafeId: result.order.cafeId, userId: session.id,
      action: "LOYALTY_POINTS_REDEEMED",
      entity: "Customer", entityId: redemption.customerId,
      details: {
        customerId: redemption.customerId, orderId, branchId,
        points: redemption.points, amountValue: redemption.discount,
        oldValue: { balance: lr.oldBalance },
        newValue: { balance: lr.oldBalance - redemption.points },
      },
    });
  }

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
