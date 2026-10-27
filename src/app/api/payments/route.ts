import { decimal, money, type Numeric, validCurrencyInput } from "@/lib/money";
import { resolveReadScope } from "@/lib/api";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requirePermission, requireKey, handleApiError, ApiError } from "@/lib/api";
import { collectOrderPayment, prepareOrderCollection, type PaymentSplit, type CollectionRedemption } from "@/lib/payments";
import { getLoyaltySettingsSafe, loyaltyCalcSettingsExact as loyaltyCalcSettings } from "@/lib/loyalty";
import { normalizeEgyptianPhone } from "@/lib/phone";
import { pointsValueExact as pointsValue } from "@/lib/loyalty-calc";

// POS payment collection — the ONLY money-collection endpoint for single
// orders. All logic lives in the shared collectPayment service (duplicate
// guard, shift gate, totals recompute, loyalty earn, audits).
//
// Accepts either a single payment { amount, method } or a split/mixed
// payment { splits: [{ method, amount }] }. Mixed payments are stored as
// one Payment row per method so cash/card/wallet drawer totals stay exact.
const splitSchema = z.object({
  method: z.enum(["CASH", "CARD", "WALLET"]),
  amount: z.number().positive().refine(validCurrencyInput, "المبلغ لازم يكون صحيح وبحد أقصى رقمين بعد العلامة"),
});
const createPaymentSchema = z.object({
  orderId: z.string(),
  amount: z.number().positive().refine(validCurrencyInput, "المبلغ لازم يكون صحيح وبحد أقصى رقمين بعد العلامة").optional(),
  method: z.enum(["CASH", "CARD", "WALLET", "MIXED"]).optional(),
  splits: z.array(splitSchema).optional(),
  // Loyalty redemption during collection (points are a discount, never a
  // payment method). customerPhone identifies the customer when the order
  // isn't linked to one yet.
  loyaltyPointsToRedeem: z.number().int().min(1).optional(),
  customerPhone: z.string().trim().optional(),
});

import { withIdempotency, authenticatedRequestScope } from "@/lib/idempotency";


export async function POST(request: NextRequest) {
  try {
    const session = await requirePermission("payments:create");
    const data = createPaymentSchema.parse(await request.json());

    if (data.loyaltyPointsToRedeem) await requireKey("loyalty.redeem_points");
    return await withIdempotency(request, (tx) => authenticatedRequestScope(tx, session, "POST /api/payments", {kind:"order",id:data.orderId}), data, async (tx) => {
      // Normalise into concrete splits. Zero money is allowed ONLY when a
      // loyalty redemption covers the whole remaining amount.
      let splits: PaymentSplit[];
      if (data.splits && data.splits.length > 0) {
        splits = data.splits.filter((s) => s.amount > 0);
      } else if (data.amount && data.method && data.method !== "MIXED") {
        splits = [{ method: data.method, amount: data.amount }];
      } else if (data.loyaltyPointsToRedeem) {
        splits = [];
      } else {
        throw new ApiError(400, "من فضلك اختار طريقة الدفع");
      }
      if (splits.length === 0 && !data.loyaltyPointsToRedeem) {
        throw new ApiError(400, "من فضلك اختار طريقة الدفع");
      }

      // Tenant / branch / state guards (authorisation stays at the route).
      const candidate = await tx.order.findFirst({ where: { id: data.orderId, ...resolveReadScope(session) }, select: { branchId: true } });
      if (!candidate) throw new ApiError(404, "الطلب مش موجود");
      const locked = await prepareOrderCollection(tx, session, data.orderId, candidate.branchId);
      const order = locked.current;
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

      // ── Loyalty redemption validation (settings-level; balance and order
      // state re-validate INSIDE the payment transaction) ──
      let redemption: CollectionRedemption | undefined;
      let pointValue: Numeric | undefined;
      if (data.loyaltyPointsToRedeem) {
        const settings = loyaltyCalcSettings(await getLoyaltySettingsSafe(order.cafeId, tx));
        if (!settings.enabled) throw new ApiError(400, "برنامج الولاء غير مفعل");
        if (order.loyaltyPointsRedeemed > 0) {
          throw new ApiError(400, "تم استخدام نقاط الولاء لهذا الطلب بالفعل");
        }
        if (data.loyaltyPointsToRedeem < settings.minPointsToRedeem) {
          throw new ApiError(400, `أقل عدد نقاط للاستخدام هو ${settings.minPointsToRedeem} نقطة`);
        }
        // Resolve the customer: the order's linked one, or by phone (cafe-scoped).
        let customerId = order.customerId;
        if (!customerId && data.customerPhone) {
          const normalized = normalizeEgyptianPhone(data.customerPhone);
          if (!normalized) throw new ApiError(400, "رقم الموبايل غير صحيح");
          const c = await tx.customer.findUnique({
            where: { cafeId_normalizedPhone: { cafeId: order.cafeId, normalizedPhone: normalized } },
            select: { id: true },
          });
          customerId = c?.id ?? null;
        }
        if (!customerId) throw new ApiError(400, "يجب اختيار عميل أولًا");

        const discount = pointsValue(data.loyaltyPointsToRedeem, settings);
        const remaining = money(order.remainingAmount);
        if (discount.gt(remaining)) {
          throw new ApiError(400, "قيمة خصم النقاط أكبر من المتبقي على الحساب");
        }
        const cap = money(decimal(order.total).times(settings.maxRedeemPercentageOfOrder).div(100));
        if (discount.gt(cap)) {
          throw new ApiError(400, "لا يمكن أن يتجاوز خصم النقاط الحد المسموح");
        }
        redemption = { customerId, points: data.loyaltyPointsToRedeem, discount };
        pointValue = settings.pointValueAmount;
      }

      const result = await collectOrderPayment({
        session,
        orderId: order.id,
        branchId: order.branchId,
        splits,
        redemption,
        pointValue,
        client: tx,
        locked,
      });

      return NextResponse.json(
        { payments: result.payments, shiftId: result.shift?.id ?? null },
        { status: 201 }
      );
    }, { scope: resolveReadScope(session) });
  } catch (error) {
    return handleApiError(error);
  }
}
