import { money, sumMoney } from "@/lib/money";
import { protectedTransaction } from "@/lib/protected-transaction";
import { createHash } from "node:crypto";
import type { OwnerAction, Prisma } from "@prisma/client";
import { ApiError, resolveReadScope } from "@/lib/api";
import { auditInTransaction } from "@/lib/audit";
import { db } from "@/lib/db";
import type { SessionUser } from "@/lib/auth";

const refundableBalance = (p: {amount:Prisma.Decimal;reversedBy:{amount:Prisma.Decimal;status:string}[]}) => money(p.amount.minus(sumMoney(p.reversedBy.filter(r=>r.status === "PAID").map(r=>r.amount))));
type Client = Prisma.TransactionClient | typeof db;
type Target = { cafeId: string; branchId: string; orderId: string | null; itemId: string | null; paymentId: string | null; amount: number; snapshot: Record<string, unknown> };
type RequestInput = { actor: SessionUser; action: OwnerAction; amendmentId?: string; orderId?: string; orderItemId?: string; paymentId?: string; reason: string; idempotencyKey: string };

export function fingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function targetFor(client: Client, input: Pick<RequestInput, "actor" | "action" | "orderId" | "orderItemId" | "paymentId" | "amendmentId">): Promise<Target> {
  const { actor, action } = input;
  if (!actor.cafeId) throw new ApiError(403, "Cafe required");

  if (action === 'AMEND_ORDER_REFUND' || action === 'AMEND_ORDER_VOID') {
    const amendment = await client.orderAmendment.findFirst({where:{id:input.amendmentId,...resolveReadScope(actor)}});
    if (!amendment || !['READY','PENDING_APPROVAL'].includes(amendment.status)) throw new ApiError(409,'Amendment is unavailable');
    const order = await client.order.findFirst({where:{id:amendment.orderId,...resolveReadScope(actor)},select:{revision:true,total:true,paidAmount:true,status:true}});
    if (!order || order.revision!==amendment.baseRevision) throw new ApiError(409,'Amendment is stale');
    const proposed=amendment.proposed as Record<string,unknown>;
    return {cafeId:amendment.cafeId,branchId:amendment.branchId,orderId:amendment.orderId,itemId:null,paymentId:null,amount:Number(proposed.total),snapshot:{action,amendmentId:amendment.id,fingerprint:amendment.fingerprint,proposal:amendment.proposed,order}};
  }

  if (action === "REFUND_PAYMENT") {
    if (!input.paymentId || input.orderItemId) throw new ApiError(400, "Choose exactly one payment target");
    const payment = await client.payment.findFirst({
      where: { id: input.paymentId, cafeId: actor.cafeId },
      include: { order: { select: { id: true, cafeId: true, branchId: true, orderNumber: true, status: true, paymentStatus: true } }, reversedBy: { select: { id: true, amount:true, status:true } } },
    });
    if (!payment || payment.order.cafeId !== actor.cafeId) throw new ApiError(404, "Payment not found");
    if (input.orderId && input.orderId !== payment.orderId) throw new ApiError(400, "Payment does not belong to the selected order");
    if (!payment.branchId && !payment.order.branchId) throw new ApiError(409, "Payment is missing a branch");
    const branchId = payment.branchId ?? payment.order.branchId;
    if (actor.branchId && actor.branchId !== branchId) throw new ApiError(403, "Payment is outside this branch");
    if (payment.type !== "COLLECTION" || payment.status !== "PAID" || payment.reversalOfPaymentId || refundableBalance(payment).lte(0)) throw new ApiError(409, "Payment is no longer refundable");
    const amount = refundableBalance(payment).toNumber();
    return { cafeId: payment.cafeId, branchId, orderId: payment.orderId, itemId: null, paymentId: payment.id, amount, snapshot: { action, paymentId: payment.id, paymentStatus: payment.status, paymentType: payment.type, amount, method: payment.method, orderId: payment.order.id, orderNumber: payment.order.orderNumber, orderStatus: payment.order.status, orderPaymentStatus: payment.order.paymentStatus } };
  }

  if (!input.orderId || input.paymentId) throw new ApiError(400, "Choose an order target");
  const order = await client.order.findFirst({ where: { id: input.orderId, cafeId: actor.cafeId }, include: {
    items: { orderBy: { id: "asc" }, select: { id: true, productName: true, variantName: true, quantity: true, unitPrice: true, lineTotal: true, kitchenStatus: true, voidedAt: true } },
    payments: { where: { type: "COLLECTION", status: "PAID", reversalOfPaymentId: null }, include: { reversedBy: { select: { id: true, amount:true, status:true } } }, orderBy: { id: "asc" } },
  } });
  if (!order) throw new ApiError(404, "Order not found");
  if (actor.branchId && actor.branchId !== order.branchId) throw new ApiError(403, "Order is outside this branch");
  if (action === "CANCEL_ORDER" && order.payments.some((payment) => refundableBalance(payment).gt(0))) {
    throw new ApiError(409, "Refund outstanding collections before requesting order cancellation");
  }
  let itemId: string | null = null;
  let amount = Number(order.total);
  if (action === "VOID_ORDER_ITEM") {
    if(order.revision>0||order.invoiceDiscountType)throw new ApiError(409,'Use Sales amendments to preserve invoice discount allocations and revisions');
    if (!input.orderItemId) throw new ApiError(400, "Choose the saved order item");
    const item = order.items.find((candidate) => candidate.id === input.orderItemId);
    if (!item) throw new ApiError(404, "Order item not found");
    if (item.voidedAt) throw new ApiError(409, "This order item was already voided");
    itemId = item.id; amount = Number(item.lineTotal);
  } else if (input.orderItemId) {
    throw new ApiError(400, "This action does not accept an item target");
  }
  if (action === "REFUND_ORDER") {
    const refundable = order.payments.filter((payment) => refundableBalance(payment).gt(0));
    if (refundable.length === 0) throw new ApiError(409, "Order has no refundable collections");
    amount = sumMoney(refundable.map(refundableBalance)).toNumber();
  }
  const snapshot = {
    action, orderId: order.id, orderNumber: order.orderNumber, orderStatus: order.status,
    paymentStatus: order.paymentStatus, total: Number(order.total), paidAmount: Number(order.paidAmount),
    remainingAmount: Number(order.remainingAmount),
    items: order.items.map((item) => ({ id: item.id, name: item.productName, variant: item.variantName, quantity: item.quantity, unitPrice: Number(item.unitPrice), lineTotal: Number(item.lineTotal), kitchenStatus: item.kitchenStatus, voidedAt: item.voidedAt })),
    collections: order.payments.filter((payment) => refundableBalance(payment).gt(0)).map((payment) => ({ id: payment.id, amount: refundableBalance(payment).toNumber(), method: payment.method, status: payment.status })),
    targetItemId: itemId,
  };
  return { cafeId: order.cafeId, branchId: order.branchId, orderId: order.id, itemId, paymentId: null, amount, snapshot };
}

export async function requestOwnerAction(input: RequestInput, client?: Prisma.TransactionClient) {
  const work = async (tx: Prisma.TransactionClient) => {
  if (input.reason.trim().length < 3 || input.reason.trim().length > 500) throw new ApiError(400, "Write a short reason for the request");
  if (input.idempotencyKey.length > 64) throw new ApiError(400, "Invalid idempotency key");
  const target = await targetFor(tx, input);
  const targetFingerprint = fingerprint(target.snapshot);
  const settings = await tx.ownerActionSettings.findUnique({ where: { cafeId: target.cafeId }, include: { owner: { select: { id: true, role: true, isActive: true, archivedAt: true, cafeId: true } } } });
  if (!settings || !settings.owner.isActive || settings.owner.archivedAt || settings.owner.cafeId !== target.cafeId || settings.owner.role !== "CAFE_OWNER") throw new ApiError(409, "Configure an active cafe owner for sale-action approvals first");
  if (settings.ownerId === input.actor.id) throw new ApiError(409, "The selected owner cannot request their own approval");
  const selectedMode = input.action === "REFUND_ORDER" || input.action === "REFUND_PAYMENT" || input.action === 'AMEND_ORDER_REFUND' ? settings.refundMode : input.action === "VOID_ORDER_ITEM" || input.action === 'AMEND_ORDER_VOID' ? settings.itemVoidMode : settings.cancelMode;
  const mode = selectedMode;
  if (mode !== "OWNER_REQUEST") {
    const passcode = await tx.ownerPasscode.findUnique({ where: { cafeId: target.cafeId }, select: { ownerId: true } });
    if (!passcode || passcode.ownerId !== settings.ownerId) throw new ApiError(409, "Configure the selected owner's passcode before enabling this authorization mode");
  }
  const previous = await tx.ownerActionRequest.findUnique({ where: { requesterId_idempotencyKey: { requesterId: input.actor.id, idempotencyKey: input.idempotencyKey } } });
  if (previous) {
    if (previous.targetFingerprint !== targetFingerprint || previous.action !== input.action || previous.reason !== input.reason.trim()) throw new ApiError(409, "Idempotency key was already used for a different action");
    return { requestId: previous.id, status: previous.status, amount: Number(previous.amount) };
  }
  const now = new Date();
  const request = await (async () => {
    const created = await tx.ownerActionRequest.create({ data: {
      cafeId: target.cafeId, branchId: target.branchId, requesterId: input.actor.id, ownerId: settings.ownerId,
      action: input.action, targetOrderId: target.orderId, targetOrderItemId: target.itemId, targetPaymentId: target.paymentId,
      targetAmendmentId: input.amendmentId,
      reason: input.reason.trim(), targetSnapshot: target.snapshot as Prisma.InputJsonValue,
      targetFingerprint, amount: target.amount, mode, settingsVersion: settings.version,
      idempotencyKey: input.idempotencyKey, createdAt: now, expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    } });
    await tx.ownerActionEvent.create({ data: { cafeId: target.cafeId, requestId: created.id, actorId: input.actor.id, event: "REQUESTED", details: { action: input.action, amount: target.amount, targetFingerprint } } });
    await auditInTransaction(tx, { cafeId: target.cafeId, userId: input.actor.id, action: "OWNER_ACTION_REQUESTED", entity: "OwnerActionRequest", entityId: created.id, details: { action: input.action, amount: target.amount, ownerId: settings.ownerId, branchId: target.branchId } });
    return created;
  })();
  return { requestId: request.id, status: request.status, amount: Number(request.amount) };
  };
  return client ? work(client) : protectedTransaction(work, resolveReadScope(input.actor));
}

export async function decideOwnerAction(args: { actor: SessionUser; requestId: string; decision: "ACCEPT" | "REJECT"; note?: string }) {
  const cafeId = args.actor.cafeId;
  if (!cafeId) throw new ApiError(403, "Cafe required");
  return protectedTransaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "OwnerActionRequest" WHERE "id" = ${args.requestId} AND "cafeId"=${cafeId} AND (${args.actor.branchId ?? null}::text IS NULL OR "branchId"=${args.actor.branchId ?? null}) FOR UPDATE`;
    const request = await tx.ownerActionRequest.findFirst({ where: { id: args.requestId, cafeId }, include: { owner: { select: { id: true, role: true, isActive: true, archivedAt: true } } } });
    if (!request) throw new ApiError(404, "Approval request not found");
    if (request.ownerId !== args.actor.id || args.actor.role !== "CAFE_OWNER" || !request.owner.isActive || request.owner.archivedAt) throw new ApiError(403, "Only the selected active cafe owner may decide this request");
    if (request.mode === "OWNER_PASSCODE") throw new ApiError(409, "This request requires owner passcode authorization");
    const settings = await tx.ownerActionSettings.findUnique({ where: { cafeId }, select: { ownerId: true, version: true } });
    if (settings?.ownerId !== request.ownerId || settings.version !== request.settingsVersion) {
      if (request.status === "PENDING") {
        const now = new Date();
        await tx.ownerActionRequest.update({ where: { id: request.id }, data: { status: "STALE", decidedAt: now } });
        await tx.ownerActionEvent.create({ data: { cafeId: request.cafeId, requestId: request.id, actorId: args.actor.id, event: "STALE", note: "Approval settings changed" } });
        await auditInTransaction(tx, { cafeId: request.cafeId, userId: args.actor.id, action: "OWNER_ACTION_STALE", entity: "OwnerActionRequest", entityId: request.id, details: { reason: "SETTINGS_CHANGED", settingsVersion: request.settingsVersion } });
      }
      return { status: request.status === "PENDING" ? "STALE" as const : request.status };
    }
    if (args.actor.branchId && args.actor.branchId !== request.branchId) throw new ApiError(403, "Request is outside this branch");
    if (request.status !== "PENDING") return { status: request.status };
    const now = new Date();
    if (request.expiresAt <= now) {
      await tx.ownerActionRequest.update({ where: { id: request.id }, data: { status: "EXPIRED", decidedAt: now, decidedById: args.actor.id } });
      await tx.ownerActionEvent.create({ data: { cafeId: request.cafeId, requestId: request.id, actorId: args.actor.id, event: "EXPIRED" } });
      await auditInTransaction(tx, { cafeId: request.cafeId, userId: args.actor.id, action: "OWNER_ACTION_EXPIRED", entity: "OwnerActionRequest", entityId: request.id });
      return { status: "EXPIRED" as const };
    }
    const target = await targetFor(tx, { actor: args.actor, action: request.action, amendmentId: request.targetAmendmentId ?? undefined, orderId: request.targetOrderId ?? undefined, orderItemId: request.targetOrderItemId ?? undefined, paymentId: request.targetPaymentId ?? undefined });
    const status = target.cafeId === request.cafeId && target.branchId === request.branchId && fingerprint(target.snapshot) === request.targetFingerprint ? (args.decision === "ACCEPT" ? "APPROVED" : "REJECTED") : "STALE";
    await tx.ownerActionRequest.update({ where: { id: request.id }, data: {
      status, decidedAt: now, decidedById: args.actor.id, decisionNote: args.note?.trim() || null,
      ...(status === "APPROVED" ? { decisionMethod: "OWNER_REQUEST" as const } : {}),
      ...(status === "APPROVED" ? { executionExpiresAt: new Date(now.getTime() + 15 * 60 * 1000) } : {}),
    } });
    await tx.ownerActionEvent.create({ data: { cafeId: request.cafeId, requestId: request.id, actorId: args.actor.id, event: status, note: args.note?.trim() || null, details: { action: request.action, targetFingerprint: request.targetFingerprint } } });
    await auditInTransaction(tx, { cafeId: request.cafeId, userId: args.actor.id, action: "OWNER_ACTION_" + status, entity: "OwnerActionRequest", entityId: request.id, details: { action: request.action, requesterId: request.requesterId, amount: Number(request.amount), branchId: request.branchId } });
    return { status };
  }, resolveReadScope(args.actor));
}

export async function listOwnerActionRequests(args: { actor: SessionUser; branchId?: string | null }) {
  if (!args.actor.cafeId) throw new ApiError(403, "Cafe required");
  const settings = await db.ownerActionSettings.findUnique({ where: { cafeId: args.actor.cafeId }, select: { ownerId: true } });
  const isSelectedOwner = settings?.ownerId === args.actor.id && args.actor.role === "CAFE_OWNER";
  const requests = await db.ownerActionRequest.findMany({ where: {
    cafeId: args.actor.cafeId,
    ...(args.actor.branchId ? { branchId: args.actor.branchId } : args.branchId ? { branchId: args.branchId } : {}),
    ...(isSelectedOwner ? {} : { requesterId: args.actor.id }),
  }, include: {
    requester: { select: { id: true, name: true } }, owner: { select: { id: true, name: true } },
    decider: { select: { id: true, name: true } }, executor: { select: { id: true, name: true } },
    branch: { select: { id: true, name: true } }, events: { include: { actor: { select: { id: true, name: true } } }, orderBy: { createdAt: "asc" } },
  }, orderBy: { createdAt: "desc" }, take: 200 });
  return { requests };
}
