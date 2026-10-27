import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ApiError, handleApiError, requireKey, resolveBranchId, resolveCafeId, resolveReadScope } from "@/lib/api";
import { getDateRangeFromFilter } from "@/lib/date-range";

function validDate(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export async function GET(request: NextRequest) {
  try {
    const actor = await requireKey("reports.view");
    resolveReadScope(actor);
    if (!actor.cafeId) throw new ApiError(403, "Cafe required");
    const params = request.nextUrl.searchParams;
    const cafeId = resolveCafeId(actor, params.get("cafeId"));
    const branchId = actor.branchId || params.get("branchId") ? resolveBranchId(actor, params.get("branchId")) : undefined;
    if (branchId && !await db.branch.findFirst({ where: { id: branchId, cafeId }, select: { id: true } })) throw new ApiError(403, "Branch is outside this cafe");
    const from = params.get("from"), to = params.get("to");
    if (!validDate(from) || !validDate(to)) throw new ApiError(400, "Provide valid from and to dates");
    const range = getDateRangeFromFilter("custom_range", { from, to });
    if (range.error) throw new ApiError(400, range.error);
    const employeeId = params.get("employeeId") || undefined;
    if (employeeId && !await db.user.findFirst({ where: { id: employeeId, cafeId, role: { not: "SUPER_ADMIN" } }, select: { id: true } })) throw new ApiError(400, "Employee is not part of this cafe");

    const requests = await db.ownerActionRequest.findMany({
      where: {
        cafeId, ...(branchId ? { branchId } : {}), createdAt: { gte: range.from, lt: new Date(range.to.getTime() + 1) },
        ...(employeeId ? { OR: [{ requesterId: employeeId }, { decidedById: employeeId }, { executorId: employeeId }] } : {}),
      },
      include: {
        requester: { select: { id: true, name: true } }, decider: { select: { id: true, name: true } },
        executor: { select: { id: true, name: true } }, owner: { select: { id: true, name: true } },
        branch: { select: { id: true, name: true } }, order: { select: { orderNumber: true } },
        orderItem: { select: { productName: true, variantName: true } },
        events: { include: { actor: { select: { id: true, name: true } } }, orderBy: { createdAt: "asc" } },
      },
      orderBy: { createdAt: "desc" }, take: 1000,
    });
    const employees = await db.user.findMany({ where: { cafeId, role: { not: "SUPER_ADMIN" }, ...(actor.branchId ? { branchId: actor.branchId } : {}) }, select: { id: true, name: true }, orderBy: { name: "asc" } });
    const branches = await db.branch.findMany({ where: { cafeId, ...(actor.branchId ? { id: actor.branchId } : {}) }, select: { id: true, name: true }, orderBy: { name: "asc" } });
    return NextResponse.json({ requests, employees, branches, range: { from: range.fromDateStr, to: range.toDateStr, timezone: "Africa/Cairo", basis: "request createdAt" } });
  } catch (error) { return handleApiError(error); }
}
