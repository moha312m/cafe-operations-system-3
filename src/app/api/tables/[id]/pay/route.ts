import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireKey, handleApiError, ApiError } from "@/lib/api";
import { audit } from "@/lib/audit";
import { getActiveShift, recomputeShiftTotals } from "@/lib/shifts";
import { recomputeSessionTotals } from "@/lib/table-sessions";
import { maybeAwardLoyaltyPoints, getLoyaltySettingsSafe, loyaltyCalcSettings } from "@/lib/loyalty";
import { applyOrderPaymentInTx, applyLoyaltyRedemptionInTx } from "@/lib/payments";
import { normalizeEgyptianPhone } from "@/lib/phone";
import { pointsValue } from "@/lib/loyalty-calc";

type Params = { params: Promise<{ id: string }> };

const round2 = (n: number) => Math.round(n * 100) / 100;

// Orders excluded from billing (mirrors the session engine).
const INACTIVE = ["CANCELLED", "REJECTED", "PENDING_WAITER_APPROVAL"] as const;

const paySchema = z.object({
  mode: z.enum(["FULL", "PARTIAL", "ITEMS"]),
  method: z.enum(["CASH", "CARD", "WALLET"]),
  amount: z.number().positive().optional(), // PARTIAL only
  note: z.string().max(300).optional(),
  payerName: z.string().max(100).optional(),
  items: z
    .array(z.object({ orderItemId: z.string(), quantity: z.number().int().min(1) }))
    .optional(), // ITEMS only
  // Loyalty redemption applied to the table settlement (FULL/PARTIAL only).
  loyaltyPointsToRedeem: z.number().int().min(1).optional(),
  customerPhone: z.string().trim().optional(),
});

// POST /api/tables/[id]/pay — collect the table bill.
//   FULL    → pays the whole remaining amount
//   PARTIAL → pays a given amount (FIFO across unpaid orders)
//   ITEMS   → pays for selected item quantities (guest pays & leaves)
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const session = await requireKey("tables.collect_payment");
    const { id } = await params;
    const data = paySchema.parse(await request.json());

    // Mode-specific permission on top of the base collect permission.
    if (data.mode === "PARTIAL") await requireKey("tables.partial_payment");
    if (data.mode === "ITEMS") await requireKey("tables.item_payment");

    const ts = await db.tableSession.findUnique({
      where: { id },
      include: {
        orders: {
          where: { status: { notIn: [...INACTIVE] } },
          orderBy: { createdAt: "asc" },
          include: { items: { include: { itemPayments: { select: { quantityPaid: true } } } } },
        },
      },
    });
    if (!ts) throw new ApiError(404, "الجلسة غير موجودة");
    if (session.role !== "SUPER_ADMIN" && ts.cafeId !== session.cafeId) {
      throw new ApiError(403, "ليس لديك صلاحية لتنفيذ هذا الإجراء");
    }
    if (session.branchId && ts.branchId !== session.branchId) {
      throw new ApiError(403, "الترابيزة تبع فرع تاني");
    }
    if (ts.status !== "OPEN") throw new ApiError(400, "الجلسة مقفولة بالفعل");

    const sessionRemaining = Number(ts.remainingAmount);
    if (sessionRemaining <= 0.001) throw new ApiError(400, "حساب الترابيزة متدفع بالكامل");

    // A cashier collecting money must have an open shift (mirrors POS).
    const shift = await getActiveShift(ts.branchId, session.id);
    if (session.role === "CASHIER" && !shift) {
      throw new ApiError(400, "لا يمكن تحصيل الدفع بدون شيفت مفتوح");
    }

    const note = [data.payerName?.trim(), data.note?.trim()].filter(Boolean).join(" — ") || null;

    // ── Loyalty redemption against the table account ──
    // Settings/cap validation here; balance + per-order state re-validate
    // inside the transaction (applyLoyaltyRedemptionInTx).
    let redemption: { customerId: string; points: number; discount: number } | null = null;
    let redemptionPointValue = 1;
    if (data.loyaltyPointsToRedeem) {
      if (data.mode === "ITEMS") {
        throw new ApiError(400, "استخدام النقاط غير متاح مع تحصيل الأصناف");
      }
      await requireKey("loyalty.redeem_points", "ليس لديك صلاحية لاستخدام نقاط الولاء");
      const settings = loyaltyCalcSettings(await getLoyaltySettingsSafe(ts.cafeId));
      if (!settings.enabled) throw new ApiError(400, "برنامج الولاء غير مفعل");
      if (data.loyaltyPointsToRedeem < settings.minPointsToRedeem) {
        throw new ApiError(400, `أقل عدد نقاط للاستخدام هو ${settings.minPointsToRedeem} نقطة`);
      }
      if (!data.customerPhone) throw new ApiError(400, "يجب اختيار عميل أولًا");
      const normalized = normalizeEgyptianPhone(data.customerPhone);
      if (!normalized) throw new ApiError(400, "رقم الموبايل غير صحيح");
      const customer = await db.customer.findUnique({
        // cafe-scoped lookup — another cafe's customer can never match
        where: { cafeId_normalizedPhone: { cafeId: ts.cafeId, normalizedPhone: normalized } },
        select: { id: true },
      });
      if (!customer) throw new ApiError(400, "يجب اختيار عميل أولًا");

      const discount = pointsValue(data.loyaltyPointsToRedeem, settings);
      if (discount > sessionRemaining + 0.001) {
        throw new ApiError(400, "قيمة خصم النقاط أكبر من المتبقي على الحساب");
      }
      const cap = round2((Number(ts.totalAmount) * settings.maxRedeemPercentageOfOrder) / 100);
      if (discount > cap + 0.001) {
        throw new ApiError(400, "لا يمكن أن يتجاوز خصم النقاط الحد المسموح");
      }
      redemption = { customerId: customer.id, points: data.loyaltyPointsToRedeem, discount };
      redemptionPointValue = settings.pointValueAmount;
    }

    // Per-order discount shares (FIFO, same walk the transaction re-does
    // with fresh reads) — money then allocates against REDUCED remainings.
    const discountShare = new Map<string, number>();
    if (redemption) {
      let dLeft = redemption.discount;
      for (const order of ts.orders) {
        if (dLeft <= 0.001) break;
        const orderRemaining = round2(Number(order.total) - Number(order.paidAmount));
        if (orderRemaining <= 0) continue;
        const share = round2(Math.min(dLeft, orderRemaining));
        discountShare.set(order.id, share);
        dLeft = round2(dLeft - share);
      }
    }
    const remainingAfterDiscount = round2(sessionRemaining - (redemption?.discount ?? 0));

    // ── Build per-order allocations ──
    type Allocation = {
      orderId: string;
      amount: number;
      items?: { orderItemId: string; quantity: number; amount: number }[];
    };
    const allocations: Allocation[] = [];

    if (data.mode === "ITEMS") {
      if (!data.items?.length) throw new ApiError(400, "اختار الأصناف المطلوب تحصيلها");
      const itemMap = new Map(
        ts.orders.flatMap((o) => o.items.map((it) => [it.id, { item: it, order: o }] as const))
      );
      const byOrder = new Map<string, { orderItemId: string; quantity: number; amount: number }[]>();
      for (const sel of data.items) {
        const entry = itemMap.get(sel.orderItemId);
        if (!entry) throw new ApiError(400, "في صنف مش موجود في الجلسة");
        const paidQty = entry.item.itemPayments.reduce((s, p) => s + p.quantityPaid, 0);
        const remainingQty = entry.item.quantity - paidQty;
        if (sel.quantity > remainingQty) {
          throw new ApiError(400, `الكمية المطلوبة أكبر من المتبقي لـ ${entry.item.productName}`);
        }
        // Unit share includes add-ons (lineTotal already includes them).
        const unitShare = Number(entry.item.lineTotal) / entry.item.quantity;
        const amount = round2(unitShare * sel.quantity);
        const list = byOrder.get(entry.order.id) ?? [];
        list.push({ orderItemId: sel.orderItemId, quantity: sel.quantity, amount });
        byOrder.set(entry.order.id, list);
      }
      for (const [orderId, items] of byOrder) {
        const order = ts.orders.find((o) => o.id === orderId)!;
        const orderRemaining = round2(Number(order.total) - Number(order.paidAmount));
        // Cap at the order's remaining so we never overpay (tax rounding).
        const amount = Math.min(round2(items.reduce((s, i) => s + i.amount, 0)), orderRemaining);
        if (amount <= 0) throw new ApiError(400, "الأصناف المحددة متدفعة بالفعل");
        allocations.push({ orderId, amount, items });
      }
    } else {
      // FULL pays everything (after any loyalty discount); PARTIAL pays
      // the requested amount, FIFO against post-discount remainings.
      let toAllocate =
        data.mode === "FULL" ? remainingAfterDiscount : round2(data.amount ?? 0);
      if (toAllocate < 0) toAllocate = 0;
      if (toAllocate <= 0 && !redemption) {
        throw new ApiError(400, "مبلغ الدفع يجب أن يكون أكبر من صفر");
      }
      if (toAllocate > remainingAfterDiscount + 0.001) {
        throw new ApiError(400, "المبلغ أكبر من المتبقي على الترابيزة");
      }
      for (const order of ts.orders) {
        if (toAllocate <= 0.001) break;
        const orderRemaining = round2(
          Number(order.total) - Number(order.paidAmount) - (discountShare.get(order.id) ?? 0)
        );
        if (orderRemaining <= 0) continue;
        const amount = Math.min(orderRemaining, toAllocate);
        allocations.push({ orderId: order.id, amount: round2(amount) });
        toAllocate = round2(toAllocate - amount);
      }
      if (allocations.length === 0 && !redemption) {
        throw new ApiError(400, "لا يوجد مبالغ متبقية للتحصيل");
      }
    }

    const totalCollected = round2(allocations.reduce((s, a) => s + a.amount, 0));

    // ── Write payments + item rows + order state in one transaction ──
    // Per-order math goes through the shared payment service so remaining
    // rechecks / duplicate guards / status updates exist exactly once.
    const paymentIds: string[] = [];
    let loyaltyOldBalance: number | null = null;
    await db.$transaction(async (tx) => {
      // Loyalty discount first — reduces order totals so the money
      // allocations below land on the reduced remainings.
      if (redemption) {
        const res = await applyLoyaltyRedemptionInTx(tx, {
          orderIds: ts.orders.map((o) => o.id),
          redemption,
          pointValue: redemptionPointValue,
          cashierId: session.id,
        });
        loyaltyOldBalance = res.oldBalance;
      }
      for (const alloc of allocations) {
        const applied = await applyOrderPaymentInTx(tx, {
          orderId: alloc.orderId,
          splits: [{ method: data.method, amount: alloc.amount }],
          cashierId: session.id,
          shiftId: shift?.id ?? null,
          tableSessionId: ts.id,
          note,
        });
        const payment = applied.payments[0];
        paymentIds.push(payment.id);

        if (alloc.items) {
          for (const it of alloc.items) {
            await tx.orderItemPayment.create({
              data: {
                cafeId: ts.cafeId,
                branchId: ts.branchId,
                tableSessionId: ts.id,
                orderId: alloc.orderId,
                orderItemId: it.orderItemId,
                paymentId: payment.id,
                quantityPaid: it.quantity,
                amountPaid: it.amount,
                createdByUserId: session.id,
              },
            });
          }
        }
      }
    });

    if (shift) await recomputeShiftTotals(shift.id);
    const updated = await recomputeSessionTotals(ts.id);

    // Loyalty: any order that just became fully paid earns its points —
    // including orders settled purely by the points discount.
    const affectedOrderIds = new Set([
      ...allocations.map((a) => a.orderId),
      ...discountShare.keys(),
    ]);
    for (const orderId of affectedOrderIds) {
      await maybeAwardLoyaltyPoints(orderId);
    }

    if (redemption) {
      await audit({
        cafeId: ts.cafeId, userId: session.id,
        action: "LOYALTY_POINTS_REDEEMED",
        entity: "Customer", entityId: redemption.customerId,
        details: {
          customerId: redemption.customerId, tableSessionId: ts.id, branchId: ts.branchId,
          points: redemption.points, amountValue: redemption.discount,
          oldValue: { balance: loyaltyOldBalance },
          newValue: { balance: (loyaltyOldBalance ?? 0) - redemption.points },
        },
      });
    }

    const AUDIT_ACTION =
      data.mode === "FULL"
        ? "TABLE_FULL_PAYMENT_COLLECTED"
        : data.mode === "PARTIAL"
          ? "TABLE_PARTIAL_PAYMENT_COLLECTED"
          : "TABLE_ITEM_PAYMENT_COLLECTED";
    await audit({
      cafeId: ts.cafeId, userId: session.id, action: AUDIT_ACTION,
      entity: "TableSession", entityId: ts.id,
      details: {
        branchId: ts.branchId, tableSessionId: ts.id, tableNumber: ts.tableNumber,
        paymentId: paymentIds[0] ?? null, paymentIds, method: data.method, note,
        oldValue: { paidAmount: Number(ts.paidAmount), remainingAmount: sessionRemaining },
        newValue: { paidAmount: Number(updated.paidAmount), remainingAmount: Number(updated.remainingAmount) },
        amount: totalCollected,
        ...(data.mode === "ITEMS" ? { items: data.items } : {}),
      },
    });

    return NextResponse.json({
      collected: totalCollected,
      loyaltyDiscount: redemption?.discount ?? 0,
      loyaltyPoints: redemption?.points ?? 0,
      paidAmount: Number(updated.paidAmount),
      remainingAmount: Number(updated.remainingAmount),
      // For the receipt: the payment rows this operation created.
      paymentIds,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
