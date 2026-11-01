import { provisionalConsumption, validateProvisionalFinishedSales } from "@/lib/sale-consumption";
import { decimal, money, sumMoney, moneyMax, type Decimal } from "@/lib/money";
import { protectedTransaction } from "@/lib/protected-transaction";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { Prisma, type ProductStockMode } from "@prisma/client";
import { db } from "@/lib/db";
import { requirePermission, handleApiError, ApiError, requireActiveSession, resolveReadScope } from "@/lib/api";
import { auditInTransaction } from "@/lib/audit";
import { resolvePermissions } from "@/lib/perms/effective";
import { canApproveOrder, getApprovalSettings } from "@/lib/qr-approval";
import { recomputeSessionTotals, attachOrderToTableSession } from "@/lib/table-sessions";
import { unitPriceExact as computeUnitPrice } from "@/lib/pricing";
import { getBranchFinancialSettings, computeChargesExact as computeCharges } from "@/lib/financials";

import { lockOrders, lockOrderPayments, lockTableSessions, lockBranchAllocator } from "@/lib/transaction-locks";


type Params = { params: Promise<{ id: string }> };



export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const session = await requirePermission("orders:read");
    const { id } = await params;
    const order = await db.order.findFirst({
      where: { id, ...resolveReadScope(session) },
      include: {
        items: { include: { addOns: true } },
        payments: { include: { receivedBy: { select: { name: true } } } },
        branch: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true } },
      },
    });
    if (!order) throw new ApiError(404, "الطلب مش موجود");
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
    const session = await requireActiveSession();
    const { id } = await params;
    const data = editSchema.parse(await request.json());

    const { keys } = await resolvePermissions(session);
    return await protectedTransaction(async (tx) => {
      const candidate = await tx.order.findFirst({ where: { id, ...resolveReadScope(session) }, select: { branchId: true } });
      if (!candidate) throw new ApiError(404, "Order not found");
      // Serialize table attachment with POS/QR creation, allowing FK readers.
      await lockBranchAllocator(tx, candidate.branchId);
      await lockOrders(tx, [id]);
      await lockOrderPayments(tx, [id]);
      const order = await tx.order.findFirst({
        where: { id, ...resolveReadScope(session) },
        include: { items: { include: { addOns: true } }, cafe: true },
      });
      if (!order) throw new ApiError(404, "الطلب مش موجود");
      // Editable only while still pending approval.
      if (order.status !== "PENDING_WAITER_APPROVAL" || order.approvalStatus === "APPROVED" || order.approvalStatus === "REJECTED") {
        throw new ApiError(400, "لا يمكن تعديل الطلب بعد دخوله مرحلة التحضير");
      }
      // Must be an authorized approver of THIS order and hold the edit key.
      const isManager = session.role === "CAFE_OWNER" || session.role === "BRANCH_MANAGER";
      if (!canApproveOrder(session, order, keys.has("qr_orders.approve")) || !keys.has("qr_orders.edit_before_approval")) {
        throw new ApiError(403, "ليس لديك صلاحية لتعديل هذا الطلب");
      }
      const appr = await getApprovalSettings(order.cafeId, order.branchId, tx);
      if (!appr.allowApproverToEditOrder && !isManager) {
        throw new ApiError(403, "تعديل الطلب غير مسموح في إعدادات هذا الفرع");
      }

      const branchId = order.branchId;
      const changes = new Map((data.items ?? []).map((i) => [i.id, i]));

      // ── Existing lines: keep price snapshot, apply new quantity / notes ──
      let subtotal = decimal(0);
      const lineUpdates: { id: string; quantity: number; lineTotal: Decimal; notes?: string | null }[] = [];
      const removals: string[] = [];
      for (const item of order.items) {
        const change = changes.get(item.id);
        const quantity = change?.quantity ?? item.quantity;
        if (quantity === 0) { removals.push(item.id); continue; }
        const perUnit = decimal(item.unitPrice).plus(sumMoney(item.addOns.map(a => a.price)));
        const lineTotal = money(perUnit.times(quantity));
        subtotal = money(subtotal.plus(lineTotal));
        const noteChanged = change && change.notes !== undefined && change.notes !== item.notes;
        if (quantity !== item.quantity || noteChanged) {
          lineUpdates.push({ id: item.id, quantity, lineTotal, notes: noteChanged ? (change!.notes ?? null) : undefined });
        }
      }

      // ── New lines: priced from the current menu (branch-aware) ──
      type NewRow = { productId: string; stockModeSnapshot: ProductStockMode; variantId: string | null; productName: string; variantName: string | null; unitPrice: Decimal; quantity: number; lineTotal: Decimal; notes: string | null; addOns: { addOnId: string; addOnName: string; price: Decimal }[] };
      const newRows: NewRow[] = [];
      if (data.newItems && data.newItems.length > 0) {
        const ids = [...new Set(data.newItems.map((i) => i.productId))].sort();
        await tx.$queryRaw`SELECT "id" FROM "Product" WHERE "cafeId"=${order.cafeId} AND "id" IN (${Prisma.join(ids)}) ORDER BY "id" FOR SHARE`;
        const products = await tx.product.findMany({
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
            return { addOnId: a.id, addOnName: a.name, price: decimal(a.price) };
          });
          const addOnsTotal = sumMoney(addOnRows.map(a => a.price));
          const lineTotal = money(unit.plus(addOnsTotal).times(it.quantity));
          subtotal = money(subtotal.plus(lineTotal));
          newRows.push({ productId: product.id, stockModeSnapshot: product.stockMode, variantId: it.variantId ?? null, productName: product.name, variantName, unitPrice: unit, quantity: it.quantity, lineTotal, notes: it.notes ?? null, addOns: addOnRows });
        }
      }

      await validateProvisionalFinishedSales(tx, { cafeId: order.cafeId, branchId }, newRows);
      const remainingCount = order.items.length - removals.length + newRows.length;
      if (remainingCount === 0) {
        throw new ApiError(400, "لازم يفضل صنف واحد على الأقل — لو عايز تلغي الطلب ارفضه");
      }

      // ── Recharge with the branch's CURRENT tax/service settings ──
      const finSettings = await getBranchFinancialSettings(branchId, tx);
      const charges = computeCharges({
        subtotal, discount: order.discountAmount, orderType: order.type, settings: finSettings,
      });
      const paid = decimal(order.paidAmount);
      const remaining = money(charges.total.minus(paid));

      // Table move detection.
      const newTable = data.tableNumber === undefined ? undefined : (data.tableNumber?.trim() || null);
      const tableChanged = newTable !== undefined && newTable !== (order.tableNumber ?? null);

      const targetSession = tableChanged && newTable
        ? await tx.tableSession.findFirst({ where: { cafeId: order.cafeId, branchId, tableNumber: newTable, status: "OPEN" }, select: { id: true } })
        : null;
      const sessionIds = [...new Set([order.tableSessionId, targetSession?.id].filter((value): value is string => !!value))].sort();
      await lockTableSessions(tx, sessionIds);

      if (removals.length > 0) await tx.orderItem.deleteMany({ where: { id: { in: removals } } });
      for (const c of lineUpdates) {
        await tx.orderItem.update({ where: { id: c.id }, data: { quantity: c.quantity, lineTotal: c.lineTotal, ...(c.notes !== undefined ? { notes: c.notes } : {}) } });
      }
      for (const row of newRows) {
        await tx.orderItem.create({
          data: {
            ...provisionalConsumption({ id: row.productId, stockMode: row.stockModeSnapshot }, row.variantId),
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
          remainingAmount: moneyMax(remaining, 0),
          taxRateSnapshot: charges.taxRateSnapshot,
          serviceRateSnapshot: charges.serviceRateSnapshot,
          ...(newTable !== undefined ? { tableNumber: newTable } : {}),
          ...(data.customerName !== undefined ? { customerName: data.customerName } : {}),
          ...(data.notes !== undefined ? { notes: data.notes } : {}),
        },
      });
      // ── Table-session move (dine-in) ──
      const oldSessionId = order.tableSessionId;
      if (tableChanged) {
        if (newTable) {
          await attachOrderToTableSession(
            { id, cafeId: order.cafeId, branchId, type: order.type, tableNumber: newTable, orderNumber: order.orderNumber, customerName: data.customerName ?? order.customerName },
            session.id, tx
          );
        } else if (oldSessionId) {
          await tx.order.update({ where: { id }, data: { tableSessionId: null } });
        }
        if (oldSessionId) await recomputeSessionTotals(oldSessionId, tx);
        await auditInTransaction(tx, {
          cafeId: order.cafeId, userId: session.id, action: "QR_ORDER_TABLE_CHANGED_BEFORE_APPROVAL",
          entity: "Order", entityId: id,
          details: { branchId, orderId: id, orderNumber: order.orderNumber, oldValue: order.tableNumber, newValue: newTable },
        });
      } else if (oldSessionId) {
        await recomputeSessionTotals(oldSessionId, tx);
      }

      // ── Granular audits ──
      const base = { cafeId: order.cafeId, userId: session.id, entity: "Order", entityId: id };
      const meta = { branchId, orderId: id, orderNumber: order.orderNumber };
      if (newRows.length > 0) {
        await auditInTransaction(tx, { ...base, action: "QR_ORDER_ITEM_ADDED_BEFORE_APPROVAL", details: { ...meta, added: newRows.map((r) => ({ name: r.productName, qty: r.quantity })) } });
      }
      if (removals.length > 0) {
        await auditInTransaction(tx, { ...base, action: "QR_ORDER_ITEM_REMOVED_BEFORE_APPROVAL", details: { ...meta, removedCount: removals.length } });
      }
      const qtyChanges = lineUpdates.filter((c) => order.items.find((i) => i.id === c.id)?.quantity !== c.quantity);
      if (qtyChanges.length > 0) {
        await auditInTransaction(tx, { ...base, action: "QR_ORDER_ITEM_QUANTITY_CHANGED_BEFORE_APPROVAL", details: { ...meta, changedCount: qtyChanges.length } });
      }
      await auditInTransaction(tx, {
        ...base, action: "QR_ORDER_EDITED_BEFORE_APPROVAL",
        details: { ...meta, removedItems: removals.length, addedItems: newRows.length, changedItems: lineUpdates.length, oldValue: Number(order.total), newValue: charges.total },
      });

      const updated = await tx.order.findUnique({
        where: { id },
        include: { items: { include: { addOns: true } }, branch: { select: { id: true, name: true } } },
      });
      return NextResponse.json({ order: updated });
    }, resolveReadScope(session));
  } catch (error) {
    return handleApiError(error);
  }
}
