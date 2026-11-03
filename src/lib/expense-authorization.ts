import type { Prisma } from "@prisma/client";
import type { SessionUser } from "@/lib/auth";
import { ApiError, requireActiveSession, resolveReadScope } from "@/lib/api";
import { resolvePermissions } from "@/lib/perms/effective";
import { mayExecuteExpense } from "@/lib/expense-rules";

// Authority locks precede Shift (rank 1). Cafe -> User -> assigned role.
// User/logout, override and role-child writers coordinate on these parents.
export async function requireExpenseAuthority(tx: Prisma.TransactionClient, cafeId: string, action: "view" | "manage" | "categories") {
  await tx.$queryRaw`SELECT "id" FROM "Cafe" WHERE "id" = ${cafeId} FOR SHARE`;
  const actor = await requireActiveSession(tx);
  if (actor.cafeId !== cafeId) throw new ApiError(403, "نطاق الكافيه اتغير");
  const account = await tx.user.findUniqueOrThrow({ where: { id: actor.id }, select: { cafeRoleId: true } });
  if (account.cafeRoleId) {
    const roles = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "CafeRole" WHERE "id" = ${account.cafeRoleId} AND "cafeId" = ${cafeId} FOR SHARE`;
    if (!roles.length) throw new ApiError(403, "الدور خارج نطاق الكافيه");
  }
  const { keys } = await resolvePermissions(actor, tx);
  if (action === "view" ? !keys.has("expenses.view") : !mayExecuteExpense(actor.role, keys)) throw new ApiError(403, "الصرف والرد للمالك والمدير المخولين فقط");
  if (action === "categories" && actor.role !== "CAFE_OWNER") throw new ApiError(403, "إنشاء وتعديل التصنيفات للمالك فقط");
  return { actor, scope: resolveReadScope(actor) };
}
export function expenseCafe(actor: SessionUser): string {
  if (!actor.cafeId) throw new ApiError(403, "حسابك غير مرتبط بكافيه");
  return actor.cafeId;
}
