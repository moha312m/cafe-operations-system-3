import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { ApiError, handleApiError } from "@/lib/api";
import { readExpenses, writeExpense } from "@/lib/expense-api";
import { expenseInput } from "@/lib/expense-rules";
import { expenseDto, recordOperatingExpense } from "@/lib/expenses";
import { addDays, zonedDayStart } from "@/lib/date-range";
const query = z.object({ q: z.string().trim().max(120).optional(), categoryId: z.string().min(1).optional(), branchId: z.string().min(1).optional(), shiftId: z.string().min(1).optional(), from: z.string().date().optional(), to: z.string().date().optional(), page: z.coerce.number().int().min(1).max(10000).default(1) });
export async function GET(request: NextRequest) {
  try {
    const q = query.parse(Object.fromEntries(request.nextUrl.searchParams));
    if (q.from && q.to && q.from > q.to) throw new ApiError(400, "بداية الفترة بعد نهايتها");
    return NextResponse.json(await readExpenses(async (tx, { scope }) => {
      if (q.branchId && scope.branchId && q.branchId !== scope.branchId) throw new ApiError(403, "الفرع خارج نطاقك");
      const where: Prisma.OperatingExpenseWhereInput = { ...scope, ...(q.q ? { OR: [{ description: { contains: q.q } }, { categoryNameSnapshot: { contains: q.q } }] } : {}), ...(q.categoryId ? { categoryId: q.categoryId } : {}), ...(q.branchId ? { branchId: q.branchId } : {}), ...(q.shiftId ? { shiftId: q.shiftId } : {}), ...((q.from || q.to) ? { occurredAt: { ...(q.from ? { gte: zonedDayStart(q.from) } : {}), ...(q.to ? { lt: zonedDayStart(addDays(q.to, 1)) } : {}) } } : {}) };
      const [rows, returns, groups, branches] = await Promise.all([
        tx.operatingExpense.findMany({ where, orderBy: [{ occurredAt: "desc" }, { id: "desc" }], skip: (q.page - 1) * 25, take: 25, include: { returns: { orderBy: [{ occurredAt: "asc" }, { id: "asc" }] } } }),
        tx.operatingExpenseReturn.aggregate({ where: { expense: where }, _sum: { amount: true } }),
        tx.operatingExpense.groupBy({
          by: ["branchId", "categoryId", "categoryNameSnapshot", "categoryCodeSnapshot"],
          where,
          _sum: { amount: true },
          _count: { _all: true },
          orderBy: [{ branchId: "asc" }, { categoryNameSnapshot: "asc" }, { categoryId: "asc" }, { categoryCodeSnapshot: "asc" }],
        }),
        tx.branch.findMany({ where: { cafeId: scope.cafeId, ...(scope.branchId ? { id: scope.branchId } : {}) }, select: { id: true, name: true } }),
      ]);
      const branchNames = Object.fromEntries(branches.map(branch => [branch.id, branch.name]));
      const breakdown = groups.map(group => ({
        branchId: group.branchId, branchName: branchNames[group.branchId] ?? "فرع غير متاح",
        categoryId: group.categoryId, categoryName: group.categoryNameSnapshot, categoryCode: group.categoryCodeSnapshot,
        count: group._count._all, paid: group._sum.amount?.toNumber() ?? 0,
      }));
      const count = breakdown.reduce((total, group) => total + group.count, 0);
      const paid = groups.reduce((total, group) => total.plus(group._sum.amount ?? 0), new Prisma.Decimal(0));
      return { branchNames, breakdown, expenses: rows.map(expenseDto), count, page: q.page, pageSize: 25, totals: { paid: paid.toNumber(), returned: returns._sum.amount?.toNumber() ?? 0 }, currency: "EGP", timezone: "Africa/Cairo" };
    }));
  } catch (error) { return handleApiError(error); }
}
export async function POST(request: NextRequest) {
  try { const body = expenseInput.parse(await request.json()); return await writeExpense(request, "POST /api/expenses", body, { branchId: body.branchId }, (tx, actor, identity) => recordOperatingExpense(tx, actor, body, identity)); }
  catch (error) { return handleApiError(error); }
}
