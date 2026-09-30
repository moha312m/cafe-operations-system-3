import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { handleApiError, ApiError, requireKey } from "@/lib/api";
import { refundPayment } from "@/lib/refunds";

type Params = { params: Promise<{ id: string }> };

// POST /api/payments/[id]/refund — reverse a payment. A reversal against a
// shift that is still open adjusts that shift; against an already-closed
// shift it posts a linked reversal in the current period instead, leaving
// the accepted close untouched (see lib/refunds). Only managers/owners
// (shifts:read) may refund.
export async function POST(_request: NextRequest, { params }: Params) {
  try {
    // R-SEC-01 — same key as the order-level refund, for the same reason:
    // reversing money is `orders.refund`, and it must honour whatever the
    // café configured rather than the legacy role column.
    const session = await requireKey(
      "orders.refund",
      "المرتجعات للمدير أو صاحب الكافيه فقط"
    );
    const { id } = await params;

    const payment = await db.payment.findUnique({
      where: { id },
      select: { cafeId: true, branchId: true },
    });
    if (!payment) throw new ApiError(404, "عملية الدفع مش موجودة");
    if (session.role !== "SUPER_ADMIN" && payment.cafeId !== session.cafeId) {
      throw new ApiError(403, "ليس لديك صلاحية لتنفيذ هذا الإجراء");
    }
    if (session.branchId && payment.branchId && payment.branchId !== session.branchId) {
      throw new ApiError(403, "ليس لديك صلاحية لتنفيذ هذا الإجراء");
    }

    const result = await refundPayment(id, session);
    return NextResponse.json({ payment: result });
  } catch (error) {
    return handleApiError(error);
  }
}
