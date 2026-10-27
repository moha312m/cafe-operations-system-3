import {recognizedSales,contributionTotals,contributionItems} from '@/lib/sales-recognition';
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requirePermission, resolveCafeId, handleApiError, ApiError, resolveReadScope } from "@/lib/api";
import { hasPermission } from "@/lib/permissions";
import { configurationFinancials } from "@/lib/recipes";
import { resolvePermissions } from "@/lib/perms/effective";
import { getCafeSettings } from "@/lib/cafe-settings";
import { withStockAlerts } from "@/lib/low-stock";
import { periodFinancials, salesByStaff, refundsByActor } from "@/lib/reporting";
import {
  getDateRangeFromFilter, dayListForRange, dateStrInTz, DEFAULT_TZ,
} from "@/lib/date-range";
import type { SessionUser } from "@/lib/auth";
import {resolveReportingSelection} from '@/lib/reporting-hours';
import {reportEventWhere,type EventWindow} from '@/lib/report-window-scope';
import {addDays} from '@/lib/date-range';

// Purchases dashboard summary — only when the feature is on and the user
// can view purchases.
async function buildPurchaseSummary(
  session: SessionUser,
  cafeId: string,
  branchFilter: { branchId?: string },
  period: { gte: Date; lte: Date },
  windows?:EventWindow[]
) {
  const settings = await getCafeSettings(cafeId);
  if (!settings.purchasesEnabled) return null;
  const { keys } = await resolvePermissions(session);
  if (!keys.has("purchases.view")) return null;

  const scope = { cafeId, ...branchFilter, status: { not: "CANCELLED" as const } };
  const [inPeriod, unpaid] = await Promise.all([
    // مشتريات الفترة — by invoiceDate, same window as the rest of the page.
    db.purchaseInvoice.aggregate({ where: { ...scope, ...(windows?reportEventWhere(windows,'invoiceDate'):{invoiceDate:period}) }, _sum: { totalAmount: true } }),
    // Unpaid invoices are a current-state alert, not a period metric.
    db.purchaseInvoice.count({ where: { ...scope, paymentStatus: { in: ["UNPAID", "PARTIAL"] } } }),
  ]);
  return {
    periodTotal: Number(inPeriod._sum.totalAmount ?? 0),
    unpaidCount: unpaid,
  };
}

// Recipe/profit dashboard summary — only for cost-privileged roles.
async function buildRecipeSummary(role: string, cafeId: string) {
  if (!hasPermission(role as never, "cost:read")) return null;
  const products = await db.product.findMany({
    where: { cafeId, isActive: true },
    select: {
      id: true,
      name: true,
      basePrice: true,
      variants: { where: { isActive: true }, orderBy: [{ sortOrder: "asc" }, { price: "asc" }] },
    },
  });
  let withoutRecipe = 0;
  let lowMargin = 0;
  let top: { name: string; profit: number; margin: number } | null = null;
  for (const p of products) {
    const configurations = p.variants.length > 0 ? p.variants : [null];
    for (const variant of configurations) {
      const financials = await configurationFinancials({
        productId: p.id,
        variantId: variant?.id ?? null,
        sellingPrice: Number(variant?.price ?? p.basePrice),
      });
      if (financials.costStatus !== "AVAILABLE") {
        withoutRecipe++;
        continue;
      }
      const { profit, margin, tier } = financials;
      if (tier === "loss") lowMargin++;
      const name = variant ? `${p.name} — ${variant.name}` : p.name;
      if (profit !== null && margin !== null && (!top || profit > top.profit)) {
        top = { name, profit, margin };
      }
    }
  }
  return { withoutRecipe, lowMargin, topProduct: top };
}

export async function GET(request: NextRequest) {
  try {
    const session = await requirePermission("dashboard:read");
    const params = request.nextUrl.searchParams;
    const cafeId = resolveCafeId(session, params.get("cafeId"));
    const branchId = resolveReadScope(session).branchId ?? params.get("branchId") ?? undefined;
    if(resolveReadScope(session).branchId&&params.get('branchId')&&params.get('branchId')!==branchId)throw new ApiError(403,'الفرع خارج نطاقك');

    // Timezone-correct reporting window (Africa/Cairo day boundaries),
    // shared with the other reports so numbers always agree.
    const win = getDateRangeFromFilter(params.get("range"), {
      date: params.get("date"),
      from: params.get("from"),
      to: params.get("to"),
    });
    if (win.error) throw new ApiError(400, win.error);
    const { from, to, prevFrom, prevTo } = win;

    const branchFilter = branchId ? { branchId } : {};
    const period = { gte: from, lte: to };
    const reportParams=new URLSearchParams({...(branchId?{branchId}:{}),businessFrom:win.fromDateStr,businessTo:win.toDateStr});
    const reporting=await resolveReportingSelection(session,reportParams,{optional:true,cafeId});
    const eventWindow=(field='createdAt',viaOrder=false)=>reporting?reportEventWhere(reporting.windows,field,viaOrder):{[field]:period};

    // Shared financial definitions, so this screen and the daily report
    // cannot disagree about the same day.
    const scope = { cafeId, branchId, period,windows:reporting?.windows };
    const [financials, staffSales, refundActors] = await Promise.all([
      periodFinancials(scope),
      salesByStaff(scope),
      refundsByActor(scope),
    ]);

    const [
allOrdersCount, cancelledCount, openOrders, branches, inventoryItems, openShiftsCount, closedShiftsCount, cashPeriodAgg, paymentSplitRows, sourceRows, collectionRows, recentOrders, recentShifts, latestClosed, pendingOrdersRows] = await Promise.all([
db.order.count({
        where: { cafeId, ...branchFilter, ...eventWindow(), status: { notIn: ["PENDING_WAITER_APPROVAL", "REJECTED"] } },
      }),
db.order.count({ where: { cafeId, ...branchFilter, status: "CANCELLED", ...eventWindow() } }),
db.order.count({ where: { cafeId, ...branchFilter, status: { in: ["CONFIRMED", "PREPARING", "READY"] } } }),
db.branch.findMany({ where: { cafeId }, select: { id: true, name: true } }),
db.inventoryItem.findMany({
        where: { cafeId, ...branchFilter, archivedAt: null },
        select: { id: true, name: true, currentStock: true, minimumStock: true, unit: true },
      }),
db.shift.count({ where: { cafeId, ...branchFilter, status: "OPEN" } }),
db.shift.count({ where: { cafeId, ...branchFilter, status: "CLOSED", ...eventWindow('closedAt') } }),
db.payment.aggregate({
        where: { cafeId, order: branchFilter, type: "COLLECTION", status: "PAID", method: "CASH", ...eventWindow('createdAt',true) },
        _sum: { amount: true },
      }),
db.payment.groupBy({
        by: ["method"],
        where: { cafeId, order: branchFilter, type: "COLLECTION", status: "PAID", ...eventWindow('createdAt',true) },
        _sum: { amount: true },
      }),
db.order.groupBy({
        by: ["source"],
        where: { cafeId, ...branchFilter, ...eventWindow(), status: { notIn: ["REJECTED", "CANCELLED"] } },
        _count: true,
      }),
db.order.groupBy({
        by: ["paymentStatus"],
        where: { cafeId, ...branchFilter, ...eventWindow(), status: { notIn: ["CANCELLED", "REJECTED", "PENDING_WAITER_APPROVAL"] } },
        _sum: { remainingAmount: true },
        _count: true,
      }),
db.order.findMany({
        where: { cafeId, ...branchFilter, ...eventWindow() },
        orderBy: { createdAt: "desc" },
        take: 8,
        select: {
          id: true, orderNumber: true, status: true, source: true, total: true,
          paymentStatus: true, remainingAmount: true, tableNumber: true, customerName: true,
          createdAt: true, branch: { select: { name: true } },
        },
      }),
db.shift.findMany({
        where: { cafeId, ...branchFilter, ...eventWindow('openedAt') },
        orderBy: { openedAt: "desc" },
        take: 6,
        select: {
          id: true, shiftNumber: true, status: true, openedAt: true, closedAt: true,
          totalSales: true, cashDifference: true, cashier: { select: { name: true } },
          branch: { select: { name: true } },
        },
      }),
db.shift.findFirst({
        where: { cafeId, ...branchFilter, status: "CLOSED", ...eventWindow('closedAt') },
        orderBy: { closedAt: "desc" },
        select: {
          shiftNumber: true, closedAt: true, totalSales: true, cashDifference: true,
          cashier: { select: { name: true } }, branch: { select: { name: true } },
        },
      }),
db.order.findMany({
        where: {
          cafeId, ...branchFilter, ...eventWindow(),
          paymentStatus: { in: ["PENDING_COLLECTION", "PARTIAL"] },
          status: { notIn: ["CANCELLED", "REJECTED", "PENDING_WAITER_APPROVAL"] },
        },
        orderBy: { createdAt: "desc" },
        take: 8,
        select: {
          id: true, orderNumber: true, total: true, remainingAmount: true,
          branch: { select: { name: true } },
        },
      })
]);

    const branchName = new Map(branches.map((b) => [b.id, b.name]));

    // Inventory alerts + a short low-stock list.
    let lowStockCount = 0;
    let outOfStockCount = 0;
    const lowStockItems: { id: string; name: string; stock: number; min: number; unit: string }[] = [];
    for (const it of await withStockAlerts(cafeId, inventoryItems)) {
      if (it.status === "ok") continue;
      if (it.status === "out") outOfStockCount++;
      else lowStockCount++;
      lowStockItems.push({ id: it.id, name: it.name, stock: Number(it.currentStock), min: it.alertThreshold, unit: it.unit });
    }

    // Sales/orders per local (Cairo) calendar day across the SELECTED range.
    // Bucketing uses the cafe timezone so late-night orders land on the
    // right day, never split by UTC boundaries.
    const dayBuckets = new Map(
      dayListForRange(win.fromDateStr, win.toDateStr).map((d) => [d, { date: d, revenue: 0, orders: 0 }])
    );
    const contributions=await recognizedSales(scope);
    const totals=contributionTotals(contributions);
    const days=dayListForRange(win.fromDateStr,win.toDateStr).length;
    const previousSelection=reporting?await resolveReportingSelection(session,new URLSearchParams({...(branchId?{branchId}:{}),reportMode:'business',businessFrom:addDays(win.fromDateStr,-days),businessTo:addDays(win.toDateStr,-days)}),{cafeId}):null;
    const previous=contributionTotals(await recognizedSales({...scope,period:{gte:prevFrom,lt:prevTo},windows:previousSelection?.windows}));
    for (const order of contributions) {
      const businessDate=reporting?.windows.find(w=>w.branchId===order.branchId&&order.at>=w.from&&order.at<w.to)?.businessDate;
      const bucket = dayBuckets.get(businessDate??dateStrInTz(order.at, DEFAULT_TZ));
      if (bucket) {
        bucket.revenue += order.revenue;
        bucket.orders += order.orders;
      }
    }
    const revenueByDay = [...dayBuckets.values()];

    // Collection breakdown.
    const collRow = (s: string) => collectionRows.find((r) => r.paymentStatus === s);
    const pending = collRow("PENDING_COLLECTION");
    const partial = collRow("PARTIAL");
    const uncollectedTotal =
      Number(pending?._sum.remainingAmount ?? 0) + Number(partial?._sum.remainingAmount ?? 0);

    const servedCount = totals.orders;
    const revenue = totals.revenue;
    const branchPerformance = [...new Set(contributions.map(r=>r.branchId))].map(branchId=>({name:branchName.get(branchId)??'فرع غير متاح',value:contributionTotals(contributions.filter(r=>r.branchId===branchId)).revenue})).sort((a,b)=>b.value-a.value);
    const productRows=contributionItems(contributions).map(t=>({name:t.product+(t.variant?' ('+t.variant+')':''),quantity:t.quantity,revenue:t.revenue}));
    const topProducts=productRows.slice(0,5),leastProducts=[...productRows].sort((a,b)=>a.quantity-b.quantity).slice(0,5);
    // Selling performance comes from the order side, attributed to whoever
    // made the sale. Deriving it from payment rows made a refund look like
    // negative sales for whoever handed the money back (REFUND-001).
    const topCashiers = staffSales
      .slice(0, 5)
      .map((s) => ({ name: s.name, value: s.netSales }));

    return NextResponse.json({
      range: win.range,
      reporting,
      // Local-calendar bounds so the UI can label "الفترة: …" exactly.
      period: { from: win.fromDateStr, to: win.toDateStr },
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
      // Gross Sales / Refunds / Net Sales / Collections — identical
      // definitions to the daily report, from the same helper.
      financials,
      salesByStaff: staffSales,
      refundsByActor: refundActors,
      taxTotal: totals.tax,
      serviceTotal: totals.service,
      uncollectedTotal: Math.round(uncollectedTotal * 100) / 100,
      pendingCount: pending?._count ?? 0,
      partialCount: partial?._count ?? 0,
      prev: { revenue: previous.revenue, orders: previous.orders },
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
      pendingCollectionOrders: pendingOrdersRows.map((o) => ({
        id: o.id, orderNumber: o.orderNumber, total: Number(o.total),
        remaining: Number(o.remainingAmount), branch: o.branch.name,
      })),
      topProducts,
      leastProducts,
      lowStockItems: lowStockItems.slice(0, 6),
      branches,
      inventory: { lowStockCount, outOfStockCount },
      recipes: await buildRecipeSummary(session.role, cafeId),
      purchases: await buildPurchaseSummary(session, cafeId, branchFilter, period,reporting?.windows),
    });
  } catch (error) {
    return handleApiError(error);
  }
}
