import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireKey, handleApiError, ApiError } from "@/lib/api";
import { audit } from "@/lib/audit";
import { getLoyaltySettingsSafe, loyaltyCalcSettings } from "@/lib/loyalty";

// GET /api/payments/collect-info?orderId=… | ?tableSessionId=…
// Feeds the POS "تحصيل الدفع" panel: totals + payment history for the
// collection target, and audits that a collection was started from POS.
export async function GET(request: NextRequest) {
  try {
    const session = await requireKey("pos.collect_payment", "ليس لديك صلاحية لتحصيل الدفع");
    const params = request.nextUrl.searchParams;
    const orderId = params.get("orderId");
    const tableSessionId = params.get("tableSessionId");

    if (orderId) {
      const order = await db.order.findFirst({
        // cafe scope in the query = tenant isolation even with a leaked id
        where: { id: orderId, cafeId: session.cafeId ?? "" },
        include: {
          payments: {
            where: { status: "PAID" },
            orderBy: { createdAt: "asc" },
            select: { id: true, amount: true, method: true, createdAt: true },
          },
          branch: { select: { id: true, name: true } },
          customer: {
            select: {
              id: true, name: true, normalizedPhone: true,
              loyaltyPointsBalance: true, totalOrders: true, totalSpent: true,
              lastOrderAt: true, isActive: true,
            },
          },
        },
      });
      if (!order) throw new ApiError(404, "الطلب مش موجود");
      if (session.branchId && order.branchId !== session.branchId) {
        throw new ApiError(403, "الطلب تبع فرع تاني");
      }

      await audit({
        cafeId: order.cafeId, userId: session.id,
        action: "PAYMENT_COLLECTION_STARTED_FROM_POS",
        entity: "Order", entityId: order.id,
        details: {
          orderId: order.id, orderNumber: order.orderNumber,
          branchId: order.branchId, remainingAmount: Number(order.remainingAmount),
        },
      });

      const loyalty = loyaltyCalcSettings(await getLoyaltySettingsSafe(order.cafeId));
      return NextResponse.json({
        loyalty,
        target: {
          kind: "order",
          orderId: order.id,
          orderNumber: order.orderNumber,
          branchId: order.branchId,
          branchName: order.branch.name,
          status: order.status,
          tableNumber: order.tableNumber,
          customerName: order.customerName,
          total: Number(order.total),
          paidAmount: Number(order.paidAmount),
          remainingAmount: Number(order.remainingAmount),
          paymentStatus: order.paymentStatus,
          alreadyRedeemed: order.loyaltyPointsRedeemed > 0,
          customer: order.customer
            ? {
                id: order.customer.id,
                name: order.customer.name,
                phone: order.customer.normalizedPhone,
                loyaltyPointsBalance: order.customer.loyaltyPointsBalance,
                totalOrders: order.customer.totalOrders,
                totalSpent: Number(order.customer.totalSpent),
                lastOrderAt: order.customer.lastOrderAt,
                isActive: order.customer.isActive,
              }
            : null,
          payments: order.payments.map((p) => ({
            id: p.id, amount: Number(p.amount), method: p.method, createdAt: p.createdAt,
          })),
        },
      });
    }

    if (tableSessionId) {
      const ts = await db.tableSession.findFirst({
        where: { id: tableSessionId, cafeId: session.cafeId ?? "" },
        select: {
          id: true, branchId: true, tableNumber: true, status: true,
          totalAmount: true, paidAmount: true, remainingAmount: true,
        },
      });
      if (!ts) throw new ApiError(404, "حساب الترابيزة مش موجود");
      if (session.branchId && ts.branchId !== session.branchId) {
        throw new ApiError(403, "الترابيزة تبع فرع تاني");
      }

      await audit({
        cafeId: session.cafeId, userId: session.id,
        action: "PAYMENT_COLLECTION_STARTED_FROM_POS",
        entity: "TableSession", entityId: ts.id,
        details: {
          tableSessionId: ts.id, tableNumber: ts.tableNumber,
          branchId: ts.branchId, remainingAmount: Number(ts.remainingAmount),
        },
      });

      const loyalty = loyaltyCalcSettings(await getLoyaltySettingsSafe(session.cafeId ?? ""));
      return NextResponse.json({
        loyalty,
        target: {
          kind: "table",
          tableSessionId: ts.id,
          branchId: ts.branchId,
          tableNumber: ts.tableNumber,
          sessionStatus: ts.status,
          total: Number(ts.totalAmount),
          paidAmount: Number(ts.paidAmount),
          remainingAmount: Number(ts.remainingAmount),
        },
      });
    }

    throw new ApiError(400, "حدد الطلب أو حساب الترابيزة");
  } catch (error) {
    return handleApiError(error);
  }
}
