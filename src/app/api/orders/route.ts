import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  requirePermission,
  requireKey,
  resolveCafeId,
  resolveBranchId,
  handleApiError,
  ApiError,
  retryOnUniqueConflict,
} from "@/lib/api";
import { audit } from "@/lib/audit";
import { unitPrice as computeUnitPrice } from "@/lib/pricing";
import { getActiveShift, requireCashCustody, recomputeShiftTotals } from "@/lib/shifts";
import { getBranchFinancialSettings, computeCharges } from "@/lib/financials";
import { attachOrderToTableSession } from "@/lib/table-sessions";
import { findOrCreateCustomerByPhone, recordCustomerOrder } from "@/lib/customers";
import { getLoyaltySettingsSafe, loyaltyCalcSettings, maybeAwardLoyaltyPoints, recordRedemptionInTx, auditRedemption } from "@/lib/loyalty";
import { validateRedemption } from "@/lib/loyalty-calc";
import { checkCartAvailability } from "@/lib/stock-availability";
import { getInventoryEnforcementMode } from "@/lib/inventory-policy";

const orderInclude = {
  items: { include: { addOns: true } },
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
    const branchId = session.branchId ?? requestedBranch;

    // Staff-tracking filters (waiter performance reports build on these).
    const createdById = params.get("createdById");
    const approvedById = params.get("approvedById");
    const source = params.get("source");

    const orders = await db.order.findMany({
      where: {
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
      },
      include: orderInclude,
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return NextResponse.json({ orders });
  } catch (error) {
    return handleApiError(error);
  }
}

const createOrderSchema = z.object({
  branchId: z.string().optional(),
  cafeId: z.string().optional(),
  type: z.enum(["DINE_IN", "TAKEAWAY", "DELIVERY"]).default("DINE_IN"),
  customerName: z.string().optional(),
  customerPhone: z.string().optional(),
  deliveryAddress: z.string().optional(),
  tableNumber: z.string().optional(),
  notes: z.string().optional(),
  discountAmount: z.number().min(0).default(0),
  // Loyalty: points the cashier redeems for this order (0 = none).
  loyaltyPointsToRedeem: z.number().int().min(0).default(0),
  // Payment collection: NOW (pay full), PENDING (collect later), PARTIAL.
  collectionMode: z.enum(["NOW", "PENDING", "PARTIAL"]).default("NOW"),
  paidAmount: z.number().min(0).optional(), // required for PARTIAL
  method: z.enum(["CASH", "CARD", "WALLET", "MIXED"]).optional(),
  splits: z
    .array(z.object({ method: z.enum(["CASH", "CARD", "WALLET"]), amount: z.number().positive() }))
    .optional(),
  items: z
    .array(
      z.object({
        productId: z.string(),
        variantId: z.string().nullable().optional(),
        quantity: z.number().int().min(1),
        addOnIds: z.array(z.string()).default([]),
        notes: z.string().optional(),
      })
    )
    .min(1),
});

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function POST(request: NextRequest) {
  try {
    const session = await requirePermission("orders:create");
    const data = createOrderSchema.parse(await request.json());
    const cafeId = resolveCafeId(session, data.cafeId);
    const branchId = resolveBranchId(session, data.branchId);

    // POS shift gate: a cashier must have an open shift to take orders.
    // Managers/owners taking the occasional order are not drawer-bound.
    if (session.role === "CASHIER") {
      const activeShift = await getActiveShift(branchId, session.id);
      if (!activeShift) {
        throw new ApiError(400, "لا يمكن تسجيل الطلب بدون شيفت مفتوح");
      }
    }

    const [cafe, branch] = await Promise.all([
      db.cafe.findUnique({ where: { id: cafeId } }),
      db.branch.findFirst({ where: { id: branchId, cafeId, isActive: true } }),
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
    const products = await db.product.findMany({
      where: { id: { in: productIds }, cafeId, isActive: true, isAvailable: true },
      include: {
        variants: true,
        addOns: { include: { addOn: true } },
        branchPrices: { where: { branchId } },
      },
    });
    const productMap = new Map(products.map((p) => [p.id, p]));

    let subtotal = 0;
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
        return { addOnId: addOn.id, addOnName: addOn.name, price: Number(addOn.price) };
      });

      const addOnsTotal = addOnRows.reduce((sum, a) => sum + a.price, 0);
      const lineTotal = round2((unitPrice + addOnsTotal) * item.quantity);
      subtotal = round2(subtotal + lineTotal);

      return {
        productId: product.id,
        variantId: item.variantId ?? null,
        productName: product.name,
        variantName,
        unitPrice,
        quantity: item.quantity,
        lineTotal,
        notes: item.notes,
        addOns: addOnRows,
      };
    });

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
    const enforcementMode = await getInventoryEnforcementMode(cafeId);
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
    });
    if (!availability.ok) {
      // What could not be sold, and why, is worth keeping: it is the record
      // the owner reads to find the ingredient that is costing them orders.
      // Written from the route rather than the service so the availability
      // check itself stays read-only.
      await audit({
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
          })
        : null;
    if (customer && !customer.isActive) customer = null; // disabled profiles don't collect/redeem

    let loyaltyDiscount = 0;
    let redeemPoints = 0;
    if (data.loyaltyPointsToRedeem > 0) {
      await requireKey("loyalty.redeem_points", "ليس لديك صلاحية لاستخدام نقاط الولاء");
      // Rejected redemptions are audited (who tried, how many points, why).
      const blockRedemption = async (reason: string): Promise<never> => {
        await audit({
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
      const loyaltySettings = await getLoyaltySettingsSafe(cafeId);
      const calc = loyaltyCalcSettings(loyaltySettings);
      // Cap check uses the pre-loyalty total (after the manual discount).
      const preFin = await getBranchFinancialSettings(branchId);
      const preCharges = computeCharges({
        subtotal, discount: data.discountAmount, orderType: data.type, settings: preFin,
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
    const finSettings = await getBranchFinancialSettings(branchId);
    const charges = computeCharges({
      subtotal,
      discount: data.discountAmount + loyaltyDiscount,
      orderType: data.type,
      settings: finSettings,
    });
    const total = charges.total;

    // ── Resolve payment collection ──
    let paidAmount = 0;
    let paymentStatus: "PAID" | "PARTIAL" | "PENDING_COLLECTION" = "PENDING_COLLECTION";
    let paySplits: { method: "CASH" | "CARD" | "WALLET"; amount: number }[] = [];

    if (data.collectionMode === "NOW") {
      if (!data.method) throw new ApiError(400, "من فضلك اختار طريقة الدفع");
      if (data.method === "MIXED") {
        paySplits = (data.splits ?? []).filter((s) => s.amount > 0);
        const sum = round2(paySplits.reduce((s, p) => s + p.amount, 0));
        if (Math.abs(sum - total) > 0.01) throw new ApiError(400, "مبلغ الدفع لا يساوي إجمالي الطلب");
      } else {
        paySplits = [{ method: data.method, amount: total }];
      }
      paidAmount = total;
      paymentStatus = "PAID";
    } else if (data.collectionMode === "PARTIAL") {
      if (!data.method || data.method === "MIXED") throw new ApiError(400, "من فضلك اختار طريقة الدفع");
      const amount = round2(data.paidAmount ?? 0);
      if (amount <= 0) throw new ApiError(400, "مبلغ الدفع يجب أن يكون أكبر من صفر");
      if (amount > total + 0.001) throw new ApiError(400, "مبلغ الدفع لا يمكن أن يكون أكبر من إجمالي الطلب");
      paySplits = [{ method: data.method, amount }];
      paidAmount = amount;
      paymentStatus = amount >= total - 0.001 ? "PAID" : "PARTIAL";
    }
    // PENDING → paidAmount 0, status PENDING_COLLECTION.

    // Creating an order WITH money attached is payment collection — same
    // permission + shift gates as the POS collection panel. (Waiters can
    // still place orders, but only as انتظار التحصيل.)
    let shift = null as Awaited<ReturnType<typeof getActiveShift>>;
    if (paySplits.length > 0) {
      await requireKey("pos.collect_payment", "ليس لديك صلاحية لتحصيل الدفع");
      shift = await requireCashCustody(branchId, session.id);
    }

    const source = session.role === "WAITER" ? "WAITER" : "CASHIER_POS";
    const remainingAmount = round2(total - paidAmount);

    // The order number is allocated from the branch's current maximum, and
    // that read takes no lock: two tills ringing up in the same moment are
    // handed the same number, and `@@unique([branchId, orderNumber])` refuses
    // the second one. The constraint is right; losing the sale to it was not.
    // The retry re-runs a transaction that has already rolled back, so the
    // second attempt reads a maximum that now includes the winner and takes
    // the next free number (R-POS-02B1).
    const placeOrder = () =>
      db.$transaction(async (tx) => {
        // Serialise the allocation itself, the way cash-close and the stock
        // ledger serialise theirs: hold the branch row for the length of the
        // transaction so concurrent tills queue here instead of all reading
        // the same maximum. The retry below is the backstop, and on its own
        // it is not enough — with eight tills racing, each round produces one
        // winner and seven losers, so three attempts still lose sales.
        await tx.$queryRaw`SELECT "id" FROM "Branch" WHERE "id" = ${branchId} FOR UPDATE`;
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
                productId: row.productId,
                variantId: row.variantId,
                productName: row.productName,
                variantName: row.variantName,
                unitPrice: row.unitPrice,
                quantity: row.quantity,
                lineTotal: row.lineTotal,
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
              cashierId: session.id, amount: s.amount, method: s.method,
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
      });

    const { created: order, redemption } = await retryOnUniqueConflict(placeOrder, {
      field: "orderNumber",
      message: "في طلب تاني اتسجل في نفس اللحظة — جرّب تاني",
    });

    if (shift) await recomputeShiftTotals(shift.id);

    // Dine-in orders join (or open) their table's session automatically.
    await attachOrderToTableSession(
      {
        id: order.id, cafeId, branchId, type: order.type,
        tableNumber: order.tableNumber, orderNumber: order.orderNumber,
        customerName: order.customerName,
      },
      session.id
    );

    // Loyalty side effects: ledger the redemption, bump customer stats,
    // then award earn-points (no-ops unless the order is already eligible).
    if (customer) {
      if (redeemPoints > 0 && redemption) {
        await auditRedemption({
          cafeId, customerId: customer.id, orderId: order.id,
          orderNumber: order.orderNumber, points: redeemPoints,
          amountValue: loyaltyDiscount, userId: session.id,
          oldBalance: redemption.oldBalance, newBalance: redemption.newBalance,
        });
      }
      await recordCustomerOrder(customer.id, total);
      await audit({
        cafeId, userId: session.id, action: "CUSTOMER_LINKED_TO_ORDER",
        entity: "Order", entityId: order.id,
        details: { customerId: customer.id, orderId: order.id, orderNumber: order.orderNumber, newValue: { phone: customer.normalizedPhone } },
      });
      await maybeAwardLoyaltyPoints(order.id);
    }

    // A sale that passed only because the café's policy allowed it is recorded
    // against the order, so a later review can tell "we had the stock" from
    // "we sold it anyway". Not written when nothing was waived — an explicit
    // NOT_APPLICABLE recipe consumes nothing and is not an override.
    if (availability.waived.length > 0) {
      await audit({
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

    await audit({
      cafeId, userId: session.id, action: "ORDER_CREATED", entity: "Order", entityId: order.id,
      details: { orderNumber: order.orderNumber, total, branchId, source, createdByName: session.name },
    });
    if (data.collectionMode === "PENDING") {
      await audit({ cafeId, userId: session.id, action: "PAYMENT_COLLECTION_PENDING", entity: "Order", entityId: order.id, details: { orderNumber: order.orderNumber, branchId, total } });
    } else if (paidAmount > 0) {
      await audit({
        cafeId, userId: session.id,
        action: paymentStatus === "PARTIAL" ? "PARTIAL_PAYMENT_RECORDED" : "PAYMENT_COLLECTED",
        entity: "Order", entityId: order.id,
        details: { orderNumber: order.orderNumber, branchId, shiftId: shift?.id ?? null, paidAmount, remainingAmount, total },
      });
    }

    // Non-blocking: the sale happened. The warning exists so the cashier is
    // never left thinking the shelf had what it did not.
    return NextResponse.json(
      availability.warnings.length > 0
        ? { order, warnings: availability.warnings, inventoryPolicy: enforcementMode }
        : { order },
      { status: 201 }
    );
  } catch (error) {
    return handleApiError(error);
  }
}
