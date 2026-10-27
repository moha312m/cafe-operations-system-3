import { Prisma } from "@prisma/client";
import { ApiError } from "@/lib/api";
import { assertOpeningReady } from "@/lib/opening-readiness";
import { protectedContext, optionalProtectedContext } from "@/lib/protected-transaction";

export function scopedLockPredicate(tx: Prisma.TransactionClient, alias: "s" | "o" | "p" | "c" | "t" | "i") {
  const scope = protectedContext(tx).scope;
  const name = Prisma.raw(alias); // closed, code-owned alias set; never request input
  const conditions: Prisma.Sql[] = [];
  if (scope.cafeId) conditions.push(Prisma.sql`${name}."cafeId"=${scope.cafeId}`);
  if (scope.branchId) conditions.push(alias === "p"
    ? Prisma.sql`(${name}."branchId"=${scope.branchId} OR ${name}."branchId" IS NULL)`
    : Prisma.sql`${name}."branchId"=${scope.branchId}`);
  return conditions.length ? Prisma.join(conditions, " AND ") : Prisma.sql`TRUE`;
}

/** Only initialized Phase 2 transactions use this lock ownership contract. */
export function inventoryRowNeedsLock(tx: Prisma.TransactionClient, id: string) {
  if (!optionalProtectedContext(tx)) return true;
  return newLocks(tx, "InventoryItem", [id], 6).length > 0;
}
export function rememberInventoryRow(tx: Prisma.TransactionClient, id: string, nowait = false) {
  if (optionalProtectedContext(tx)) remember(tx, "InventoryItem", [id], [id], 6, nowait ? "FOR UPDATE NOWAIT" : "FOR UPDATE");
}

function newLocks(tx: Prisma.TransactionClient, entity: string, ids: string[], rank: number) {
  const context = protectedContext(tx);
  const held = context.held.get(entity) ?? new Set<string>();
  const sorted = [...new Set(ids)].sort().filter(id => !held.has(id));
  if (sorted.length && (rank < context.highestRank || (held.size && sorted[0] < [...held].sort().at(-1)!))) {
    throw new ApiError(409, "حالة الحساب اتغيرت — جرّب العملية تاني بنفس المفتاح");
  }
  return sorted;
}
function remember(tx: Prisma.TransactionClient, entity: string, requested: string[], actual: string[], rank: number, mode = "FOR UPDATE") {
  const context = protectedContext(tx);
  const held = context.held.get(entity) ?? new Set<string>();
  for (const id of requested) held.add(id);
  context.held.set(entity, held);
  context.highestRank = Math.max(context.highestRank, rank);
  context.trace.push({ entity, ids: actual, mode });
}
export function assertFinancialLocks(tx: Prisma.TransactionClient, orderIds: string[], shiftId?: string | null) {
  const context = protectedContext(tx);
  if ((shiftId && !context.held.get("Shift")?.has(shiftId)) || orderIds.some(id => !context.held.get("Order")?.has(id) || !context.held.get("Payment")?.has(id))) {
    throw new Error("Financial helper requires the orchestrator's verified locked transaction context");
  }
}

/** Shift → sorted Orders → sorted Payments → Inventory. Discovery reads
 * identify rows only; all decisions use reads after these locks.
 */
export async function lockShifts(tx: Prisma.TransactionClient, ids: string[]) {
  const sorted = newLocks(tx, "Shift", ids, 1);
  if (!sorted.length) return;
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT s."id" FROM "Shift" s WHERE s."id" IN (${Prisma.join(sorted)}) AND ${scopedLockPredicate(tx, "s")} ORDER BY s."id" FOR UPDATE OF s`;
  if (rows.length !== sorted.length) throw new ApiError(404, "الشيفت مش موجود في نطاقك");
  remember(tx, "Shift", sorted, rows.map(r => r.id), 1);
}
export async function lockOrders(tx: Prisma.TransactionClient, ids: string[], amendmentId?: string) {
  const sorted = newLocks(tx, "Order", ids, 2);
  if (!sorted.length) return;
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT o."id" FROM "Order" o WHERE o."id" IN (${Prisma.join(sorted)}) AND ${scopedLockPredicate(tx, "o")} ORDER BY o."id" FOR UPDATE OF o`;
  if (rows.length !== sorted.length) throw new ApiError(404, "الطلب مش موجود في نطاقك");
  remember(tx, "Order", sorted, rows.map(r => r.id), 2);
  const reserved = await tx.order.findFirst({where:{id:{in:sorted},activeAmendmentId:{not:null},...(amendmentId ? {NOT:{activeAmendmentId:amendmentId}} : {})},select:{id:true}});
  if (reserved) throw new ApiError(409,'الطلب محجوز لتسوية تعديل — راجع المبيعات قبل أي حركة أخرى');
}
export async function lockOrderPayments(tx: Prisma.TransactionClient, ids: string[]) {
  const sorted = newLocks(tx, "Payment", ids, 3);
  if (!sorted.length) return;
  const orders = await tx.order.findMany({ where: { id: { in: sorted }, ...protectedContext(tx).scope }, select: { id: true } });
  if (orders.length !== sorted.length) throw new ApiError(404, "الطلب مش موجود في نطاقك");
  const expected = await tx.payment.count({ where: { orderId: { in: sorted }, order: protectedContext(tx).scope } });
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT p."id" FROM "Payment" p JOIN "Order" o ON o."id"=p."orderId" WHERE p."orderId" IN (${Prisma.join(sorted)}) AND ${scopedLockPredicate(tx, "o")} AND ${scopedLockPredicate(tx, "p")} AND p."cafeId"=o."cafeId" AND (p."branchId" IS NULL OR p."branchId"=o."branchId") ORDER BY p."id" FOR UPDATE OF p`;
  if (rows.length !== expected) throw new ApiError(409, "بيانات فرع الدفعات مش متطابقة مع الطلب");
  remember(tx, "Payment", sorted, rows.map(r => r.id), 3);
}
// Auxiliary rows follow financial locks: Customer -> TableSession. This
// prevents earning/reversal updates from inverting order creation's locks.
export async function lockCustomers(tx: Prisma.TransactionClient, ids: string[]) {
  const sorted = newLocks(tx, "Customer", ids, 4);
  if (!sorted.length) return;
  const scope = protectedContext(tx).scope;
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT c."id" FROM "Customer" c WHERE c."id" IN (${Prisma.join(sorted)}) AND (${scope.cafeId ?? null}::text IS NULL OR c."cafeId"=${scope.cafeId ?? null}) ORDER BY c."id" FOR NO KEY UPDATE OF c`;
  if (rows.length !== sorted.length) throw new ApiError(404, "العميل مش موجود في نطاقك");
  remember(tx, "Customer", sorted, rows.map(r => r.id), 4, "FOR NO KEY UPDATE");
}
export async function lockTableSessions(tx: Prisma.TransactionClient, ids: string[]) {
  const sorted = newLocks(tx, "TableSession", ids, 5);
  if (!sorted.length) return;
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT t."id" FROM "TableSession" t WHERE t."id" IN (${Prisma.join(sorted)}) AND ${scopedLockPredicate(tx, "t")} ORDER BY t."id" FOR UPDATE OF t`;
  if (rows.length !== sorted.length) throw new ApiError(404, "حساب الترابيزة مش موجود في نطاقك");
  remember(tx, "TableSession", sorted, rows.map(row => row.id), 5);
}
export async function lockBranchAllocator(tx: Prisma.TransactionClient, branchId: string) {
  const scope = protectedContext(tx).scope;
  if (scope.branchId && branchId !== scope.branchId) throw new ApiError(404, "الفرع مش موجود في نطاقك");
  const ids = newLocks(tx, "Branch", [branchId], 1.5);
  if (!ids.length) return;
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Branch" WHERE "id"=${branchId} AND (${scope.cafeId ?? null}::text IS NULL OR "cafeId"=${scope.cafeId ?? null}) FOR NO KEY UPDATE`;
  if (rows.length !== 1) throw new ApiError(404, "الفرع مش موجود في نطاقك");
  remember(tx, "Branch", ids, ids, 1.5, "FOR NO KEY UPDATE");
}
export async function requireOpenPostingShift(tx: Prisma.TransactionClient, shiftId: string, branchId?: string, cafeId?: string) {
  await lockShifts(tx, [shiftId]);
  return validateOpenPostingShift(tx, shiftId, branchId, cafeId);
}
export async function validateOpenPostingShift(tx: Prisma.TransactionClient, shiftId: string, branchId?: string, cafeId?: string) {
  if (!protectedContext(tx).held.get("Shift")?.has(shiftId)) throw new Error("Shift validation requires a verified held lock");
  const shift = await tx.shift.findUnique({ where: { id: shiftId } });
  if (!shift || shift.status !== "OPEN" || (branchId && shift.branchId !== branchId) || (cafeId && shift.cafeId !== cafeId)) {
    throw new ApiError(409, "التحصيل والمرتجعات محتاجين شيفت مفتوح في نفس الفرع");
  }
  if (shift.custodyGateReason) throw new ApiError(400, "الشيفت مستني استلام العهدة");
  await assertOpeningReady(tx, { shiftId: shift.id, scope: "OPERATIONS" });
  return shift;
}
export async function requireCashCustodyInTx(tx: Prisma.TransactionClient, branchId: string, userId: string) {
  const candidate = await tx.shift.findFirst({ where: { ...protectedContext(tx).scope, branchId, cashierId: userId, status: "OPEN" }, orderBy: { openedAt: "desc" }, select: { id: true } });
  if (!candidate) throw new ApiError(400, "التحصيل محتاج شيفت مفتوح");
  const shift = await requireOpenPostingShift(tx, candidate.id, branchId);
  if (shift.cashierId !== userId) throw new ApiError(409, "عهدة الشيفت اتغيرت");
  return shift;
}
