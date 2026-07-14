import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requirePermission, handleApiError, ApiError } from "@/lib/api";
import { audit } from "@/lib/audit";

type Params = { params: Promise<{ id: string }> };

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const session = await requirePermission("orders:read");
    const { id } = await params;
    const order = await db.order.findUnique({
      where: { id },
      include: {
        items: { include: { addOns: true } },
        payments: { include: { receivedBy: { select: { name: true } } } },
        branch: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true } },
      },
    });
    if (!order) throw new ApiError(404, "الطلب مش موجود");
    if (session.role !== "SUPER_ADMIN" && order.cafeId !== session.cafeId) {
      throw new ApiError(403, "ليس لديك صلاحية لتنفيذ هذا الإجراء");
    }
    return NextResponse.json({ order });
  } catch (error) {
    return handleApiError(error);
  }
}

const editSchema = z.object({
  tableNumber: z.string().nullable().optional(),
  customerName: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  // Quantity adjustments per existing order item; 0 removes the line.
  items: z
    .array(z.object({ id: z.string(), quantity: z.number().int().min(0) }))
    .optional(),
});

// Waiter corrections to a QR order before approving it: quantities,
// removed lines, table number, customer name, notes. Totals are
// recomputed server-side from the stored price snapshots.
export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const session = await requirePermission("orders:approve");
    const { id } = await params;
    const data = editSchema.parse(await request.json());

    const order = await db.order.findUnique({
      where: { id },
      include: { items: { include: { addOns: true } }, cafe: true },
    });
    if (!order) throw new ApiError(404, "الطلب مش موجود");
    if (session.role !== "SUPER_ADMIN" && order.cafeId !== session.cafeId) {
      throw new ApiError(403, "ليس لديك صلاحية لتنفيذ هذا الإجراء");
    }
    if (session.branchId && order.branchId !== session.branchId) {
      throw new ApiError(403, "الطلب تبع فرع تاني");
    }
    if (order.status !== "PENDING_WAITER_APPROVAL") {
      throw new ApiError(400, "الطلب اتأكد بالفعل — مينفعش يتعدل من هنا");
    }

    const quantities = new Map((data.items ?? []).map((i) => [i.id, i.quantity]));

    // New per-line quantities → recomputed totals from stored snapshots.
    let subtotal = 0;
    const lineUpdates: { id: string; quantity: number; lineTotal: number }[] = [];
    const removals: string[] = [];
    for (const item of order.items) {
      const quantity = quantities.get(item.id) ?? item.quantity;
      if (quantity === 0) {
        removals.push(item.id);
        continue;
      }
      const perUnit =
        Number(item.unitPrice) +
        item.addOns.reduce((s, a) => s + Number(a.price), 0);
      const lineTotal = round2(perUnit * quantity);
      subtotal = round2(subtotal + lineTotal);
      if (quantity !== item.quantity) {
        lineUpdates.push({ id: item.id, quantity, lineTotal });
      }
    }
    if (removals.length === order.items.length) {
      throw new ApiError(400, "لازم يفضل صنف واحد على الأقل — لو عايز تلغي الطلب ارفضه");
    }

    const discountAmount = Math.min(Number(order.discountAmount), subtotal);
    const taxAmount = round2(
      (subtotal - discountAmount) * (Number(order.cafe.taxRate) / 100)
    );
    const total = round2(subtotal - discountAmount + taxAmount);

    const updated = await db.$transaction(async (tx) => {
      if (removals.length > 0) {
        await tx.orderItem.deleteMany({ where: { id: { in: removals } } });
      }
      for (const change of lineUpdates) {
        await tx.orderItem.update({
          where: { id: change.id },
          data: { quantity: change.quantity, lineTotal: change.lineTotal },
        });
      }
      return tx.order.update({
        where: { id },
        data: {
          subtotal,
          taxAmount,
          discountAmount,
          total,
          ...(data.tableNumber !== undefined ? { tableNumber: data.tableNumber } : {}),
          ...(data.customerName !== undefined ? { customerName: data.customerName } : {}),
          ...(data.notes !== undefined ? { notes: data.notes } : {}),
        },
        include: {
          items: { include: { addOns: true } },
          branch: { select: { id: true, name: true } },
        },
      });
    });

    await audit({
      cafeId: order.cafeId,
      userId: session.id,
      action: "ORDER_UPDATED",
      entity: "Order",
      entityId: id,
      details: {
        orderNumber: order.orderNumber,
        removedItems: removals.length,
        changedItems: lineUpdates.length,
        total,
      },
    });

    return NextResponse.json({ order: updated });
  } catch (error) {
    return handleApiError(error);
  }
}
