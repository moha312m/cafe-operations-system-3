import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  requirePermission,
  resolveCafeId,
  resolveBranchId,
  handleApiError,
  ApiError,
} from "@/lib/api";
import { audit } from "@/lib/audit";
import { unitPrice as computeUnitPrice } from "@/lib/pricing";
import { getActiveShift } from "@/lib/shifts";

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

    const discountAmount = round2(Math.min(data.discountAmount, subtotal));
    const taxAmount = round2((subtotal - discountAmount) * (Number(cafe.taxRate) / 100));
    const total = round2(subtotal - discountAmount + taxAmount);

    // The source is derived from the authenticated role — clients can
    // never claim QR_MENU (that only happens via the public QR endpoint).
    const source = session.role === "WAITER" ? "WAITER" : "CASHIER_POS";

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
          type: data.type,
          status: "CONFIRMED", // staff orders skip the approval queue
          source,
          customerName: data.customerName,
          customerPhone: data.customerPhone,
          deliveryAddress: data.deliveryAddress,
          tableNumber: data.tableNumber,
          notes: data.notes,
          subtotal,
          taxAmount,
          discountAmount,
          total,
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
    });

    await audit({
      cafeId,
      userId: session.id,
      action: "ORDER_CREATED",
      entity: "Order",
      entityId: order.id,
      details: {
        orderNumber: order.orderNumber,
        total,
        branchId,
        source,
        createdById: session.id,
        createdByName: session.name,
      },
    });

    return NextResponse.json({ order }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
