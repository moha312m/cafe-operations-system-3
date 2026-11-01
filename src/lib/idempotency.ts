import { createHash, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { ApiError, resolveReadScope } from "@/lib/api";
import { protectedTransaction, protectedContext, type TransactionScope } from "@/lib/protected-transaction";
import { sqlState } from "@/lib/database-errors";
import type { Prisma, IdempotencyKey } from "@prisma/client";
import type { SessionUser } from "@/lib/auth";

const LEASE_MS = 120_000;
export function requestScope(actor: SessionUser, operation: string) {
  return `${actor.cafeId ?? "platform"}:${actor.branchId ?? "all"}:${actor.id}:${operation}`;
}
export async function authenticatedRequestScope(tx: Prisma.TransactionClient, actor: SessionUser, operation: string, target: { kind: "order" | "table" | "branch"; id: string }) {
  const scope = resolveReadScope(actor);
  let row: { cafeId: string; branchId: string } | null;
  if (target.kind === "branch") {
    if (scope.branchId && scope.branchId !== target.id) throw new ApiError(403, "ليس لديك صلاحية على فرع تاني");
    const branch = await tx.branch.findFirst({ where: { id: target.id, cafeId: scope.cafeId }, select: { id: true, cafeId: true } });
    row = branch ? { cafeId: branch.cafeId, branchId: branch.id } : null;
  } else if (target.kind === "order") {
    row = await tx.order.findFirst({ where: { id: target.id, ...scope }, select: { cafeId: true, branchId: true } });
  } else {
    row = await tx.tableSession.findFirst({ where: { id: target.id, ...scope }, select: { cafeId: true, branchId: true } });
  }
  if (!row) throw new ApiError(404, "الحساب مش موجود في نطاقك");
  return requestScope({ ...actor, ...row }, operation);
}
export async function publicQrRequestScope(tx: Prisma.TransactionClient, branchId: string) {
  const branch = await tx.branch.findFirst({ where: { id: branchId, isActive: true, publicMenuEnabled: true }, include: { cafe: { include: { settings: true } } } });
  if (!branch || !branch.cafe.isActive || branch.cafe.settings?.qrMenuEnabled === false) throw new ApiError(403, "المنيو غير متاح حاليًا");
  return "public:" + branch.id + ":POST /api/qr/orders";
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${canonical(obj[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
export function requestFingerprint(body: unknown) {
  return createHash("sha256").update(canonical(body)).digest("hex");
}
function replay(row: IdempotencyKey) {
  if (row.response === null || row.statusCode === null) throw new ApiError(409, "نتيجة العملية المحفوظة مش متاحة");
  return NextResponse.json(row.response, { status: row.statusCode, headers: { "Idempotency-Replayed": "true" } });
}

/** Reserve separately so an in-flight duplicate sees STARTED immediately.
 * The reservation row is then held through the business transaction, fencing
 * expired workers. Completing the response and the sale is one commit.
 */
export async function withIdempotency(
  request: Request,
  scopeInput: string | ((tx: Prisma.TransactionClient) => Promise<string>),
  body: unknown,
  work: (tx: Prisma.TransactionClient) => Promise<NextResponse>,
  options: { scope?: TransactionScope; authorize?: (tx: Prisma.TransactionClient) => Promise<void> } = {},
): Promise<NextResponse> {
  const key = request.headers.get("Idempotency-Key")?.trim();
  if (!key || key.length < 8 || key.length > 128 || !/^[\x21-\x7e]+$/.test(key)) {
    throw new ApiError(400, "مفتاح العملية مطلوب، من ٨ إلى ١٢٨ حرف");
  }
  const requestHash = requestFingerprint(body);
  const ownerToken = randomUUID();
  let scope = typeof scopeInput === "string" ? scopeInput : "";
  const authorize = async (tx: Prisma.TransactionClient) => {
    await options.authorize?.(tx);
    if (typeof scopeInput === "function" && await scopeInput(tx) !== scope) throw new ApiError(403, "صلاحية الوصول للحساب اتغيرت");
  };
  let reservation: IdempotencyKey;
  try {
    reservation = await protectedTransaction(async (tx) => {
      if (typeof scopeInput === "function") scope = await scopeInput(tx);
      await authorize(tx);
      const now = new Date();
      const until = new Date(now.getTime() + LEASE_MS);
      const existing = await tx.idempotencyKey.findUnique({ where: { scope_key: { scope, key } } });
      if (!existing) await tx.$executeRaw`
        INSERT INTO "IdempotencyKey" ("id", "scope", "key", "requestHash", "ownerToken", "lockedUntil", "updatedAt")
        VALUES (${randomUUID()}, ${scope}, ${key}, ${requestHash}, ${ownerToken}, ${until}, ${now})
        ON CONFLICT ("scope", "key") DO NOTHING
      `;
      let row = existing ?? await tx.idempotencyKey.findUniqueOrThrow({ where: { scope_key: { scope, key } } });
      if (row.requestHash !== requestHash) throw new ApiError(409, "المفتاح مستخدم لطلب مختلف");
      if (row.status === "COMPLETED" || row.ownerToken === ownerToken) return row;
      if (row.status === "STARTED" && row.lockedUntil > now) throw new ApiError(409, "العملية دي قيد التنفيذ — جرّب بنفس المفتاح بعد لحظات");
      // An expired lease is reclaimable only if no worker currently holds it.
      await tx.$queryRaw`SELECT "id" FROM "IdempotencyKey" WHERE "id"=${row.id} FOR UPDATE NOWAIT`;
      protectedContext(tx).trace.push({ entity: "IdempotencyKey", ids: [row.id], mode: "FOR UPDATE NOWAIT" });
      row = await tx.idempotencyKey.findUniqueOrThrow({ where: { id: row.id } });
      if (row.status === "COMPLETED") return row;
      if (row.requestHash !== requestHash) throw new ApiError(409, "المفتاح مستخدم لطلب مختلف");
      if (row.status === "STARTED" && row.lockedUntil > now) throw new ApiError(409, "العملية دي قيد التنفيذ — جرّب بنفس المفتاح بعد لحظات");
      return tx.idempotencyKey.update({ where: { id: row.id }, data: { status: "STARTED", ownerToken, lockedUntil: until } });
    }, options.scope);
  } catch (error) {
    if (sqlState(error) === "55P03") {
      throw new ApiError(409, "العملية دي قيد التنفيذ — جرّب بنفس المفتاح بعد لحظات");
    }
    throw error;
  }
  if (reservation.status === "COMPLETED") return replay(reservation);
  let callbackFailed = false;
  try {
    return await protectedTransaction(async (tx) => {
      try {
      await tx.$queryRaw`SELECT "id" FROM "IdempotencyKey" WHERE "id"=${reservation.id} FOR UPDATE`;
      protectedContext(tx).trace.push({ entity: "IdempotencyKey", ids: [reservation.id], mode: "FOR UPDATE" });
      const current = await tx.idempotencyKey.findUniqueOrThrow({ where: { id: reservation.id } });
      await authorize(tx);
      if (current.status === "COMPLETED") return replay(current);
      if (current.ownerToken !== ownerToken || current.status !== "STARTED" || current.requestHash !== requestHash) throw new ApiError(409, "حجز العملية اتغير — جرّب بنفس المفتاح");
      const response = await work(tx);
      if (!response.ok) throw new ApiError(response.status, "العملية ما اكتملتش");
      const payload = await response.clone().json() as Prisma.InputJsonValue;
      await tx.idempotencyKey.update({
        where: { id: current.id }, data: {
          status: "COMPLETED", response: payload, statusCode: response.status,
        }
      });
      return response;
      } catch (error) { callbackFailed = true; throw error; }
    }, options.scope);
  } catch (error) {
    // Reconcile persisted state before classifying an ambiguous commit. Only
    // an actual callback failure is known not to have committed business work.
    try {
      const completed = await protectedTransaction(async (tx) => {
        const row = await tx.idempotencyKey.findUnique({ where: { id: reservation.id } });
        if (row?.status === "COMPLETED" && row.requestHash === requestHash) {
          await authorize(tx);
          return row;
        }
        if (callbackFailed) await tx.idempotencyKey.updateMany({
          where: { id: reservation.id, scope, key, requestHash, ownerToken, status: "STARTED" },
          data: { status: "FAILED", lockedUntil: new Date(0) },
        });
        return null;
      }, options.scope);
      if (completed) return replay(completed);
    } catch { console.error("Idempotency outcome reconciliation failed; reservation remains fenced"); }
    throw error;
  }
}
