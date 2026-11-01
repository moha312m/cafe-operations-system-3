// Pure shared contracts. Numeric JSON is retained; monetary decisions use Decimal.
import { z } from "zod";
import { decimal, type Decimal, type Numeric } from "./money";

export function expenseAmount(value: unknown): Decimal {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new RangeError("أدخل مبلغًا رقميًا محدودًا");
  const amount = decimal(value);
  if (amount.lte(0) || amount.decimalPlaces() > 2 || amount.gt("9999999999.99")) throw new RangeError("المبلغ موجب وبمنزلتين عشريتين كحد أقصى وداخل سعة التخزين");
  return amount;
}
const amount = z.number({ error: "أدخل مبلغًا رقميًا محدودًا" }).superRefine((value, ctx) => {
  try { expenseAmount(value); } catch (error) { ctx.addIssue({ code: "custom", message: (error as Error).message }); }
});
const text = (max: number) => z.string().trim().min(1, "هذا الحقل مطلوب").max(max);
export const expenseInput = z.object({ branchId: text(128), categoryId: text(128), amount, description: text(500), documentReference: text(200).optional() }).strict();
export const returnInput = z.object({ amount, reason: text(500), documentReference: text(200).optional() }).strict();
export const categoryInput = z.object({ code: z.string().trim().regex(/^[A-Z0-9_]{1,40}$/, "الكود حروف لاتينية كبيرة وأرقام وشرطة سفلية"), nameAr: text(100), classification: z.literal("OPERATING_EXPENSE") }).strict();
export const categoryUpdateInput = z.object({ nameAr: text(100).optional(), archived: z.boolean().optional() }).strict().refine(x => x.nameAr !== undefined || x.archived !== undefined);
export function mayExecuteExpense(role: string, keys: ReadonlySet<string>): boolean {
  return (role === "CAFE_OWNER" || role === "BRANCH_MANAGER") && keys.has("expenses.manage");
}
export function drawerExpected(input: { opening: Numeric; netCollections: Numeric; supplierPayouts: Numeric; expensePayouts: Numeric; expenseReturns: Numeric }): Decimal {
  const expected = decimal(input.opening).plus(decimal(input.netCollections)).minus(decimal(input.supplierPayouts)).minus(decimal(input.expensePayouts)).plus(decimal(input.expenseReturns));
  if (expected.abs().gt("99999999.99")) throw new RangeError("النقد المتوقع خارج سعة الدرج");
  return expected;
}
export function assertExpenseReturn(source: { amount: Numeric; returned: Numeric; shiftId: string; currentShiftId: string; status: string; custodyValid: boolean }, amount: Decimal): void {
  if (source.status !== "OPEN" || source.shiftId !== source.currentShiftId || !source.custodyValid) throw new RangeError("رد النقد متاح إلى نفس الدرج المفتوح في عهدتك فقط؛ الرد بعد الإقفال أو إلى درج آخر يحتاج مسارًا منفصلًا");
  if (amount.gt(decimal(source.amount).minus(decimal(source.returned)))) throw new RangeError("مبلغ الرد أكبر من المتبقي غير المردود");
}
export function expenseSourceKey(kind: "expense" | "return", id: string): string {
  return kind === "expense" ? `operating-expense:${id}:paid:v1` : `operating-expense-return:${id}:received:v1`;
}

export function expenseBranchWhere(scope: { cafeId?: string; branchId?: string }): { cafeId: string; id?: string } {
  if (!scope.cafeId) throw new RangeError("نطاق الكافيه مطلوب");
  return { cafeId: scope.cafeId, ...(scope.branchId ? { id: scope.branchId } : {}) };
}

export function expenseAggregate(value: Numeric): Decimal {
  const total = decimal(value);
  if (total.lt(0) || total.decimalPlaces() > 2 || total.gt("9999999999.99")) throw new RangeError("إجمالي المصروفات أو الردود خارج سعة التخزين");
  return total;
}
