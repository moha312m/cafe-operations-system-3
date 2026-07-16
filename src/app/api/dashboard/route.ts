import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requirePermission, resolveCafeId, handleApiError } from "@/lib/api";
import { hasPermission } from "@/lib/permissions";
import { productCost, profitFor } from "@/lib/costing";

// Recipe/profit dashboard summary — only for cost-privileged roles.
async function buildRecipeSummary(role: string, cafeId: string) {
  if (!hasPermission(role as never, "cost:read")) return null;
  const products = await db.product.findMany({
    where: { cafeId, isActive: true },
    select: {
      name: true,
      basePrice: true,
      recipeItems: {
        include: { inventoryItem: { select: { unit: true, costPerUnit: true } } },
      },
    },
  });
  let withoutRecipe = 0;
  let lowMargin = 0;
  let top: { name: string; profit: number; margin: number } | null = null;
  for (const p of products) {
    const hasRecipe = p.recipeItems.length > 0;
    if (!hasRecipe) {
      withoutRecipe++;
      continue;
    }
    const cost = productCost(p.recipeItems);
    const { profit, margin, tier } = profitFor(Number(p.basePrice), cost, true);
    if (tier === "loss") lowMargin++;
    if (!top || profit > top.profit) top = { name: p.name, profit, margin };
  }
  return { withoutRecipe, lowMargin, topProduct: top };
}

// Owner dashboard: today's headline numbers plus a 7-day revenue trend
// and top products, optionally filtered to one branch.
export async function GET(request: NextRequest) {
  try {
    const session = await requirePermission("dashboard:read");
    const params = request.nextUrl.searchParams;
    const cafeId = resolveCafeId(session, params.get("cafeId"));
    const branchId = session.branchId ?? params.get("branchId") ?? undefined;

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const sevenDaysAgo = new Date(startOfToday);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);

    const branchFilter = branchId ? { branchId } : {};
    const completedToday = {
      cafeId,
      ...branchFilter,
      status: "SERVED" as const,
      createdAt: { gte: startOfToday },
    };

    const [
      todayAgg, openOrders, weekOrders, topItems, branches, inventoryItems,
      openShiftsCount, cashTodayAgg, paymentSplitRows, salesByBranchToday,
      cashiersTodayRows, recentOrders, leastItems,
    ] =
      await Promise.all([
        db.order.aggregate({
          where: completedToday,
          _sum: { total: true },
          _count: true,
        }),
        db.order.count({
          where: {
            cafeId,
            ...branchFilter,
            status: { in: ["CONFIRMED", "PREPARING", "READY"] },
          },
        }),
        db.order.findMany({
          where: {
            cafeId,
            ...branchFilter,
            status: "SERVED",
            createdAt: { gte: sevenDaysAgo },
          },
          select: { total: true, createdAt: true },
        }),
        db.orderItem.groupBy({
          by: ["productName"],
          where: {
            order: { cafeId, ...branchFilter, status: "SERVED", createdAt: { gte: sevenDaysAgo } },
          },
          _sum: { quantity: true, lineTotal: true },
          orderBy: { _sum: { quantity: "desc" } },
          take: 5,
        }),
        db.branch.findMany({ where: { cafeId }, select: { id: true, name: true } }),
        db.inventoryItem.findMany({
          where: { cafeId, ...branchFilter, archivedAt: null },
          select: { currentStock: true, minimumStock: true },
        }),
        // Open shifts (net cash + shift count headline cards)
        db.shift.count({ where: { cafeId, ...branchFilter, status: "OPEN" } }),
        db.payment.aggregate({
          where: { cafeId, ...branchFilter, status: "PAID", method: "CASH", createdAt: { gte: startOfToday } },
          _sum: { amount: true },
        }),
        db.payment.groupBy({
          by: ["method"],
          where: { cafeId, ...branchFilter, status: "PAID", createdAt: { gte: startOfToday } },
          _sum: { amount: true },
        }),
        db.order.groupBy({
          by: ["branchId"],
          where: { cafeId, status: "SERVED", createdAt: { gte: startOfToday } },
          _sum: { total: true },
        }),
        db.payment.groupBy({
          by: ["receivedById"],
          where: { cafeId, ...branchFilter, status: "PAID", createdAt: { gte: startOfToday } },
          _sum: { amount: true },
          orderBy: { _sum: { amount: "desc" } },
          take: 5,
        }),
        db.order.findMany({
          where: { cafeId, ...branchFilter },
          orderBy: { createdAt: "desc" },
          take: 8,
          select: {
            id: true, orderNumber: true, status: true, source: true, total: true,
            tableNumber: true, customerName: true, createdAt: true,
            branch: { select: { name: true } },
          },
        }),
        db.orderItem.groupBy({
          by: ["productName"],
          where: {
            order: { cafeId, ...branchFilter, status: "SERVED", createdAt: { gte: sevenDaysAgo } },
          },
          _sum: { quantity: true, lineTotal: true },
          orderBy: { _sum: { quantity: "asc" } },
          take: 5,
        }),
      ]);

    // Resolve cashier names for the "top cashiers" table.
    const cashierIds = cashiersTodayRows.map((r) => r.receivedById).filter(Boolean) as string[];
    const cashierUsers = cashierIds.length
      ? await db.user.findMany({ where: { id: { in: cashierIds } }, select: { id: true, name: true } })
      : [];
    const cashierName = new Map(cashierUsers.map((u) => [u.id, u.name]));
    const branchName = new Map(branches.map((b) => [b.id, b.name]));

    // Inventory alert counts (derived from stock vs minimum).
    let lowStockCount = 0;
    let outOfStockCount = 0;
    for (const it of inventoryItems) {
      const cur = Number(it.currentStock);
      if (cur <= 0) outOfStockCount++;
      else if (cur <= Number(it.minimumStock)) lowStockCount++;
    }

    // Bucket the week's completed orders by local calendar day.
    const revenueByDay: { date: string; revenue: number; orders: number }[] = [];
    for (let i = 0; i < 7; i++) {
      const day = new Date(sevenDaysAgo);
      day.setDate(day.getDate() + i);
      revenueByDay.push({
        date: day.toISOString().slice(0, 10),
        revenue: 0,
        orders: 0,
      });
    }
    for (const order of weekOrders) {
      const local = new Date(order.createdAt);
      local.setHours(0, 0, 0, 0);
      const idx = Math.round((local.getTime() - sevenDaysAgo.getTime()) / 86_400_000);
      if (revenueByDay[idx]) {
        revenueByDay[idx].revenue += Number(order.total);
        revenueByDay[idx].orders += 1;
      }
    }

    const todayCount = todayAgg._count;
    const todayRevenue = Number(todayAgg._sum.total ?? 0);

    return NextResponse.json({
      todayRevenue,
      todayOrders: todayCount,
      averageOrderValue: todayCount > 0 ? todayRevenue / todayCount : 0,
      openOrders,
      openShifts: openShiftsCount,
      netCash: Number(cashTodayAgg._sum.amount ?? 0),
      revenueByDay,
      paymentSplit: paymentSplitRows.map((p) => ({
        method: p.method,
        value: Number(p._sum.amount ?? 0),
      })),
      branchPerformance: session.branchId
        ? []
        : salesByBranchToday
            .map((r) => ({ name: branchName.get(r.branchId) ?? "—", value: Number(r._sum.total ?? 0) }))
            .sort((a, b) => b.value - a.value),
      topCashiers: cashiersTodayRows
        .filter((r) => r.receivedById)
        .map((r) => ({ name: cashierName.get(r.receivedById!) ?? "—", value: Number(r._sum.amount ?? 0) })),
      recentOrders: recentOrders.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        status: o.status,
        source: o.source,
        total: Number(o.total),
        table: o.tableNumber,
        customer: o.customerName,
        branch: o.branch.name,
        createdAt: o.createdAt,
      })),
      topProducts: topItems.map((t) => ({
        name: t.productName,
        quantity: t._sum.quantity ?? 0,
        revenue: Number(t._sum.lineTotal ?? 0),
      })),
      leastProducts: leastItems.map((t) => ({
        name: t.productName,
        quantity: t._sum.quantity ?? 0,
        revenue: Number(t._sum.lineTotal ?? 0),
      })),
      branches,
      inventory: { lowStockCount, outOfStockCount },
      recipes: await buildRecipeSummary(session.role, cafeId),
    });
  } catch (error) {
    return handleApiError(error);
  }
}
