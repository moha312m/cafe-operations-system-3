import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requirePermission, handleApiError } from "@/lib/api";

// Enriched cafe list for the super-admin cafes table: counts + today/month
// sales + last-order time, computed with a few grouped queries rather than
// N per-cafe round-trips.
export async function GET() {
  try {
    await requirePermission("platform:manage");

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    const served = "SERVED" as const;

    const [cafes, todayByCafe, monthByCafe, lastOrders, owners] = await Promise.all([
      db.cafe.findMany({
        orderBy: { createdAt: "desc" },
        include: {
          _count: { select: { branches: true, users: true, orders: true } },
        },
      }),
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
      db.order.groupBy({
        by: ["cafeId"],
        _max: { createdAt: true },
      }),
      db.user.findMany({
        where: { role: "CAFE_OWNER", archivedAt: null },
        select: { id: true, name: true, cafeId: true },
        orderBy: { createdAt: "asc" },
      }),
    ]);

    const today = new Map(todayByCafe.map((r) => [r.cafeId, Number(r._sum.total ?? 0)]));
    const month = new Map(monthByCafe.map((r) => [r.cafeId, Number(r._sum.total ?? 0)]));
    const last = new Map(lastOrders.map((r) => [r.cafeId, r._max.createdAt]));
    // First owner per cafe (used for the "reset owner password" action).
    const ownerByCafe = new Map<string, { id: string; name: string }>();
    for (const o of owners) {
      if (o.cafeId && !ownerByCafe.has(o.cafeId)) ownerByCafe.set(o.cafeId, { id: o.id, name: o.name });
    }

    return NextResponse.json({
      cafes: cafes.map((c) => ({
        id: c.id,
        name: c.name,
        slug: c.slug,
        currency: c.currency,
        isActive: c.isActive,
        planName: c.planName,
        subscriptionStatus: c.subscriptionStatus,
        subscriptionEndsAt: c.subscriptionEndsAt,
        createdAt: c.createdAt,
        branches: c._count.branches,
        users: c._count.users,
        orders: c._count.orders,
        todaySales: today.get(c.id) ?? 0,
        monthSales: month.get(c.id) ?? 0,
        lastOrderAt: last.get(c.id) ?? null,
        owner: ownerByCafe.get(c.id) ?? null,
      })),
    });
  } catch (error) {
    return handleApiError(error);
  }
}
