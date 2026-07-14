import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requirePermission, handleApiError, ApiError } from "@/lib/api";
import { audit } from "@/lib/audit";
import { deductStockForOrder, auditDeduction, StockError } from "@/lib/stock-deduction";
import type { OrderStatus } from "@prisma/client";

type Params = { params: Promise<{ id: string }> };

// Legal state machine for staff transitions. Approval/rejection of QR
// orders is NOT here — that goes through /approve and /reject, which
// enforce the orders:approve permission and record who decided.
const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING_WAITER_APPROVAL: [], // only approve/reject endpoints may move it
  CONFIRMED: ["PREPARING", "CANCELLED"],
  PREPARING: ["READY", "CANCELLED"],
  READY: ["SERVED"],
  SERVED: [],
  CANCELLED: [],
  REJECTED: [],
};

const bodySchema = z.object({
  status: z.enum(["PREPARING", "READY", "SERVED", "CANCELLED"]),
});

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const session = await requirePermission("orders:update-status");
    const { id } = await params;
    const { status } = bodySchema.parse(await request.json());

    const order = await db.order.findUnique({
      where: { id },
      include: { payments: { where: { status: "PAID" } } },
    });
    if (!order) throw new ApiError(404, "الطلب مش موجود");
    if (session.role !== "SUPER_ADMIN" && order.cafeId !== session.cafeId) {
      throw new ApiError(403, "ليس لديك صلاحية لتنفيذ هذا الإجراء");
    }
    if (session.branchId && order.branchId !== session.branchId) {
      throw new ApiError(403, "الطلب تبع فرع تاني");
    }

    if (!TRANSITIONS[order.status].includes(status)) {
      throw new ApiError(400, "الحالة دي مش مسموحة للطلب في وضعه الحالي");
    }
    if (status === "CANCELLED") {
      await requirePermission("orders:cancel");
    }
    // An order can only be served once fully paid.
    if (status === "SERVED") {
      const paid = order.payments.reduce((sum, p) => sum + Number(p.amount), 0);
      if (paid + 0.001 < Number(order.total)) {
        throw new ApiError(400, "لازم الطلب يتدفع بالكامل قبل التسليم");
      }
    }

    const now = new Date();
    const timeline =
      status === "PREPARING"
        ? { preparationStartedAt: now }
        : status === "READY"
          ? { readyAt: now }
          : status === "SERVED"
            ? { servedAt: now, completedAt: now }
            : {};

    // Item-level kitchen status mirrors the order status for now
    // (item-by-item tracking is prepared in the schema for later).
    const itemKitchenStatus =
      status === "PREPARING"
        ? "PREPARING"
        : status === "READY"
          ? "READY"
          : status === "SERVED"
            ? "SERVED"
            : status === "CANCELLED"
              ? "CANCELLED"
              : null;

    // Deduction result captured from inside the transaction so we can
    // write its audit rows after a successful commit.
    let deduction: Awaited<ReturnType<typeof deductStockForOrder>> | null = null;

    let updated;
    try {
      updated = await db.$transaction(async (tx) => {
        if (itemKitchenStatus) {
          await tx.orderItem.updateMany({
            where: { orderId: id, kitchenStatus: { not: "CANCELLED" } },
            data: { kitchenStatus: itemKitchenStatus },
          });
        }
        // Auto-deduct ingredients on SERVED. Throws on insufficient
        // stock (unless the cafe allows negative) → rolls back the whole
        // transition so the order is NOT marked served.
        const timelineExtra: { stockDeductedAt?: Date } = {};
        if (status === "SERVED" && !order.stockDeductedAt) {
          deduction = await deductStockForOrder(tx, id, session.id);
          timelineExtra.stockDeductedAt = now;
        }
        return tx.order.update({
          where: { id },
          data: { status, ...timeline, ...timelineExtra },
          include: {
            items: { include: { addOns: true } },
            payments: true,
            branch: { select: { id: true, name: true } },
            createdBy: { select: { id: true, name: true } },
          },
        });
      });
    } catch (e) {
      if (e instanceof StockError) {
        await audit({
          cafeId: order.cafeId,
          userId: session.id,
          action: "STOCK_DEDUCTION_FAILED",
          entity: "Order",
          entityId: id,
          details: { orderNumber: order.orderNumber, reason: e.message },
        });
        throw new ApiError(400, e.message);
      }
      throw e;
    }

    if (deduction) {
      await auditDeduction(
        order.cafeId,
        order.branchId,
        session.id,
        id,
        order.orderNumber,
        deduction
      );
    }

    const AUDIT_ACTIONS: Record<string, string> = {
      PREPARING: "ORDER_PREPARATION_STARTED",
      READY: "ORDER_READY",
      SERVED: "ORDER_SERVED",
      CANCELLED: "ORDER_CANCELLED",
    };
    await audit({
      cafeId: order.cafeId,
      userId: session.id,
      action: AUDIT_ACTIONS[status] ?? "ORDER_STATUS_CHANGED",
      entity: "Order",
      entityId: id,
      details: {
        from: order.status,
        to: status,
        orderNumber: order.orderNumber,
        branchId: order.branchId,
      },
    });

    return NextResponse.json({ order: updated });
  } catch (error) {
    return handleApiError(error);
  }
}
