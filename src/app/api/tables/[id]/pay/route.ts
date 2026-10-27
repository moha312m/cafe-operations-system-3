import { decimal, money, sumMoney, moneyMin, type Decimal, type Numeric, validCurrencyInput } from "@/lib/money";
import { NextResponse, type NextRequest } from "next/server";
import {allocateOrderPayable} from '@/lib/order-amendment-math';
import { z } from "zod";
import { requireKey, handleApiError, ApiError, resolveReadScope } from "@/lib/api";
import { auditInTransaction } from "@/lib/audit";
import { recomputeShiftTotals } from "@/lib/shifts";
import { recomputeSessionTotals } from "@/lib/table-sessions";
import { maybeAwardLoyaltyPoints, getLoyaltySettingsSafe, loyaltyCalcSettingsExact as loyaltyCalcSettings } from "@/lib/loyalty";
import { applyOrderPaymentInTx, applyLoyaltyRedemptionInTx } from "@/lib/payments";
import { normalizeEgyptianPhone } from "@/lib/phone";
import { pointsValueExact as pointsValue } from "@/lib/loyalty-calc";

import { withIdempotency, authenticatedRequestScope } from "@/lib/idempotency";
import { requireCashCustodyInTx, lockOrders, lockOrderPayments, lockCustomers, lockTableSessions } from "@/lib/transaction-locks";

type Params = { params: Promise<{ id: string }> };

const round2 = money;

// Orders excluded from billing (mirrors the session engine).
const INACTIVE = ["CANCELLED", "REJECTED", "PENDING_WAITER_APPROVAL"] as const;

const paySchema = z.object({
  mode: z.enum(["FULL", "PARTIAL", "ITEMS"]),
  method: z.enum(["CASH", "CARD", "WALLET"]),
  amount: z.number().positive().refine(validCurrencyInput, "المبلغ لازم يكون صحيح وبحد أقصى رقمين بعد العلامة").optional(), // PARTIAL only
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
    resolveReadScope(session);
    const { id } = await params;
    const data = paySchema.parse(await request.json());

    // Mode-specific permission on top of the base collect permission.
    if (data.mode === "PARTIAL") await requireKey("tables.partial_payment");
    if (data.mode === "ITEMS") await requireKey("tables.item_payment");

    if (data.loyaltyPointsToRedeem) await requireKey("loyalty.redeem_points");
    return await withIdempotency(request, (tx) => authenticatedRequestScope(tx, session, "POST /api/tables/" + id + "/pay", {kind:"table",id}), data, async (tx) => {
      const candidate = await tx.tableSession.findUnique({ where: { id }, select: { branchId: true, cafeId: true } });
      if (!candidate) throw new ApiError(404, "الجلسة مش موجودة");
      if (session.role !== "SUPER_ADMIN" && candidate.cafeId !== session.cafeId) throw new ApiError(403, "الترابيزة تبع كافيه تاني");
      if (session.branchId && candidate.branchId !== session.branchId) throw new ApiError(403, "الترابيزة تبع فرع تاني");
      const shift = await requireCashCustodyInTx(tx, candidate.branchId, session.id);
      const members = await tx.order.findMany({ where: { tableSessionId: id }, select: { id: true } });
      await lockOrders(tx, members.map((o) => o.id));
      await lockOrderPayments(tx, members.map((o) => o.id));
      const orderCustomers = await tx.order.findMany({ where: { id: { in: members.map((order) => order.id) } }, select: { customerId: true } });
      const redemptionPhone = data.loyaltyPointsToRedeem && data.customerPhone ? normalizeEgyptianPhone(data.customerPhone) : null;
      const redemptionCustomer = redemptionPhone ? await tx.customer.findUnique({ where: { cafeId_normalizedPhone: { cafeId: candidate.cafeId, normalizedPhone: redemptionPhone } }, select: { id: true } }) : null;
      await lockCustomers(tx, [...orderCustomers.map((order) => order.customerId), redemptionCustomer?.id].filter((id): id is string => !!id));
      // Table metadata follows money locks. All quantities/balances are then read afresh.
      await lockTableSessions(tx, [id]);
      await recomputeSessionTotals(id, tx);
      const ts = await tx.tableSession.findUnique({
        where: { id },
        include: {
          orders: {
            where: { status: { notIn: [...INACTIVE] } },
            orderBy: { createdAt: "asc" },
            include: { items: { where: { voidedAt: null }, include: { itemPayments: { select: { quantityPaid: true, amountPaid: true } } } } },
          },
        },
      });
      if (!ts) throw new ApiError(404, "الجلسة غير موجودة");
      const lockedMembers = new Set(members.map((order) => order.id));
      if (ts.orders.some((order) => !lockedMembers.has(order.id))) {
        throw new ApiError(409, "طلبات الترابيزة اتغيرت — جرّب التحصيل تاني");
      }
      if (session.role !== "SUPER_ADMIN" && ts.cafeId !== session.cafeId) {
        throw new ApiError(403, "ليس لديك صلاحية لتنفيذ هذا الإجراء");
      }
      if (session.branchId && ts.branchId !== session.branchId) {
        throw new ApiError(403, "الترابيزة تبع فرع تاني");
      }
      if (ts.status !== "OPEN") throw new ApiError(400, "الجلسة مقفولة بالفعل");

      // REFUNDED is terminal even though its historical total is retained.
      const collectibleOrders = ts.orders.filter(order => order.paymentStatus !== "REFUNDED");

      const sessionRemaining = money(ts.remainingAmount);
      if (sessionRemaining.lte(0)) throw new ApiError(400, "حساب الترابيزة متدفع بالكامل");

      // Anyone collecting money must have an open shift (mirrors POS).


      const note = [data.payerName?.trim(), data.note?.trim()].filter(Boolean).join(" — ") || null;

      // ── Loyalty redemption against the table account ──
      // Settings/cap validation here; balance + per-order state re-validate
      // inside the transaction (applyLoyaltyRedemptionInTx).
      let redemption: { customerId: string; points: number; discount: Decimal } | null = null;
      let redemptionPointValue: Numeric = 1;
      if (data.loyaltyPointsToRedeem) {
        if (data.mode === "ITEMS") {
          throw new ApiError(400, "استخدام النقاط غير متاح مع تحصيل الأصناف");
        }
        const settings = loyaltyCalcSettings(await getLoyaltySettingsSafe(ts.cafeId, tx));
        if (!settings.enabled) throw new ApiError(400, "برنامج الولاء غير مفعل");
        if (data.loyaltyPointsToRedeem < settings.minPointsToRedeem) {
          throw new ApiError(400, `أقل عدد نقاط للاستخدام هو ${settings.minPointsToRedeem} نقطة`);
        }
        if (!data.customerPhone) throw new ApiError(400, "يجب اختيار عميل أولًا");
        const normalized = normalizeEgyptianPhone(data.customerPhone);
        if (!normalized) throw new ApiError(400, "رقم الموبايل غير صحيح");
        const customer = await tx.customer.findUnique({
          // cafe-scoped lookup — another cafe's customer can never match
          where: { cafeId_normalizedPhone: { cafeId: ts.cafeId, normalizedPhone: normalized } },
          select: { id: true },
        });
        if (!customer) throw new ApiError(400, "يجب اختيار عميل أولًا");

        const discount = pointsValue(data.loyaltyPointsToRedeem, settings);
        if (discount.gt(sessionRemaining)) {
          throw new ApiError(400, "قيمة خصم النقاط أكبر من المتبقي على الحساب");
        }
        const cap = money(decimal(ts.totalAmount).times(settings.maxRedeemPercentageOfOrder).div(100));
        if (discount.gt(cap)) {
          throw new ApiError(400, "لا يمكن أن يتجاوز خصم النقاط الحد المسموح");
        }
        redemption = { customerId: customer.id, points: data.loyaltyPointsToRedeem, discount };
        redemptionPointValue = settings.pointValueAmount;
      }

      // Per-order discount shares (FIFO, same walk the transaction re-does
      // with fresh reads) — money then allocates against REDUCED remainings.
      const discountShare = new Map<string, Decimal>();
      if (redemption) {
        let dLeft = redemption.discount;
        for (const order of collectibleOrders) {
          if (dLeft.lte(0)) break;
          const orderRemaining = money(decimal(order.total).minus(order.paidAmount));
          if (orderRemaining.lte(0)) continue;
          const share = money(moneyMin(dLeft, orderRemaining));
          discountShare.set(order.id, share);
          dLeft = money(dLeft.minus(share));
        }
      }
      const remainingAfterDiscount = money(sessionRemaining.minus(redemption?.discount ?? 0));

      // ── Build per-order allocations ──
      type Allocation = {
        orderId: string;
        amount: Decimal;
        items?: { orderItemId: string; quantity: number; amount: Decimal }[];
      };
      const allocations: Allocation[] = [];

      if (data.mode === "ITEMS") {
        if (!data.items?.length) throw new ApiError(400, "اختار الأصناف المطلوب تحصيلها");
        const itemMap = new Map(
          collectibleOrders.flatMap((o) => o.items.map((it) => [it.id, { item: it, order: o }] as const))
        );
        if (new Set(data.items.map((i) => i.orderItemId)).size !== data.items.length) throw new ApiError(400, "اختار كل صنف مرة واحدة بس");
        const byOrder = new Map<string, { orderItemId: string; quantity: number; amount: Decimal }[]>();
        for (const sel of data.items) {
          const entry = itemMap.get(sel.orderItemId);
          if (!entry) throw new ApiError(400, "في صنف مش موجود في الجلسة");
          if(entry.order.revision>0&&entry.order.items.some(i=>i.itemPayments.length))throw new ApiError(409,'الفاتورة المعدلة بها توزيعات أصناف تاريخية؛ استخدم التحصيل الكامل أو الجزئي بالمبلغ لحفظ تاريخها');
          const paidQty = entry.item.itemPayments.reduce((s, p) => s + p.quantityPaid, 0);
          const remainingQty = entry.item.quantity - paidQty;
          if (sel.quantity > remainingQty) {
            throw new ApiError(400, `الكمية المطلوبة أكبر من المتبقي لـ ${entry.item.productName}`);
          }
          // Unit share includes add-ons (lineTotal already includes them).
          const payable=allocateOrderPayable(entry.order.total,entry.order.items).find(s=>s.id===entry.item.id)!.amount;
          const cumulativeShare = money(decimal(payable).times(paidQty + sel.quantity).div(entry.item.quantity));
          const amount = money(cumulativeShare.minus(sumMoney(entry.item.itemPayments.map(p => p.amountPaid))));
          const list = byOrder.get(entry.order.id) ?? [];
          list.push({ orderItemId: sel.orderItemId, quantity: sel.quantity, amount });
          byOrder.set(entry.order.id, list);
        }
        for (const [orderId, items] of byOrder) {
          const order = collectibleOrders.find((o) => o.id === orderId)!;
          const orderRemaining = money(decimal(order.total).minus(order.paidAmount));
          // Cap at the order's remaining so we never overpay (tax rounding).
          const amount = moneyMin(money(sumMoney(items.map(i => i.amount))), orderRemaining);
          if (amount.lte(0)) throw new ApiError(400, "الأصناف المحددة متدفعة بالفعل");
          // Discount/tax caps must also reconcile every item ledger leg.
          const nominal = sumMoney(items.map(i => i.amount));
          let remainder = money(amount);
          const reconciled = items.map((item, index) => {
            const share = index === items.length - 1 ? remainder : moneyMin(money(amount.times(item.amount).div(nominal)), remainder);
            remainder = money(remainder.minus(share));
            return { ...item, amount: share };
          });
          allocations.push({ orderId, amount, items: reconciled });
        }
      } else {
        // FULL pays everything (after any loyalty discount); PARTIAL pays
        // the requested amount, FIFO against post-discount remainings.
        let toAllocate =
          data.mode === "FULL" ? remainingAfterDiscount : round2(data.amount ?? 0);
        if (toAllocate.lt(0)) toAllocate = decimal(0);
        if (toAllocate.lte(0) && !redemption) {
          throw new ApiError(400, "مبلغ الدفع يجب أن يكون أكبر من صفر");
        }
        if (toAllocate.gt(remainingAfterDiscount)) {
          throw new ApiError(400, "المبلغ أكبر من المتبقي على الترابيزة");
        }
        for (const order of collectibleOrders) {
          if (toAllocate.lte(0)) break;
          const orderRemaining = round2(
            decimal(order.total).minus(order.paidAmount).minus(discountShare.get(order.id) ?? 0)
          );
          if (orderRemaining.lte(0)) continue;
          const amount = moneyMin(orderRemaining, toAllocate);
          allocations.push({ orderId: order.id, amount: round2(amount) });
          toAllocate = money(toAllocate.minus(amount));
        }
        if (allocations.length === 0 && !redemption) {
          throw new ApiError(400, "لا يوجد مبالغ متبقية للتحصيل");
        }
      }

      const totalCollected = money(sumMoney(allocations.map(a => a.amount)));

      // ── Write payments + item rows + order state in one transaction ──
      // Per-order math goes through the shared payment service so remaining
      // rechecks / duplicate guards / status updates exist exactly once.
      const paymentIds: string[] = [];
      let loyaltyOldBalance: number | null = null;
      await (async () => {
        // Loyalty discount first — reduces order totals so the money
        // allocations below land on the reduced remainings.
        if (redemption) {
          const res = await applyLoyaltyRedemptionInTx(tx, {
            orderIds: collectibleOrders.map((o) => o.id),
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
      })();

      if (shift) await recomputeShiftTotals(shift.id, tx);
      const updated = await recomputeSessionTotals(ts.id, tx);

      // Loyalty: any order that just became fully paid earns its points —
      // including orders settled purely by the points discount.
      const affectedOrderIds = new Set([
        ...allocations.map((a) => a.orderId),
        ...discountShare.keys(),
      ]);
      for (const orderId of affectedOrderIds) {
        await maybeAwardLoyaltyPoints(orderId, tx);
      }

      if (redemption) {
        await auditInTransaction(tx, {
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
      await auditInTransaction(tx, {
        cafeId: ts.cafeId, userId: session.id, action: AUDIT_ACTION,
        entity: "TableSession", entityId: ts.id,
        details: {
          branchId: ts.branchId, tableSessionId: ts.id, tableNumber: ts.tableNumber,
          paymentId: paymentIds[0] ?? null, paymentIds, method: data.method, note,
          oldValue: { paidAmount: Number(ts.paidAmount), remainingAmount: sessionRemaining.toNumber() },
          newValue: { paidAmount: Number(updated.paidAmount), remainingAmount: Number(updated.remainingAmount) },
          amount: totalCollected.toNumber(),
          ...(data.mode === "ITEMS" ? { items: data.items } : {}),
        },
      });

      return NextResponse.json({
        collected: totalCollected.toNumber(),
        loyaltyDiscount: redemption?.discount.toNumber() ?? 0,
        loyaltyPoints: redemption?.points ?? 0,
        paidAmount: Number(updated.paidAmount),
        remainingAmount: Number(updated.remainingAmount),
        // For the receipt: the payment rows this operation created.
        paymentIds,
      });
    }, { scope: resolveReadScope(session) });
  } catch (error) {
    return handleApiError(error);
  }
}
