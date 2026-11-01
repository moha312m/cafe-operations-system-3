import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requirePermission, requireFeature, resolveCafeId, resolveBranchId, handleApiError, ApiError } from "@/lib/api";

const WINDOW_HOURS = 12;
const LIMIT = 30;

// GET /api/display/orders?branchId= — what the customer-facing screen shows:
// order NUMBERS being prepared and ready for pickup, nothing else (no names,
// items or amounts — the screen faces the room). READY is set on the bar
// screen, so this follows the same feature switch.
export async function GET(request: NextRequest) {
  try {
    const session = await requirePermission("orders:read");
    await requireFeature(session, "kitchenScreenEnabled");
    const params = request.nextUrl.searchParams;
    const cafeId = resolveCafeId(session, params.get("cafeId"));
    const branchId = resolveBranchId(session, params.get("branchId"));
    const branch = await db.branch.findFirst({ where: { id: branchId, cafeId }, select: { name: true } });
    if (!branch) throw new ApiError(404, "الفرع مش موجود");

    const since = new Date(Date.now() - WINDOW_HOURS * 3_600_000);
    const [preparing, ready] = await Promise.all([
      db.order.findMany({
        where: { cafeId, branchId, status: { in: ["CONFIRMED", "PREPARING"] }, createdAt: { gte: since } },
        orderBy: { createdAt: "asc" },
        take: LIMIT,
        select: { orderNumber: true },
      }),
      db.order.findMany({
        where: { cafeId, branchId, status: "READY", createdAt: { gte: since } },
        orderBy: [{ readyAt: { sort: "desc", nulls: "last" } }, { orderNumber: "desc" }],
        take: LIMIT,
        select: { orderNumber: true, readyAt: true },
      }),
    ]);

    return NextResponse.json({
      branchName: branch.name,
      preparing: preparing.map((o) => o.orderNumber),
      ready: ready.map((o) => ({ orderNumber: o.orderNumber, readyAt: o.readyAt })),
    });
  } catch (error) {
    return handleApiError(error);
  }
}
