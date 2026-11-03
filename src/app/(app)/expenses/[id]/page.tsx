import { ExpenseDetail } from "@/components/expenses/expense-workspace";
export default async function ExpensePage({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; return <ExpenseDetail id={id} />; }
