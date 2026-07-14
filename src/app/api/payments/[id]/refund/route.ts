import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { handleApiError, ApiError } from "@/lib/api";
import { audit } from "@/lib/audit";
import { recomputeShiftTotals } from "@/lib/shifts";

type Params = { params: Promise<{ id: string }> };

// POST /api/payments/[id]/refund — mark a payment refunded. A cash refund
// reduces the shift's expected cash; card/wallet reduce their totals. Only
// managers/owners (payments:create + shifts:read) may refund.
export async function POST(_request: NextRequest, { params }: Params) {
  try {
    const session = await getSession();
    if (!session) throw new ApiError(401, "Not authenticated");
    if (!hasPermission(session.role, "shifts:read")) {
      throw new ApiError(403, "المرتجعات للمدير أو صاحب الكافيه فقط");
    }
    const { id } = await params;

    const payment = await db.payment.findUnique({
      where: { id },
      include: { order: { select: { orderNumber: true } } },
    });
    if (!payment) throw new ApiError(404, "عملية الدفع مش موجودة");
    if (session.role !== "SUPER_ADMIN" && payment.cafeId !== session.cafeId) {
      throw new ApiError(403, "ليس لديك صلاحية لتنفيذ هذا الإجراء");
    }
    if (session.branchId && payment.branchId && payment.branchId !== session.branchId) {
      throw new ApiError(403, "ليس لديك صلاحية لتنفيذ هذا الإجراء");
    }
    if (payment.status === "REFUNDED") throw new ApiError(400, "الدفعة مرتجعة بالفعل");

    const refunded = await db.payment.update({
      where: { id },
      data: { status: "REFUNDED" },
    });
    if (payment.shiftId) await recomputeShiftTotals(payment.shiftId);

    await audit({
      cafeId: payment.cafeId,
      userId: session.id,
      action: "PAYMENT_REFUNDED",
      entity: "Payment",
      entityId: payment.id,
      details: {
        branchId: payment.branchId,
        shiftId: payment.shiftId,
        orderId: payment.orderId,
        orderNumber: payment.order?.orderNumber,
        oldValue: "PAID",
        newValue: "REFUNDED",
        amount: Number(payment.amount),
        method: payment.method,
      },
    });

    return NextResponse.json({ payment: refunded });
  } catch (error) {
    return handleApiError(error);
  }
}
