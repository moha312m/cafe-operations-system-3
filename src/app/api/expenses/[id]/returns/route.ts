import { type NextRequest } from "next/server";
import { handleApiError } from "@/lib/api";
import { writeExpense } from "@/lib/expense-api";
import { returnInput } from "@/lib/expense-rules";
import { recordOperatingExpenseReturn } from "@/lib/expenses";
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = returnInput.parse(await request.json());
    return await writeExpense(request, `POST /api/expenses/${id}/returns`, body, { expenseId: id }, (tx, actor, identity) => recordOperatingExpenseReturn(tx, actor, id, body, identity));
  } catch (error) { return handleApiError(error); }
}
