import { NextResponse, type NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  requireKey,
  requireFeature,
  resolveCafeId,
  resolveBranchId,
  handleApiError,
  ApiError,
} from "@/lib/api";
import { VARIANCE_CASE_LIST_SELECT } from "@/lib/variance-case";
import { dateStrInTz, DEFAULT_TZ, getDateRangeFromFilter } from "@/lib/date-range";
import { money } from "@/lib/money";

const TYPES = ["CASH", "TENDER", "STOCK", "OPENING_EXCEPTION"] as const;
const STATUSES = [
  "OPEN",
  "UNDER_INVESTIGATION",
  "RESPONSIBILITY_ASSIGNED",
  "APPROVED",
  "RESOLVED",
  "WAIVED",
] as const;

// Unknown filter values are REFUSED rather than dropped. A board that
// silently ignored `?status=NOPE` would answer a question nobody asked, and
// the person reading it would have no way to tell.
const filterSchema = z.object({
  type: z.enum(TYPES, { message: "نوع فرق غير معروف" }).optional(),
  status: z.enum(STATUSES, { message: "حالة غير معروفة" }).optional(),
  custodyPeriodId: z.string().min(1).optional(),
  // The cashier of the case's shift, a participant in its custody, or the person it was assigned to.
  userId: z.string().min(1).optional(),
});

// GET /api/variances — the differences this café has found and not yet closed.
//
// Scope is the CALLER'S, not the query's: a branch-pinned user gets their own
// branch whether or not they asked, and asking for another branch is refused
// rather than quietly widened. An unpinned owner with no branch named gets
// the whole café, which is the board they are entitled to.
export async function GET(request: NextRequest) {
  try {
    const session = await requireKey("variance.view");
    await requireFeature(session, "shiftManagementEnabled");

    const params = request.nextUrl.searchParams;
    const cafeId = resolveCafeId(session, params.get("cafeId"));

    // `resolveBranchId` throws for a pinned user naming somebody else's
    // branch, which is the refusal we want; it is only skipped when an
    // unpinned caller asked for no branch at all.
    const requestedBranch = params.get("branchId");
    const branchId =
      session.branchId || requestedBranch
        ? resolveBranchId(session, requestedBranch)
        : undefined;

    const filters = filterSchema.parse({
      type: params.get("type") ?? undefined,
      status: params.get("status") ?? undefined,
      custodyPeriodId: params.get("custodyPeriodId") ?? undefined,
      userId: params.get("userId") ?? undefined,
    });

    // Applied only when asked for: the range resolver defaults to today, and
    // defaulting a board to today would hide every case older than this
    // morning from somebody who filtered nothing.
    // `from`/`to` alone (YYYY-MM-DD, café days) are a custom range.
    const rawRange = params.get("range") ?? (params.get("from") || params.get("to") ? "custom_range" : null);
    let openedAt: { gte: Date; lte: Date } | undefined;
    if (rawRange) {
      const range = getDateRangeFromFilter(rawRange, {
        date: params.get("date"),
        // An open end means "until today" / "from that day".
        from: params.get("from") ?? params.get("to"),
        to: params.get("to") ?? (params.get("from") ? dateStrInTz(new Date(), DEFAULT_TZ) : null),
      });
      if (range.error && !params.get("range")) throw new ApiError(400, range.error);
      openedAt = { gte: range.from, lte: range.to };
    }

    const where: Prisma.VarianceCaseWhereInput = {
      cafeId,
      ...(branchId ? { branchId } : {}),
      ...(filters.type ? { type: filters.type } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.custodyPeriodId ? { custodyPeriodId: filters.custodyPeriodId } : {}),
      ...(openedAt ? { openedAt } : {}),
      ...(filters.userId ? { OR: [
        { shift: { cashierId: filters.userId } },
        { cashShift: { is: { cashierId: filters.userId } } },
        { custodyPeriod: { participants: { some: { userId: filters.userId } } } },
        { assignedResponsibilityUserId: filters.userId },
      ] } : {}),
    };

    // The money summary covers every case the filters match, not just the 200 rows drawn. A shortage is a
    // negative signed variance; an unvalued stock case adds nothing to the impact and is counted apart.
    const moneyTypes = { in: ["CASH", "TENDER"] as ("CASH" | "TENDER")[] };
    const [cases, shortage, overage, stock, unvaluedStockCount, byType] = await Promise.all([
      db.varianceCase.findMany({
        where,
        select: VARIANCE_CASE_LIST_SELECT,
        orderBy: [{ blocking: "desc" }, { openedAt: "desc" }],
        take: 200,
      }),
      db.varianceCase.aggregate({ where: { AND: [where, { type: moneyTypes, amountVariance: { lt: 0 } }] }, _sum: { amountVariance: true } }),
      db.varianceCase.aggregate({ where: { AND: [where, { type: moneyTypes, amountVariance: { gt: 0 } }] }, _sum: { amountVariance: true } }),
      db.varianceCase.aggregate({ where: { AND: [where, { type: "STOCK", financialImpactAvailable: true }] }, _sum: { financialImpact: true }, _count: { _all: true } }),
      db.varianceCase.count({ where: { AND: [where, { type: "STOCK", financialImpactAvailable: false }] } }),
      db.varianceCase.groupBy({ by: ["type"], where: { AND: [where, { status: { notIn: ["RESOLVED", "WAIVED"] } }] }, _count: { _all: true } }),
    ]);
    const openByType = Object.fromEntries(byType.map((row) => [row.type, row._count._all]));

    return NextResponse.json({
      cases,
      summary: {
        openCount: byType.reduce((n, row) => n + row._count._all, 0),
        openByType,
        totalCashShortageAmount: money(shortage._sum.amountVariance ?? 0).abs().toFixed(2),
        totalCashOverageAmount: money(overage._sum.amountVariance ?? 0).toFixed(2),
        totalStockFinancialImpact: money(stock._sum.financialImpact ?? 0).toFixed(2),
        stockCaseCount: stock._count._all + unvaluedStockCount,
        unvaluedStockCount,
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
