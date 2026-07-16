import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requirePermission, handleApiError } from "@/lib/api";
import type { Prisma } from "@prisma/client";

// Platform-wide sales report with filters.
//   ?from=YYYY-MM-DD  ?to=YYYY-MM-DD  ?cafeId=  ?method=CASH|CARD|WALLET
// Aggregates SERVED-order sales; payment totals come from the Payment
// ledger so cash/card/wallet splits are exact.
export async function GET(request: NextRequest) {
  try {
    await requirePermission("platform:manage");
    const p = request.nextUrl.searchParams;

    const from = p.get("from") ? new Date(p.get("from")!) : (() => {
      const d = new Date(); d.setDate(d.getDate() - 29); d.setHours(0, 0, 0, 0); return d;
    })();
    const to = p.get("to") ? new Date(p.get("to")!) : new Date();
    to.setHours(23, 59, 59, 999);
    const cafeId = p.get("cafeId") || undefined;
    const method = p.get("method") || undefined;

    const orderWhere: Prisma.OrderWhereInput = {
      status: "SERVED",
      createdAt: { gte: from, lte: to },
      ...(cafeId ? { cafeId } : {}),
    };
    const payWhere: Prisma.PaymentWhereInput = {
      status: "PAID",
      createdAt: { gte: from, lte: to },
      ...(cafeId ? { cafeId } : {}),
      ...(method ? { method: method as Prisma.PaymentWhereInput["method"] } : {}),
    };

    const [totals, byPayment, salesByCafe, ordersByCafe, cafes] = await Promise.all([
      db.order.aggregate({ where: orderWhere, _sum: { total: true }, _count: true }),
      db.payment.groupBy({ by: ["method"], where: payWhere, _sum: { amount: true } }),
      db.order.groupBy({ by: ["cafeId"], where: orderWhere, _sum: { total: true }, _count: true }),
      db.order.groupBy({ by: ["cafeId"], where: orderWhere, _count: true }),
      db.cafe.findMany({ select: { id: true, name: true, isActive: true } }),
    ]);

    const nameOf = (id: string) => cafes.find((c) => c.id === id)?.name ?? "—";
    const ordersMap = new Map(ordersByCafe.map((r) => [r.cafeId, r._count]));

    const perCafe = salesByCafe
      .map((r) => ({
        cafeId: r.cafeId,
        name: nameOf(r.cafeId),
        sales: Number(r._sum.total ?? 0),
        orders: ordersMap.get(r.cafeId) ?? 0,
      }))
      .sort((a, b) => b.sales - a.sales);

    // Cafes with no sales in the window = low-activity list.
    const activeIds = new Set(salesByCafe.map((r) => r.cafeId));
    const lowActivity = cafes
      .filter((c) => !activeIds.has(c.id))
      .map((c) => ({ cafeId: c.id, name: c.name, isActive: c.isActive }));

    const pay = (m: string) =>
      Number(byPayment.find((r) => r.method === m)?._sum.amount ?? 0);
    const totalSales = Number(totals._sum.total ?? 0);
    const totalOrders = totals._count;

    return NextResponse.json({
      range: { from: from.toISOString(), to: to.toISOString() },
      totals: {
        totalSales,
        totalOrders,
        avgOrderValue: totalOrders > 0 ? totalSales / totalOrders : 0,
        cash: pay("CASH"),
        card: pay("CARD"),
        wallet: pay("WALLET"),
      },
      topCafes: perCafe.slice(0, 10),
      lowActivity,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
