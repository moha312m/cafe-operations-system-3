import bcrypt from "bcryptjs";
import { verifyPassword, type SessionUser } from "@/lib/auth";
import { ApiError } from "@/lib/api";
import { auditInTransaction } from "@/lib/audit";
import { db } from "@/lib/db";
import { fingerprint, targetFor } from "@/lib/owner-action-approvals";

const PASSCODE_PATTERN = /^\d{6,12}$/;
const LOCK_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;

export function validateOwnerPasscode(passcode: string) {
  if (!PASSCODE_PATTERN.test(passcode)) {
    throw new ApiError(400, "Passcode must contain 6 to 12 digits");
  }
}

export async function configureOwnerPasscode(args: {
  actor: SessionUser;
  currentPassword: string;
  passcode: string;
}) {
  const { actor } = args;
  if (!actor.cafeId || actor.role !== "CAFE_OWNER") throw new ApiError(403, "Cafe owner required");
  validateOwnerPasscode(args.passcode);

  const user = await db.user.findFirst({
    where: { id: actor.id, cafeId: actor.cafeId, role: "CAFE_OWNER", isActive: true, archivedAt: null },
    select: { passwordHash: true },
  });
  if (!user || !(await verifyPassword(args.currentPassword, user.passwordHash))) {
    throw new ApiError(401, "Current password is incorrect");
  }

  const passcodeHash = await bcrypt.hash(args.passcode, 12);
  return db.$transaction(async (tx) => {
    await tx.$queryRawUnsafe('SELECT "id" FROM "OwnerActionSettings" WHERE "cafeId" = $1 FOR UPDATE', actor.cafeId);
    const settings = await tx.ownerActionSettings.findUnique({ where: { cafeId: actor.cafeId! } });
    if (!settings || settings.ownerId !== actor.id) throw new ApiError(403, "Only the selected owner can configure this passcode");

    const previous = await tx.ownerPasscode.findUnique({ where: { cafeId: actor.cafeId! }, select: { id: true, version: true } });
    const version = (previous?.version ?? 0) + 1;
    const saved = await tx.ownerPasscode.upsert({
      where: { cafeId: actor.cafeId! },
      create: { cafeId: actor.cafeId!, ownerId: actor.id, passcodeHash, version },
      update: { ownerId: actor.id, passcodeHash, version },
      select: { id: true, version: true },
    });

    const stale = await tx.ownerActionRequest.findMany({
      where: { cafeId: actor.cafeId!, ownerId: actor.id, status: "APPROVED", decisionMethod: "OWNER_PASSCODE" },
      select: { id: true },
    });
    if (stale.length) {
      await tx.ownerActionRequest.updateMany({
        where: { id: { in: stale.map((row) => row.id) }, status: "APPROVED" },
        data: { status: "STALE" },
      });
      for (const row of stale) {
        await tx.ownerActionEvent.create({ data: { cafeId: actor.cafeId!, requestId: row.id, actorId: actor.id, event: "STALE", note: "Owner passcode changed" } });
      }
    }
    await auditInTransaction(tx, {
      cafeId: actor.cafeId!, userId: actor.id, action: previous ? "OWNER_PASSCODE_ROTATED" : "OWNER_PASSCODE_CONFIGURED",
      entity: "OwnerPasscode", entityId: saved.id,
      details: { version: saved.version, invalidatedApprovals: stale.length },
    });
    return { configured: true as const, version: saved.version };
  });
}

type PasscodeResult = "APPROVED" | "INVALID" | "LOCKED" | "STALE" | "EXPIRED" | "NOT_PENDING";

export async function authorizeOwnerActionByPasscode(args: {
  actor: SessionUser;
  requestId: string;
  passcode: string;
}): Promise<{ status: "APPROVED" }> {
  const { actor } = args;
  if (!actor.cafeId) throw new ApiError(403, "Cafe required");
  validateOwnerPasscode(args.passcode);

  const preliminary = await db.ownerActionRequest.findFirst({
    where: { id: args.requestId, cafeId: actor.cafeId, requesterId: actor.id },
    select: { cafeId: true, ownerId: true },
  });
  if (!preliminary) throw new ApiError(404, "Owner action request not found");

  const result = await db.$transaction(async (tx): Promise<PasscodeResult> => {
    const lockedPasscodes = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      'SELECT "id" FROM "OwnerPasscode" WHERE "cafeId" = $1 FOR UPDATE', preliminary.cafeId
    );
    if (!lockedPasscodes.length) throw new ApiError(409, "The selected owner has not configured a passcode");
    await tx.$queryRawUnsafe(
      'SELECT "id" FROM "OwnerActionRequest" WHERE "id" = $1 AND "cafeId" = $2 FOR UPDATE', args.requestId, preliminary.cafeId
    );

    const [credential, request, settings] = await Promise.all([
      tx.ownerPasscode.findUnique({ where: { cafeId: preliminary.cafeId } }),
      tx.ownerActionRequest.findFirst({ where: { id: args.requestId, cafeId: preliminary.cafeId, requesterId: actor.id } }),
      tx.ownerActionSettings.findUnique({ where: { cafeId: actor.cafeId! }, select: { ownerId: true, version: true } }),
    ]);
    if (!credential || !request || !settings || request.ownerId !== preliminary.ownerId) throw new ApiError(404, "Owner action request not found");
    if (request.status !== "PENDING") return "NOT_PENDING";
    const isRefund = request.action === "REFUND_ORDER" || request.action === "REFUND_PAYMENT";
    const requiredMode = isRefund ? "refundMode" : request.action === "VOID_ORDER_ITEM" ? "itemVoidMode" : "cancelMode";
    const mode = await tx.ownerActionSettings.findUnique({
      where: { cafeId: actor.cafeId! }, select: { refundMode: true, cancelMode: true, itemVoidMode: true },
    });
    const currentMode = mode?.[requiredMode];
    if (currentMode === "OWNER_REQUEST" || request.mode === "OWNER_REQUEST") return "NOT_PENDING";

    const now = new Date();
    const failures = await tx.ownerPasscodeAttempt.count({
      where: { cafeId: request.cafeId, ownerId: request.ownerId, requesterId: actor.id, success: false, createdAt: { gt: new Date(now.getTime() - LOCK_WINDOW_MS) } },
    });
    if (failures >= MAX_FAILURES) return "LOCKED";
    const valid = credential.ownerId === request.ownerId && await bcrypt.compare(args.passcode, credential.passcodeHash);
    if (!valid) {
      await tx.ownerPasscodeAttempt.create({ data: { cafeId: request.cafeId, ownerId: request.ownerId, passcodeId: credential.id, requesterId: actor.id, requestId: request.id, success: false } });
      await tx.ownerActionEvent.create({ data: { cafeId: request.cafeId, requestId: request.id, actorId: actor.id, event: "PASSCODE_FAILED", details: { ownerId: request.ownerId } } });
      await auditInTransaction(tx, { cafeId: request.cafeId, userId: actor.id, action: "OWNER_PASSCODE_FAILED", entity: "OwnerActionRequest", entityId: request.id, details: { ownerId: request.ownerId } });
      return "INVALID";
    }
    await tx.ownerPasscodeAttempt.create({ data: { cafeId: request.cafeId, ownerId: request.ownerId, passcodeId: credential.id, requesterId: actor.id, requestId: request.id, success: true } });
    if (settings.ownerId !== request.ownerId || settings.version !== request.settingsVersion) {
      await tx.ownerActionRequest.update({ where: { id: request.id }, data: { status: "STALE", decidedAt: now } });
      await tx.ownerActionEvent.create({ data: { cafeId: request.cafeId, requestId: request.id, actorId: actor.id, event: "STALE", note: "Approval settings changed" } });
      await auditInTransaction(tx, { cafeId: request.cafeId, userId: actor.id, action: "OWNER_ACTION_STALE", entity: "OwnerActionRequest", entityId: request.id, details: { reason: "SETTINGS_CHANGED" } });
      return "STALE";
    }
    if (credential.ownerId !== request.ownerId) return "NOT_PENDING";
    if (request.expiresAt <= now) {
      await tx.ownerActionRequest.update({ where: { id: request.id }, data: { status: "EXPIRED", decidedAt: now } });
      await tx.ownerActionEvent.create({ data: { cafeId: request.cafeId, requestId: request.id, actorId: actor.id, event: "EXPIRED" } });
      await auditInTransaction(tx, { cafeId: request.cafeId, userId: actor.id, action: "OWNER_ACTION_EXPIRED", entity: "OwnerActionRequest", entityId: request.id });
      return "EXPIRED";
    }
    const target = await targetFor(tx, { actor, action: request.action, orderId: request.targetOrderId ?? undefined, orderItemId: request.targetOrderItemId ?? undefined, paymentId: request.targetPaymentId ?? undefined });
    if (target.cafeId !== request.cafeId || target.branchId !== request.branchId || fingerprint(target.snapshot) !== request.targetFingerprint) {
      await tx.ownerActionRequest.update({ where: { id: request.id }, data: { status: "STALE", decidedAt: now } });
      await tx.ownerActionEvent.create({ data: { cafeId: request.cafeId, requestId: request.id, actorId: actor.id, event: "STALE", note: "Action target changed" } });
      await auditInTransaction(tx, { cafeId: request.cafeId, userId: actor.id, action: "OWNER_ACTION_STALE", entity: "OwnerActionRequest", entityId: request.id, details: { reason: "TARGET_CHANGED" } });
      return "STALE";
    }
    await tx.ownerActionRequest.update({ where: { id: request.id }, data: {
      status: "APPROVED", decidedAt: now, decidedById: request.ownerId, decisionMethod: "OWNER_PASSCODE",
      credentialVersion: credential.version, executionExpiresAt: new Date(now.getTime() + 15 * 60 * 1000),
    } });
    await tx.ownerActionEvent.create({ data: { cafeId: request.cafeId, requestId: request.id, actorId: actor.id, event: "PASSCODE_APPROVED", details: { ownerId: request.ownerId, credentialVersion: credential.version } } });
    await auditInTransaction(tx, { cafeId: request.cafeId, userId: actor.id, action: "OWNER_ACTION_APPROVED_BY_PASSCODE", entity: "OwnerActionRequest", entityId: request.id, details: { action: request.action, requesterId: request.requesterId, ownerId: request.ownerId, amount: Number(request.amount), branchId: request.branchId } });
    return "APPROVED";
  });

  if (result === "APPROVED") return { status: "APPROVED" };
  if (result === "INVALID") throw new ApiError(401, "Passcode is incorrect");
  if (result === "LOCKED") throw new ApiError(429, "Too many incorrect passcode attempts. Try again later");
  if (result === "STALE") throw new ApiError(409, "The request changed and needs a new authorization");
  if (result === "EXPIRED") throw new ApiError(410, "The owner action request expired");
  throw new ApiError(409, "This owner action request is no longer pending or does not allow passcode authorization");
}
