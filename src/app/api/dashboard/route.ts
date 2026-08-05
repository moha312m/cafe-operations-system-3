import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requirePermission, resolveCafeId, handleApiError } from "@/lib/api";
import { hasPermission } from "@/lib/permissions";
import { productCost, profitFor } from "@/lib/costing";
import { resolvePermissions } from "@/lib/perms/effective";
import { getCafeSettings } from "@/lib/cafe-settings";
import type { SessionUser } from "@/lib/auth";

// Purchases dashboard summary — only when the feature is on and the user
// can view purchases.
async function buildPurchaseSummary(
  session: SessionUser,
  cafeId: string,
  branchFilter: { branchId?: string },
  startOfToday: Date
) {
  const settings = await getCafeSettings(cafeId);
  if (!settings.purchasesEnabled) return null;
  const { keys } = await resolvePermissions(session);
  if (!keys.has("purchases.view")) return null;

  const startOfMonth = new Date(startOfToday);
  startOfMonth.setDate(1);
  const scope = { cafeId, ...branchFilter, status: { not: "CANCELLED" as const } };
  const [today, month, unpaid] = await Promise.all([
    db.purchaseInvoice.aggregate({ where: { ...scope, invoiceDate: { gte: startOfToday } }, _sum: { totalAmount: true } }),
    db.purchaseInvoice.aggregate({ where: { ...scope, invoiceDate: { gte: startOfMonth } }, _sum: { totalAmount: true } }),
    db.purchaseInvoice.count({ where: { ...scope, paymentStatus: { in: ["UNPAID", "PARTIAL"] } } }),
  ]);
  return {
    todayTotal: Number(today._sum.totalAmount ?? 0),
    monthTotal: Number(month._sum.totalAmount ?? 0),
    unpaidCount: unpaid,
  };
}

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
    if (p.recipeItems.length === 0) {
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

// Resolve the reporting window from ?range= (today|7d|30d|month|custom).
function resolveWindow(range: string, fromParam: string | null, toParam: string | null) {
  const now = new Date();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  let from = startOfToday;
  let to = now;
  if (range === "7d") {
    from = new Date(startOfToday);
    from.setDate(from.getDate() - 6);
  } else if (range === "30d") {
    from = new Date(startOfToday);
    from.setDate(from.getDate() - 29);
  } else if (range === "month") {
    from = new Date(now.getFullYear(), now.getMonth(), 1);
  } else if (range === "custom" && fromParam) {
    from = new Date(`${fromParam}T00:00:00`);
    to = toParam ? new Date(`${toParam}T23:59:59`) : now;
  }
  // Previous same-length window (for "vs previous" comparison).
  const len = to.getTime() - from.getTime();
  const prevFrom = new Date(from.getTime() - len);
  return { now, startOfToday, from, to, prevFrom, prevTo: from };
}

export async function GET(request: NextRequest) {
  try {
    const session = await requirePermission("dashboard:read");
    const params = request.nextUrl.searchParams;
    const cafeId = resolveCafeId(session, params.get("cafeId"));
    const branchId = session.branchId ?? params.get("branchId") ?? undefined;
    const range = params.get("range") ?? "today";

    const { now, startOfToday, from, to, prevFrom, prevTo } = resolveWindow(
      range,
      params.get("from"),
      params.get("to")
    );
    const sevenDaysAgo = new Date(startOfToday);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);

    const branchFilter = branchId ? { branchId } : {};
    const period = { gte: from, lte: to };
    const servedInPeriod = { cafeId, ...branchFilter, status: "SERVED" as const, createdAt: period };

    const [
      servedAgg, prevServedAgg, allOrdersCount, cancelledCount, openOrders,
      weekOrders, topItems, leastItems, branches, inventoryItems,
      openShiftsCount, closedShiftsCount, cashPeriodAgg, paymentSplitRows,
      salesByBranch, cashiersRows, sourceRows, collectionRows,
      recentOrders, recentShifts, latestClosed,
    ] = await Promise.all([
      db.order.aggregate({
        where: servedInPeriod,
        _sum: { total: true, taxAmount: true, serviceChargeAmount: true },
        _count: true,
      }),
      db.order.aggregate({
        where: { cafeId, ...branchFilter, status: "SERVED", createdAt: { gte: prevFrom, lt: prevTo } },
        _sum: { total: true },
        _count: true,
      }),
      db.order.count({
        where: { cafeId, ...branchFilter, createdAt: period, status: { notIn: ["PENDING_WAITER_APPROVAL", "REJECTED"] } },
      }),
      db.order.count({ where: { cafeId, ...branchFilter, status: "CANCELLED", createdAt: period } }),
      db.order.count({ where: { cafeId, ...branchFilter, status: { in: ["CONFIRMED", "PREPARING", "READY"] } } }),
      db.order.findMany({
        where: { cafeId, ...branchFilter, status: "SERVED", createdAt: { gte: sevenDaysAgo } },
        select: { total: true, createdAt: true },
      }),
      db.orderItem.groupBy({
        by: ["productName"],
        where: { order: { cafeId, ...branchFilter, status: "SERVED", createdAt: period } },
        _sum: { quantity: true, lineTotal: true },
        orderBy: { _sum: { quantity: "desc" } },
        take: 5,
      }),
      db.orderItem.groupBy({
        by: ["productName"],
        where: { order: { cafeId, ...branchFilter, status: "SERVED", createdAt: period } },
        _sum: { quantity: true, lineTotal: true },
        orderBy: { _sum: { quantity: "asc" } },
        take: 5,
      }),
      db.branch.findMany({ where: { cafeId }, select: { id: true, name: true } }),
      db.inventoryItem.findMany({
        where: { cafeId, ...branchFilter, archivedAt: null },
        select: { name: true, currentStock: true, minimumStock: true, unit: true },
      }),
      db.shift.count({ where: { cafeId, ...branchFilter, status: "OPEN" } }),
      // Shifts CLOSED within the window (by closedAt) — the "closed today" metric.
      db.shift.count({ where: { cafeId, ...branchFilter, status: "CLOSED", closedAt: period } }),
      db.payment.aggregate({
        where: { cafeId, order: branchFilter, status: "PAID", method: "CASH", createdAt: period },
        _sum: { amount: true },
      }),
      db.payment.groupBy({
        by: ["method"],
        where: { cafeId, order: branchFilter, status: "PAID", createdAt: period },
        _sum: { amount: true },
      }),
      db.order.groupBy({
        by: ["branchId"],
        where: { cafeId, ...branchFilter, status: "SERVED", createdAt: period },
        _sum: { total: true },
      }),
      db.payment.groupBy({
        by: ["cashierId"],
        where: { cafeId, order: branchFilter, status: "PAID", createdAt: period, cashierId: { not: null } },
        _sum: { amount: true },
        orderBy: { _sum: { amount: "desc" } },
        take: 5,
      }),
      db.order.groupBy({
        by: ["source"],
        where: { cafeId, ...branchFilter, createdAt: period, status: { notIn: ["REJECTED", "CANCELLED"] } },
        _count: true,
      }),
      db.order.groupBy({
        by: ["paymentStatus"],
        where: { cafeId, ...branchFilter, createdAt: period, status: { notIn: ["CANCELLED", "REJECTED", "PENDING_WAITER_APPROVAL"] } },
        _sum: { remainingAmount: true },
        _count: true,
      }),
      db.order.findMany({
        where: { cafeId, ...branchFilter },
        orderBy: { createdAt: "desc" },
        take: 8,
        select: {
          id: true, orderNumber: true, status: true, source: true, total: true,
          paymentStatus: true, remainingAmount: true, tableNumber: true, customerName: true,
          createdAt: true, branch: { select: { name: true } },
        },
      }),
      db.shift.findMany({
        where: { cafeId, ...branchFilter },
        orderBy: { openedAt: "desc" },
        take: 6,
        select: {
          id: true, shiftNumber: true, status: true, openedAt: true, closedAt: true,
          totalSales: true, cashDifference: true, cashier: { select: { name: true } },
          branch: { select: { name: true } },
        },
      }),
      db.shift.findFirst({
        where: { cafeId, ...branchFilter, status: "CLOSED" },
        orderBy: { closedAt: "desc" },
        select: {
          shiftNumber: true, closedAt: true, totalSales: true, cashDifference: true,
          cashier: { select: { name: true } }, branch: { select: { name: true } },
        },
      }),
    ]);

    const cashierIds = cashiersRows.map((r) => r.cashierId).filter(Boolean) as string[];
    const cashierUsers = cashierIds.length
      ? await db.user.findMany({ where: { id: { in: cashierIds } }, select: { id: true, name: true } })
      : [];
    const cashierName = new Map(cashierUsers.map((u) => [u.id, u.name]));
    const branchName = new Map(branches.map((b) => [b.id, b.name]));

    // Inventory alerts + a short low-stock list.
    let lowStockCount = 0;
    let outOfStockCount = 0;
    const lowStockItems: { name: string; stock: number; min: number; unit: string }[] = [];
    for (const it of inventoryItems) {
      const cur = Number(it.currentStock);
      const min = Number(it.minimumStock);
      if (cur <= 0) {
        outOfStockCount++;
        lowStockItems.push({ name: it.name, stock: cur, min, unit: it.unit });
      } else if (cur <= min) {
        lowStockCount++;
        lowStockItems.push({ name: it.name, stock: cur, min, unit: it.unit });
      }
    }

    // 7-day trend (always the last 7 calendar days, independent of range).
    const revenueByDay: { date: string; revenue: number; orders: number }[] = [];
    for (let i = 0; i < 7; i++) {
      const day = new Date(sevenDaysAgo);
      day.setDate(day.getDate() + i);
      revenueByDay.push({ date: day.toISOString().slice(0, 10), revenue: 0, orders: 0 });
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

    // Collection breakdown.
    const collRow = (s: string) => collectionRows.find((r) => r.paymentStatus === s);
    const pending = collRow("PENDING_COLLECTION");
    const partial = collRow("PARTIAL");
    const uncollectedTotal =
      Number(pending?._sum.remainingAmount ?? 0) + Number(partial?._sum.remainingAmount ?? 0);

    const servedCount = servedAgg._count;
    const revenue = Number(servedAgg._sum.total ?? 0);
    const branchPerformance = salesByBranch
      .map((r) => ({ name: branchName.get(r.branchId) ?? "—", value: Number(r._sum.total ?? 0) }))
      .sort((a, b) => b.value - a.value);
    const topProducts = topItems.map((t) => ({ name: t.productName, quantity: t._sum.quantity ?? 0, revenue: Number(t._sum.lineTotal ?? 0) }));
    const leastProducts = leastItems.map((t) => ({ name: t.productName, quantity: t._sum.quantity ?? 0, revenue: Number(t._sum.lineTotal ?? 0) }));
    const topCashiers = cashiersRows
      .filter((r) => r.cashierId)
      .map((r) => ({ name: cashierName.get(r.cashierId!) ?? "—", value: Number(r._sum.amount ?? 0) }));

    return NextResponse.json({
      range,
      // Headline KPIs (period-scoped)
      todayRevenue: revenue,
      todayOrders: servedCount,
      ordersAll: allOrdersCount,
      completedOrders: servedCount,
      cancelledOrders: cancelledCount,
      averageOrderValue: servedCount > 0 ? Math.round((revenue / servedCount) * 100) / 100 : 0,
      openOrders,
      openShifts: openShiftsCount,
      closedShiftsToday: closedShiftsCount,
      netCash: Number(cashPeriodAgg._sum.amount ?? 0),
      taxTotal: Number(servedAgg._sum.taxAmount ?? 0),
      serviceTotal: Number(servedAgg._sum.serviceChargeAmount ?? 0),
      uncollectedTotal: Math.round(uncollectedTotal * 100) / 100,
      pendingCount: pending?._count ?? 0,
      partialCount: partial?._count ?? 0,
      prev: { revenue: Number(prevServedAgg._sum.total ?? 0), orders: prevServedAgg._count },
      // Charts
      revenueByDay,
      paymentSplit: paymentSplitRows.map((p) => ({ method: p.method, value: Number(p._sum.amount ?? 0) })),
      ordersBySource: sourceRows.map((s) => ({ source: s.source, count: s._count })),
      branchPerformance: session.branchId ? [] : branchPerformance,
      topCashiers,
      // Insights
      bestBranch: branchPerformance[0] ?? null,
      bestProduct: topProducts[0] ?? null,
      worstProduct: leastProducts[0] ?? null,
      bestCashier: topCashiers[0] ?? null,
      qrOrders: sourceRows.find((s) => s.source === "QR_MENU")?._count ?? 0,
      cashierOrders: sourceRows.find((s) => s.source === "CASHIER_POS")?._count ?? 0,
      latestClosedShift: latestClosed
        ? {
            shiftNumber: latestClosed.shiftNumber,
            closedAt: latestClosed.closedAt,
            cashier: latestClosed.cashier.name,
            branch: latestClosed.branch.name,
            totalSales: Number(latestClosed.totalSales),
            cashDifference: Number(latestClosed.cashDifference ?? 0),
          }
        : null,
      // Tables
      recentOrders: recentOrders.map((o) => ({
        id: o.id, orderNumber: o.orderNumber, status: o.status, source: o.source,
        total: Number(o.total), paymentStatus: o.paymentStatus, remaining: Number(o.remainingAmount),
        table: o.tableNumber, customer: o.customerName, branch: o.branch.name, createdAt: o.createdAt,
      })),
      recentShifts: recentShifts.map((s) => ({
        id: s.id, shiftNumber: s.shiftNumber, status: s.status,
        openedAt: s.openedAt, closedAt: s.closedAt, totalSales: Number(s.totalSales),
        cashDifference: s.cashDifference == null ? null : Number(s.cashDifference),
        cashier: s.cashier.name, branch: s.branch.name,
      })),
      pendingCollectionOrders: recentOrders
        .filter((o) => o.paymentStatus === "PENDING_COLLECTION" || o.paymentStatus === "PARTIAL")
        .map((o) => ({ id: o.id, orderNumber: o.orderNumber, total: Number(o.total), remaining: Number(o.remainingAmount), branch: o.branch.name })),
      topProducts,
      leastProducts,
      lowStockItems: lowStockItems.slice(0, 6),
      branches,
      inventory: { lowStockCount, outOfStockCount },
      recipes: await buildRecipeSummary(session.role, cafeId),
      purchases: await buildPurchaseSummary(session, cafeId, branchFilter, startOfToday),
    });
  } catch (error) {
    return handleApiError(error);
  }
}
