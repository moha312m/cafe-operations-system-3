import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requirePermission, handleApiError, ApiError } from "@/lib/api";
import { collectOrderPayment, type PaymentSplit } from "@/lib/payments";

// POS payment collection — the ONLY money-collection endpoint for single
// orders. All logic lives in the shared collectPayment service (duplicate
// guard, shift gate, totals recompute, loyalty earn, audits).
//
// Accepts either a single payment { amount, method } or a split/mixed
// payment { splits: [{ method, amount }] }. Mixed payments are stored as
// one Payment row per method so cash/card/wallet drawer totals stay exact.
const splitSchema = z.object({
  method: z.enum(["CASH", "CARD", "WALLET"]),
  amount: z.number().positive(),
});
const createPaymentSchema = z.object({
  orderId: z.string(),
  amount: z.number().positive().optional(),
  method: z.enum(["CASH", "CARD", "WALLET", "MIXED"]).optional(),
  splits: z.array(splitSchema).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const session = await requirePermission("payments:create");
    const data = createPaymentSchema.parse(await request.json());

    // Normalise into concrete splits.
    let splits: PaymentSplit[];
    if (data.splits && data.splits.length > 0) {
      splits = data.splits.filter((s) => s.amount > 0);
    } else if (data.amount && data.method && data.method !== "MIXED") {
      splits = [{ method: data.method, amount: data.amount }];
    } else {
      throw new ApiError(400, "من فضلك اختار طريقة الدفع");
    }
    if (splits.length === 0) throw new ApiError(400, "من فضلك اختار طريقة الدفع");

    // Tenant / branch / state guards (authorisation stays at the route).
    const order = await db.order.findUnique({
      where: { id: data.orderId },
      select: { id: true, cafeId: true, branchId: true, status: true },
    });
    if (!order) throw new ApiError(404, "الطلب مش موجود");
    if (session.role !== "SUPER_ADMIN" && order.cafeId !== session.cafeId) {
      throw new ApiError(403, "ليس لديك صلاحية لتنفيذ هذا الإجراء");
    }
    if (session.branchId && order.branchId !== session.branchId) {
      throw new ApiError(403, "الطلب تبع فرع تاني");
    }
    if (order.status === "CANCELLED" || order.status === "REJECTED") {
      throw new ApiError(400, "مينفعش تحصيل طلب ملغي أو مرفوض");
    }
    if (order.status === "PENDING_WAITER_APPROVAL") {
      throw new ApiError(400, "الطلب لسه مستني موافقة الويتر");
    }

    const result = await collectOrderPayment({
      session,
      orderId: order.id,
      branchId: order.branchId,
      splits,
    });

    return NextResponse.json(
      { payments: result.payments, shiftId: result.shift?.id ?? null },
      { status: 201 }
    );
  } catch (error) {
    return handleApiError(error);
  }
}
