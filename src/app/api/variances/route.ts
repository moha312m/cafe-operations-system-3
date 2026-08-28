import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  requireKey,
  requireFeature,
  resolveCafeId,
  resolveBranchId,
  handleApiError,
} from "@/lib/api";
import { VARIANCE_CASE_LIST_SELECT } from "@/lib/variance-case";
import { getDateRangeFromFilter } from "@/lib/date-range";

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
    });

    // Applied only when asked for: the range resolver defaults to today, and
    // defaulting a board to today would hide every case older than this
    // morning from somebody who filtered nothing.
    const rawRange = params.get("range");
    let openedAt: { gte: Date; lte: Date } | undefined;
    if (rawRange) {
      const range = getDateRangeFromFilter(rawRange, {
        date: params.get("date"),
        from: params.get("from"),
        to: params.get("to"),
      });
      openedAt = { gte: range.from, lte: range.to };
    }

    const cases = await db.varianceCase.findMany({
      where: {
        cafeId,
        ...(branchId ? { branchId } : {}),
        ...(filters.type ? { type: filters.type } : {}),
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.custodyPeriodId ? { custodyPeriodId: filters.custodyPeriodId } : {}),
        ...(openedAt ? { openedAt } : {}),
      },
      select: VARIANCE_CASE_LIST_SELECT,
      orderBy: [{ blocking: "desc" }, { openedAt: "desc" }],
      take: 200,
    });

    return NextResponse.json({ cases });
  } catch (error) {
    return handleApiError(error);
  }
}
