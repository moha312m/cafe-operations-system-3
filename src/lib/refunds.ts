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

/** A collection is refundable once, and a reversal is not itself refundable. */
function assertRefundable(p: {
  type: string; status: string; reversalOfPaymentId: string | null;
  reversedBy: { id: string }[];
}) {
  if (p.type === "REFUND") throw new ApiError(400, "دي عملية عكسية مش دفعة");
  if (p.reversalOfPaymentId) throw new ApiError(400, "دي عملية عكسية مش دفعة");
  if (p.status === "REFUNDED") throw new ApiError(400, "الدفعة مرتجعة بالفعل");
  if (p.reversedBy.length > 0) throw new ApiError(400, "الدفعة مرتجعة بالفعل");
}

/**
 * Which drawer carries this reversal.
 *
 * Cash requires the person issuing it to hold an open shift at the branch, in
 * either period — money never leaves a drawer nobody is holding, and being a
 * manager is not a substitute. A closed original shift keeps the figures its
 * cashier accepted, so the outflow posts to the refunder's own shift instead
 * (SHIFT-002).
 */
async function resolveRefundShift(
  payment: { method: string; branchId: string | null; shiftId: string | null },
  session: SessionUser,
  closedPeriod: boolean
): Promise<string | null> {
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
    return closedPeriod ? custody.id : payment.shiftId ?? custody.id;
  }
  if (closedPeriod) {
    // Non-cash after close attaches to the refunder's open shift when they
    // have one, but never requires a drawer for money that never touched one.
    const open = payment.branchId
      ? await db.shift.findFirst({
          where: { branchId: payment.branchId, cashierId: session.id, status: "OPEN" },
          select: { id: true },
        })
      : null;
    return open?.id ?? null;
  }
  return payment.shiftId;
}

/**
 * Refund an entire order.
 *
 * An order can hold several collections — a MIXED payment writes one row per
 * method, a PARTIAL order is collected again later, and table allocations pay
 * in instalments. Reversing them one at a time would let somebody refund the
 * cash leg of a mixed order, see "refunded", and leave the card leg standing.
 * So this is all-or-nothing: every collection is reversed inside one
 * transaction, or none is.
 */
export async function refundOrder(
  orderId: string,
  session: SessionUser,
  reason: string
) {
  const trimmed = (reason ?? "").trim();
  if (!trimmed) throw new ApiError(400, "لازم تكتب سبب الاسترجاع");

  const order = await db.order.findUnique({
    where: { id: orderId },
    select: {
      id: true, cafeId: true, orderNumber: true, paymentStatus: true, tableSessionId: true,
      payments: {
        select: {
          id: true, amount: true, method: true, type: true, status: true, branchId: true,
          shiftId: true, cafeId: true, tableSessionId: true, orderId: true,
          reversalOfPaymentId: true,
          reversedBy: { select: { id: true } },
          shift: { select: { id: true, status: true, shiftNumber: true } },
        },
      },
    },
  });
  if (!order) throw new ApiError(404, "الطلب مش موجود");
  if (order.paymentStatus === "REFUNDED") throw new ApiError(400, "الطلب مرتجع بالفعل");

  const collections = order.payments.filter(
    (p) => p.type === "COLLECTION" && p.status === "PAID" && !p.reversalOfPaymentId
  );
  if (collections.length === 0) throw new ApiError(400, "مفيش مبلغ محصّل على الطلب ده");
  for (const c of collections) assertRefundable(c);

  // Resolve every drawer BEFORE writing anything, so a missing custody on one
  // leg refuses the whole refund rather than half-reversing the order.
  const targets = new Map<string, string | null>();
  for (const c of collections) {
    targets.set(c.id, await resolveRefundShift(c, session, c.shift?.status === "CLOSED"));
  }

  const totalRefunded =
    Math.round(collections.reduce((s, c) => s + Number(c.amount), 0) * 100) / 100;

  const refunds = await db.$transaction(async (tx) => {
    // Claim the order before writing anything. Two refund requests that
    // arrive together — a double-tapped button, a retried request — both read
    // an unrefunded order and would both proceed, reversing the money twice.
    // This conditional update is the serialisation point: it locks the row,
    // and only one caller can find it un-refunded.
    const claimed = await tx.order.updateMany({
      where: { id: order.id, paymentStatus: { not: "REFUNDED" } },
      data: { paymentStatus: "REFUNDED" },
    });
    if (claimed.count === 0) throw new ApiError(400, "الطلب مرتجع بالفعل");

    // Re-check inside the lock: a concurrent caller may have reversed these
    // rows between our read and our claim.
    const stillOpen = await tx.payment.findMany({
      where: {
        orderId: order.id, type: "COLLECTION", status: "PAID",
        reversalOfPaymentId: null, reversedBy: { none: {} },
      },
      select: { id: true },
    });
    if (stillOpen.length !== collections.length) {
      throw new ApiError(400, "الطلب مرتجع بالفعل");
    }

    const rows = [];
    for (const c of collections) {
      rows.push(
        await tx.payment.create({
          data: {
            cafeId: c.cafeId,
            branchId: c.branchId,
            orderId: order.id,
            shiftId: targets.get(c.id) ?? null,
            cashierId: session.id,
            amount: Number(c.amount),
            method: c.method,
            type: "REFUND",
            status: "PAID",
            receivedById: session.id,
            tableSessionId: c.tableSessionId,
            reversalOfPaymentId: c.id,
            refundReason: trimmed,
            note:
              c.shift?.status === "CLOSED"
                ? `عكس دفعة من شيفت مقفول #${c.shift.shiftNumber}`
                : undefined,
          },
        })
      );
    }
    await applyRefundToOrderSettlement(tx, order.id, totalRefunded);
    return rows;
  });

  for (const shiftId of new Set([...targets.values()].filter(Boolean) as string[])) {
    await recomputeShiftTotals(shiftId);
  }
  if (order.tableSessionId) await recomputeSessionTotals(order.tableSessionId);

  await audit({
    cafeId: order.cafeId,
    userId: session.id,
    action: "PAYMENT_REFUNDED",
    entity: "Order",
    entityId: order.id,
    details: {
      orderId: order.id,
      orderNumber: order.orderNumber,
      mode: "FULL_ORDER_REFUND",
      totalRefunded,
      reason: trimmed,
      legs: collections.map((c) => ({
        paymentId: c.id,
        amount: Number(c.amount),
        method: c.method,
        postedToShiftId: targets.get(c.id) ?? null,
        originalShiftId: c.shiftId,
        originalShiftClosed: c.shift?.status === "CLOSED",
      })),
    },
  });

  const fresh = await db.order.findUniqueOrThrow({
    where: { id: order.id },
    select: {
      id: true, orderNumber: true, total: true, paidAmount: true,
      remainingAmount: true, paymentStatus: true,
    },
  });
  return { order: fresh, refunds, totalRefunded };
}

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
