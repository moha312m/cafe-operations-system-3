import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { handleApiError, ApiError, requireKey } from "@/lib/api";
import { refundOrder } from "@/lib/refunds";

type Params = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  // A refund always has to say why. Whitespace is not a reason.
  reason: z.string().trim().min(1, "لازم تكتب سبب الاسترجاع").max(500),
});

// POST /api/orders/[id]/refund — return everything collected on this order.
//
// Authorisation here is the same rule the shift reports use, so refund
// authority stays with managers and owners. It is enforced on every request:
// hiding the button is presentation, not security. Cash custody is enforced
// deeper, in the refund service, because it depends on each payment's method.
export async function POST(request: NextRequest, { params }: Params) {
  try {
    // R-SEC-01 — refund authority is `orders.refund`, resolved through the
    // effective permission system. It used to read `shifts:read` out of the
    // static role table, which meant a café that revoked refund rights
    // through a custom role or a per-user override changed nothing: the
    // legacy `role` column still said BRANCH_MANAGER and the refund went
    // through. The key existed in the catalog the whole time; no route
    // enforced it.
    const session = await requireKey(
      "orders.refund",
      "المرتجعات للمدير أو صاحب الكافيه فقط"
    );
    const { id } = await params;

    const order = await db.order.findUnique({
      where: { id },
      select: { cafeId: true, branchId: true },
    });
    if (!order) throw new ApiError(404, "الطلب مش موجود");
    if (session.role !== "SUPER_ADMIN" && order.cafeId !== session.cafeId) {
      throw new ApiError(403, "ليس لديك صلاحية لتنفيذ هذا الإجراء");
    }
    if (session.branchId && order.branchId && order.branchId !== session.branchId) {
      throw new ApiError(403, "ليس لديك صلاحية لتنفيذ هذا الإجراء");
    }

    const { reason } = bodySchema.parse(await request.json());
    const result = await refundOrder(id, session, reason);
    return NextResponse.json(result);
  } catch (error) {
    return handleApiError(error);
  }
}
