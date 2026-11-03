import { NextResponse } from "next/server";
import { ApiError, handleApiError, requireKey, resolveReadScope } from "@/lib/api";
import { expenseCafe, requireExpenseAuthority } from "@/lib/expense-authorization";
import { categoryUpdateInput } from "@/lib/expense-rules";
import { protectedTransaction } from "@/lib/protected-transaction";
import { auditInTransaction } from "@/lib/audit";
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const initial = await requireKey("expenses.manage"), cafeId = expenseCafe(initial), { id } = await params;
    const body = categoryUpdateInput.parse(await request.json());
    const category = await protectedTransaction(async tx => {
      const { actor } = await requireExpenseAuthority(tx, cafeId, "categories");
      const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "ExpenseCategory" WHERE "id"=${id} AND "cafeId"=${cafeId} FOR NO KEY UPDATE`;
      if (!rows.length) throw new ApiError(404, "التصنيف غير موجود");
      const row = await tx.expenseCategory.update({ where: { id }, data: { ...(body.nameAr ? { nameAr: body.nameAr } : {}), ...(body.archived === undefined ? {} : { archivedAt: body.archived ? new Date() : null }) } });
      await auditInTransaction(tx, { cafeId, userId: actor.id, action: "EXPENSE_CATEGORY_UPDATED", entity: "ExpenseCategory", entityId: id, details: body });
      return row;
    }, resolveReadScope(initial));
    return NextResponse.json({ category });
  } catch (error) { return handleApiError(error); }
}
