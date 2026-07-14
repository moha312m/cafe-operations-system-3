import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requirePermission, resolveCafeId, handleApiError, ApiError } from "@/lib/api";

// Daily sales report: totals, payment-method breakdown, per-branch
// breakdown, and item sales for one calendar day (?date=YYYY-MM-DD).
export async function GET(request: NextRequest) {
  try {
    const session = await requirePermission("reports:read");
    const params = request.nextUrl.searchParams;
    const cafeId = resolveCafeId(session, params.get("cafeId"));
    const branchId = session.branchId ?? params.get("branchId") ?? undefined;

    const dateParam = params.get("date");
    const dayStart = dateParam ? new Date(`${dateParam}T00:00:00`) : new Date();
    if (isNaN(dayStart.getTime())) throw new ApiError(400, "Invalid date");
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);

    const branchFilter = branchId ? { branchId } : {};
    const dayWindow = { gte: dayStart, lt: dayEnd };

    const [
      completed,
      cancelledCount,
      payments,
      itemSales,
      branchTotals,
      branches,
      shiftGroups,
      closedAgg,
      cashierGroups,
    ] = await Promise.all([
        db.order.aggregate({
          where: { cafeId, ...branchFilter, status: "SERVED", createdAt: dayWindow },
          _sum: { total: true, subtotal: true, taxAmount: true, discountAmount: true },
          _count: true,
        }),
        db.order.count({
          where: { cafeId, ...branchFilter, status: "CANCELLED", createdAt: dayWindow },
        }),
        db.payment.groupBy({
          by: ["method"],
          where: {
            cafeId,
            status: "PAID",
            createdAt: dayWindow,
            order: { ...branchFilter },
          },
          _sum: { amount: true },
          _count: true,
        }),
        db.orderItem.groupBy({
          by: ["productName", "variantName"],
          where: {
            order: { cafeId, ...branchFilter, status: "SERVED", createdAt: dayWindow },
          },
          _sum: { quantity: true, lineTotal: true },
          orderBy: { _sum: { lineTotal: "desc" } },
        }),
        db.order.groupBy({
          by: ["branchId"],
          where: { cafeId, status: "SERVED", createdAt: dayWindow },
          _sum: { total: true },
          _count: true,
        }),
        db.branch.findMany({ where: { cafeId }, select: { id: true, name: true } }),
        // Shifts opened during the day, grouped by status.
        db.shift.groupBy({
          by: ["status"],
          where: { cafeId, ...branchFilter, openedAt: dayWindow },
          _count: true,
        }),
        // Cash-difference total across shifts closed during the day.
        db.shift.aggregate({
          where: { cafeId, ...branchFilter, status: "CLOSED", closedAt: dayWindow },
          _sum: { cashDifference: true },
        }),
        // Sales by cashier (PAID payments).
        db.payment.groupBy({
          by: ["cashierId"],
          where: {
            cafeId,
            status: "PAID",
            createdAt: dayWindow,
            order: { ...branchFilter },
          },
          _sum: { amount: true },
          _count: true,
        }),
      ]);

    const branchName = new Map(branches.map((b) => [b.id, b.name]));

    // Resolve cashier names.
    const cashierIds = cashierGroups
      .map((c) => c.cashierId)
      .filter((id): id is string => Boolean(id));
    const cashierUsers = cashierIds.length
      ? await db.user.findMany({
          where: { id: { in: cashierIds } },
          select: { id: true, name: true },
        })
      : [];
    const cashierName = new Map(cashierUsers.map((u) => [u.id, u.name]));

    const openShifts = shiftGroups.find((s) => s.status === "OPEN")?._count ?? 0;
    const closedShifts = shiftGroups.find((s) => s.status === "CLOSED")?._count ?? 0;
    const orderCount = completed._count;
    const revenue = Number(completed._sum.total ?? 0);

    return NextResponse.json({
      date: dayStart.toISOString().slice(0, 10),
      totals: {
        orders: orderCount,
        cancelled: cancelledCount,
        gross: Number(completed._sum.subtotal ?? 0),
        discounts: Number(completed._sum.discountAmount ?? 0),
        tax: Number(completed._sum.taxAmount ?? 0),
        revenue,
        avgOrderValue: orderCount > 0 ? Math.round((revenue / orderCount) * 100) / 100 : 0,
      },
      shifts: {
        open: openShifts,
        closed: closedShifts,
        cashDifferenceTotal: Number(closedAgg._sum.cashDifference ?? 0),
      },
      byCashier: cashierGroups
        .filter((c) => c.cashierId)
        .map((c) => ({
          cashierId: c.cashierId as string,
          cashierName: cashierName.get(c.cashierId as string) ?? "—",
          amount: Number(c._sum.amount ?? 0),
          count: c._count,
        })),
      byPaymentMethod: payments.map((p) => ({
        method: p.method,
        amount: Number(p._sum.amount ?? 0),
        count: p._count,
      })),
      byBranch: branchTotals.map((b) => ({
        branchId: b.branchId,
        branchName: branchName.get(b.branchId) ?? b.branchId,
        revenue: Number(b._sum.total ?? 0),
        orders: b._count,
      })),
      items: itemSales.map((i) => ({
        product: i.productName,
        variant: i.variantName,
        quantity: i._sum.quantity ?? 0,
        revenue: Number(i._sum.lineTotal ?? 0),
      })),
    });
  } catch (error) {
    return handleApiError(error);
  }
}
