import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requirePermission, resolveCafeId, handleApiError, ApiError, resolveReadScope } from "@/lib/api";
import { periodFinancials, salesByStaff, refundsByActor } from "@/lib/reporting";
import {recognizedSales,contributionTotals,contributionItems} from '@/lib/sales-recognition';
import { addDays, dateStrInTz, zonedDayStart } from "@/lib/date-range";
import {resolveReportingSelection} from '@/lib/reporting-hours';
import {reportEventWhere} from '@/lib/report-window-scope';
import {signReportOutput} from '@/lib/report-output';

// Daily sales report: totals, payment-method breakdown, per-branch
// breakdown, and item sales for one calendar day (?date=YYYY-MM-DD).
export async function GET(request: NextRequest) {
  try {
    const session = await requirePermission("reports:read");
    const params = request.nextUrl.searchParams;
    const cafeId = resolveCafeId(session, params.get("cafeId"));
    const assignedBranch=resolveReadScope(session).branchId;
    if(assignedBranch&&params.get('branchId')&&params.get('branchId')!==assignedBranch)throw new ApiError(403,'الفرع خارج نطاقك');
    const branchId = assignedBranch ?? params.get("branchId") ?? undefined;
    const reporting=await resolveReportingSelection(session,params,{cafeId});

    const date = params.get('businessFrom') ?? params.get("date") ?? dateStrInTz(new Date());
    const parsedDate = new Date(`${date}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) {
      throw new ApiError(400, "Invalid date");
    }
    const dayStart = zonedDayStart(date);
    const dayEnd = zonedDayStart(addDays(date, 1));

    const branchFilter = branchId ? { branchId } : {};
    const dayWindow = { gte: dayStart, lt: dayEnd };
    const eventWindow=(field='createdAt',viaOrder=false)=>reporting?reportEventWhere(reporting.windows,field,viaOrder):{[field]:dayWindow};

    // Sales, refunds and money movement come from one shared definition so
    // this report and the dashboard cannot drift apart.
    const scope = { cafeId, branchId, period: dayWindow,windows:reporting?.windows };
    const [financials, staffSales, refundActors] = await Promise.all([
      periodFinancials(scope),
      salesByStaff(scope),
      refundsByActor(scope),
    ]);

    const [
      cancelledCount,
      collectionGroups,
      payments,
      branches,
      shiftGroups,
      closedAgg,
      cashierGroups,
    ] = await Promise.all([
        db.order.count({
          where: { cafeId, ...branchFilter, status: "CANCELLED", ...eventWindow() },
        }),
        // Collection state across non-cancelled orders created today.
        db.order.groupBy({
          by: ["paymentStatus"],
          where: {
            cafeId, ...branchFilter, ...eventWindow(),
            status: { notIn: ["CANCELLED", "REJECTED", "PENDING_WAITER_APPROVAL"] },
          },
          _sum: { total: true, paidAmount: true, remainingAmount: true },
          _count: true,
        }),
        db.payment.groupBy({
          by: ["method"],
          where: {
            cafeId,
            type: "COLLECTION",
            status: "PAID",
            ...eventWindow('createdAt',true),
            order: { ...branchFilter },
          },
          _sum: { amount: true },
          _count: true,
        }),
        db.branch.findMany({ where: { cafeId, ...(branchId ? { id: branchId } : {}) }, select: { id: true, name: true } }),
        // Shifts opened during the day, grouped by status.
        db.shift.groupBy({
          by: ["status"],
          where: { cafeId, ...branchFilter, ...eventWindow('openedAt') },
          _count: true,
        }),
        // Cash-difference total across shifts closed during the day.
        db.shift.aggregate({
          where: { cafeId, ...branchFilter, status: "CLOSED", ...eventWindow('closedAt') },
          _sum: { cashDifference: true },
        }),
        // Sales by cashier (PAID payments).
        db.payment.groupBy({
          by: ["cashierId"],
          where: {
            cafeId,
            type: "COLLECTION",
            status: "PAID",
            ...eventWindow('createdAt',true),
            order: { ...branchFilter },
          },
          _sum: { amount: true },
          _count: true,
        }),
      ]);

    // ── Table sessions ──
    const [openTables, closedTables, tablePayAgg] = await Promise.all([
      db.tableSession.findMany({
        where: { cafeId, ...branchFilter, status: "OPEN" },
        select: { remainingAmount: true },
      }),
      db.tableSession.findMany({
        where: { cafeId, ...branchFilter, status: "CLOSED", ...eventWindow('closedAt') },
        select: { startedAt: true, closedAt: true, totalAmount: true },
      }),
      // Payments collected through the tables board today.
      db.payment.aggregate({
        where: {
          cafeId, type: "COLLECTION", status: "PAID", ...eventWindow('createdAt',true),
          tableSessionId: { not: null }, order: { ...branchFilter },
        },
        _sum: { amount: true },
        _count: true,
      }),
    ]);
    // ── Purchases (day) ──
    // A purchase is recognized when it is confirmed (stock added). A draft is
    // a commitment — still editable, no stock — so it is reported apart and
    // owes the supplier nothing yet. The unpaid balance is as of now, not
    // as of the selected period.
    const [purchaseAgg, supplierPayAgg, purchaseUnpaid, draftAgg] = await Promise.all([
      db.purchaseInvoice.aggregate({
        where: { cafeId, ...branchFilter, status: "CONFIRMED", ...eventWindow('invoiceDate') },
        _sum: { totalAmount: true }, _count: true,
      }),
      db.purchasePayment.aggregate({
        where: { cafeId, ...branchFilter, ...eventWindow('paidAt') },
        _sum: { amount: true },
      }),
      db.purchaseInvoice.aggregate({
        where: { cafeId, ...branchFilter, status: "CONFIRMED", paymentStatus: { in: ["UNPAID", "PARTIAL"] } },
        _sum: { remainingAmount: true },
      }),
      db.purchaseInvoice.aggregate({
        where: { cafeId, ...branchFilter, status: "DRAFT", ...eventWindow('invoiceDate') },
        _sum: { totalAmount: true }, _count: true,
      }),
    ]);
    const unpaidAsOf = new Date().toISOString();

    const tableUncollected = openTables.reduce((s, ts) => s + Number(ts.remainingAmount), 0);
    const durations = closedTables
      .filter((ts) => ts.closedAt)
      .map((ts) => (new Date(ts.closedAt!).getTime() - new Date(ts.startedAt).getTime()) / 60_000);
    const avgTableMinutes = durations.length
      ? Math.round(durations.reduce((s, d) => s + d, 0) / durations.length)
      : 0;

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
    const recognized=await recognizedSales(scope),recognizedTotals=contributionTotals(recognized);
    const orderCount = recognizedTotals.orders;
    const revenue = recognizedTotals.revenue;

    // Collection breakdown by payment status.
    const collectRow = (status: string) => collectionGroups.find((g) => g.paymentStatus === status);
    const pending = collectRow("PENDING_COLLECTION");
    const partial = collectRow("PARTIAL");
    const paidAmountTotal = collectionGroups.reduce((s, g) => s + Number(g._sum.paidAmount ?? 0), 0);
    const uncollectedTotal = collectionGroups
      .filter((g) => g.paymentStatus === "PENDING_COLLECTION" || g.paymentStatus === "PARTIAL")
      .reduce((s, g) => s + Number(g._sum.remainingAmount ?? 0), 0);

    const result={
      date,
      reporting,
      totals: {
        orders: orderCount,
        cancelled: cancelledCount,
        gross: recognizedTotals.gross,
        discounts: recognizedTotals.discounts,
        service: recognizedTotals.service,
        tax: recognizedTotals.tax,
        revenue,
        avgOrderValue: orderCount > 0 ? Math.round((revenue / orderCount) * 100) / 100 : 0,
      },
      collection: {
        paidTotal: Math.round(paidAmountTotal * 100) / 100,
        uncollectedTotal: Math.round(uncollectedTotal * 100) / 100,
        pendingCount: pending?._count ?? 0,
        pendingRemaining: Math.round(Number(pending?._sum.remainingAmount ?? 0) * 100) / 100,
        partialCount: partial?._count ?? 0,
        partialRemaining: Math.round(Number(partial?._sum.remainingAmount ?? 0) * 100) / 100,
      },
      shifts: {
        open: openShifts,
        closed: closedShifts,
        cashDifferenceTotal: Number(closedAgg._sum.cashDifference ?? 0),
      },
      tables: {
        openCount: openTables.length,
        closedTodayCount: closedTables.length,
        avgSittingMinutes: avgTableMinutes,
        collectedTotal: Number(tablePayAgg._sum.amount ?? 0),
        collectedCount: tablePayAgg._count,
        uncollectedTotal: Math.round(tableUncollected * 100) / 100,
        closedSales: Math.round(closedTables.reduce((s, ts) => s + Number(ts.totalAmount), 0) * 100) / 100,
      },
      purchases: {
        total: Number(purchaseAgg._sum.totalAmount ?? 0),
        invoiceCount: purchaseAgg._count,
        supplierPayments: Number(supplierPayAgg._sum.amount ?? 0),
        unpaidTotal: Math.round(Number(purchaseUnpaid._sum.remainingAmount ?? 0) * 100) / 100,
        unpaidAsOf,
        draftCount: draftAgg._count,
        draftTotal: Number(draftAgg._sum.totalAmount ?? 0),
      },
      // Gross Sales / Refunds / Net Sales / Collections, by transaction period.
      financials,
      // Selling performance, attributed to whoever made the sale. A refund
      // reduces the original seller rather than appearing as negative sales
      // for whoever processed it.
      salesByStaff: staffSales.map((s) => ({
        userId: s.userId,
        name: s.name,
        grossSales: s.grossSales,
        refunds: s.refunds,
        netSales: s.netSales,
        orders: s.orders,
      })),
      // Refund processing, kept separate from selling performance.
      refundsByActor: refundActors,
      // Money handled per cashier (collections and refunds alike). Retained
      // for continuity — it answers "who touched money", not "who sold".
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
      byBranch: [...new Set(recognized.map(r=>r.branchId))].map(branchId=>({branchId,branchName:branchName.get(branchId)??branchId,...contributionTotals(recognized.filter(r=>r.branchId===branchId))})),
      items: contributionItems(recognized),
    };
    return NextResponse.json({...result,outputSnapshot:signReportOutput(session.id,{title:reporting?.mode==='custom'?'تقرير مبيعات مخصص':reporting?.mode==='outside'?'تقرير مبيعات خارج الساعات':'تقرير أيام العمل',reporting:{mode:reporting?.mode,windows:reporting?.windows,branches:reporting?.branches.map(b=>({id:b.id,name:b.name}))},metrics:{totals:result.totals,financials:result.financials,collection:result.collection,shifts:result.shifts,tables:result.tables,purchases:result.purchases},rows:[...result.byBranch.map(row=>({section:'byBranch',...row})),...result.byPaymentMethod.map(row=>({section:'byPaymentMethod',...row})),...result.byCashier.map(row=>({section:'byCashier',...row})),...result.refundsByActor.map(row=>({section:'refundsByActor',...row})),...result.items.map(row=>({section:'items',...row})),...result.salesByStaff.map(row=>({section:'salesByStaff',...row}))],generatedAt:new Date().toISOString()})});
  } catch (error) {
    return handleApiError(error);
  }
}
