import { protectedTransaction } from "@/lib/protected-transaction";
import { NextResponse, type NextRequest } from "next/server";
import { handleApiError, ApiError, requireActiveSession, resolveReadScope } from "@/lib/api";
import { auditInTransaction } from "@/lib/audit";
import { recomputeSessionTotals } from "@/lib/table-sessions";
import { resolvePermissions } from "@/lib/perms/effective";
import { canApproveOrder } from "@/lib/qr-approval";

import { lockOrders, lockOrderPayments } from "@/lib/transaction-locks";

type Params = { params: Promise<{ id: string }> };

// Approve a QR menu order → CONFIRMED, enters the normal kitchen workflow.
// Authorization is assignment-aware (specific user / role / any-authorized,
// with owner/manager override) — see canApproveOrder.
export async function POST(_request: NextRequest, { params }: Params) {
  try {
    const session = await requireActiveSession();
    const { id } = await params;

    const { keys } = await resolvePermissions(session);
    return await protectedTransaction(async (tx) => {
      await lockOrders(tx, [id]);
      await lockOrderPayments(tx, [id]);
      const order = await tx.order.findFirst({ where: { id, ...resolveReadScope(session) } });
      if (!order) throw new ApiError(404, "الطلب مش موجود");
      if (order.status !== "PENDING_WAITER_APPROVAL") {
        throw new ApiError(400, "الطلب ده مش مستني موافقة");
      }
      if (!canApproveOrder(session, order, keys.has("qr_orders.approve"))) {
        throw new ApiError(403, "ليس لديك صلاحية لتأكيد هذا الطلب");
      }

      const updated = await tx.order.update({
        where: { id },
        data: {
          status: "CONFIRMED",
          approvalStatus: "APPROVED",
          approvedById: session.id,
          approvedAt: new Date(),
        },
        include: {
          items: { include: { addOns: true } },
          branch: { select: { id: true, name: true } },
          approvedBy: { select: { id: true, name: true } },
        },
      });

      // Approval makes the order count towards the table bill.
      if (order.tableSessionId) await recomputeSessionTotals(order.tableSessionId, tx);

      const kitchen = await tx.cafeSettings.findUnique({ where: { cafeId: order.cafeId }, select: { kitchenScreenEnabled: true } });
      await auditInTransaction(tx, {
        cafeId: order.cafeId,
        userId: session.id,
        action: "QR_ORDER_APPROVED",
        entity: "Order",
        entityId: id,
        details: {
          branchId: order.branchId, orderId: id,
          orderNumber: order.orderNumber, source: order.source,
          approvedById: session.id, approvedByName: session.name,
          oldValue: "PENDING_APPROVAL", newValue: "APPROVED",
        },
      });
      if (kitchen?.kitchenScreenEnabled) {
        await auditInTransaction(tx, {
          cafeId: order.cafeId, userId: session.id, action: "QR_ORDER_SENT_TO_KITCHEN",
          entity: "Order", entityId: id,
          details: { branchId: order.branchId, orderId: id, orderNumber: order.orderNumber },
        });
      }

      return NextResponse.json({ order: updated });
    }, resolveReadScope(session));
  } catch (error) {
    return handleApiError(error);
  }
}
