import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireKey, resolveCafeId, handleApiError } from "@/lib/api";
import { serializeCustomer } from "@/lib/customers";

// GET /api/customers?search= — cafe-scoped customer list + loyalty report
// metrics. Gated by customers.view ("ليس لديك صلاحية للوصول لبيانات العملاء"
// comes from the guard's 403 handler in the UI).
export async function GET(request: NextRequest) {
  try {
    const session = await requireKey("customers.view", "ليس لديك صلاحية للوصول لبيانات العملاء");
    const params = request.nextUrl.searchParams;
    const cafeId = resolveCafeId(session, params.get("cafeId"));
    const search = params.get("search")?.trim();

    const where = {
      cafeId,
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: "insensitive" as const } },
              { normalizedPhone: { contains: search.replace(/\D/g, "") } },
            ],
          }
        : {}),
    };

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [customers, totalCount, newToday, repeatCount, pointsAgg, topSpenders] =
      await Promise.all([
        db.customer.findMany({
          where,
          orderBy: { lastOrderAt: { sort: "desc", nulls: "last" } },
          take: 200,
        }),
        db.customer.count({ where: { cafeId } }),
        db.customer.count({ where: { cafeId, createdAt: { gte: startOfToday } } }),
        db.customer.count({ where: { cafeId, totalOrders: { gte: 2 } } }),
        db.customer.aggregate({
          where: { cafeId },
          _sum: {
            lifetimePointsEarned: true, lifetimePointsRedeemed: true,
            totalSpent: true, loyaltyPointsBalance: true,
          },
        }),
        db.customer.findMany({
          where: { cafeId, totalSpent: { gt: 0 } },
          orderBy: { totalSpent: "desc" },
          take: 5,
          select: { id: true, name: true, normalizedPhone: true, totalSpent: true, totalOrders: true, loyaltyPointsBalance: true },
        }),
      ]);

    return NextResponse.json({
      customers: customers.map(serializeCustomer),
      stats: {
        totalCount,
        newToday,
        repeatCount,
        totalPointsIssued: pointsAgg._sum.lifetimePointsEarned ?? 0,
        totalPointsRedeemed: pointsAgg._sum.lifetimePointsRedeemed ?? 0,
        currentPointsBalance: pointsAgg._sum.loyaltyPointsBalance ?? 0,
        avgSpend: totalCount > 0 ? Number(pointsAgg._sum.totalSpent ?? 0) / totalCount : 0,
        topSpenders: topSpenders.map((c) => ({
          ...c,
          totalSpent: Number(c.totalSpent),
        })),
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
