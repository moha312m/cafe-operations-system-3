// Branch currency (v1: one currency per cafe, 2-decimal currencies only).
//
// The cafe's currency is the single source of truth in the database (Cafe.currency); every branch mirrors it
// (Branch.currencyCode) and the database cascades a change to all branches in the same statement. The
// currency locks once the cafe has any financial record, and is never converted: history keeps the meaning
// it was recorded with. The service enforces the rules first with Arabic messages; the migration's triggers
// are the backstop for any other writer.
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import type { SessionUser } from "@/lib/auth";
import { auditInTransaction } from "@/lib/audit";
import { withIdempotency } from "@/lib/idempotency";
import { protectedContext } from "@/lib/protected-transaction";
import { lockCafeBranches } from "@/lib/transaction-locks";
import { currencyMeta, isSupportedCurrency } from "@/lib/currency";
import type { Prisma } from "@prisma/client";

export const BRANCH_CURRENCY_ACTION = "BRANCH_CURRENCY_CHANGED";
export const CURRENCY_LOCKED_MESSAGE = "العملة مقفلة لوجود حركات مالية";
export const CURRENCY_MISMATCH_MESSAGE = "يجب أن تكون عملة كل الفروع واحدة";

export const changeCurrencySchema = z.object({
  currencyCode: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "رمز العملة غير صالح"),
  reason: z.string().trim().min(3, "اكتب سبب التغيير").max(300),
}).strict();

export async function currencyIsLocked(tx: Prisma.TransactionClient | typeof db, cafeId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ locked: boolean }[]>`SELECT "currency_lock_has_records"(${cafeId}) AS locked`;
  return rows[0]?.locked === true;
}

/** Maps the database guards (which can only fire for a writer that skipped the checks or lost a race). */
export function mapCurrencyDatabaseError(error: unknown): never {
  const text = error instanceof Error ? error.message : String(error);
  if (text.includes("CURRENCY_LOCKED")) throw new ApiError(409, CURRENCY_LOCKED_MESSAGE);
  if (text.includes("CURRENCY_MISMATCH")) throw new ApiError(409, CURRENCY_MISMATCH_MESSAGE);
  throw error;
}

export async function getCurrencyState(actor: SessionUser) {
  if (!actor.cafeId) throw new ApiError(403, "الحساب غير مرتبط بكافيه");
  const where = { cafeId: actor.cafeId, ...(actor.branchId ? { id: actor.branchId } : {}) };
  const [cafe, branches, locked, history] = await Promise.all([
    db.cafe.findUniqueOrThrow({ where: { id: actor.cafeId }, select: { currency: true } }),
    db.branch.findMany({ where, select: { id: true, name: true, currencyCode: true }, orderBy: { createdAt: "asc" } }),
    currencyIsLocked(db, actor.cafeId),
    db.auditLog.findMany({
      where: { cafeId: actor.cafeId, action: BRANCH_CURRENCY_ACTION, ...(actor.branchId ? { entityId: actor.branchId } : {}) },
      orderBy: { createdAt: "desc" }, take: 5, select: { id: true, entityId: true, details: true, createdAt: true, user: { select: { name: true } } },
    }),
  ]);
  return { cafeCurrency: cafe.currency, branches, locked, history };
}

/** Owner only. Changes the cafe's currency (and so every branch's) in one transaction. */
export async function changeCafeCurrency(request: Request, actor: SessionUser, branchId: string, raw: unknown): Promise<NextResponse> {
  const input = changeCurrencySchema.parse(raw);
  if (actor.role !== "CAFE_OWNER" || !actor.cafeId) throw new ApiError(403, "تغيير العملة للمالك فقط");
  const cafeId = actor.cafeId;
  if (!isSupportedCurrency(input.currencyCode)) {
    throw new ApiError(400, currencyMeta(input.currencyCode) ? "غير مدعومة حالياً" : "عملة غير معروفة");
  }
  return await withIdempotency(request, `branch-currency:${cafeId}:${actor.id}`, { branchId, ...input }, async (tx) => {
    protectedContext(tx).scope = { cafeId };
    const owner = await tx.user.findUnique({ where: { id: actor.id }, select: { role: true, isActive: true, archivedAt: true, cafeId: true } });
    if (!owner || !owner.isActive || owner.archivedAt || owner.role !== "CAFE_OWNER" || owner.cafeId !== cafeId) throw new ApiError(403, "تغيير العملة للمالك فقط");
    const branch = await tx.branch.findFirst({ where: { id: branchId, cafeId }, select: { id: true } });
    if (!branch) throw new ApiError(404, "الفرع مش موجود");
    const branchIds = await lockCafeBranches(tx, cafeId);
    await tx.$queryRaw`SELECT "id" FROM "Cafe" WHERE "id"=${cafeId} FOR NO KEY UPDATE`;
    const cafe = await tx.cafe.findUniqueOrThrow({ where: { id: cafeId }, select: { currency: true } });
    const before = await tx.branch.findMany({ where: { cafeId }, select: { id: true, currencyCode: true }, orderBy: { id: "asc" } });
    if (cafe.currency === input.currencyCode && before.every(b => b.currencyCode === input.currencyCode)) {
      return NextResponse.json({ changed: false, currencyCode: input.currencyCode });
    }
    if (await currencyIsLocked(tx, cafeId)) throw new ApiError(409, CURRENCY_LOCKED_MESSAGE);
    try {
      await tx.cafe.update({ where: { id: cafeId }, data: { currency: input.currencyCode } });
    } catch (error) {
      mapCurrencyDatabaseError(error);
    }
    const after = await tx.branch.findMany({ where: { cafeId, id: { in: branchIds } }, select: { id: true, currencyCode: true } });
    if (after.some(b => b.currencyCode !== input.currencyCode)) throw new ApiError(409, CURRENCY_MISMATCH_MESSAGE);
    for (const b of before) {
      await auditInTransaction(tx, {
        cafeId, userId: actor.id, action: BRANCH_CURRENCY_ACTION, entity: "Branch", entityId: b.id,
        details: { branchId: b.id, from: b.currencyCode, to: input.currencyCode, reason: input.reason, requestedOn: branchId },
      });
    }
    return NextResponse.json({ changed: true, currencyCode: input.currencyCode, branchIds });
  }, { scope: { cafeId } });
}
