import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { handleApiError, ApiError } from "@/lib/api";
import { audit } from "@/lib/audit";
import { recomputeSessionTotals } from "@/lib/table-sessions";
import { resolvePermissions } from "@/lib/perms/effective";
import { canApproveOrder } from "@/lib/qr-approval";

type Params = { params: Promise<{ id: string }> };

// Approve a QR menu order → CONFIRMED, enters the normal kitchen workflow.
// Authorization is assignment-aware (specific user / role / any-authorized,
// with owner/manager override) — see canApproveOrder.
export async function POST(_request: NextRequest, { params }: Params) {
  try {
    const session = await getSession();
    if (!session) throw new ApiError(401, "سجّل دخولك الأول");
    const { id } = await params;

    const order = await db.order.findUnique({ where: { id } });
    if (!order) throw new ApiError(404, "الطلب مش موجود");
    if (order.status !== "PENDING_WAITER_APPROVAL") {
      throw new ApiError(400, "الطلب ده مش مستني موافقة");
    }
    const { keys } = await resolvePermissions(session);
    if (!canApproveOrder(session, order, keys.has("qr_orders.approve"))) {
      throw new ApiError(403, "ليس لديك صلاحية لتأكيد هذا الطلب");
    }

    const updated = await db.order.update({
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
    if (order.tableSessionId) await recomputeSessionTotals(order.tableSessionId);

    const kitchen = await db.cafeSettings.findUnique({ where: { cafeId: order.cafeId }, select: { kitchenScreenEnabled: true } });
    await audit({
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
      await audit({
        cafeId: order.cafeId, userId: session.id, action: "QR_ORDER_SENT_TO_KITCHEN",
        entity: "Order", entityId: id,
        details: { branchId: order.branchId, orderId: id, orderNumber: order.orderNumber },
      });
    }

    return NextResponse.json({ order: updated });
  } catch (error) {
    return handleApiError(error);
  }
}
