import { decimal, money, sumMoney } from "@/lib/money";
import { protectedTransaction, protectedContext } from "@/lib/protected-transaction";
import { ApiError, resolveReadScope } from "@/lib/api";
import type { OwnerAction, Prisma } from "@prisma/client";
import type { SessionUser } from "@/lib/auth";
import { auditInTransaction } from "@/lib/audit";
import { fingerprint, targetFor } from "@/lib/owner-action-approvals";
import { refundOrderInTransaction, refundPaymentInTransaction, lockRefundOrderForAction, type RefundLockContext } from "@/lib/refunds";
import { recomputeSessionTotals } from "@/lib/table-sessions";
import { reverseOrderLoyalty } from "@/lib/loyalty";
import { unrecordCustomerOrder } from "@/lib/customers";
import { computeChargesExact as computeCharges } from "@/lib/charges";

import { lockOrders, lockOrderPayments, lockCustomers } from "@/lib/transaction-locks";

type ClaimArgs = { actor: SessionUser; requestId: string; action?: OwnerAction; idempotencyKey: string };

async function claimApprovedAction(tx: Prisma.TransactionClient, args: ClaimArgs) {
  const scope = resolveReadScope(args.actor);
  const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "OwnerActionRequest" WHERE "id"=${args.requestId} AND "cafeId"=${args.actor.cafeId} AND (${scope.branchId ?? null}::text IS NULL OR "branchId"=${scope.branchId ?? null}) FOR UPDATE`;
  if (!locked.length) throw new ApiError(404, "Owner action request not found");
  protectedContext(tx).trace.push({ entity: "OwnerActionRequest", ids: locked.map(row => row.id), mode: "FOR UPDATE" });
  const request = await tx.ownerActionRequest.findFirst({ where: { id: args.requestId, cafeId: args.actor.cafeId! } });
  if (!request || request.requesterId !== args.actor.id) throw new ApiError(404, "Owner action request not found");
  if (request.action === 'AMEND_ORDER_REFUND' || request.action === 'AMEND_ORDER_VOID') throw new ApiError(409,'Use the amendment settlement workflow for this approval');
  if (request.action !== (args.action ?? request.action)) throw new ApiError(409, "Approved action does not match this operation");

  if (request.status === "EXECUTED") {
    if (request.executionIdempotencyKey !== args.idempotencyKey) throw new ApiError(409, "This request has already been executed");
    const event = await tx.ownerActionEvent.findFirst({ where: { requestId: request.id, event: "EXECUTED" }, orderBy: { createdAt: "desc" } });
    return { alreadyExecuted: true as const, result: event?.details ?? null, request };
  }
  if (request.status !== "APPROVED") throw new ApiError(409, "Owner approval is not available for execution");
  const now = new Date();
  if (!request.executionExpiresAt || request.executionExpiresAt <= now) {
    await tx.ownerActionRequest.update({ where: { id: request.id }, data: { status: "EXPIRED" } });
    await tx.ownerActionEvent.create({ data: { cafeId: request.cafeId, requestId: request.id, actorId: args.actor.id, event: "EXPIRED", note: "Execution approval expired" } });
    await auditInTransaction(tx, { cafeId: request.cafeId, userId: args.actor.id, action: "OWNER_ACTION_EXPIRED", entity: "OwnerActionRequest", entityId: request.id, details: { phase: "EXECUTION" } });
    return { expired: true as const, request };
  }

  const settings = await tx.ownerActionSettings.findUnique({ where: { cafeId: request.cafeId } });
  const owner = await tx.user.findFirst({ where: { id: request.ownerId, cafeId: request.cafeId, role: "CAFE_OWNER", isActive: true, archivedAt: null }, select: { id: true } });
  if (!settings || !owner || settings.ownerId !== request.ownerId || settings.version !== request.settingsVersion) {
    await tx.ownerActionRequest.update({ where: { id: request.id }, data: { status: "STALE" } });
    await tx.ownerActionEvent.create({ data: { cafeId: request.cafeId, requestId: request.id, actorId: args.actor.id, event: "STALE", note: "Approval settings changed" } });
    await auditInTransaction(tx, { cafeId: request.cafeId, userId: args.actor.id, action: "OWNER_ACTION_STALE", entity: "OwnerActionRequest", entityId: request.id, details: { reason: "SETTINGS_CHANGED" } });
    return { stale: true as const, request };
  }
  if (request.decisionMethod === "OWNER_PASSCODE") {
    const credential = await tx.ownerPasscode.findUnique({ where: { cafeId: request.cafeId }, select: { ownerId: true, version: true } });
    if (!credential || credential.ownerId !== request.ownerId || credential.version !== request.credentialVersion) {
      await tx.ownerActionRequest.update({ where: { id: request.id }, data: { status: "STALE" } });
      await tx.ownerActionEvent.create({ data: { cafeId: request.cafeId, requestId: request.id, actorId: args.actor.id, event: "STALE", note: "Owner passcode changed" } });
      await auditInTransaction(tx, { cafeId: request.cafeId, userId: args.actor.id, action: "OWNER_ACTION_STALE", entity: "OwnerActionRequest", entityId: request.id, details: { reason: "CREDENTIAL_CHANGED" } });
      return { stale: true as const, request };
    }
  }

  let refundContext: RefundLockContext | undefined;
  if (request.action === "REFUND_ORDER" || request.action === "REFUND_PAYMENT") {
    refundContext = await lockRefundOrderForAction(tx, request.targetOrderId!, args.actor);
  } else {
    await lockOrders(tx, [request.targetOrderId!]);
    await lockOrderPayments(tx, [request.targetOrderId!]);
  }
  const target = await targetFor(tx, {
    actor: args.actor, action: request.action, orderId: request.targetOrderId ?? undefined,
    orderItemId: request.targetOrderItemId ?? undefined, paymentId: request.targetPaymentId ?? undefined,
  });
  if (target.cafeId !== request.cafeId || target.branchId !== request.branchId || fingerprint(target.snapshot) !== request.targetFingerprint) {
    await tx.ownerActionRequest.update({ where: { id: request.id }, data: { status: "STALE" } });
    await tx.ownerActionEvent.create({ data: { cafeId: request.cafeId, requestId: request.id, actorId: args.actor.id, event: "STALE", note: "Action target changed" } });
    await auditInTransaction(tx, { cafeId: request.cafeId, userId: args.actor.id, action: "OWNER_ACTION_STALE", entity: "OwnerActionRequest", entityId: request.id, details: { reason: "TARGET_CHANGED" } });
    return { stale: true as const, request };
  }
  return { alreadyExecuted: false as const, request, target, now, refundContext };
}


async function voidOrderItemInTransaction(
  tx: Prisma.TransactionClient,
  args: { actor: SessionUser; requestId: string; orderId: string; itemId: string; reason: string; now: Date }
) {
  const order = await tx.order.findFirst({
    where: { id: args.orderId, cafeId: args.actor.cafeId! },
    include: {
      items: { orderBy: { id: "asc" }, include: { itemPayments: { select: { id: true } } } },
      payments: { select: { id: true, type: true, status: true, reversalOfPaymentId: true } },
    },
  });
  if (!order || !["CONFIRMED", "PREPARING", "READY"].includes(order.status)) throw new ApiError(409, "This order can no longer have an item voided");
  if(order.revision>0||order.invoiceDiscountType||order.items.some(i=>i.itemDiscountAmount?.gt(0)))throw new ApiError(409,'استخدم تعديل الأصناف في المبيعات لحفظ المراجعة وتوزيع الخصومات الصحيح');
  if (order.paymentStatus === "PAID" || order.paymentStatus === "PARTIAL" || order.paymentStatus === "REFUNDED" || decimal(order.paidAmount).gt(0)) {
    throw new ApiError(409, "Paid or refunded orders cannot have individual items voided");
  }
  if (order.payments.some((payment) => payment.type === "REFUND" || (payment.type === "COLLECTION" && payment.status === "PAID"))) {
    throw new ApiError(409, "Orders with payment history cannot have individual items voided");
  }
  const item = order.items.find((row) => row.id === args.itemId);
  if (!item || item.voidedAt) throw new ApiError(409, "This order item is no longer available to void");
  if (item.itemPayments.length) throw new ApiError(409, "An allocated or paid order item cannot be voided");
  const activeItems = order.items.filter((row) => !row.voidedAt);
  if (activeItems.length <= 1) throw new ApiError(409, "Use approved order cancellation to remove the last item");

  const subtotal = money(sumMoney(activeItems.filter(row => row.id !== item.id).map(row => row.lineTotal)));
  const discount = money(order.discountAmount);
  if (order.loyaltyPointsRedeemed > 0 && subtotal.lt(discount)) {
    throw new ApiError(409, "The remaining lines cannot preserve the redeemed loyalty discount; cancel the order instead");
  }
  const taxRate = decimal(order.taxRateSnapshot ?? 0);
  const serviceRate = decimal(order.serviceRateSnapshot ?? 0);
  if (decimal(order.serviceChargeAmount).gt(0) && serviceRate.lte(0)) {
    throw new ApiError(409, "This order has a fixed service charge without a stored recalculation snapshot");
  }
  const charges = computeCharges({
    subtotal,
    discount,
    orderType: order.type,
    settings: {
      taxEnabled: taxRate.gt(0), taxRate, applyTaxTo: "ALL_ORDERS",
      serviceChargeEnabled: serviceRate.gt(0), serviceChargeType: "PERCENTAGE",
      serviceChargeRate: serviceRate, serviceChargeFixedAmount: 0, applyServiceTo: "ALL_ORDERS",
    },
  });
  await tx.orderItem.update({
    where: { id: item.id },
    data: { voidedAt: args.now, voidedById: args.actor.id, voidApprovalRequestId: args.requestId, voidReason: args.reason, kitchenStatus: "CANCELLED" },
  });
  const updated = await tx.order.update({
    where: { id: order.id },
    data: {
      subtotal: charges.subtotal, discountAmount: charges.discountAmount,
      serviceChargeAmount: charges.serviceChargeAmount, taxAmount: charges.taxAmount, total: charges.total,
      remainingAmount: charges.total,
    },
    select: { id: true, orderNumber: true, subtotal: true, discountAmount: true, taxAmount: true, serviceChargeAmount: true, total: true, paidAmount: true, remainingAmount: true },
  });
  if (order.tableSessionId) await recomputeSessionTotals(order.tableSessionId, tx);
  await auditInTransaction(tx, {
    cafeId: order.cafeId, userId: args.actor.id, action: "ORDER_ITEM_VOIDED", entity: "OrderItem", entityId: item.id,
    details: { orderId: order.id, orderNumber: order.orderNumber, approvalRequestId: args.requestId, reason: args.reason, lineTotal: Number(item.lineTotal), prepared: ["PREPARING", "READY"].includes(order.status) },
  });
  return { itemId: item.id, orderId: order.id, orderCancelled: false, order: updated };
}
export async function executeApprovedAction(args: {
  actor: SessionUser;
  requestId: string;
  idempotencyKey: string;
}): Promise<{ alreadyExecuted: boolean; status: string; result: unknown }> {
  if (!args.actor.cafeId || args.idempotencyKey.length < 8 || args.idempotencyKey.length > 64) throw new ApiError(400, "Invalid execution request");
  const outcome = await protectedTransaction(async (tx) => {
    const claim = await claimApprovedAction(tx, args);
    if ("expired" in claim) return { alreadyExecuted: false, status: "EXPIRED", result: null };
    if ("stale" in claim) return { alreadyExecuted: false, status: "STALE", result: null };
    if (claim.alreadyExecuted) return { alreadyExecuted: true, status: "EXECUTED", result: claim.result };
    const { request, now } = claim;
    let result: unknown;

    if (request.action === "REFUND_ORDER") {
      result = await refundOrderInTransaction(tx, request.targetOrderId!, args.actor, request.reason, claim.refundContext);
    } else if (request.action === "REFUND_PAYMENT") {
      result = await refundPaymentInTransaction(tx, request.targetPaymentId!, args.actor, request.reason, claim.refundContext);
    } else if (request.action === "CANCEL_ORDER") {
      const order = await tx.order.findFirst({
        where: { id: request.targetOrderId!, cafeId: request.cafeId },
        select: { id: true, branchId: true, orderNumber: true, status: true, paymentStatus: true, paidAmount: true, remainingAmount: true, customerId: true, total: true, tableSessionId: true, payments: true },
      });
      const fullyRefundedReady = order?.status === "READY"
        && order.paymentStatus === "REFUNDED"
        && decimal(order.paidAmount).eq(0)
        && decimal(order.remainingAmount).eq(0);
      if (!order || (!["CONFIRMED", "PREPARING"].includes(order.status) && !fullyRefundedReady)) throw new ApiError(409, "Order can no longer be cancelled");
      if (order.payments.some((payment) => payment.type === "COLLECTION" && payment.status === "PAID" && !payment.reversalOfPaymentId)) {
        const reversed = await tx.payment.findMany({ where: { orderId: order.id, type: "COLLECTION", reversedBy: { some: {} } }, select: { id: true } });
        const collections = order.payments.filter((payment) => payment.type === "COLLECTION" && payment.status === "PAID" && !payment.reversalOfPaymentId);
        if (collections.some((payment) => !reversed.some((row) => row.id === payment.id))) throw new ApiError(409, "Outstanding payment prevents order cancellation");
      }
      await tx.order.update({ where: { id: order.id }, data: { status: "CANCELLED", completedAt: now } });
      await tx.orderItem.updateMany({ where: { orderId: order.id, kitchenStatus: { not: "CANCELLED" } }, data: { kitchenStatus: "CANCELLED" } });
      if (order.customerId) await lockCustomers(tx, [order.customerId]);
      if (order.tableSessionId) await recomputeSessionTotals(order.tableSessionId, tx);
      if (order.customerId) await unrecordCustomerOrder(order.customerId, order.total, tx);
      await reverseOrderLoyalty(order.id, args.actor.id, tx);
      result = { orderId: order.id, status: "CANCELLED" };
      await auditInTransaction(tx, { cafeId: request.cafeId, userId: args.actor.id, action: "ORDER_CANCELLED", entity: "Order", entityId: order.id,
        details: { orderNumber: order.orderNumber, branchId: order.branchId, approvalRequestId: request.id, reason: request.reason } });
    } else if (request.action === "VOID_ORDER_ITEM") {
      result = await voidOrderItemInTransaction(tx, {
        actor: args.actor, requestId: request.id, orderId: request.targetOrderId!, itemId: request.targetOrderItemId!, reason: request.reason, now,
      });
    }

    await tx.ownerActionRequest.update({ where: { id: request.id }, data: {
      status: "EXECUTED", executedAt: now, executorId: args.actor.id, executionIdempotencyKey: args.idempotencyKey,
    } });
    await tx.ownerActionEvent.create({ data: {
      cafeId: request.cafeId, requestId: request.id, actorId: args.actor.id, event: "EXECUTED",
      details: { action: request.action, requesterId: request.requesterId, ownerId: request.ownerId, result: result as Prisma.InputJsonValue },
    } });
    await auditInTransaction(tx, { cafeId: request.cafeId, userId: args.actor.id, action: "OWNER_ACTION_EXECUTED", entity: "OwnerActionRequest", entityId: request.id,
      details: { action: request.action, requesterId: request.requesterId, ownerId: request.ownerId, amount: Number(request.amount), branchId: request.branchId, executionIdempotencyKey: args.idempotencyKey },
    });
    return { alreadyExecuted: false, status: "EXECUTED", result };
  }, resolveReadScope(args.actor));
  return outcome;
}
