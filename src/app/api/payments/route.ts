import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requirePermission, handleApiError, ApiError } from "@/lib/api";
import { audit } from "@/lib/audit";
import { getActiveShift, recomputeShiftTotals } from "@/lib/shifts";

const round2 = (n: number) => Math.round(n * 100) / 100;

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
    let splits: { method: "CASH" | "CARD" | "WALLET"; amount: number }[];
    if (data.splits && data.splits.length > 0) {
      splits = data.splits.filter((s) => s.amount > 0);
    } else if (data.amount && data.method && data.method !== "MIXED") {
      splits = [{ method: data.method, amount: data.amount }];
    } else {
      throw new ApiError(400, "من فضلك اختار طريقة الدفع");
    }
    if (splits.length === 0) throw new ApiError(400, "من فضلك اختار طريقة الدفع");

    const order = await db.order.findUnique({
      where: { id: data.orderId },
      include: { payments: { where: { status: "PAID" } } },
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

    const alreadyPaid = order.payments.reduce((s, p) => s + Number(p.amount), 0);
    const remaining = round2(Number(order.total) - alreadyPaid);
    if (remaining <= 0) throw new ApiError(400, "الطلب متدفع بالكامل");

    const payAmount = round2(splits.reduce((s, p) => s + p.amount, 0));
    if (payAmount > remaining + 0.001) {
      throw new ApiError(400, "مبلغ الدفع أكبر من المتبقي على الطلب");
    }

    // Link to the cashier's open shift (null for managers/owners without one).
    const shift = await getActiveShift(order.branchId, session.id);

    const created = await db.$transaction(async (tx) => {
      const rows = [];
      for (const s of splits) {
        rows.push(
          await tx.payment.create({
            data: {
              cafeId: order.cafeId,
              branchId: order.branchId,
              orderId: order.id,
              shiftId: shift?.id ?? null,
              cashierId: session.id,
              amount: s.amount,
              method: s.method,
              status: "PAID",
              receivedById: session.id,
            },
          })
        );
      }
      return rows;
    });

    if (shift) await recomputeShiftTotals(shift.id);

    await audit({
      cafeId: order.cafeId,
      userId: session.id,
      action: "PAYMENT_RECORDED",
      entity: "Payment",
      entityId: created[0]?.id ?? null,
      details: {
        branchId: order.branchId,
        shiftId: shift?.id ?? null,
        orderId: order.id,
        orderNumber: order.orderNumber,
        newValue: splits,
      },
    });

    // Order fully settled?
    if (round2(remaining - payAmount) <= 0) {
      await audit({
        cafeId: order.cafeId,
        userId: session.id,
        action: "ORDER_PAID",
        entity: "Order",
        entityId: order.id,
        details: {
          branchId: order.branchId,
          shiftId: shift?.id ?? null,
          orderId: order.id,
          orderNumber: order.orderNumber,
          total: Number(order.total),
        },
      });
    }

    return NextResponse.json(
      { payments: created, shiftId: shift?.id ?? null },
      { status: 201 }
    );
  } catch (error) {
    return handleApiError(error);
  }
}
