import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requirePermission, handleApiError, ApiError } from "@/lib/api";
import { audit } from "@/lib/audit";
import { deductStockForOrder, auditDeduction, StockError } from "@/lib/stock-deduction";
import { recomputeSessionTotals } from "@/lib/table-sessions";
import { reverseOrderLoyalty } from "@/lib/loyalty";
import { isOrderFullyPaid } from "@/lib/order-payments";
import { requiresPaymentBeforeServing } from "@/lib/serving-policy";
import { unrecordCustomerOrder } from "@/lib/customers";
import type { OrderStatus } from "@prisma/client";
import type { StockAttributionSnapshot } from "@/lib/ledger";

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
      // Every payment row on the order, because "how much is collected" is
      // collections less refunds — filtering to status PAID alone would count
      // a refund as money received (REFUND-005).
      include: { payments: true },
    });
    if (!order) throw new ApiError(404, "الطلب مش موجود");
    if (session.role !== "SUPER_ADMIN" && order.cafeId !== session.cafeId) {
      throw new ApiError(403, "ليس لديك صلاحية لتنفيذ هذا الإجراء");
    }
    if (session.branchId && order.branchId !== session.branchId) {
      throw new ApiError(403, "الطلب تبع فرع تاني");
    }

    if (!(status === "SERVED" && order.status === "SERVED") && !TRANSITIONS[order.status].includes(status)) {
      throw new ApiError(400, "الحالة دي مش مسموحة للطلب في وضعه الحالي");
    }
    if (status === "CANCELLED") {
      await requirePermission("orders:cancel");
    }
    // Whether an unpaid order may reach the customer is the owner's decision,
    // set per order type and resolved from the branch's effective policy —
    // never from anything the caller sends. A café with table service serves
    // first and bills after; a takeaway counter does not.
    if (status === "SERVED" && order.status !== "SERVED") {
      const mustBePaid = await requiresPaymentBeforeServing(order.branchId, order.type);
      if (mustBePaid && !isOrderFullyPaid({ total: order.total, payments: order.payments })) {
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
    let servedReplay = false;
    try {
      updated = await db.$transaction(async (tx) => {
        if (status === "SERVED") {
          await tx.$queryRawUnsafe('SELECT "id" FROM "Order" WHERE "id" = $1 FOR UPDATE', id);
          const lockedOrder = await tx.order.findUniqueOrThrow({
            where: { id },
            include: { payments: true },
          });

          if (lockedOrder.status === "SERVED") {
            servedReplay = true;
            return tx.order.findUniqueOrThrow({
              where: { id },
              include: {
                items: { include: { addOns: true } },
                payments: true,
                branch: { select: { id: true, name: true } },
                createdBy: { select: { id: true, name: true } },
              },
            });
          }
          if (!TRANSITIONS[lockedOrder.status].includes(status)) {
            throw new ApiError(400, "Order status transition is not allowed in its current state");
          }

          const custodyRows = await tx.$queryRawUnsafe<{
            id: string;
            holderType: "USER" | "BRANCH";
            responsibleShiftId: string | null;
          }[]>(
            'SELECT "id", "holderType", "responsibleShiftId" FROM "CustodyPeriod" WHERE "branchId" = $1 AND "scope" = \'STOCK\' AND "status" = \'OPEN\' FOR UPDATE',
            lockedOrder.branchId
          );
          const custody = custodyRows[0];
          if (!custody || custody.holderType !== "USER" || !custody.responsibleShiftId) {
            throw new ApiError(409, "Serving requires an open USER-held stock custody with a responsible shift");
          }
          const attribution: StockAttributionSnapshot = {
            custodyPeriodId: custody.id,
            shiftId: custody.responsibleShiftId,
          };
          const servedTimeline = { servedAt: now, completedAt: now, stockDeductedAt: now };
          deduction = await deductStockForOrder(tx, id, session.id, attribution);
          await tx.orderItem.updateMany({
            where: { orderId: id, kitchenStatus: { not: "CANCELLED" } },
            data: { kitchenStatus: "SERVED" },
          });
          return tx.order.update({
            where: { id },
            data: {
              status: "SERVED",
              ...servedTimeline,
              servedById: session.id,
              servedStockCustodyPeriodId: custody.id,
              servedShiftId: custody.responsibleShiftId,
            },
            include: {
              items: { include: { addOns: true } },
              payments: true,
              branch: { select: { id: true, name: true } },
              createdBy: { select: { id: true, name: true } },
            },
          });
        }
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

    if (servedReplay) return NextResponse.json({ order: updated });

    // Cancellations change the table bill — keep the session totals fresh.
    if (order.tableSessionId) {
      await recomputeSessionTotals(order.tableSessionId);
    }

    // Cancelled orders give back redeemed points, claw back earned ones,
    // and roll the customer's order stats back.
    if (status === "CANCELLED" && order.customerId) {
      await reverseOrderLoyalty(order.id, session.id);
      await unrecordCustomerOrder(order.customerId, Number(order.total));
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
