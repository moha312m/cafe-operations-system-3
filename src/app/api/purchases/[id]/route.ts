import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireKey, handleApiError, ApiError, requireFeature } from "@/lib/api";
import { audit } from "@/lib/audit";
import { round2, paymentStatusFor } from "@/lib/purchases";
import type { Prisma } from "@prisma/client";

type Params = { params: Promise<{ id: string }> };

async function loadScoped(session: Awaited<ReturnType<typeof requireKey>>, id: string) {
  const inv = await db.purchaseInvoice.findUnique({ where: { id } });
  if (!inv) throw new ApiError(404, "الفاتورة غير موجودة");
  if (session.role !== "SUPER_ADMIN" && inv.cafeId !== session.cafeId) {
    throw new ApiError(403, "ليس لديك صلاحية لتنفيذ هذا الإجراء");
  }
  if (session.branchId && inv.branchId !== session.branchId) {
    throw new ApiError(403, "الفاتورة تبع فرع تاني");
  }
  return inv;
}

// GET /api/purchases/[id] — full invoice detail.
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const session = await requireKey("purchases.view");
    await requireFeature(session, "purchasesEnabled");
    const { id } = await params;
    await loadScoped(session, id);

    const inv = await db.purchaseInvoice.findUnique({
      where: { id },
      include: {
        supplier: { select: { id: true, name: true, phone: true } },
        branch: { select: { name: true } },
        createdBy: { select: { name: true } },
        items: { include: { inventoryItem: { select: { name: true } } } },
        payments: { orderBy: { paidAt: "asc" }, include: { createdBy: { select: { name: true } } } },
      },
    });
    if (!inv) throw new ApiError(404, "الفاتورة غير موجودة");

    return NextResponse.json({
      invoice: {
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        supplier: inv.supplier,
        branch: inv.branch.name,
        invoiceDate: inv.invoiceDate,
        status: inv.status,
        confirmedAt: inv.confirmedAt,
        paymentStatus: inv.paymentStatus,
        subtotalAmount: Number(inv.subtotalAmount),
        discountAmount: Number(inv.discountAmount),
        taxAmount: Number(inv.taxAmount),
        totalAmount: Number(inv.totalAmount),
        paidAmount: Number(inv.paidAmount),
        remainingAmount: Number(inv.remainingAmount),
        notes: inv.notes,
        createdBy: inv.createdBy?.name ?? null,
        items: inv.items.map((it) => ({
          id: it.id,
          inventoryItemId: it.inventoryItemId,
          name: it.inventoryItem.name,
          quantity: Number(it.quantity),
          unit: it.unit,
          unitCost: Number(it.unitCost),
          totalCost: Number(it.totalCost),
          expiryDate: it.expiryDate,
        })),
        payments: inv.payments.map((p) => ({
          id: p.id,
          amount: Number(p.amount),
          method: p.method,
          note: p.note,
          paidAt: p.paidAt,
          createdBy: p.createdBy?.name ?? null,
        })),
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}

const patchSchema = z.object({
  supplierId: z.string().nullable().optional(),
  invoiceDate: z.string().optional(),
  discountAmount: z.number().min(0).optional(),
  taxAmount: z.number().min(0).optional(),
  notes: z.string().max(500).nullable().optional(),
  items: z
    .array(z.object({
      inventoryItemId: z.string(),
      quantity: z.number().positive(),
      unitCost: z.number().min(0),
      expiryDate: z.string().optional(),
    }))
    .min(1)
    .optional(),
});

// PATCH /api/purchases/[id] — edit a DRAFT invoice only.
export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const session = await requireKey("purchases.edit");
    await requireFeature(session, "purchasesEnabled");
    const { id } = await params;
    const inv = await loadScoped(session, id);
    if (inv.status !== "DRAFT") throw new ApiError(400, "لا يمكن تعديل فاتورة مؤكدة أو ملغية");

    const data = patchSchema.parse(await request.json());

    if (data.supplierId) {
      const supplier = await db.supplier.findFirst({ where: { id: data.supplierId, cafeId: inv.cafeId } });
      if (!supplier) throw new ApiError(400, "المورد غير موجود");
    }

    // Recompute totals if items or charges changed.
    let subtotal = Number(inv.subtotalAmount);
    let itemRows: Prisma.PurchaseInvoiceItemCreateManyInput[] | null = null;

    if (data.items) {
      const itemIds = [...new Set(data.items.map((i) => i.inventoryItemId))];
      const invItems = await db.inventoryItem.findMany({
        where: { id: { in: itemIds }, cafeId: inv.cafeId, branchId: inv.branchId },
        select: { id: true, unit: true },
      });
      const invMap = new Map(invItems.map((i) => [i.id, i]));
      subtotal = 0;
      itemRows = data.items.map((it) => {
        const invItem = invMap.get(it.inventoryItemId);
        if (!invItem) throw new ApiError(400, "في خامة مش موجودة في مخزون الفرع");
        const totalCost = round2(it.quantity * it.unitCost);
        subtotal = round2(subtotal + totalCost);
        return {
          cafeId: inv.cafeId, branchId: inv.branchId, purchaseInvoiceId: id,
          inventoryItemId: it.inventoryItemId, quantity: it.quantity,
          unit: invItem.unit, unitCost: it.unitCost, totalCost,
          expiryDate: it.expiryDate ? new Date(it.expiryDate) : null,
        };
      });
    }

    const discount = data.discountAmount ?? Number(inv.discountAmount);
    const tax = data.taxAmount ?? Number(inv.taxAmount);
    const total = round2(subtotal - discount + tax);
    if (total < 0) throw new ApiError(400, "الخصم أكبر من قيمة الفاتورة");
    const paid = Number(inv.paidAmount);
    const remaining = round2(total - paid);

    await db.$transaction(async (tx) => {
      if (itemRows) {
        await tx.purchaseInvoiceItem.deleteMany({ where: { purchaseInvoiceId: id } });
        await tx.purchaseInvoiceItem.createMany({ data: itemRows });
      }
      await tx.purchaseInvoice.update({
        where: { id },
        data: {
          ...(data.supplierId !== undefined ? { supplierId: data.supplierId } : {}),
          ...(data.invoiceDate ? { invoiceDate: new Date(data.invoiceDate) } : {}),
          ...(data.notes !== undefined ? { notes: data.notes || null } : {}),
          subtotalAmount: subtotal,
          discountAmount: discount,
          taxAmount: tax,
          totalAmount: total,
          remainingAmount: Math.max(remaining, 0),
          paymentStatus: paymentStatusFor(total, paid),
        },
      });
    });

    await audit({
      cafeId: inv.cafeId, userId: session.id, action: "PURCHASE_INVOICE_UPDATED",
      entity: "PurchaseInvoice", entityId: id,
      details: { branchId: inv.branchId, purchaseInvoiceId: id, total },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleApiError(error);
  }
}
