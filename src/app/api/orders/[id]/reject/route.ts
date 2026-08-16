import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { handleApiError, ApiError } from "@/lib/api";
import { audit } from "@/lib/audit";
import { recomputeSessionTotals } from "@/lib/table-sessions";
import { resolvePermissions } from "@/lib/perms/effective";
import { canApproveOrder, getApprovalSettings } from "@/lib/qr-approval";
import { reverseOrderLoyalty } from "@/lib/loyalty";
import { unrecordCustomerOrder } from "@/lib/customers";

type Params = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  reason: z.string().trim().min(2, "سبب الرفض مطلوب"),
});

// Reject a QR menu order (with a reason). Rejected orders never reach the
// kitchen board and drop out of the table bill.
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const session = await getSession();
    if (!session) throw new ApiError(401, "سجّل دخولك الأول");
    const { id } = await params;
    const { reason } = bodySchema.parse(await request.json());

    const order = await db.order.findUnique({ where: { id } });
    if (!order) throw new ApiError(404, "الطلب مش موجود");
    if (order.status !== "PENDING_WAITER_APPROVAL") {
      throw new ApiError(400, "الطلب ده مش مستني موافقة");
    }
    const { keys } = await resolvePermissions(session);
    if (!canApproveOrder(session, order, keys.has("qr_orders.approve"))) {
      throw new ApiError(403, "ليس لديك صلاحية لتأكيد هذا الطلب");
    }
    // Rejection can be disabled by the branch's approval settings.
    const appr = await getApprovalSettings(order.cafeId, order.branchId);
    if (!appr.allowApproverToRejectOrder && session.role !== "CAFE_OWNER" && session.role !== "BRANCH_MANAGER") {
      throw new ApiError(403, "رفض الطلبات غير مسموح في إعدادات هذا الفرع");
    }

    const updated = await db.order.update({
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
    if (order.tableSessionId) await recomputeSessionTotals(order.tableSessionId);

    // Rejected orders never count toward the customer's stats or points.
    if (order.customerId) {
      await reverseOrderLoyalty(order.id, session.id);
      await unrecordCustomerOrder(order.customerId, Number(order.total));
    }

    await audit({
      cafeId: order.cafeId,
      userId: session.id,
      action: "QR_ORDER_REJECTED",
      entity: "Order",
      entityId: id,
      details: { branchId: order.branchId, orderId: id, orderNumber: order.orderNumber, reason, oldValue: "PENDING_APPROVAL", newValue: "REJECTED" },
    });

    return NextResponse.json({ order: updated });
  } catch (error) {
    return handleApiError(error);
  }
}
