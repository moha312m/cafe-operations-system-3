import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requirePermission, handleApiError, ApiError } from "@/lib/api";
import { getSession } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { resolvePermissions } from "@/lib/perms/effective";
import { canApproveOrder, getApprovalSettings } from "@/lib/qr-approval";
import { recomputeSessionTotals, attachOrderToTableSession } from "@/lib/table-sessions";
import { unitPrice as computeUnitPrice } from "@/lib/pricing";
import { getBranchFinancialSettings, computeCharges } from "@/lib/financials";

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
  // Quantity adjustments (and per-item note edits) for EXISTING lines; 0 removes.
  items: z
    .array(z.object({ id: z.string(), quantity: z.number().int().min(0), notes: z.string().nullable().optional() }))
    .optional(),
  // Brand-new lines added by the approver, priced server-side from the menu.
  newItems: z
    .array(z.object({
      productId: z.string(),
      variantId: z.string().nullable().optional(),
      addOnIds: z.array(z.string()).default([]),
      quantity: z.number().int().min(1),
      notes: z.string().optional(),
    }))
    .optional(),
});

// Approver corrections to a pending QR order: add/remove/adjust items, edit
// notes, move table, then save (stays pending) or save-and-confirm. Totals
// are recomputed server-side; new items use current menu prices and the
// branch's current tax/service settings.
export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const session = await getSession();
    if (!session) throw new ApiError(401, "سجّل دخولك الأول");
    const { id } = await params;
    const data = editSchema.parse(await request.json());

    const order = await db.order.findUnique({
      where: { id },
      include: { items: { include: { addOns: true } }, cafe: true },
    });
    if (!order) throw new ApiError(404, "الطلب مش موجود");
    // Editable only while still pending approval.
    if (order.status !== "PENDING_WAITER_APPROVAL" || order.approvalStatus === "APPROVED" || order.approvalStatus === "REJECTED") {
      throw new ApiError(400, "لا يمكن تعديل الطلب بعد دخوله مرحلة التحضير");
    }
    // Must be an authorized approver of THIS order and hold the edit key.
    const { keys } = await resolvePermissions(session);
    const isManager = session.role === "CAFE_OWNER" || session.role === "BRANCH_MANAGER";
    if (!canApproveOrder(session, order, keys.has("qr_orders.approve")) || !keys.has("qr_orders.edit_before_approval")) {
      throw new ApiError(403, "ليس لديك صلاحية لتعديل هذا الطلب");
    }
    const appr = await getApprovalSettings(order.cafeId, order.branchId);
    if (!appr.allowApproverToEditOrder && !isManager) {
      throw new ApiError(403, "تعديل الطلب غير مسموح في إعدادات هذا الفرع");
    }

    const branchId = order.branchId;
    const changes = new Map((data.items ?? []).map((i) => [i.id, i]));

    // ── Existing lines: keep price snapshot, apply new quantity / notes ──
    let subtotal = 0;
    const lineUpdates: { id: string; quantity: number; lineTotal: number; notes?: string | null }[] = [];
    const removals: string[] = [];
    for (const item of order.items) {
      const change = changes.get(item.id);
      const quantity = change?.quantity ?? item.quantity;
      if (quantity === 0) { removals.push(item.id); continue; }
      const perUnit = Number(item.unitPrice) + item.addOns.reduce((s, a) => s + Number(a.price), 0);
      const lineTotal = round2(perUnit * quantity);
      subtotal = round2(subtotal + lineTotal);
      const noteChanged = change && change.notes !== undefined && change.notes !== item.notes;
      if (quantity !== item.quantity || noteChanged) {
        lineUpdates.push({ id: item.id, quantity, lineTotal, notes: noteChanged ? (change!.notes ?? null) : undefined });
      }
    }

    // ── New lines: priced from the current menu (branch-aware) ──
    type NewRow = { productId: string; variantId: string | null; productName: string; variantName: string | null; unitPrice: number; quantity: number; lineTotal: number; notes: string | null; addOns: { addOnId: string; addOnName: string; price: number }[] };
    const newRows: NewRow[] = [];
    if (data.newItems && data.newItems.length > 0) {
      const ids = [...new Set(data.newItems.map((i) => i.productId))];
      const products = await db.product.findMany({
        where: { id: { in: ids }, cafeId: order.cafeId, isActive: true },
        include: { variants: true, addOns: { include: { addOn: true } }, branchPrices: { where: { branchId } } },
      });
      const pmap = new Map(products.map((p) => [p.id, p]));
      for (const it of data.newItems) {
        const product = pmap.get(it.productId);
        if (!product) throw new ApiError(400, "في منتج مش متاح");
        // Non-managers can only add available products.
        if (!product.isAvailable && !isManager) throw new ApiError(400, `${product.name} غير متاح حاليًا`);
        let variantName: string | null = null;
        let chosen: { price: unknown } | null = null;
        if (it.variantId) {
          const v = product.variants.find((x) => x.id === it.variantId && x.isActive);
          if (!v) throw new ApiError(400, `اختار حجم متاح لـ ${product.name}`);
          chosen = v; variantName = v.name;
        } else if (product.variants.some((v) => v.isActive)) {
          throw new ApiError(400, `اختار الحجم لـ ${product.name}`);
        }
        const unit = computeUnitPrice(
          { basePrice: product.basePrice.toString(), branchPrices: product.branchPrices.map((bp) => ({ branchId: bp.branchId, price: bp.price.toString() })) },
          chosen ? { price: String(chosen.price) } : null,
          branchId
        );
        const allowed = new Map(product.addOns.filter((pa) => pa.addOn.isActive).map((pa) => [pa.addOn.id, pa.addOn]));
        const addOnRows = it.addOnIds.map((aid) => {
          const a = allowed.get(aid);
          if (!a) throw new ApiError(400, `في إضافة مش متاحة لـ ${product.name}`);
          return { addOnId: a.id, addOnName: a.name, price: Number(a.price) };
        });
        const addOnsTotal = addOnRows.reduce((s, a) => s + a.price, 0);
        const lineTotal = round2((unit + addOnsTotal) * it.quantity);
        subtotal = round2(subtotal + lineTotal);
        newRows.push({ productId: product.id, variantId: it.variantId ?? null, productName: product.name, variantName, unitPrice: unit, quantity: it.quantity, lineTotal, notes: it.notes ?? null, addOns: addOnRows });
      }
    }

    const remainingCount = order.items.length - removals.length + newRows.length;
    if (remainingCount === 0) {
      throw new ApiError(400, "لازم يفضل صنف واحد على الأقل — لو عايز تلغي الطلب ارفضه");
    }

    // ── Recharge with the branch's CURRENT tax/service settings ──
    const finSettings = await getBranchFinancialSettings(branchId);
    const charges = computeCharges({
      subtotal, discount: Number(order.discountAmount), orderType: order.type, settings: finSettings,
    });
    const paid = Number(order.paidAmount);
    const remaining = round2(charges.total - paid);

    // Table move detection.
    const newTable = data.tableNumber === undefined ? undefined : (data.tableNumber?.trim() || null);
    const tableChanged = newTable !== undefined && newTable !== (order.tableNumber ?? null);

    await db.$transaction(async (tx) => {
      if (removals.length > 0) await tx.orderItem.deleteMany({ where: { id: { in: removals } } });
      for (const c of lineUpdates) {
        await tx.orderItem.update({ where: { id: c.id }, data: { quantity: c.quantity, lineTotal: c.lineTotal, ...(c.notes !== undefined ? { notes: c.notes } : {}) } });
      }
      for (const row of newRows) {
        await tx.orderItem.create({
          data: {
            orderId: id, productId: row.productId, variantId: row.variantId,
            productName: row.productName, variantName: row.variantName,
            unitPrice: row.unitPrice, quantity: row.quantity, lineTotal: row.lineTotal, notes: row.notes,
            addOns: { create: row.addOns },
          },
        });
      }
      await tx.order.update({
        where: { id },
        data: {
          subtotal: charges.subtotal,
          discountAmount: charges.discountAmount,
          serviceChargeAmount: charges.serviceChargeAmount,
          taxAmount: charges.taxAmount,
          total: charges.total,
          remainingAmount: Math.max(remaining, 0),
          taxRateSnapshot: charges.taxRateSnapshot,
          serviceRateSnapshot: charges.serviceRateSnapshot,
          ...(newTable !== undefined ? { tableNumber: newTable } : {}),
          ...(data.customerName !== undefined ? { customerName: data.customerName } : {}),
          ...(data.notes !== undefined ? { notes: data.notes } : {}),
        },
      });
    });

    // ── Table-session move (dine-in) ──
    const oldSessionId = order.tableSessionId;
    if (tableChanged) {
      if (newTable) {
        await attachOrderToTableSession(
          { id, cafeId: order.cafeId, branchId, type: order.type, tableNumber: newTable, orderNumber: order.orderNumber, customerName: data.customerName ?? order.customerName },
          session.id
        );
      } else if (oldSessionId) {
        await db.order.update({ where: { id }, data: { tableSessionId: null } });
      }
      if (oldSessionId) await recomputeSessionTotals(oldSessionId);
      await audit({
        cafeId: order.cafeId, userId: session.id, action: "QR_ORDER_TABLE_CHANGED_BEFORE_APPROVAL",
        entity: "Order", entityId: id,
        details: { branchId, orderId: id, orderNumber: order.orderNumber, oldValue: order.tableNumber, newValue: newTable },
      });
    } else if (oldSessionId) {
      await recomputeSessionTotals(oldSessionId);
    }

    // ── Granular audits ──
    const base = { cafeId: order.cafeId, userId: session.id, entity: "Order", entityId: id };
    const meta = { branchId, orderId: id, orderNumber: order.orderNumber };
    if (newRows.length > 0) {
      await audit({ ...base, action: "QR_ORDER_ITEM_ADDED_BEFORE_APPROVAL", details: { ...meta, added: newRows.map((r) => ({ name: r.productName, qty: r.quantity })) } });
    }
    if (removals.length > 0) {
      await audit({ ...base, action: "QR_ORDER_ITEM_REMOVED_BEFORE_APPROVAL", details: { ...meta, removedCount: removals.length } });
    }
    const qtyChanges = lineUpdates.filter((c) => order.items.find((i) => i.id === c.id)?.quantity !== c.quantity);
    if (qtyChanges.length > 0) {
      await audit({ ...base, action: "QR_ORDER_ITEM_QUANTITY_CHANGED_BEFORE_APPROVAL", details: { ...meta, changedCount: qtyChanges.length } });
    }
    await audit({
      ...base, action: "QR_ORDER_EDITED_BEFORE_APPROVAL",
      details: { ...meta, removedItems: removals.length, addedItems: newRows.length, changedItems: lineUpdates.length, oldValue: Number(order.total), newValue: charges.total },
    });

    const updated = await db.order.findUnique({
      where: { id },
      include: { items: { include: { addOns: true } }, branch: { select: { id: true, name: true } } },
    });
    return NextResponse.json({ order: updated });
  } catch (error) {
    return handleApiError(error);
  }
}
