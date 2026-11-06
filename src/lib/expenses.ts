import { isSupportedCurrency } from "@/lib/currency";
import type { Prisma, OperatingExpense, OperatingExpenseReturn } from "@prisma/client";
import { ApiError } from "@/lib/api";
import type { SessionUser } from "@/lib/auth";
import { auditInTransaction } from "@/lib/audit";
import { requireCashCustodyInTx, lockOperatingExpense } from "@/lib/transaction-locks";
import { recomputeShiftTotals } from "@/lib/shifts";
import { decimal, sumMoney } from "@/lib/money";
import { expenseAmount, assertExpenseReturn, expenseSourceKey, type expenseInput, type returnInput } from "@/lib/expense-rules";
import type { z } from "zod";

type Identity = { idempotencyScope: string; idempotencyKey: string; requestHash: string };
type ExpenseWithReturns = OperatingExpense & { returns: OperatingExpenseReturn[] };
export function expenseDto(row: ExpenseWithReturns) {
  const returned = sumMoney(row.returns.map(r => r.amount));
  return {
    id: row.id, branchId: row.branchId, shiftId: row.shiftId, classification: "OPERATING_EXPENSE", fundingSource: "DRAWER",
    categoryId: row.categoryId, categoryCode: row.categoryCodeSnapshot, categoryName: row.categoryNameSnapshot,
    amount: row.amount.toNumber(), currency: row.currency, description: row.description,
    documentReference: row.documentReference, actorName: row.actorNameSnapshot, occurredAt: row.occurredAt.toISOString(),
    returnedAmount: returned.toNumber(), unrecoveredAmount: decimal(row.amount).minus(returned).toNumber(), sourceKey: expenseSourceKey("expense", row.id),
    returns: row.returns.map(r => ({ id: r.id, amount: r.amount.toNumber(), reason: r.reason, documentReference: r.documentReference,
      actorName: r.actorNameSnapshot, occurredAt: r.occurredAt.toISOString(), sourceKey: expenseSourceKey("return", r.id) })),
  };
}
export async function recordOperatingExpense(tx: Prisma.TransactionClient, actor: SessionUser, data: z.infer<typeof expenseInput>, identity: Identity) {
  const branch = await tx.branch.findFirst({ where: { id: data.branchId, cafeId: actor.cafeId! }, select: { cafe: { select: { currency: true } } } });
  if (!branch || (actor.branchId && actor.branchId !== data.branchId)) throw new ApiError(404, "الفرع غير موجود في نطاقك");
  const currency = branch.cafe.currency;
  if (!isSupportedCurrency(currency)) throw new ApiError(400, "عملة الكافيه غير مدعومة للمصروفات حاليًا");
  const shift = await requireCashCustodyInTx(tx, data.branchId, actor.id);
  const categories = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "ExpenseCategory" WHERE "id"=${data.categoryId} AND "cafeId"=${actor.cafeId!} AND "archivedAt" IS NULL FOR SHARE`;
  if (!categories.length) throw new ApiError(400, "اختر بند مصروف تشغيلي معتمد وغير مؤرشف");
  const category = await tx.expenseCategory.findUniqueOrThrow({ where: { id: data.categoryId } });
  const amount = expenseAmount(data.amount);
  const fresh = await recomputeExpenseDrawer(shift.id, tx);
  if (!fresh || fresh.status !== "OPEN") throw new ApiError(409, "الدرج لم يعد مفتوحًا");
  if (amount.gt(decimal(fresh.expectedCashAmount))) throw new ApiError(400, "النقد المتوقع المتاح لا يكفي للصرف؛ تحقق من الدرج");
  const expense = await tx.operatingExpense.create({ data: {
    cafeId: actor.cafeId!, branchId: data.branchId, shiftId: shift.id, categoryId: category.id,
    categoryCodeSnapshot: category.code, categoryNameSnapshot: category.nameAr, amount, currency,
    description: data.description, documentReference: data.documentReference ?? null,
    actorId: actor.id, actorNameSnapshot: actor.name, ...identity,
  }, include: { returns: true } });
  await recomputeExpenseDrawer(shift.id, tx);
  await auditInTransaction(tx, { cafeId: actor.cafeId, userId: actor.id, action: "OPERATING_EXPENSE_PAID", entity: "OperatingExpense", entityId: expense.id,
    details: { branchId: expense.branchId, shiftId: shift.id, amount: amount.toNumber(), currency, categoryId: category.id, sourceKey: expenseSourceKey("expense", expense.id) } });
  return expenseDto(expense);
}
export async function recordOperatingExpenseReturn(tx: Prisma.TransactionClient, actor: SessionUser, id: string, data: z.infer<typeof returnInput>, identity: Identity) {
  const scope = { cafeId: actor.cafeId!, ...(actor.branchId ? { branchId: actor.branchId } : {}) };
  const candidate = await tx.operatingExpense.findFirst({ where: { id, ...scope }, select: { branchId: true, shift: { select: { status: true } } } });
  if (!candidate) throw new ApiError(404, "المصروف غير موجود في نطاقك");
  if (candidate.shift.status !== "OPEN") throw new ApiError(400, "رد النقد بعد إقفال الدرج الأصلي أو بدء تسليمه يحتاج مسارًا منفصلًا");
  const shift = await requireCashCustodyInTx(tx, candidate.branchId, actor.id);
  await lockOperatingExpense(tx, id);
  const expense = await tx.operatingExpense.findFirstOrThrow({ where: { id, ...scope }, include: { returns: true } });
  const amount = expenseAmount(data.amount);
  try { assertExpenseReturn({ amount: expense.amount, returned: sumMoney(expense.returns.map(r => r.amount)), shiftId: expense.shiftId, currentShiftId: shift.id, status: shift.status, custodyValid: shift.cashierId === actor.id }, amount); }
  catch (error) { throw new ApiError(400, (error as Error).message); }
  const received = await tx.operatingExpenseReturn.create({ data: {
    expenseId: id, cafeId: expense.cafeId, branchId: expense.branchId, shiftId: expense.shiftId,
    amount, currency: expense.currency, reason: data.reason, documentReference: data.documentReference ?? null,
    actorId: actor.id, actorNameSnapshot: actor.name, ...identity,
  } });
  await recomputeExpenseDrawer(shift.id, tx);
  await auditInTransaction(tx, { cafeId: actor.cafeId, userId: actor.id, action: "OPERATING_EXPENSE_CASH_RETURNED", entity: "OperatingExpenseReturn", entityId: received.id,
    details: { expenseId: id, sourceKey: expenseSourceKey("return", received.id), branchId: expense.branchId, shiftId: shift.id, amount: amount.toNumber(), currency: expense.currency, reason: data.reason } });
  return expenseDto(await tx.operatingExpense.findUniqueOrThrow({ where: { id }, include: { returns: { orderBy: [{ occurredAt: "asc" }, { id: "asc" }] } } }));
}

async function recomputeExpenseDrawer(shiftId: string, tx: Prisma.TransactionClient) {
  try { return await recomputeShiftTotals(shiftId, tx); }
  catch (error) { if (error instanceof RangeError) throw new ApiError(400, error.message); throw error; }
}
