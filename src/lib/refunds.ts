import { money, sumMoney } from "@/lib/money";
import { protectedTransaction } from "@/lib/protected-transaction";
import type { Prisma } from "@prisma/client";
import type { SessionUser } from "@/lib/auth";
import { ApiError, resolveReadScope } from "@/lib/api";
import { auditInTransaction } from "@/lib/audit";
import { recomputeShiftTotals } from "@/lib/shifts";
import { recomputeSessionTotals } from "@/lib/table-sessions";
import { applyRefundToOrderSettlement } from "@/lib/payments";
import { lockShifts, lockOrders, lockOrderPayments, validateOpenPostingShift } from "@/lib/transaction-locks";

function assertRefundable(p: { type: string; status: string; reversalOfPaymentId: string | null; reversedBy: { id: string }[] }) {
  if (p.type !== "COLLECTION" || p.reversalOfPaymentId) throw new ApiError(400, "مينفعش تعمل مرتجع لعملية مرتجع");
  if (p.status !== "PAID" || p.reversedBy.length) throw new ApiError(400, "الدفعة مرتجعة بالفعل أو لم يتم تحصيلها");
}
const verifiedRefundLocks = new WeakMap<object, WeakSet<object>>();
/** Identify rows inside the transaction, then re-read financial state only
 * after Shift → Order → Payment locks. Never acquire a new Shift lock later.
 */
export async function lockRefundOrderForAction(tx: Prisma.TransactionClient, orderId: string, actor: SessionUser) {
  const scope = resolveReadScope(actor);
  const candidate = await tx.order.findFirst({
    where: { id: orderId, ...scope }, select: {
      id: true, cafeId: true, branchId: true, payments: { select: { shiftId: true } },
    }
  });
  if (!candidate) throw new ApiError(404, "الطلب مش موجود");
  const drawer = await tx.shift.findFirst({ where: { branchId: candidate.branchId, cashierId: actor.id, status: "OPEN" }, orderBy: { openedAt: "desc" }, select: { id: true } });
  const shiftIds = [...new Set([...candidate.payments.map((p) => p.shiftId).filter((id): id is string => !!id), ...(drawer ? [drawer.id] : [])])];
  await lockShifts(tx, shiftIds);
  await lockOrders(tx, [orderId]);
  await lockOrderPayments(tx, [orderId]);
  const order = await tx.order.findFirst({
    where: { id: orderId, ...scope }, include: {
      payments: { orderBy: { id: "asc" }, include: { reversedBy: { select: { id: true } }, shift: { select: { id: true, status: true, shiftNumber: true } } } },
    }
  });
  if (!order) throw new ApiError(404, "الطلب مش موجود");
  if (order.branchId !== candidate.branchId || order.payments.some((p) => p.shiftId && !shiftIds.includes(p.shiftId))) throw new ApiError(409, "التحصيل اتغير أثناء بدء المرتجع — جرّب تاني");
  const context = { order, drawerId: drawer?.id ?? null };
  const verified = verifiedRefundLocks.get(tx) ?? new WeakSet<object>();
  verified.add(context); verifiedRefundLocks.set(tx, verified);
  return context;
}
export type RefundLockContext = Awaited<ReturnType<typeof lockRefundOrderForAction>>;
function verifyRefundContext(tx: Prisma.TransactionClient, context: RefundLockContext, orderId: string) {
  if (!verifiedRefundLocks.get(tx)?.has(context) || context.order.id !== orderId) throw new Error("Refund context belongs to another transaction or target");
  return context;
}
type Collection = Awaited<ReturnType<typeof lockRefundOrderForAction>>["order"]["payments"][number];
async function refundTarget(tx: Prisma.TransactionClient, p: Collection, actor: SessionUser, drawerId: string | null, branchId: string) {
  const historical = !p.shift || p.shift.status !== "OPEN";
  if (p.method === "CASH") {
    if (!drawerId) throw new ApiError(400, "مرتجع الكاش محتاج شيفت مفتوح بعهدتك");
    const drawer = await validateOpenPostingShift(tx, drawerId, branchId, p.cafeId);
    if (drawer.cashierId !== actor.id) throw new ApiError(409, "عهدة الشيفت اتغيرت");
  }
  const target = historical ? drawerId : p.shiftId;
  if (target) await validateOpenPostingShift(tx, target, branchId, p.cafeId);
  // Unattached historical noncash reversals preserve the existing contract.
  return target;
}
async function writeReversal(tx: Prisma.TransactionClient, p: Collection, actor: SessionUser, reason: string, targetShiftId: string | null) {
  return tx.payment.create({
    data: {
      cafeId: p.cafeId, branchId: p.branchId, orderId: p.orderId,
      shiftId: targetShiftId, cashierId: actor.id, receivedById: actor.id,
      amount: p.amount, method: p.method, type: "REFUND", status: "PAID",
      tableSessionId: p.tableSessionId, reversalOfPaymentId: p.id, refundReason: reason,
      note: p.shift && p.shift.status !== "OPEN" ? `مرتجع من شيفت مقفول رقم ${p.shift.shiftNumber}` : undefined,
    }
  });
}
async function refundOrderCore(tx: Prisma.TransactionClient, orderId: string, actor: SessionUser, reason: string, locked?: RefundLockContext) {
  const trimmed = reason?.trim();
  if (!trimmed) throw new ApiError(400, "لازم تكتب سبب المرتجع");
  const { order, drawerId } = locked ? verifyRefundContext(tx, locked, orderId) : await lockRefundOrderForAction(tx, orderId, actor);
  if (order.paymentStatus === "REFUNDED") throw new ApiError(400, "الطلب مرتجع بالفعل");
  const collections = order.payments.filter((p) => p.type === "COLLECTION" && p.status === "PAID" && !p.reversalOfPaymentId && p.reversedBy.length === 0);
  if (!collections.length) throw new ApiError(400, "مفيش مبلغ متحصل على الطلب ده");
  const targets = new Map<string, string | null>();
  for (const p of collections) {
    assertRefundable(p);
    targets.set(p.id, await refundTarget(tx, p, actor, drawerId, order.branchId));
  }
  const totalRefunded = money(sumMoney(collections.map(p => p.amount)));
  const refunds = [];
  for (const p of collections) refunds.push(await writeReversal(tx, p, actor, trimmed, targets.get(p.id) ?? null));
  await applyRefundToOrderSettlement(tx, order.id, totalRefunded);
  for (const id of [...new Set([...targets.values()].filter((id): id is string => !!id))].sort()) await recomputeShiftTotals(id, tx);
  if (order.tableSessionId) await recomputeSessionTotals(order.tableSessionId, tx);
  await auditInTransaction(tx, {
    cafeId: order.cafeId, userId: actor.id, action: "PAYMENT_REFUNDED", entity: "Order", entityId: order.id,
    details: {
      orderId, orderNumber: order.orderNumber, mode: "FULL_ORDER_REFUND", totalRefunded, reason: trimmed,
      legs: collections.map((p) => ({
        paymentId: p.id, amount: Number(p.amount), method: p.method,
        postedToShiftId: targets.get(p.id) ?? null, originalShiftId: p.shiftId, originalShiftClosed: p.shift?.status !== "OPEN"
      })),
    },
  });
  const fresh = await tx.order.findUniqueOrThrow({
    where: { id: order.id }, select: {
      id: true, orderNumber: true, total: true, paidAmount: true, remainingAmount: true, paymentStatus: true,
    }
  });
  return { order: fresh, refunds, totalRefunded: totalRefunded.toNumber() };
}
async function refundPaymentCore(tx: Prisma.TransactionClient, paymentId: string, actor: SessionUser, reason?: string, locked?: RefundLockContext) {
  const candidate = locked ? { orderId: locked.order.id } : await tx.payment.findFirst({ where: { id: paymentId, order: resolveReadScope(actor) }, select: { orderId: true } });
  if (!candidate) throw new ApiError(404, "الدفعة مش موجودة");
  const { order, drawerId } = locked ? verifyRefundContext(tx, locked, candidate.orderId) : await lockRefundOrderForAction(tx, candidate.orderId, actor);
  const payment = order.payments.find((p) => p.id === paymentId);
  if (!payment) throw new ApiError(409, "الدفعة اتغيرت — جرّب تاني");
  assertRefundable(payment);
  const targetShiftId = await refundTarget(tx, payment, actor, drawerId, order.branchId);
  const refund = await writeReversal(tx, payment, actor, reason?.trim() || "مرتجع دفعة", targetShiftId);
  await applyRefundToOrderSettlement(tx, order.id, payment.amount);
  if (targetShiftId) await recomputeShiftTotals(targetShiftId, tx);
  if (order.tableSessionId) await recomputeSessionTotals(order.tableSessionId, tx);
  await auditInTransaction(tx, {
    cafeId: order.cafeId, userId: actor.id, action: "PAYMENT_REFUNDED", entity: "Payment", entityId: payment.id,
    details: {
      branchId: order.branchId, shiftId: payment.shiftId, orderId: order.id, orderNumber: order.orderNumber,
      amount: Number(payment.amount), method: payment.method, mode: payment.shift?.status === "OPEN" ? "IN_PERIOD" : "POST_CLOSE_REVERSAL",
      refundPaymentId: refund.id, postedToShiftId: targetShiftId, closedShiftId: payment.shift?.status !== "OPEN" ? payment.shiftId : null, reason: reason ?? null
    },
  });
  return refund;
}
export function refundOrder(orderId: string, actor: SessionUser, reason: string) {
  return protectedTransaction((tx) => refundOrderCore(tx, orderId, actor, reason), resolveReadScope(actor));
}
export function refundPayment(paymentId: string, actor: SessionUser, reason?: string) {
  return protectedTransaction((tx) => refundPaymentCore(tx, paymentId, actor, reason), resolveReadScope(actor));
}
export async function refundOrderInTransaction(tx: Prisma.TransactionClient, orderId: string, actor: SessionUser, reason: string, locked?: RefundLockContext) {
  const result = await refundOrderCore(tx, orderId, actor, reason, locked);
  return { refundIds: result.refunds.map((p) => p.id), totalRefunded: result.totalRefunded };
}
export async function refundPaymentInTransaction(tx: Prisma.TransactionClient, paymentId: string, actor: SessionUser, reason: string, locked?: RefundLockContext) {
  if (reason.trim().length < 3) throw new ApiError(400, "لازم تكتب سبب المرتجع");
  const refund = await refundPaymentCore(tx, paymentId, actor, reason, locked);
  return { refundId: refund.id, amount: Number(refund.amount), postedToShiftId: refund.shiftId };
}
