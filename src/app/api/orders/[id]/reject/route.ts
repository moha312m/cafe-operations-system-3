import { protectedTransaction } from "@/lib/protected-transaction";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { handleApiError, ApiError, requireActiveSession, resolveReadScope } from "@/lib/api";
import { auditInTransaction } from "@/lib/audit";
import { recomputeSessionTotals } from "@/lib/table-sessions";
import { resolvePermissions } from "@/lib/perms/effective";
import { canApproveOrder, getApprovalSettings } from "@/lib/qr-approval";
import { reverseOrderLoyalty } from "@/lib/loyalty";
import { unrecordCustomerOrder } from "@/lib/customers";

import { lockOrders, lockOrderPayments, lockCustomers } from "@/lib/transaction-locks";

type Params = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  reason: z.string().trim().min(2, "سبب الرفض مطلوب"),
});

// Reject a QR menu order (with a reason). Rejected orders never reach the
// kitchen board and drop out of the table bill.
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const session = await requireActiveSession();
    const { id } = await params;
    const { reason } = bodySchema.parse(await request.json());

    const { keys } = await resolvePermissions(session);
    return await protectedTransaction(async (tx) => {
      await lockOrders(tx, [id]);
      await lockOrderPayments(tx, [id]);
      const order = await tx.order.findFirst({ where: { id, ...resolveReadScope(session) } });
      if (!order) throw new ApiError(404, "الطلب مش موجود");
      if (order.status !== "PENDING_WAITER_APPROVAL") {
        throw new ApiError(400, "الطلب ده مش مستني موافقة");
      }
      if (order.customerId) await lockCustomers(tx, [order.customerId]);
      if (!canApproveOrder(session, order, keys.has("qr_orders.approve"))) {
        throw new ApiError(403, "ليس لديك صلاحية لتأكيد هذا الطلب");
      }
      // Rejection can be disabled by the branch's approval settings.
      const appr = await getApprovalSettings(order.cafeId, order.branchId, tx);
      if (!appr.allowApproverToRejectOrder && session.role !== "CAFE_OWNER" && session.role !== "BRANCH_MANAGER") {
        throw new ApiError(403, "رفض الطلبات غير مسموح في إعدادات هذا الفرع");
      }

      const updated = await tx.order.update({
        where: { id },
        data: {
          status: "REJECTED",
          approvalStatus: "REJECTED",
          rejectedById: session.id,
          rejectedAt: new Date(),
          rejectionReason: reason,
        },
      });

      // Rejected orders drop out of the table bill (session stays open).
      if (order.tableSessionId) await recomputeSessionTotals(order.tableSessionId, tx);

      // Rejected orders never count toward the customer's stats or points.
      if (order.customerId) {
        await reverseOrderLoyalty(order.id, session.id, tx);
        await unrecordCustomerOrder(order.customerId, order.total, tx);
      }

      await auditInTransaction(tx, {
        cafeId: order.cafeId,
        userId: session.id,
        action: "QR_ORDER_REJECTED",
        entity: "Order",
        entityId: id,
        details: { branchId: order.branchId, orderId: id, orderNumber: order.orderNumber, reason, oldValue: "PENDING_APPROVAL", newValue: "REJECTED" },
      });

      return NextResponse.json({ order: updated });
    }, resolveReadScope(session));
  } catch (error) {
    return handleApiError(error);
  }
}
