import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requirePermission, handleApiError, ApiError } from "@/lib/api";
import { audit } from "@/lib/audit";
import { getCafeSettings, toFeatureMap } from "@/lib/cafe-settings";
import type { Prisma } from "@prisma/client";

type Params = { params: Promise<{ cafeId: string }> };

// ── GET: full detail for one cafe (overview, branches, users, sales,
//    orders, shifts, audit) ─────────────────────────────────────────
export async function GET(_req: NextRequest, { params }: Params) {
  try {
    await requirePermission("platform:manage");
    const { cafeId } = await params;

    const cafe = await db.cafe.findUnique({ where: { id: cafeId } });
    if (!cafe) throw new ApiError(404, "الكافيه غير موجود");

    const settings = await getCafeSettings(cafeId);

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    const days30 = new Date(startOfToday);
    days30.setDate(days30.getDate() - 29);
    const days7 = new Date(startOfToday);
    days7.setDate(days7.getDate() - 6);
    const served = "SERVED" as const;
    const base = { cafeId };

    const [
      branches,
      users,
      todayAgg,
      monthAgg,
      staffCount,
      lastOrder,
      salesByBranch,
      salesByPayment,
      topProducts,
      recentOrders,
      recentShifts,
      auditLogs,
      week30Orders,
      todayByBranch,
      monthByBranch,
      openShiftsByBranch,
      ordersCountByBranch,
    ] = await Promise.all([
      db.branch.findMany({ where: base, orderBy: { createdAt: "asc" } }),
      db.user.findMany({
        where: base,
        orderBy: { createdAt: "asc" },
        select: {
          id: true, name: true, email: true, phone: true, role: true,
          isActive: true, archivedAt: true, lastLoginAt: true,
          branch: { select: { name: true } },
        },
      }),
      db.order.aggregate({
        where: { ...base, status: served, createdAt: { gte: startOfToday } },
        _sum: { total: true }, _count: true,
      }),
      db.order.aggregate({
        where: { ...base, status: served, createdAt: { gte: startOfMonth } },
        _sum: { total: true }, _count: true,
      }),
      db.user.count({ where: { ...base, archivedAt: null } }),
      db.order.findFirst({ where: base, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
      db.order.groupBy({
        by: ["branchId"],
        where: { ...base, status: served, createdAt: { gte: days30 } },
        _sum: { total: true },
      }),
      db.payment.groupBy({
        by: ["method"],
        where: { ...base, status: "PAID", createdAt: { gte: days30 } },
        _sum: { amount: true },
      }),
      db.orderItem.groupBy({
        by: ["productName"],
        where: { order: { ...base, status: served, createdAt: { gte: days30 } } },
        _sum: { quantity: true, lineTotal: true },
        orderBy: { _sum: { lineTotal: "desc" } },
        take: 5,
      }),
      db.order.findMany({
        where: base,
        orderBy: { createdAt: "desc" },
        take: 10,
        select: {
          id: true, orderNumber: true, source: true, status: true,
          total: true, createdAt: true, branch: { select: { name: true } },
        },
      }),
      db.shift.findMany({
        where: base,
        orderBy: { openedAt: "desc" },
        take: 8,
        select: {
          id: true, shiftNumber: true, status: true, openedAt: true, closedAt: true,
          totalSales: true, cashDifference: true,
          cashier: { select: { name: true } }, branch: { select: { name: true } },
        },
      }),
      db.auditLog.findMany({
        where: base,
        orderBy: { createdAt: "desc" },
        take: 15,
        select: {
          id: true, action: true, entity: true, createdAt: true,
          user: { select: { name: true } },
        },
      }),
      db.order.findMany({
        where: { ...base, status: served, createdAt: { gte: days7 } },
        select: { total: true, createdAt: true },
      }),
      db.order.groupBy({
        by: ["branchId"],
        where: { ...base, status: served, createdAt: { gte: startOfToday } },
        _sum: { total: true },
      }),
      db.order.groupBy({
        by: ["branchId"],
        where: { ...base, status: served, createdAt: { gte: startOfMonth } },
        _sum: { total: true },
      }),
      db.shift.groupBy({
        by: ["branchId"],
        where: { ...base, status: "OPEN" },
        _count: true,
      }),
      db.order.groupBy({ by: ["branchId"], where: base, _count: true }),
    ]);

    const branchToday = new Map(todayByBranch.map((r) => [r.branchId, Number(r._sum.total ?? 0)]));
    const branchMonth = new Map(monthByBranch.map((r) => [r.branchId, Number(r._sum.total ?? 0)]));
    const branchOpen = new Map(openShiftsByBranch.map((r) => [r.branchId, r._count]));
    const branchOrders = new Map(ordersCountByBranch.map((r) => [r.branchId, r._count]));
    const branchName = new Map(branches.map((b) => [b.id, b.name]));
    const branchStaff = await db.user.groupBy({
      by: ["branchId"], where: { ...base, archivedAt: null }, _count: true,
    });
    const branchStaffCount = new Map(branchStaff.map((r) => [r.branchId, r._count]));

    // 7-day sales trend.
    const trend: { date: string; sales: number }[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(days7);
      d.setDate(d.getDate() + i);
      trend.push({ date: d.toISOString().slice(0, 10), sales: 0 });
    }
    for (const o of week30Orders) {
      const local = new Date(o.createdAt);
      local.setHours(0, 0, 0, 0);
      const idx = Math.round((local.getTime() - days7.getTime()) / 86_400_000);
      if (trend[idx]) trend[idx].sales += Number(o.total);
    }

    const todayCount = todayAgg._count;
    const todaySales = Number(todayAgg._sum.total ?? 0);

    return NextResponse.json({
      cafe: {
        id: cafe.id, name: cafe.name, slug: cafe.slug, currency: cafe.currency,
        taxRate: Number(cafe.taxRate), isActive: cafe.isActive,
        suspendedAt: cafe.suspendedAt, suspendedReason: cafe.suspendedReason,
        planName: cafe.planName, subscriptionStatus: cafe.subscriptionStatus,
        subscriptionStartedAt: cafe.subscriptionStartedAt,
        subscriptionEndsAt: cafe.subscriptionEndsAt, createdAt: cafe.createdAt,
      },
      settings: toFeatureMap(settings),
      overview: {
        branches: branches.length,
        staff: staffCount,
        orders: monthAgg._count,
        todaySales,
        monthSales: Number(monthAgg._sum.total ?? 0),
        avgOrderValue: todayCount > 0 ? todaySales / todayCount : 0,
        lastOrderAt: lastOrder?.createdAt ?? null,
      },
      branches: branches.map((b) => ({
        id: b.id, name: b.name, isActive: b.isActive,
        orders: branchOrders.get(b.id) ?? 0,
        todaySales: branchToday.get(b.id) ?? 0,
        monthSales: branchMonth.get(b.id) ?? 0,
        staff: branchStaffCount.get(b.id) ?? 0,
        openShifts: branchOpen.get(b.id) ?? 0,
      })),
      users,
      reports: {
        trend7: trend,
        byBranch: salesByBranch.map((r) => ({
          label: branchName.get(r.branchId ?? "") ?? "—",
          value: Number(r._sum.total ?? 0),
        })),
        byPayment: salesByPayment.map((r) => ({
          method: r.method, value: Number(r._sum.amount ?? 0),
        })),
        topProducts: topProducts.map((p) => ({
          name: p.productName,
          quantity: p._sum.quantity ?? 0,
          revenue: Number(p._sum.lineTotal ?? 0),
        })),
      },
      orders: recentOrders,
      shifts: recentShifts,
      audit: auditLogs,
    });
  } catch (error) {
    return handleApiError(error);
  }
}

// ── PATCH: update cafe, suspend/activate, subscription ──────────────
const patchSchema = z.object({
  name: z.string().min(2).optional(),
  currency: z.string().length(3).optional(),
  taxRate: z.number().min(0).max(100).optional(),
  isActive: z.boolean().optional(),
  suspendedReason: z.string().max(300).nullable().optional(),
  planName: z.string().min(1).max(60).optional(),
  subscriptionStatus: z.enum(["TRIAL", "ACTIVE", "EXPIRED", "SUSPENDED"]).optional(),
  subscriptionStartedAt: z.string().datetime().nullable().optional(),
  subscriptionEndsAt: z.string().datetime().nullable().optional(),
});

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const session = await requirePermission("platform:manage");
    const { cafeId } = await params;
    const existing = await db.cafe.findUnique({ where: { id: cafeId } });
    if (!existing) throw new ApiError(404, "الكافيه غير موجود");

    const data = patchSchema.parse(await request.json());
    const update: Prisma.CafeUpdateInput = {};

    if (data.name !== undefined) update.name = data.name;
    if (data.currency !== undefined) update.currency = data.currency;
    if (data.taxRate !== undefined) update.taxRate = data.taxRate;
    if (data.planName !== undefined) update.planName = data.planName;
    if (data.subscriptionStatus !== undefined) update.subscriptionStatus = data.subscriptionStatus;
    if (data.subscriptionStartedAt !== undefined)
      update.subscriptionStartedAt = data.subscriptionStartedAt ? new Date(data.subscriptionStartedAt) : null;
    if (data.subscriptionEndsAt !== undefined)
      update.subscriptionEndsAt = data.subscriptionEndsAt ? new Date(data.subscriptionEndsAt) : null;

    // Suspend / activate — records the suspension timestamp + reason.
    let suspendEvent: "CAFE_SUSPENDED" | "CAFE_ACTIVATED" | null = null;
    if (data.isActive !== undefined && data.isActive !== existing.isActive) {
      update.isActive = data.isActive;
      if (data.isActive) {
        update.suspendedAt = null;
        update.suspendedReason = null;
        suspendEvent = "CAFE_ACTIVATED";
      } else {
        update.suspendedAt = new Date();
        update.suspendedReason = data.suspendedReason ?? null;
        suspendEvent = "CAFE_SUSPENDED";
      }
    }

    const cafe = await db.cafe.update({ where: { id: cafeId }, data: update });

    if (suspendEvent) {
      await audit({
        cafeId, userId: session.id, action: suspendEvent, entity: "Cafe", entityId: cafeId,
        details: { name: cafe.name, reason: data.suspendedReason ?? null, byName: session.name },
      });
    } else {
      await audit({
        cafeId, userId: session.id, action: "CAFE_UPDATED", entity: "Cafe", entityId: cafeId,
        details: { name: cafe.name, byName: session.name },
      });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleApiError(error);
  }
}
