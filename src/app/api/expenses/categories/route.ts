import { NextResponse } from "next/server";
import { handleApiError, requireKey, resolveReadScope } from "@/lib/api";
import { expenseCafe, requireExpenseAuthority } from "@/lib/expense-authorization";
import { readExpenses } from "@/lib/expense-api";
import { categoryInput, expenseBranchWhere } from "@/lib/expense-rules";
import { protectedTransaction } from "@/lib/protected-transaction";
import { auditInTransaction } from "@/lib/audit";
import { isOperatingExpenseAccount } from "@/lib/accounting/chart-view";
export async function GET() {
  try {
    return NextResponse.json(await readExpenses(async (tx, { actor, scope }) => {
      const [branches, categories, entity] = await Promise.all([
        tx.branch.findMany({ where: expenseBranchWhere(scope), select: { id: true, name: true }, orderBy: { name: "asc" } }),
        tx.expenseCategory.findMany({ where: { cafeId: actor.cafeId! }, orderBy: [{ archivedAt: "asc" }, { code: "asc" }] }),
        tx.accountingEntity.findUnique({ where: { cafeId: actor.cafeId! }, select: { id: true } }),
      ]);
      const chartAccounts = entity
        ? (await tx.accountingAccount.findMany({
            where: { entityId: entity.id, cafeId: actor.cafeId!, type: "EXPENSE", isPostable: true, isActive: true },
            orderBy: { code: "asc" },
            select: { id: true, code: true, name: true, type: true, isPostable: true, isActive: true, systemKey: true },
          }))
            .filter((a) => isOperatingExpenseAccount(a))
            .map((a) => ({ id: a.id, code: a.code, name: a.name }))
        : [];
      return { branches, categories, chartAccounts };
    }));
  }
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
