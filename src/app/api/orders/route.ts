import { provisionalConsumption, finalizeOrderConsumption } from "@/lib/sale-consumption";
import { decimal, money, sumMoney, validCurrencyInput, type Numeric } from "@/lib/money";
import {priceAmendment} from '@/lib/order-amendment-math';
import { queueRefusalAudit } from "@/lib/protected-transaction";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  requirePermission,
  requireKey,
  resolveCafeId,
  resolveBranchId,
  resolveReadScope,
  handleApiError,
  ApiError,
} from "@/lib/api";
import { audit, auditInTransaction } from "@/lib/audit";
import { orderPage } from "@/lib/order-pagination";
import { unitPriceExact as computeUnitPrice } from "@/lib/pricing";
import { recomputeShiftTotals } from "@/lib/shifts";
import { getBranchFinancialSettings, computeChargesExact as computeCharges } from "@/lib/financials";
import { attachOrderToTableSession } from "@/lib/table-sessions";
import { findOrCreateCustomerByPhone, recordCustomerOrder } from "@/lib/customers";
import { getLoyaltySettingsSafe, loyaltyCalcSettingsExact as loyaltyCalcSettings, maybeAwardLoyaltyPoints, recordRedemptionInTx, auditRedemption } from "@/lib/loyalty";
import { validateRedemptionExact as validateRedemption } from "@/lib/loyalty-calc";
import { checkCartAvailability } from "@/lib/stock-availability";
import { getInventoryEnforcementMode } from "@/lib/inventory-policy";

import { withIdempotency, authenticatedRequestScope } from "@/lib/idempotency";
import { requireCashCustodyInTx, lockBranchAllocator } from "@/lib/transaction-locks";

const orderInclude = {
  items: { include: { addOns: true, voidedBy: { select: { id: true, name: true } } } },
  payments: true,
  branch: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  approvedBy: { select: { id: true, name: true } },
  rejectedBy: { select: { id: true, name: true } },
} as const;

export async function GET(request: NextRequest) {
  try {
    const session = await requirePermission("orders:read");
    const params = request.nextUrl.searchParams;
    const cafeId = resolveCafeId(session, params.get("cafeId"));

    const status = params.get("status");
    const requestedBranch = params.get("branchId");
    // Branch-pinned staff only see their branch's orders.
    const branchId = resolveReadScope(session).branchId ?? requestedBranch;

    // Staff-tracking filters (waiter performance reports build on these).
    const createdById = params.get("createdById");
    const approvedById = params.get("approvedById");
    const source = params.get("source");

    const page = orderPage(params, {
        cafeId,
        ...(branchId ? { branchId } : {}),
        ...(createdById ? { createdById } : {}),
        ...(approvedById ? { approvedById } : {}),
        ...(source === "QR_MENU" || source === "WAITER" || source === "CASHIER_POS"
          ? { source }
          : {}),
        // Without an explicit status filter, QR orders awaiting approval
        // and rejected orders are hidden — the kitchen board never sees
        // them. The approval queue asks for them explicitly.
        ...(status
          ? { status: { in: status.split(",") as never } }
          : { status: { notIn: ["PENDING_WAITER_APPROVAL", "REJECTED"] } }),
    });
    const orders = await db.order.findMany({
      where: page.where,
      include: {
        ...orderInclude,
        // The most recent handover that passed this order on, if any.
        handoverCarries: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: {
            createdAt: true,
            statusAtHandover: true,
            shift: { select: { shiftNumber: true, cashier: { select: { name: true } } } },
          },
        },
        deferredStockDeduction: { select: { servedAt: true, appliedAt: true } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: page.pageSize + 1,
    });
    return NextResponse.json(page.finish(orders));
  } catch (error) {
    return handleApiError(error);
  }
}

const createOrderSchema = z.object({
  invoiceDiscount:z.object({type:z.enum(['NONE','PERCENT','FIXED']),value:z.string().regex(/^\d+(\.\d{1,2})?$/)}).optional(),
  branchId: z.string().optional(),
  cafeId: z.string().optional(),
  type: z.enum(["DINE_IN", "TAKEAWAY", "DELIVERY"]).default("DINE_IN"),
  customerName: z.string().optional(),
  customerPhone: z.string().optional(),
  deliveryAddress: z.string().optional(),
  tableNumber: z.string().optional(),
  notes: z.string().optional(),
  discountAmount: z.number().min(0).refine(validCurrencyInput, "المبلغ لازم يكون صحيح وبحد أقصى رقمين بعد العلامة").default(0),
  // Loyalty: points the cashier redeems for this order (0 = none).
  loyaltyPointsToRedeem: z.number().int().min(0).default(0),
  // Payment collection: NOW (pay full), PENDING (collect later), PARTIAL.
  collectionMode: z.enum(["NOW", "PENDING", "PARTIAL"]).default("NOW"),
  paidAmount: z.number().min(0).refine(validCurrencyInput, "المبلغ لازم يكون صحيح وبحد أقصى رقمين بعد العلامة").optional(), // required for PARTIAL
  method: z.enum(["CASH", "CARD", "WALLET", "MIXED"]).optional(),
  splits: z
    .array(z.object({ method: z.enum(["CASH", "CARD", "WALLET"]), amount: z.number().positive().refine(validCurrencyInput, "المبلغ لازم يكون صحيح وبحد أقصى رقمين بعد العلامة") }))
    .optional(),
  items: z
    .array(
      z.object({
        productId: z.string(),
        discount:z.object({type:z.enum(['NONE','PERCENT','FIXED']),value:z.string().regex(/^\d+(\.\d{1,2})?$/)}).default({type:'NONE',value:'0'}),
        variantId: z.string().nullable().optional(),
        quantity: z.number().int().min(1),
        addOnIds: z.array(z.string()).default([]),
        notes: z.string().optional(),
      })
    )
    .min(1),
});

const round2 = money;

export async function POST(request: NextRequest) {
  try {
    const session = await requirePermission("orders:create");
    await requireKey("pos.create_order");
    const data = createOrderSchema.parse(await request.json());
    const cafeId = resolveCafeId(session, data.cafeId);
    const branchId = resolveBranchId(session, data.branchId);

    // Re-check before idempotency replay, using the current effective keys.
    if (data.discountAmount > 0 || (data.invoiceDiscount&&Number(data.invoiceDiscount.value)>0) || data.items.some(i=>Number(i.discount.value)>0)) {
      try { await requireKey("pos.apply_discount"); }
      catch (error) {
        if (error instanceof ApiError && error.status === 403) {
          await audit({ cafeId, userId: session.id, action: "ORDER_DISCOUNT_REFUSED", entity: "Order",
            details: { branchId, permissionKey: "pos.apply_discount" } });
        }
        throw error;
      }
    }
    if (data.loyaltyPointsToRedeem > 0) await requireKey("loyalty.redeem_points");
    if (data.collectionMode !== "PENDING") await requireKey("pos.collect_payment");
    return await withIdempotency(request, (tx) => authenticatedRequestScope(tx, session, "POST /api/orders", {kind:"branch",id:branchId}), data, async (tx) => {
      const shift = session.role === "CASHIER" || data.collectionMode !== "PENDING"
        ? await requireCashCustodyInTx(tx, branchId, session.id) : null;
      await lockBranchAllocator(tx, branchId);
      // POS shift gate: a cashier must have an open shift to take orders.
      // Managers/owners taking the occasional order are not drawer-bound.
      const [cafe, branch] = await Promise.all([
        tx.cafe.findUnique({ where: { id: cafeId } }),
        tx.branch.findFirst({ where: { id: branchId, cafeId, isActive: true } }),
      ]);
      if (!cafe) throw new ApiError(404, "Cafe not found");
      if (!branch) throw new ApiError(400, "Branch not found in this cafe");

      // Order-type invariants, mirrored from the POS UI.
      if (data.type === "DINE_IN" && !data.tableNumber?.trim()) {
        throw new ApiError(400, "Table number is required for dine-in orders");
      }
      if (data.type === "DELIVERY" && !data.customerName?.trim()) {
        throw new ApiError(400, "Customer name is required for delivery orders");
      }

      // Prices are always computed server-side from the current menu —
      // the client only sends ids and quantities.
      const productIds = [...new Set(data.items.map((i) => i.productId))];
      const products = await tx.product.findMany({
        where: { id: { in: productIds }, cafeId, isActive: true, isAvailable: true },
        include: {
          variants: true,
          addOns: { include: { addOn: true } },
          branchPrices: { where: { branchId } },
        },
      });
      const productMap = new Map(products.map((p) => [p.id, p]));

      let subtotal = decimal(0);
      const itemRows = data.items.map((item) => {
        const product = productMap.get(item.productId);
        if (!product) {
          throw new ApiError(400, `Product not available: ${item.productId}`);
        }
        let variantName: string | null = null;
        let chosenVariant: { price: unknown } | null = null;

        if (item.variantId) {
          const variant = product.variants.find(
            (v) => v.id === item.variantId && v.isActive
          );
          if (!variant) {
            throw new ApiError(400, `Variant not available for ${product.name}`);
          }
          chosenVariant = variant;
          variantName = variant.name;
        } else if (product.variants.some((v) => v.isActive)) {
          throw new ApiError(400, `Please choose a variant for ${product.name}`);
        }

        // Branch-aware price snapshot: variant absolute price (shifted by
        // any branch override) or the branch-effective base price.
        const unitPrice = computeUnitPrice(
          {
            basePrice: product.basePrice.toString(),
            branchPrices: product.branchPrices.map((bp) => ({
              branchId: bp.branchId,
              price: bp.price.toString(),
            })),
          },
          chosenVariant ? { price: String(chosenVariant.price) } : null,
          branchId
        );

        const allowedAddOns = new Map(
          product.addOns
            .filter((pa) => pa.addOn.isActive)
            .map((pa) => [pa.addOn.id, pa.addOn])
        );
        const addOnRows = item.addOnIds.map((addOnId) => {
          const addOn = allowedAddOns.get(addOnId);
          if (!addOn) {
            throw new ApiError(400, `Add-on not available for ${product.name}`);
          }
          return { addOnId: addOn.id, addOnName: addOn.name, price: decimal(addOn.price) };
        });

        const addOnsTotal = sumMoney(addOnRows.map(a => a.price));
        const lineTotal = money(unitPrice.plus(addOnsTotal).times(item.quantity));
        subtotal = money(subtotal.plus(lineTotal));

        return {
          ...provisionalConsumption(product, item.variantId ?? null),
          productId: product.id,
          variantId: item.variantId ?? null,
          productName: product.name,
          variantName,
          unitPrice,
          quantity: item.quantity,
          lineTotal,
          notes: item.notes,
          addOns: addOnRows,
          itemDiscountType:item.discount.type,itemDiscountValue:item.discount.value,itemDiscountAmount:'0.00',invoiceDiscountShare:'0.00',
        };
      });

      if(data.invoiceDiscount&&data.discountAmount>0)throw new ApiError(400,'استخدم تعريف خصم واحد للفاتورة');
      const invoiceDiscount=data.invoiceDiscount??{type:data.discountAmount>0?'FIXED':'NONE',value:String(data.discountAmount)};
      let priced;
      try{priced=priceAmendment(itemRows.map((row,index)=>({id:String(index),unitPrice:row.unitPrice,addOnTotal:sumMoney(row.addOns.map(a=>a.price)),quantity:row.quantity,discount:data.items[index].discount})),invoiceDiscount);}catch(e){throw new ApiError(400,e instanceof Error?e.message:'خصم غير صالح');}
      const effectiveDiscount=decimal(priced.discountAmount);
      for(const [index,row] of itemRows.entries()){row.lineTotal=money(priced.lines[index].lineTotal);row.itemDiscountAmount=priced.lines[index].itemDiscount;row.invoiceDiscountShare=priced.lines[index].invoiceShare;}
      if(effectiveDiscount.gt(0)&&!['CAFE_OWNER','BRANCH_MANAGER'].includes(session.role)){
        const limit=await tx.salesDiscountLimit.findUnique({where:{userId:session.id}});
        if(effectiveDiscount.gt(limit?.maxAmount??0)||(!subtotal.isZero()&&effectiveDiscount.times(100).div(subtotal).gt(limit?.maxPercent??0)))throw new ApiError(403,'الخصم يتجاوز حدك؛ احفظ الطلب بدون خصم وبانتظار التحصيل ثم اطلب اعتماد المدير من المبيعات');
      }

      // ── Can the branch actually make this? ──
      //
      // Placed here on purpose: the menu configuration above is validated, so
      // the exact sold configuration (product, size, add-ons) is known, and
      // NOTHING has been written yet. Everything below this point either
      // creates a row or takes money — `findOrCreateCustomerByPhone` alone will
      // create a customer profile — so a refusal has to happen before it, or
      // "the order was blocked" would still leave a trail of the sale.
      //
      // The check is read-only and holds no lock. It is an operational
      // availability answer, not a reservation: stock can still be consumed by
      // another order between here and SERVED, and the locked deduction at
      // SERVED remains the authoritative, concurrency-safe guard.
      // The café's persisted policy, read from the café the caller is
      // authenticated into. Deliberately NOT from the request body: enforcement
      // is a business setting the owner configures, never something a till can
      // ask to relax.
      if (effectiveDiscount.gt(subtotal)) {
        queueRefusalAudit(tx, { cafeId, userId: session.id, action: "ORDER_DISCOUNT_REFUSED", entity: "Order",
          details: { branchId, reason: "EXCEEDS_SUBTOTAL" } });
        throw new ApiError(400, "Discount cannot exceed the order subtotal");
      }
      const enforcementMode = await getInventoryEnforcementMode(cafeId, tx);
      const availability = await checkCartAvailability({
        cafeId,
        branchId,
        mode: enforcementMode,
        lines: itemRows.map((row) => ({
          productId: row.productId,
          variantId: row.variantId,
          addOnIds: row.addOns.map((a) => a.addOnId),
          quantity: row.quantity,
          label: row.variantName ? `${row.productName} (${row.variantName})` : row.productName,
        })),
      }, tx);
      if (!availability.ok) {
        // What could not be sold, and why, is worth keeping: it is the record
        // the owner reads to find the ingredient that is costing them orders.
        // Written from the route rather than the service so the availability
        // check itself stays read-only.
        queueRefusalAudit(tx, {
          cafeId, userId: session.id, action: "ORDER_BLOCKED_STOCK_UNAVAILABLE",
          entity: "Order", entityId: null,
          details: {
            branchId, mode: enforcementMode,
            reason: availability.message, refusals: availability.refusals,
          },
        });
        // 409, not 400: the request is well-formed and the menu configuration is
        // valid — it conflicts with the branch's CURRENT state, and the same
        // request may well succeed after a delivery lands.
        throw new ApiError(409, availability.message ?? "لا يمكن إتمام الطلب حاليًا");
      }

      // ── Customer profile link (by phone) + loyalty redemption ──
      // Invalid/absent phone just skips the link; redemption REQUIRES a
      // known customer with sufficient balance.
      let customer =
        data.customerPhone?.trim()
          ? await findOrCreateCustomerByPhone({
            cafeId,
            phone: data.customerPhone,
            name: data.customerName,
          }, tx)
          : null;
      if (customer && !customer.isActive) customer = null; // disabled profiles don't collect/redeem

      let loyaltyDiscount = decimal(0);
      let redeemPoints = 0;
      if (data.loyaltyPointsToRedeem > 0) {
        // Rejected redemptions are audited (who tried, how many points, why).
        const blockRedemption = async (reason: string): Promise<never> => {
          queueRefusalAudit(tx, {
            cafeId, userId: session.id, action: "LOYALTY_REDEMPTION_BLOCKED",
            entity: "Customer", entityId: customer?.id ?? null,
            details: {
              customerId: customer?.id ?? null, branchId,
              points: data.loyaltyPointsToRedeem, reason,
            },
          });
          throw new ApiError(400, reason);
        };
        // MVP rule: points redeem only when money is collected NOW — no
        // pending-collection reservations to reconcile later.
        if (data.collectionMode !== "NOW") {
          await blockRedemption("يمكن استخدام النقاط عند التحصيل الآن فقط");
        }
        if (!customer) await blockRedemption("يجب إدخال رقم موبايل العميل أولًا");
        // Safe fetch: if the loyalty tables are unreachable, settings resolve
        // to "disabled" and validation returns a clean Arabic error.
        const loyaltySettings = await getLoyaltySettingsSafe(cafeId, tx);
        const calc = loyaltyCalcSettings(loyaltySettings);
        // Cap check uses the pre-loyalty total (after the manual discount).
        const preFin = await getBranchFinancialSettings(branchId, tx);
        const preCharges = computeCharges({
          subtotal, discount: effectiveDiscount, orderType: data.type, settings: preFin,
        });
        const verdict = validateRedemption(
          data.loyaltyPointsToRedeem,
          customer!.loyaltyPointsBalance,
          preCharges.total,
          calc
        );
        if (!verdict.ok) await blockRedemption(verdict.error);
        else {
          loyaltyDiscount = verdict.amount;
          redeemPoints = data.loyaltyPointsToRedeem;
        }
      }

      // Charges come from the branch's configurable tax/service settings,
      // snapshotted onto the order so later edits never rewrite history.
      const finSettings = await getBranchFinancialSettings(branchId, tx);
      const charges = computeCharges({
        subtotal,
        discount: effectiveDiscount.plus(loyaltyDiscount),
        orderType: data.type,
        settings: finSettings,
      });
      const total = charges.total;

      // ── Resolve payment collection ──
      let paidAmount = decimal(0);
      let paymentStatus: "PAID" | "PARTIAL" | "PENDING_COLLECTION" = "PENDING_COLLECTION";
      let paySplits: { method: "CASH" | "CARD" | "WALLET"; amount: Numeric }[] = [];

      if (data.collectionMode === "NOW") {
        if (!data.method) throw new ApiError(400, "من فضلك اختار طريقة الدفع");
        if (data.method === "MIXED") {
          paySplits = (data.splits ?? []).filter((s) => s.amount > 0);
          const sum = money(sumMoney(paySplits.map(p => p.amount)));
          if (!sum.eq(total)) throw new ApiError(400, "مبلغ الدفع لا يساوي إجمالي الطلب");
        } else {
          paySplits = [{ method: data.method, amount: total }];
        }
        paidAmount = total;
        paymentStatus = "PAID";
      } else if (data.collectionMode === "PARTIAL") {
        if (!data.method || data.method === "MIXED") throw new ApiError(400, "من فضلك اختار طريقة الدفع");
        const amount = round2(data.paidAmount ?? 0);
        if (amount.lte(0)) throw new ApiError(400, "مبلغ الدفع يجب أن يكون أكبر من صفر");
        if (amount.gt(total)) throw new ApiError(400, "مبلغ الدفع لا يمكن أن يكون أكبر من إجمالي الطلب");
        paySplits = [{ method: data.method, amount }];
        paidAmount = amount;
        paymentStatus = amount.gte(total) ? "PAID" : "PARTIAL";
      }
      // PENDING → paidAmount 0, status PENDING_COLLECTION.

      // Creating an order WITH money attached is payment collection — same
      // permission + shift gates as the POS collection panel. (Waiters can
      // still place orders, but only as انتظار التحصيل.)
      const source = session.role === "WAITER" ? "WAITER" : "CASHIER_POS";
      const remainingAmount = money(total.minus(paidAmount));

      // Allocate under the branch lock acquired at transaction entry.
      const placeOrder = async () => {
        // NO KEY UPDATE serializes allocation while permitting FK readers.
        const last = await tx.order.aggregate({
          where: { branchId },
          _max: { orderNumber: true },
        });
        const created = await tx.order.create({
          data: {
            cafeId,
            branchId,
            orderNumber: (last._max.orderNumber ?? 0) + 1,
            type: data.type,
            status: "CONFIRMED", // staff orders skip the approval queue
            source,
            customerName: data.customerName,
            customerPhone: data.customerPhone,
            deliveryAddress: data.deliveryAddress,
            tableNumber: data.tableNumber,
            notes: data.notes,
            saleShiftId:shift?.id??null,invoiceDiscountType:invoiceDiscount.type,invoiceDiscountValue:invoiceDiscount.value,
            subtotal: charges.subtotal,
            discountAmount: charges.discountAmount,
            serviceChargeAmount: charges.serviceChargeAmount,
            taxAmount: charges.taxAmount,
            total,
            paymentStatus,
            paidAmount,
            remainingAmount,
            taxRateSnapshot: charges.taxRateSnapshot,
            serviceRateSnapshot: charges.serviceRateSnapshot,
            // The policy this order was ACCEPTED under, stored alongside the
            // rates and for the same reason: the availability answer above was
            // given under `enforcementMode`, and the deduction at SERVED must be
            // given under the same one however the café is configured by then.
            // Server-derived — `createOrderSchema` has no such field, so a till
            // cannot ask for a mode, only be told one.
            inventoryEnforcementMode: enforcementMode,
            customerId: customer?.id ?? null,
            loyaltyPointsRedeemed: redeemPoints,
            loyaltyDiscountAmount: loyaltyDiscount,
            createdById: session.id,
            items: {
              create: itemRows.map((row) => ({
                stockModeSnapshot: row.stockModeSnapshot, stockProductIdSnapshot: row.stockProductIdSnapshot, stockVariantIdSnapshot: row.stockVariantIdSnapshot,
                productId: row.productId,
                variantId: row.variantId,
                productName: row.productName,
                variantName: row.variantName,
                unitPrice: row.unitPrice,
                quantity: row.quantity,
                lineTotal: row.lineTotal,
                itemDiscountType:row.itemDiscountType,itemDiscountValue:row.itemDiscountValue,itemDiscountAmount:row.itemDiscountAmount,invoiceDiscountShare:row.invoiceDiscountShare,
                notes: row.notes,
                addOns: { create: row.addOns },
              })),
            },
          },
          include: orderInclude,
        });
        for (const s of paySplits) {
          await tx.payment.create({
            data: {
              cafeId, branchId, orderId: created.id, shiftId: shift?.id ?? null,
              cashierId: session.id, amount: money(s.amount), method: s.method,
              status: "PAID", receivedById: session.id,
            },
          });
        }
        // Take the loyalty points HERE rather than after the commit. The
        // discount is already priced into the row above, so a redemption
        // that cannot be honoured has to take the order down with it —
        // otherwise the café has sold at a discount and been paid in points
        // the customer did not have (R-POS-02B1).
        let redemption: { oldBalance: number; newBalance: number } | null = null;
        if (customer && redeemPoints > 0) {
          redemption = await recordRedemptionInTx(tx, {
            cafeId,
            customerId: customer.id,
            orderId: created.id,
            orderNumber: created.orderNumber,
            points: redeemPoints,
            amountValue: loyaltyDiscount,
            userId: session.id,
          });
        }
        // The redemption travels out with the order: it is read below for the
        // audit row, and only the attempt that actually committed can supply
        // it.
        return { created, redemption };
      };

      const { created: order, redemption } = await placeOrder();

      if (effectiveDiscount.gt(0)) {
        await auditInTransaction(tx, { cafeId, userId: session.id, action: "ORDER_DISCOUNT_APPLIED", entity: "Order", entityId: order.id,
          details: { branchId, manualDiscount: effectiveDiscount.toString(), subtotal: subtotal.toString(),invoiceDiscount,itemDiscounts:itemRows.map(r=>({productId:r.productId,type:r.itemDiscountType,value:r.itemDiscountValue,amount:r.itemDiscountAmount})) } });
      }
      if (shift) await recomputeShiftTotals(shift.id, tx);

      // Dine-in orders join (or open) their table's session automatically.
      await attachOrderToTableSession(
        {
          id: order.id, cafeId, branchId, type: order.type,
          tableNumber: order.tableNumber, orderNumber: order.orderNumber,
          customerName: order.customerName,
        },
        session.id, tx
      );

      await finalizeOrderConsumption(tx, order.id, new Date());

      // Loyalty side effects: ledger the redemption, bump customer stats,
      // then award earn-points (no-ops unless the order is already eligible).
      if (customer) {
        if (redeemPoints > 0 && redemption) {
          await auditRedemption({
            cafeId, customerId: customer.id, orderId: order.id,
            orderNumber: order.orderNumber, points: redeemPoints,
            amountValue: loyaltyDiscount, userId: session.id,
            oldBalance: redemption.oldBalance, newBalance: redemption.newBalance,
          }, tx);
        }
        await recordCustomerOrder(customer.id, total, tx);
        await auditInTransaction(tx, {
          cafeId, userId: session.id, action: "CUSTOMER_LINKED_TO_ORDER",
          entity: "Order", entityId: order.id,
          details: { customerId: customer.id, orderId: order.id, orderNumber: order.orderNumber, newValue: { phone: customer.normalizedPhone } },
        });
        await maybeAwardLoyaltyPoints(order.id, tx);
      }

      // A sale that passed only because the café's policy allowed it is recorded
      // against the order, so a later review can tell "we had the stock" from
      // "we sold it anyway". Not written when nothing was waived — an explicit
      // NOT_APPLICABLE recipe consumes nothing and is not an override.
      if (availability.waived.length > 0) {
        await auditInTransaction(tx, {
          cafeId, userId: session.id,
          action: "ORDER_INVENTORY_POLICY_OVERRIDE",
          entity: "Order", entityId: order.id,
          details: {
            orderNumber: order.orderNumber, branchId,
            // Read off the order rather than off the variable: this row is
            // evidence about what governed THIS order, and the order is where
            // that now lives. The two agree at this instant; taking it from the
            // order is what keeps them agreeing if the café changes later.
            mode: order.inventoryEnforcementMode,
            byName: session.name,
            reasonCategories: [...new Set(availability.waived.map((r) => r.kind))],
            knownShortages: availability.waived
              .filter((r) => r.kind === "INSUFFICIENT")
              .map((r) => r.kind === "INSUFFICIENT"
                ? { ingredient: r.ingredient, available: r.available, required: r.required }
                : null)
              .filter(Boolean),
            recipeGaps: availability.unresolvedConsumption,
            // The honest part: whether this order's recorded consumption can be
            // treated as complete.
            consumptionPartial: availability.unresolvedConsumption.length > 0
              || availability.waived.some((r) => r.kind === "INGREDIENT_NOT_STOCKED"),
          },
        });
      }

      await auditInTransaction(tx, {
        cafeId, userId: session.id, action: "ORDER_CREATED", entity: "Order", entityId: order.id,
        details: { orderNumber: order.orderNumber, total, branchId, source, createdByName: session.name },
      });
      if (data.collectionMode === "PENDING") {
        await auditInTransaction(tx, { cafeId, userId: session.id, action: "PAYMENT_COLLECTION_PENDING", entity: "Order", entityId: order.id, details: { orderNumber: order.orderNumber, branchId, total } });
      } else if (paidAmount.gt(0)) {
        await auditInTransaction(tx, {
          cafeId, userId: session.id,
          action: paymentStatus === "PARTIAL" ? "PARTIAL_PAYMENT_RECORDED" : "PAYMENT_COLLECTED",
          entity: "Order", entityId: order.id,
          details: { orderNumber: order.orderNumber, branchId, shiftId: shift?.id ?? null, paidAmount, remainingAmount, total },
        });
      }

      // Non-blocking: the sale happened. The warning exists so the cashier is
      // never left thinking the shelf had what it did not.
      const freshOrder = await tx.order.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude });
      await tx.orderTrace.create({data:{cafeId,branchId,orderId:order.id,revision:0,action:'ORDER_CREATED',actorId:session.id,originalCashierId:session.id,shiftId:shift?.id,reason:'إنشاء الفاتورة',details:JSON.parse(JSON.stringify({before:null,after:freshOrder,discounts:{invoice:invoiceDiscount,items:itemRows.map(r=>({productId:r.productId,type:r.itemDiscountType,value:r.itemDiscountValue,amount:r.itemDiscountAmount}))}}))}});
      return NextResponse.json(
        availability.warnings.length > 0
          ? { order: freshOrder, warnings: availability.warnings, inventoryPolicy: enforcementMode }
          : { order: freshOrder },
        { status: 201 }
      );
    }, { scope: resolveReadScope(session) });
  } catch (error) {
    return handleApiError(error);
  }
}
