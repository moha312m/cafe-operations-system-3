import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requirePermission, handleApiError, ApiError } from "@/lib/api";
import { audit } from "@/lib/audit";

type Params = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  reason: z.string().trim().min(2, "سبب الرفض مطلوب"),
});

// Waiter rejects a QR menu order (with a reason). Rejected orders never
// reach the kitchen board.
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const session = await requirePermission("orders:approve");
    const { id } = await params;
    const { reason } = bodySchema.parse(await request.json());

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
        status: "REJECTED",
        rejectedById: session.id,
        rejectedAt: new Date(),
        rejectionReason: reason,
      },
    });

    await audit({
      cafeId: order.cafeId,
      userId: session.id,
      action: "ORDER_REJECTED",
      entity: "Order",
      entityId: id,
      details: { orderNumber: order.orderNumber, reason },
    });

    return NextResponse.json({ order: updated });
  } catch (error) {
    return handleApiError(error);
  }
}
