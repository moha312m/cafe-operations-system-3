import bcrypt from "bcryptjs";
import type { Prisma } from "@prisma/client";
import { ApiError } from "@/lib/api";
import type { SessionUser } from "@/lib/auth";
import { auditInTransaction } from "@/lib/audit";
import { db } from "@/lib/db";
import { decimal, type Numeric } from "@/lib/money";
import { OWNER_PASSCODE_LOCK_WINDOW_MS, OWNER_PASSCODE_MAX_FAILURES, OWNER_PASSCODE_PATTERN } from "@/lib/owner-passcode";

// Owner override for discounts: a cashier without `pos.apply_discount`, or a
// non-manager whose discount exceeds their SalesDiscountLimit, may proceed when
// the owner types the café's owner passcode on the cashier's screen.
//
// The credential is the existing OwnerPasscode (a separate 6–12 digit code), never
// the owner's login password. Failures share the OwnerPasscodeAttempt lockout with
// the owner-action passcode flow. The code travels in a header so it never enters
// a request body, an idempotency fingerprint, a stored row or an audit entry.

export const OWNER_OVERRIDE_HEADER = "x-owner-override-code";
export const OWNER_OVERRIDE_REFUSED = "Invalid owner override code or insufficient permissions";
export const OWNER_OVERRIDE_LOCKED = "Too many incorrect passcode attempts. Try again later";

export type OwnerOverrideReason = "DISCOUNT_PERMISSION" | "DISCOUNT_LIMIT";
export type OwnerOverrideGrant = { cafeId: string; branchId: string; ownerId: string; passcodeId: string; version: number };
export type OwnerOverrideCheck =
  | { status: "NONE" }
  | { status: "INVALID" }
  | { status: "LOCKED" }
  | { status: "VALID"; grant: OwnerOverrideGrant };

const NO_OVERRIDE: OwnerOverrideCheck = { status: "NONE" };
const MANAGER_ROLES = ["CAFE_OWNER", "BRANCH_MANAGER"];

export const isDiscountManager = (role: string) => MANAGER_ROLES.includes(role);

export function overrideCodeFrom(request: Request): string | undefined {
  const code = request.headers.get(OWNER_OVERRIDE_HEADER)?.trim();
  return code ? code : undefined;
}

/** A well-formed code compared with bcrypt; a malformed one never reaches the hash. */
export async function overrideCodeMatches(code: string, passcodeHash: string) {
  return OWNER_PASSCODE_PATTERN.test(code) && bcrypt.compare(code, passcodeHash);
}

export function discountExceedsLimit(args: { discount: Numeric; subtotal: Numeric; limit: { maxAmount: Numeric; maxPercent: Numeric } | null }) {
  const discount = decimal(args.discount), subtotal = decimal(args.subtotal);
  if (!discount.gt(0)) return false;
  const percent = subtotal.isZero() ? decimal(0) : discount.times(100).div(subtotal);
  return discount.gt(decimal(args.limit?.maxAmount ?? 0)) || percent.gt(decimal(args.limit?.maxPercent ?? 0));
}

/**
 * The discount decision, without I/O. Managers are not bound by a limit; anyone
 * without `pos.apply_discount` or over their limit needs a valid owner override.
 */
export function discountDecision(args: {
  role: string;
  hasDiscountKey: boolean;
  discount: Numeric;
  subtotal: Numeric;
  limit: { maxAmount: Numeric; maxPercent: Numeric } | null;
  override: OwnerOverrideCheck["status"];
}): { allowed: boolean; reasons: OwnerOverrideReason[] } {
  if (!decimal(args.discount).gt(0)) return { allowed: true, reasons: [] };
  const reasons: OwnerOverrideReason[] = [];
  if (!args.hasDiscountKey) reasons.push("DISCOUNT_PERMISSION");
  if (!isDiscountManager(args.role) && discountExceedsLimit(args)) reasons.push("DISCOUNT_LIMIT");
  return { allowed: reasons.length === 0 || args.override === "VALID", reasons };
}

/** The refusal to raise when an override was needed: unchanged without a code. */
export function overrideRefusal(check: OwnerOverrideCheck, original: ApiError) {
  if (check.status === "INVALID") return new ApiError(403, OWNER_OVERRIDE_REFUSED);
  if (check.status === "LOCKED") return new ApiError(429, OWNER_OVERRIDE_LOCKED);
  return original;
}

/**
 * Checks a supplied code against the owner passcode of the actor's café. Runs in
 * its own transaction so a failed attempt is recorded even when the caller's
 * write then refuses and rolls back.
 */
export async function checkOwnerOverrideCode(actor: SessionUser, args: { branchId: string; code?: string }): Promise<OwnerOverrideCheck> {
  if (!args.code) return NO_OVERRIDE;
  const cafeId = actor.cafeId;
  if (!cafeId) return { status: "INVALID" };
  return db.$transaction(async (tx): Promise<OwnerOverrideCheck> => {
    await tx.$queryRawUnsafe('SELECT "id" FROM "OwnerPasscode" WHERE "cafeId" = $1 FOR UPDATE', cafeId);
    const [credential, settings] = await Promise.all([
      tx.ownerPasscode.findUnique({ where: { cafeId } }),
      tx.ownerActionSettings.findUnique({ where: { cafeId }, select: { ownerId: true } }),
    ]);
    if (!credential || !settings || credential.ownerId !== settings.ownerId) return { status: "INVALID" };
    const owner = await tx.user.findFirst({
      where: { id: credential.ownerId, cafeId, role: "CAFE_OWNER", isActive: true, archivedAt: null, OR: [{ branchId: null }, { branchId: args.branchId }] },
      select: { id: true },
    });
    if (!owner) return { status: "INVALID" };

    const failures = await tx.ownerPasscodeAttempt.count({
      where: { cafeId, ownerId: credential.ownerId, requesterId: actor.id, success: false, createdAt: { gt: new Date(Date.now() - OWNER_PASSCODE_LOCK_WINDOW_MS) } },
    });
    if (failures >= OWNER_PASSCODE_MAX_FAILURES) return { status: "LOCKED" };

    if (!(await overrideCodeMatches(args.code!, credential.passcodeHash))) {
      await tx.ownerPasscodeAttempt.create({ data: { cafeId, ownerId: credential.ownerId, passcodeId: credential.id, requesterId: actor.id, success: false } });
      await auditInTransaction(tx, {
        cafeId, userId: actor.id, action: "OWNER_OVERRIDE_FAILED", entity: "OwnerPasscode", entityId: credential.id,
        details: { ownerId: credential.ownerId, branchId: args.branchId },
      });
      return { status: "INVALID" };
    }
    return { status: "VALID", grant: { cafeId, branchId: args.branchId, ownerId: credential.ownerId, passcodeId: credential.id, version: credential.version } };
  });
}

/**
 * Records an override that a write actually relied on, inside that write's
 * transaction. The passcode must still be the one that was checked.
 */
export async function recordOwnerOverrideInTransaction(tx: Prisma.TransactionClient, actor: SessionUser, grant: OwnerOverrideGrant, entry: {
  orderId: string;
  amendmentId?: string;
  operation: "ORDER_CREATE" | "ORDER_AMENDMENT";
  reasons: OwnerOverrideReason[];
  discountAmount: Numeric;
  subtotal: Numeric;
}) {
  const current = await tx.ownerPasscode.findUnique({ where: { cafeId: grant.cafeId }, select: { id: true, ownerId: true, version: true } });
  if (!current || current.id !== grant.passcodeId || current.ownerId !== grant.ownerId || current.version !== grant.version) {
    throw new ApiError(409, "رمز موافقة المالك اتغير؛ أدخله مرة تانية");
  }
  await tx.ownerPasscodeAttempt.create({ data: { cafeId: grant.cafeId, ownerId: grant.ownerId, passcodeId: grant.passcodeId, requesterId: actor.id, success: true } });
  await auditInTransaction(tx, {
    cafeId: grant.cafeId, userId: actor.id, action: "OWNER_OVERRIDE_USED", entity: "Order", entityId: entry.orderId,
    details: {
      userId: actor.id, invoiceId: entry.orderId, timestamp: new Date().toISOString(),
      ownerId: grant.ownerId, branchId: grant.branchId, operation: entry.operation, amendmentId: entry.amendmentId ?? null,
      reasons: entry.reasons, discountAmount: decimal(entry.discountAmount).toFixed(2), subtotal: decimal(entry.subtotal).toFixed(2),
      passcodeVersion: grant.version,
    },
  });
}
