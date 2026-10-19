import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requirePermission, resolveCafeId, handleApiError, ApiError, resolveReadScope } from "@/lib/api";
import { DEFAULT_STALE_ORDER_ALERT_HOURS, openOrdersSummary } from "@/lib/open-orders";

// GET /api/orders/open-summary?branchId= — what is still open at the branch,
// and which orders have been sitting long enough to count as forgotten.
// Read by the close dialog (before the drawer is counted) and by the
// forgotten-orders banner. Read-only; branch-pinned users see their branch.
export async function GET(request: NextRequest) {
  try {
    const session = await requirePermission("orders:read");
    const params = request.nextUrl.searchParams;
    const cafeId = resolveCafeId(session, params.get("cafeId"));
    const requested = params.get("branchId");
    if (session.branchId && requested && requested !== session.branchId) {
      throw new ApiError(403, "Not allowed");
    }
    const branchId = resolveReadScope(session).branchId ?? requested;
    if (branchId) {
      const branch = await db.branch.findFirst({ where: { id: branchId, cafeId }, select: { id: true } });
      if (!branch) throw new ApiError(404, "الفرع مش موجود");
    }

    const settings = await db.cafeSettings.findUnique({
      where: { cafeId },
      select: { staleOrderAlertHours: true, carryOpenOrdersOnHandover: true },
    });
    const staleHours = settings?.staleOrderAlertHours ?? DEFAULT_STALE_ORDER_ALERT_HOURS;
    const summary = await openOrdersSummary({ cafeId, branchId, staleHours });

    return NextResponse.json({
      staleHours,
      carryOpenOrdersOnHandover: settings?.carryOpenOrdersOnHandover ?? false,
      ...summary,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
