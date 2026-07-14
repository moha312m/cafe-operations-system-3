import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requirePermission, handleApiError, ApiError } from "@/lib/api";
import { audit } from "@/lib/audit";

type Params = { params: Promise<{ id: string }> };

// Waiter approves a QR menu order → it becomes CONFIRMED and enters
// the normal kitchen workflow.
export async function POST(_request: NextRequest, { params }: Params) {
  try {
    const session = await requirePermission("orders:approve");
    const { id } = await params;

    const order = await db.order.findUnique({ where: { id } });
    if (!order) throw new ApiError(404, "الطلب مش موجود");
    if (session.role !== "SUPER_ADMIN" && order.cafeId !== session.cafeId) {
      throw new ApiError(403, "ليس لديك صلاحية لتنفيذ هذا الإجراء");
    }
    if (session.branchId && order.branchId !== session.branchId) {
      throw new ApiError(403, "الطلب تبع فرع تاني");
    }
    if (order.status !== "PENDING_WAITER_APPROVAL") {
      throw new ApiError(400, "الطلب ده مش مستني موافقة");
    }

    const updated = await db.order.update({
      where: { id },
      data: {
        status: "CONFIRMED",
        approvedById: session.id,
        approvedAt: new Date(),
      },
      include: {
        items: { include: { addOns: true } },
        branch: { select: { id: true, name: true } },
        approvedBy: { select: { id: true, name: true } },
      },
    });

    await audit({
      cafeId: order.cafeId,
      userId: session.id,
      action: "ORDER_APPROVED",
      entity: "Order",
      entityId: id,
      details: {
        orderNumber: order.orderNumber,
        source: order.source,
        approvedById: session.id,
        approvedByName: session.name,
      },
    });

    return NextResponse.json({ order: updated });
  } catch (error) {
    return handleApiError(error);
  }
}
