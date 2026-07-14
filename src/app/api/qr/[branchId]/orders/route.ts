import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handleApiError, ApiError } from "@/lib/api";
import { audit } from "@/lib/audit";
import { unitPrice as computeUnitPrice } from "@/lib/pricing";

type Params = { params: Promise<{ branchId: string }> };

const round2 = (n: number) => Math.round(n * 100) / 100;

const qrOrderSchema = z.object({
  customerName: z.string().trim().min(2, "اكتب اسمك"),
  customerPhone: z
    .string()
    .trim()
    .regex(/^[0-9+\s-]{6,20}$/, "رقم موبايل مش صحيح")
    .optional()
    .or(z.literal("")),
  tableNumber: z.string().trim().optional(),
  notes: z.string().optional(),
  items: z
    .array(
      z.object({
        productId: z.string(),
        variantId: z.string().nullable().optional(),
        quantity: z.number().int().min(1).max(50),
        addOnIds: z.array(z.string()).default([]),
        notes: z.string().optional(),
      })
    )
    .min(1)
    .max(30),
});

// Public: a customer submits an order from the QR menu. It lands in the
// waiter approval queue (PENDING_WAITER_APPROVAL) — never straight to
// the kitchen. Prices always come from the current menu, server-side.
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { branchId } = await params;
    const data = qrOrderSchema.parse(await request.json());

    const branch = await db.branch.findUnique({
      where: { id: branchId },
      include: { cafe: true },
    });
    if (!branch || !branch.isActive || !branch.cafe.isActive) {
      throw new ApiError(404, "المنيو ده مش متاح");
    }
    if (!branch.publicMenuEnabled) {
      throw new ApiError(403, "المنيو غير متاح حاليًا");
    }
    const cafeId = branch.cafeId;

    const productIds = [...new Set(data.items.map((i) => i.productId))];
    const products = await db.product.findMany({
      // Customers can only order what's published AND available.
      where: {
        id: { in: productIds },
        cafeId,
        isActive: true,
        showInCustomerMenu: true,
        isAvailable: true,
      },
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
      if (!product) throw new ApiError(400, "في منتج مش متاح دلوقتي");
      let variantName: string | null = null;
      let chosenVariant: { price: unknown } | null = null;

      if (item.variantId) {
        const variant = product.variants.find(
          (v) => v.id === item.variantId && v.isActive
        );
        if (!variant) throw new ApiError(400, `اختار حجم متاح لـ ${product.name}`);
        chosenVariant = variant;
        variantName = variant.name;
      } else if (product.variants.some((v) => v.isActive)) {
        throw new ApiError(400, `اختار الحجم لـ ${product.name}`);
      }

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
        if (!addOn) throw new ApiError(400, `في إضافة مش متاحة لـ ${product.name}`);
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

    const taxAmount = round2(subtotal * (Number(branch.cafe.taxRate) / 100));
    const total = round2(subtotal + taxAmount);

    const order = await db.$transaction(async (tx) => {
      const last = await tx.order.aggregate({
        where: { branchId },
        _max: { orderNumber: true },
      });
      return tx.order.create({
        data: {
          cafeId,
          branchId,
          orderNumber: (last._max.orderNumber ?? 0) + 1,
          type: "DINE_IN",
          status: "PENDING_WAITER_APPROVAL",
          source: "QR_MENU",
          customerName: data.customerName,
          customerPhone: data.customerPhone || null,
          tableNumber: data.tableNumber,
          notes: data.notes,
          subtotal,
          taxAmount,
          total,
          createdById: null, // placed by the customer, no user account
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
      });
    });

    await audit({
      cafeId,
      action: "QR_ORDER_SUBMITTED",
      entity: "Order",
      entityId: order.id,
      details: {
        orderNumber: order.orderNumber,
        branchId,
        total,
        customerName: data.customerName,
        tableNumber: data.tableNumber ?? null,
      },
    });

    return NextResponse.json(
      {
        order: {
          id: order.id,
          orderNumber: order.orderNumber,
          total: order.total,
          status: order.status,
        },
      },
      { status: 201 }
    );
  } catch (error) {
    return handleApiError(error);
  }
}
