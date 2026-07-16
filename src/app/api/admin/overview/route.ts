import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requirePermission, handleApiError } from "@/lib/api";

// Platform-wide dashboard. SUPER_ADMIN only — aggregates across every
// tenant. No cafeId scoping here by design (this is the one place that
// legitimately reads all cafes at once).
export async function GET() {
  try {
    await requirePermission("platform:manage");

    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const sevenDaysAgo = new Date(startOfToday);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
    const served = "SERVED" as const;

    const [
      totalCafes,
      activeCafes,
      totalBranches,
      totalUsers,
      totalOrders,
      openShifts,
      todayAgg,
      monthAgg,
      weekOrders,
      paymentSplit,
      cafes,
      cafesForGrowth,
    ] = await Promise.all([
      db.cafe.count(),
      db.cafe.count({ where: { isActive: true } }),
      db.branch.count(),
      db.user.count({ where: { role: { not: "SUPER_ADMIN" } } }),
      db.order.count(),
      db.shift.count({ where: { status: "OPEN" } }),
      db.order.aggregate({
        where: { status: served, createdAt: { gte: startOfToday } },
        _sum: { total: true },
        _count: true,
      }),
      db.order.aggregate({
        where: { status: served, createdAt: { gte: startOfMonth } },
        _sum: { total: true },
      }),
      db.order.findMany({
        where: { status: served, createdAt: { gte: sevenDaysAgo } },
        select: { total: true, createdAt: true },
      }),
      db.payment.groupBy({
        by: ["method"],
        where: { status: "PAID", createdAt: { gte: startOfMonth } },
        _sum: { amount: true },
      }),
      db.cafe.findMany({
        select: { id: true, name: true, createdAt: true },
      }),
      db.cafe.findMany({ select: { createdAt: true }, orderBy: { createdAt: "asc" } }),
    ]);

    // Per-cafe sales for today + month (for "top cafe" cards + rankings).
    const [todayByCafe, monthByCafe] = await Promise.all([
      db.order.groupBy({
        by: ["cafeId"],
        where: { status: served, createdAt: { gte: startOfToday } },
        _sum: { total: true },
      }),
      db.order.groupBy({
        by: ["cafeId"],
        where: { status: served, createdAt: { gte: startOfMonth } },
        _sum: { total: true },
      }),
    ]);

    const nameOf = (id: string) => cafes.find((c) => c.id === id)?.name ?? "—";
    const rank = (
      rows: { cafeId: string; _sum: { total: unknown } }[]
    ) =>
      rows
        .map((r) => ({ label: nameOf(r.cafeId), value: Number(r._sum.total ?? 0) }))
        .sort((a, b) => b.value - a.value);

    const topToday = rank(todayByCafe);
    const topMonth = rank(monthByCafe);

    // 7-day sales & orders buckets (local calendar days).
    const days: { date: string; sales: number; orders: number }[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(sevenDaysAgo);
      d.setDate(d.getDate() + i);
      days.push({ date: d.toISOString().slice(0, 10), sales: 0, orders: 0 });
    }
    for (const o of weekOrders) {
      const local = new Date(o.createdAt);
      local.setHours(0, 0, 0, 0);
      const idx = Math.round((local.getTime() - sevenDaysAgo.getTime()) / 86_400_000);
      if (days[idx]) {
        days[idx].sales += Number(o.total);
        days[idx].orders += 1;
      }
    }

    // Cumulative cafe growth (monthly buckets, last 6 months).
    const growth: { label: string; value: number }[] = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const next = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      const count = cafesForGrowth.filter((c) => new Date(c.createdAt) < next).length;
      growth.push({
        label: d.toLocaleDateString("ar-EG-u-nu-latn", { month: "short" }),
        value: count,
      });
    }

    const todayCount = todayAgg._count;
    const todaySales = Number(todayAgg._sum.total ?? 0);

    return NextResponse.json({
      stats: {
        totalCafes,
        activeCafes,
        suspendedCafes: totalCafes - activeCafes,
        totalBranches,
        totalUsers,
        totalOrders,
        todaySales,
        monthSales: Number(monthAgg._sum.total ?? 0),
        openShifts,
        todayOrders: todayCount,
        avgOrderValue: todayCount > 0 ? todaySales / todayCount : 0,
        topCafeToday: topToday[0]?.value ? topToday[0].label : "—",
        topCafeMonth: topMonth[0]?.value ? topMonth[0].label : "—",
      },
      charts: {
        days,
        topCafes: topMonth.slice(0, 5),
        paymentSplit: paymentSplit.map((p) => ({
          method: p.method,
          value: Number(p._sum.amount ?? 0),
        })),
        growth,
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
