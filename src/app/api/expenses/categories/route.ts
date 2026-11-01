import { NextResponse } from "next/server";
import { handleApiError, requireKey, resolveReadScope } from "@/lib/api";
import { expenseCafe, requireExpenseAuthority } from "@/lib/expense-authorization";
import { readExpenses } from "@/lib/expense-api";
import { categoryInput, expenseBranchWhere } from "@/lib/expense-rules";
import { protectedTransaction } from "@/lib/protected-transaction";
import { auditInTransaction } from "@/lib/audit";
export async function GET() {
  try { return NextResponse.json(await readExpenses(async (tx, { actor, scope }) => ({ branches: await tx.branch.findMany({ where: expenseBranchWhere(scope), select: { id: true, name: true }, orderBy: { name: "asc" } }), categories: await tx.expenseCategory.findMany({ where: { cafeId: actor.cafeId! }, orderBy: [{ archivedAt: "asc" }, { code: "asc" }] }) }))); }
  catch (error) { return handleApiError(error); }
}
export async function POST(request: Request) {
  try {
    const initial = await requireKey("expenses.manage"), cafeId = expenseCafe(initial);
    const body = categoryInput.parse(await request.json());
    const category = await protectedTransaction(async tx => {
      const { actor } = await requireExpenseAuthority(tx, cafeId, "categories");
      const row = await tx.expenseCategory.create({ data: { cafeId, code: body.code, nameAr: body.nameAr, createdById: actor.id } });
      await auditInTransaction(tx, { cafeId, userId: actor.id, action: "EXPENSE_CATEGORY_CREATED", entity: "ExpenseCategory", entityId: row.id, details: { code: row.code, nameAr: row.nameAr, classification: body.classification } });
      return row;
    }, resolveReadScope(initial));
    return NextResponse.json({ category }, { status: 201 });
  } catch (error) { return handleApiError(error); }
}
