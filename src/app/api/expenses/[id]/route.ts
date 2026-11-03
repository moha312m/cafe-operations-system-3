import { NextResponse } from "next/server";
import { ApiError, handleApiError } from "@/lib/api";
import { readExpenses } from "@/lib/expense-api";
import { expenseDto } from "@/lib/expenses";
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return NextResponse.json(await readExpenses(async (tx, { scope }) => {
      const row = await tx.operatingExpense.findFirst({ where: { id, ...scope }, include: { returns: { orderBy: [{ occurredAt: "asc" }, { id: "asc" }] }, shift: { select: { status: true } } } });
      if (!row) throw new ApiError(404, "المصروف غير موجود في نطاقك");
      return { expense: expenseDto(row), drawerStatus: row.shift.status };
    }));
  } catch (error) { return handleApiError(error); }
}
