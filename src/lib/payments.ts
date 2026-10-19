import { decimal, money, sumMoney, moneyMin, moneyMax, type Numeric, type Decimal, validCurrencyInput } from "@/lib/money";
import { protectedTransaction, queueRefusalAudit } from "@/lib/protected-transaction";
// ── Central payment-collection service ───────────────────────────────
// THE single source of truth for collecting money against an order.
// Every collection path (POS single-order collect, POS table invoices,
// table-session FIFO allocations) funnels through applyOrderPaymentInTx,
// so remaining-amount math, duplicate guards, and denormalised status
// updates exist exactly once.

import { auditInTransaction } from "@/lib/audit";
import { ApiError, resolveReadScope } from "@/lib/api";
import { recomputeShiftTotals } from "@/lib/shifts";
import { recomputeSessionTotals } from "@/lib/table-sessions";
import { maybeAwardLoyaltyPoints } from "@/lib/loyalty";
import type { Prisma, PaymentMethod } from "@prisma/client";
import type { SessionUser } from "@/lib/auth";

import { requireCashCustodyInTx, validateOpenPostingShift, assertFinancialLocks, lockOrders, lockOrderPayments, lockCustomers } from "@/lib/transaction-locks";



export type PaymentSplit = { method: Exclude<PaymentMethod, "MIXED">; amount: Numeric };

// Close an order out after its money has been returned.
//
// `paidAmount` is the live settlement balance rather than a record of what was
// once collected, so leaving it at the full total after a refund reads as
// money the café is still holding (REFUND-002).
//
// A FULL refund is terminal: nothing is paid and nothing is owed. REFUNDED
// means the customer owes nothing — not that the bill has reopened. Leaving a
// receivable behind would let Gross 120 / Refunds 120 / Net 0 coexist with a
// live 120 against the same sale, which no reconciliation can express. A
// customer who buys again gets a new order.
//
// History is not lost by this: the Payment rows keep both the collection and
// the refund, so what actually moved stays derivable.
export async function applyRefundToOrderSettlement(
  tx: Prisma.TransactionClient,
  orderId: string,
  amount: Numeric
) {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: { total: true, paidAmount: true },
  });
  if (!order) return;

  const newPaid = moneyMax(money(decimal(order.paidAmount).minus(decimal(amount))), 0);
  const fullyRefunded = newPaid.isZero();

  await tx.order.update({
    where: { id: orderId },
    data: {
      paidAmount: newPaid,
      // Terminal on a full refund; a part-refund leaves the balance owed.
      remainingAmount: fullyRefunded ? 0 : moneyMax(money(decimal(order.total).minus(newPaid)), 0),
      paymentStatus: fullyRefunded ? "REFUNDED" : "PARTIAL",
    },
  });
}

// A loyalty redemption applied during collection. `points` were validated
// against the loyalty settings by the caller; the balance and per-order
// state are re-validated INSIDE the transaction.
export type CollectionRedemption = {
  customerId: string;
  points: number;
  discount: Numeric; // EGP value = points × pointValueAmount
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
    pointValue: Numeric;
    cashierId: string;
  }
) {
  // Read the customer for the things that do not change under contention —
  // which café they belong to, whether they are active, and the balance this
  // redemption will be reported against.
  //
  // NOT for deciding whether the points are there. This read used to claim
  // that "concurrent redemptions serialize", and it does not: a SELECT takes
  // no lock under READ COMMITTED, so two collections both saw the same
  // balance, both passed the check below, and both subtracted — leaving the
  // customer owing the café points it had already given away. The decision is
  // made by the conditional update at the end of this function, which is the
  // only statement that can make it atomically (R-POS-02B1).
  const customer = await tx.customer.findUnique({
    where: { id: redemption.customerId },
    select: { id: true, cafeId: true, isActive: true, loyaltyPointsBalance: true },
  });
  if (!customer || !customer.isActive) throw new ApiError(400, "يجب اختيار عميل أولًا");
  // A courtesy check, not the guard: it refuses the common case early, before
  // any order is rewritten, and says so in the cashier's own words.
  if (customer.loyaltyPointsBalance < redemption.points) {
    throw new ApiError(400, "لا يوجد رصيد نقاط كافي");
  }

  let discountLeft = money(redemption.discount);
  let pointsLeft = redemption.points;
  const applied: { orderId: string; orderNumber: number; share: Decimal; points: number }[] = [];

  for (const orderId of orderIds) {
    if (discountLeft.lte(0)) break;
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: {
        id: true, cafeId: true, orderNumber: true, total: true, paidAmount: true, paymentStatus: true,
        discountAmount: true, loyaltyDiscountAmount: true, loyaltyPointsRedeemed: true,
      },
    });
    if (!order || order.paymentStatus === "REFUNDED") continue;
    if (order.cafeId !== customer.cafeId) {
      throw new ApiError(403, "لا يمكن استخدام نقاط عميل من كافيه آخر");
    }
    const remaining = money(decimal(order.total).minus(order.paidAmount));
    if (remaining.lte(0)) continue;

    const share = money(moneyMin(discountLeft, remaining));
    // Attribute points proportionally; the last affected order absorbs
    // rounding so points always sum exactly.
    const isLast = discountLeft.minus(share).lte(0);
    const sharePoints = isLast ? pointsLeft : Math.min(share.div(decimal(pointValue)).floor().toNumber(), pointsLeft);
    discountLeft = money(discountLeft.minus(share));
    pointsLeft -= sharePoints;

    const newTotal = money(decimal(order.total).minus(share));
    const newRemaining = moneyMax(money(newTotal.minus(order.paidAmount)), 0);
    await tx.order.update({
      where: { id: order.id },
      data: {
        total: newTotal,
        discountAmount: money(decimal(order.discountAmount).plus(share)),
        loyaltyDiscountAmount: money(decimal(order.loyaltyDiscountAmount).plus(share)),
        loyaltyPointsRedeemed: order.loyaltyPointsRedeemed + sharePoints,
        remainingAmount: newRemaining,
        paymentStatus: newRemaining.isZero() ? "PAID" : decimal(order.paidAmount).gt(0) ? "PARTIAL" : undefined,
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

  if (discountLeft.gt(0) || applied.length === 0) {
    throw new ApiError(400, "قيمة خصم النقاط أكبر من المتبقي على الحساب");
  }

  // The guard and the write are one statement. PostgreSQL re-evaluates a
  // WHERE clause against the committed row when an UPDATE has waited on
  // another transaction's lock, so a redemption that lost the race matches
  // nothing, changes nothing, and is told so — the balance cannot be driven
  // below zero by concurrency, without a CHECK constraint and without a
  // migration. Same shape as the conditional refund guard in refunds.ts.
  const claimed = await tx.customer.updateMany({
    where: { id: customer.id, loyaltyPointsBalance: { gte: redemption.points } },
    data: {
      loyaltyPointsBalance: { decrement: redemption.points },
      lifetimePointsRedeemed: { increment: redemption.points },
    },
  });
  if (claimed.count === 0) {
    // Throwing rolls the whole collection back, so the orders discounted
    // above are restored with it — points are never given away free.
    throw new ApiError(400, "لا يوجد رصيد نقاط كافي");
  }

  // The balance the audit reports is read back, not carried down from the
  // read at the top: another redemption may have committed in between and
  // still left enough points for this one, in which case the figure that was
  // read is not the balance this deduction actually started from.
  const after = await tx.customer.findUniqueOrThrow({
    where: { id: customer.id },
    select: { loyaltyPointsBalance: true },
  });

  return { applied, oldBalance: after.loyaltyPointsBalance + redemption.points };
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
  // The row lock is the serialisation point, and it has to be a lock.
  //
  // This was a plain `findUnique` with a comment claiming that "concurrent
  // collections serialize here". They did not: under PostgreSQL's default
  // READ COMMITTED a plain SELECT blocks nobody, and no isolation level is
  // configured anywhere in this application. Two cashiers — or one cashier
  // double-tapping "تحصيل", or a client retrying a slow request — both read
  // `paidAmount = 0`, both passed the duplicate guard below, and both wrote
  // an ABSOLUTE `paidAmount`. The order ended up paid once with two payment
  // rows against it, and because `recomputeShiftTotals` sums payment ROWS,
  // the drawer was then expected to hold twice the sale: a shortage raised
  // at close against a cashier who took the money exactly once.
  //
  // `FOR UPDATE` makes the second caller wait for the first to commit and
  // then read what it wrote, so the guard below refuses it. Same shape as
  // `lockShift` in cash-close and `lockItemForUpdate` in the ledger.
  if (!shiftId) throw new ApiError(400, "التحصيل محتاج شيفت مفتوح");
  assertFinancialLocks(tx, [orderId], shiftId);
  const shift = await validateOpenPostingShift(tx, shiftId);
  if (shift.cashierId !== cashierId) throw new ApiError(409, "عهدة الشيفت اتغيرت");

  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: {
      id: true, cafeId: true, branchId: true, orderNumber: true,
      total: true, paidAmount: true, paymentStatus: true, tableSessionId: true, status: true,
    },
  });
  if (!order) throw new ApiError(404, "الطلب مش موجود");

  if (shift.branchId !== order.branchId || shift.cafeId !== order.cafeId) throw new ApiError(403, "شيفت التحصيل تبع فرع تاني");
  if (["CANCELLED", "REJECTED", "PENDING_WAITER_APPROVAL"].includes(order.status)) throw new ApiError(400, "حالة الطلب الحالية مش بتسمح بالتحصيل");
  if (splits.some((p) => !validCurrencyInput(p.amount.toString()) || decimal(p.amount).lte(0))) throw new ApiError(400, "المبالغ لازم تكون موجبة وبحد أقصى رقمين بعد العلامة");

  // A refunded sale is closed for good. This has to be checked explicitly:
  // the guard below derives remaining from `total - paidAmount`, and a full
  // refund leaves paidAmount at zero, which would otherwise look like an
  // ordinary unpaid order and let the same sale be collected twice. A
  // customer buying again gets a new order (REFUND-002).
  if (order.paymentStatus === "REFUNDED") {
    throw new ApiError(400, "الطلب ده مرتجع — اعمل طلب جديد بدل ما تحصّل عليه");
  }

  const oldRemaining = money(decimal(order.total).minus(order.paidAmount));
  if (oldRemaining.lte(0)) {
    throw new DuplicatePaymentError(order.id, order.orderNumber, order.cafeId);
  }

  const payAmount = money(sumMoney(splits.map(p => p.amount)));
  if (payAmount.lte(0)) throw new ApiError(400, "مبلغ الدفع يجب أن يكون أكبر من صفر");
  if (payAmount.gt(oldRemaining)) {
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
          amount: money(s.amount),
          method: s.method,
          status: "PAID",
          receivedById: cashierId,
          tableSessionId: sessionId,
          note: note ?? undefined,
        },
      })
    );
  }

  const newPaid = money(decimal(order.paidAmount).plus(payAmount));
  const newRemaining = moneyMax(money(decimal(order.total).minus(newPaid)), 0);
  const newStatus = newRemaining.isZero() ? ("PAID" as const) : ("PARTIAL" as const);
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
const verifiedCollections = new WeakMap<object, WeakSet<object>>();
export async function prepareOrderCollection(tx: Prisma.TransactionClient, session: SessionUser, orderId: string, branchId: string) {
    const shift = await requireCashCustodyInTx(tx, branchId, session.id);
    await lockOrders(tx, [orderId]);
    await lockOrderPayments(tx, [orderId]);
    const current = await tx.order.findFirst({ where: { id: orderId, ...resolveReadScope(session) } });
    if (!current) throw new ApiError(404, "الطلب مش موجود");
    if (current.branchId !== shift.branchId || current.cafeId !== shift.cafeId) throw new ApiError(403, "الطلب وعهدة الكاش تابعين لفروع مختلفة");
    if (current.paymentStatus === "REFUNDED") throw new ApiError(400, "الطلب ده مرتجع — اعمل طلب جديد بدل ما تحصّل عليه");
    if (["CANCELLED", "REJECTED", "PENDING_WAITER_APPROVAL"].includes(current.status)) throw new ApiError(400, "حالة الطلب الحالية مش بتسمح بالتحصيل");
  const context = { shift, current };
  const verified = verifiedCollections.get(tx) ?? new WeakSet<object>();
  verified.add(context); verifiedCollections.set(tx, verified);
  return context;
}
export type CollectionLockContext = Awaited<ReturnType<typeof prepareOrderCollection>>;
function verifyCollectionContext(tx: Prisma.TransactionClient, context: CollectionLockContext, orderId: string, cashierId: string) {
  if (!verifiedCollections.get(tx)?.has(context) || context.current.id !== orderId || context.shift.cashierId !== cashierId) throw new Error("Collection context belongs to another transaction or target");
  return context;
}

export async function collectOrderPayment({
  session,
  orderId,
  branchId,
  splits,
  redemption,
  pointValue,
  client,
  locked,
}: {
  session: SessionUser;
  orderId: string;
  branchId: string;
  splits: PaymentSplit[];
  // Optional loyalty redemption, applied atomically with the payment.
  redemption?: CollectionRedemption;
  pointValue?: Numeric;
  client?: Prisma.TransactionClient;
  locked?: CollectionLockContext;
}) {
  // Anyone touching the drawer must be on an open shift — see
  // requireCashCustody. The caller has already authorised the collection.
  const work = async (tx: Prisma.TransactionClient) => {
    const { shift, current } = locked ? verifyCollectionContext(tx, locked, orderId, session.id) : await prepareOrderCollection(tx, session, orderId, branchId);
    if (redemption && current.loyaltyPointsRedeemed > 0) throw new ApiError(400, "تم استخدام نقاط الولاء لهذا الطلب بالفعل");
    await lockCustomers(tx, [current.customerId, redemption?.customerId].filter((id): id is string => !!id));

    const moneyAmount = money(sumMoney(splits.map(p => p.amount)));

    let result;
    let loyaltyResult: { applied: { orderId: string; orderNumber: number; share: Decimal; points: number }[]; oldBalance: number } | null = null;
    try {
      result = await (async () => {
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
        if (moneyAmount.gt(0)) {
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
        const rem = money(order.remainingAmount);
        return {
          order,
          payments: [] as { id: string }[],
          payAmount: decimal(0),
          oldRemaining: money(rem.plus(decimal(redemption?.discount ?? 0))),
          newRemaining: rem,
          oldStatus: order.paymentStatus,
          newStatus: order.paymentStatus,
          tableSessionId: order.tableSessionId,
        };
      })();
    } catch (e) {
      if (e instanceof DuplicatePaymentError) {
        queueRefusalAudit(tx, {
          cafeId: e.cafeId, userId: session.id,
          action: "DUPLICATE_PAYMENT_BLOCKED",
          entity: "Order", entityId: e.orderId,
          details: { orderId: e.orderId, orderNumber: e.orderNumber, branchId },
        });
      }
      throw e;
    }

    if (shift) await recomputeShiftTotals(shift.id, tx);
    if (result.tableSessionId) await recomputeSessionTotals(result.tableSessionId, tx);
    // Fully-paid orders earn points in the same transaction.
    if (result.newStatus === "PAID") await maybeAwardLoyaltyPoints(orderId, tx);

    // (loyaltyResult is assigned inside the transaction callback — TS can't
    // track that, so re-widen the type here.)
    const lr = loyaltyResult as { applied: unknown; oldBalance: number } | null;
    if (redemption && lr) {
      await auditInTransaction(tx, {
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
    await auditInTransaction(tx, {
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
      await auditInTransaction(tx, {
        cafeId: result.order.cafeId, userId: session.id,
        action: "ORDER_PAYMENT_STATUS_CHANGED",
        entity: "Order", entityId: orderId,
        details: { ...meta, oldValue: result.oldStatus, newValue: result.newStatus },
      });
    }

    return { ...result, shift };
  };
  if (client) return work(client);
  return protectedTransaction(work, resolveReadScope(session));
}
