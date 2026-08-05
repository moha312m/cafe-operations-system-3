import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  requireKey, resolveCafeId, resolveBranchId, handleApiError, ApiError, requireFeature,
} from "@/lib/api";
import { audit } from "@/lib/audit";
import { round2, paymentStatusFor } from "@/lib/purchases";
import type { Prisma } from "@prisma/client";

// GET /api/purchases — invoice list (+ summary cards). Filters: date, supplier,
// branch, paymentStatus, status.
export async function GET(request: NextRequest) {
  try {
    const session = await requireKey("purchases.view");
    await requireFeature(session, "inventoryEnabled");
    await requireFeature(session, "purchasesEnabled");
    const params = request.nextUrl.searchParams;
    const cafeId = resolveCafeId(session, params.get("cafeId"));
    const branchId = session.branchId ?? params.get("branchId") ?? undefined;

    const where: Prisma.PurchaseInvoiceWhereInput = {
      cafeId,
      ...(branchId ? { branchId } : {}),
      ...(params.get("supplierId") ? { supplierId: params.get("supplierId")! } : {}),
      ...(["DRAFT", "CONFIRMED", "CANCELLED"].includes(params.get("status") ?? "")
        ? { status: params.get("status") as never } : {}),
      ...(["UNPAID", "PARTIAL", "PAID"].includes(params.get("paymentStatus") ?? "")
        ? { paymentStatus: params.get("paymentStatus") as never } : {}),
    };
    const dateParam = params.get("date");
    if (dateParam) {
      const start = new Date(`${dateParam}T00:00:00`);
      if (!isNaN(start.getTime())) {
        const end = new Date(start); end.setDate(end.getDate() + 1);
        where.invoiceDate = { gte: start, lt: end };
      }
    }

    // Summary windows (respect the branch scope, ignore other filters).
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
    const startOfMonth = new Date(); startOfMonth.setDate(1); startOfMonth.setHours(0, 0, 0, 0);
    const scope: Prisma.PurchaseInvoiceWhereInput = { cafeId, ...(branchId ? { branchId } : {}), status: { not: "CANCELLED" } };

    const [invoices, todayAgg, monthAgg, unpaidCount, partialCount, activeSuppliers] = await Promise.all([
      db.purchaseInvoice.findMany({
        where,
        orderBy: { invoiceDate: "desc" },
        take: 100,
        include: {
          supplier: { select: { name: true } },
          branch: { select: { name: true } },
          _count: { select: { items: true } },
        },
      }),
      db.purchaseInvoice.aggregate({ where: { ...scope, invoiceDate: { gte: startOfToday } }, _sum: { totalAmount: true } }),
      db.purchaseInvoice.aggregate({ where: { ...scope, invoiceDate: { gte: startOfMonth } }, _sum: { totalAmount: true } }),
      db.purchaseInvoice.count({ where: { ...scope, paymentStatus: "UNPAID" } }),
      db.purchaseInvoice.count({ where: { ...scope, paymentStatus: "PARTIAL" } }),
      db.supplier.count({ where: { cafeId, isActive: true } }),
    ]);

    return NextResponse.json({
      summary: {
        todayTotal: Number(todayAgg._sum.totalAmount ?? 0),
        monthTotal: Number(monthAgg._sum.totalAmount ?? 0),
        unpaidCount, partialCount, activeSuppliers,
      },
      invoices: invoices.map((inv) => ({
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        supplier: inv.supplier?.name ?? null,
        branch: inv.branch.name,
        invoiceDate: inv.invoiceDate,
        itemCount: inv._count.items,
        totalAmount: Number(inv.totalAmount),
        paidAmount: Number(inv.paidAmount),
        remainingAmount: Number(inv.remainingAmount),
        paymentStatus: inv.paymentStatus,
        status: inv.status,
      })),
    });
  } catch (error) {
    return handleApiError(error);
  }
}

const itemSchema = z.object({
  inventoryItemId: z.string(),
  quantity: z.number().positive("الكمية يجب أن تكون أكبر من صفر"),
  unitCost: z.number().min(0),
  expiryDate: z.string().optional(),
});
const createSchema = z.object({
  branchId: z.string().optional(),
  cafeId: z.string().optional(),
  supplierId: z.string().nullable().optional(),
  invoiceNumber: z.string().trim().max(60).optional(),
  invoiceDate: z.string().optional(),
  discountAmount: z.number().min(0).default(0),
  taxAmount: z.number().min(0).default(0),
  notes: z.string().max(500).optional(),
  items: z.array(itemSchema).min(1, "أضف صنف واحد على الأقل"),
  // Optional initial supplier payment recorded on creation.
  payment: z
    .object({
      amount: z.number().positive(),
      method: z.enum(["CASH", "CARD", "WALLET", "BANK_TRANSFER"]),
    })
    .optional(),
});

// POST /api/purchases — create a DRAFT invoice (+ optional initial payment).
export async function POST(request: NextRequest) {
  try {
    const session = await requireKey("purchases.create");
    await requireFeature(session, "inventoryEnabled");
    await requireFeature(session, "purchasesEnabled");
    const data = createSchema.parse(await request.json());
    const cafeId = resolveCafeId(session, data.cafeId);
    const branchId = resolveBranchId(session, data.branchId);

    // Validate supplier belongs to the cafe.
    if (data.supplierId) {
      const supplier = await db.supplier.findFirst({ where: { id: data.supplierId, cafeId } });
      if (!supplier) throw new ApiError(400, "المورد غير موجود");
    }

    // Resolve each item against branch inventory (fixes unit + names).
    const itemIds = [...new Set(data.items.map((i) => i.inventoryItemId))];
    const invItems = await db.inventoryItem.findMany({
      where: { id: { in: itemIds }, cafeId, branchId },
      select: { id: true, unit: true },
    });
    const invMap = new Map(invItems.map((i) => [i.id, i]));

    let subtotal = 0;
    const itemRows = data.items.map((it) => {
      const inv = invMap.get(it.inventoryItemId);
      if (!inv) throw new ApiError(400, "في خامة مش موجودة في مخزون الفرع");
      const totalCost = round2(it.quantity * it.unitCost);
      subtotal = round2(subtotal + totalCost);
      return {
        cafeId, branchId,
        inventoryItemId: it.inventoryItemId,
        quantity: it.quantity,
        unit: inv.unit, // stock is kept in the item's own unit
        unitCost: it.unitCost,
        totalCost,
        expiryDate: it.expiryDate ? new Date(it.expiryDate) : null,
      };
    });

    const total = round2(subtotal - data.discountAmount + data.taxAmount);
    if (total < 0) throw new ApiError(400, "الخصم أكبر من قيمة الفاتورة");
    const paid = round2(Math.min(data.payment?.amount ?? 0, total));
    const remaining = round2(total - paid);

    // Invoice number: manual (unique) or auto per branch.
    let invoiceNumber = data.invoiceNumber?.trim();
    if (invoiceNumber) {
      const clash = await db.purchaseInvoice.findUnique({
        where: { branchId_invoiceNumber: { branchId, invoiceNumber } },
      });
      if (clash) throw new ApiError(409, "رقم الفاتورة مستخدم بالفعل");
    } else {
      const count = await db.purchaseInvoice.count({ where: { branchId } });
      invoiceNumber = `PUR-${count + 1}`;
    }

    const invoice = await db.$transaction(async (tx) => {
      const created = await tx.purchaseInvoice.create({
        data: {
          cafeId, branchId,
          supplierId: data.supplierId ?? null,
          invoiceNumber,
          invoiceDate: data.invoiceDate ? new Date(data.invoiceDate) : new Date(),
          status: "DRAFT",
          subtotalAmount: subtotal,
          discountAmount: data.discountAmount,
          taxAmount: data.taxAmount,
          totalAmount: total,
          paidAmount: paid,
          remainingAmount: remaining,
          paymentStatus: paymentStatusFor(total, paid),
          notes: data.notes || null,
          createdByUserId: session.id,
          items: { create: itemRows },
        },
      });
      if (data.payment && paid > 0) {
        await tx.purchasePayment.create({
          data: {
            cafeId, branchId, purchaseInvoiceId: created.id,
            amount: paid, method: data.payment.method,
            createdByUserId: session.id,
          },
        });
      }
      return created;
    });

    await audit({
      cafeId, userId: session.id, action: "PURCHASE_INVOICE_CREATED",
      entity: "PurchaseInvoice", entityId: invoice.id,
      details: { branchId, purchaseInvoiceId: invoice.id, supplierId: data.supplierId ?? null, invoiceNumber, total, itemCount: itemRows.length },
    });
    if (paid > 0) {
      await audit({
        cafeId, userId: session.id, action: "PURCHASE_PAYMENT_RECORDED",
        entity: "PurchaseInvoice", entityId: invoice.id,
        details: { branchId, purchaseInvoiceId: invoice.id, amount: paid, method: data.payment?.method },
      });
    }

    return NextResponse.json({ id: invoice.id, invoiceNumber }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
