import type { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { requireKey, ApiError, resolveReadScope } from "@/lib/api";
import { expenseCafe, requireExpenseAuthority } from "@/lib/expense-authorization";
import { protectedTransaction, protectedContext } from "@/lib/protected-transaction";
import { withIdempotency, requestScope, requestFingerprint } from "@/lib/idempotency";
import type { SessionUser } from "@/lib/auth";

type Context = { actor: SessionUser; scope: ReturnType<typeof resolveReadScope> };
export async function readExpenses<T>(work: (tx: Prisma.TransactionClient, context: Context) => Promise<T>) {
  const initial = await requireKey("expenses.view");
  const cafeId = expenseCafe(initial);
  return protectedTransaction(async tx => work(tx, await requireExpenseAuthority(tx, cafeId, "view")), resolveReadScope(initial));
}
export async function writeExpense(request: Request, operation: string, body: unknown, target: { branchId: string } | { expenseId: string }, work: (tx: Prisma.TransactionClient, actor: SessionUser, identity: { idempotencyScope: string; idempotencyKey: string; requestHash: string }) => Promise<unknown>) {
  let actor = await requireKey("expenses.manage");
  const cafeId = expenseCafe(actor);
  let idempotencyScope = "";
  return withIdempotency(request, async tx => {
    const context = await requireExpenseAuthority(tx, cafeId, "manage");
    actor = context.actor;
    protectedContext(tx).scope = context.scope;
    let branchId: string;
    if ("branchId" in target) {
      if (actor.branchId && actor.branchId !== target.branchId) throw new ApiError(404, "الفرع خارج نطاقك");
      const branch = await tx.branch.findFirst({ where: { id: target.branchId, cafeId }, select: { id: true } });
      if (!branch) throw new ApiError(404, "الفرع غير موجود");
      branchId = branch.id;
    } else {
      const expense = await tx.operatingExpense.findFirst({ where: { id: target.expenseId, ...context.scope }, select: { branchId: true } });
      if (!expense) throw new ApiError(404, "المصروف غير موجود في نطاقك");
      branchId = expense.branchId;
    }
    idempotencyScope = requestScope({ ...actor, cafeId, branchId }, operation);
    return idempotencyScope;
  }, body, async tx => NextResponse.json(await work(tx, actor, {
    idempotencyScope, idempotencyKey: request.headers.get("Idempotency-Key")!.trim(), requestHash: requestFingerprint(body),
  }), { status: 201 }), { scope: resolveReadScope(actor) });
}
