import { protectedTransaction } from "@/lib/protected-transaction";
import { acquireInventorySharedLocks } from "@/lib/inventory-freeze";
import { lockItemForUpdate } from "@/lib/ledger";
import { assertFinishedStockEditable } from "@/lib/finished-stock-history";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requirePermission, handleApiError } from "@/lib/api";
import { audit } from "@/lib/audit";
import { publicInventoryItem } from "@/lib/public-shape";
import { findScopedItem } from "@/lib/inventory-scope";
import type { Prisma } from "@prisma/client";

type Params = { params: Promise<{ id: string }> };

const updateSchema = z.object({
  name: z.string().min(1, "اسم الخامة مطلوب").optional(),
  category: z.string().nullable().optional(),
  unit: z.enum(["GRAM", "KG", "ML", "LITER", "PIECE", "BOX", "BAG"]).optional(),
  minimumStock: z.number().min(0).optional(),
  costPerUnit: z.number().min(0).optional(),
  supplierName: z.string().nullable().optional(),
  expiryDate: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
  archived: z.boolean().optional(),
});

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const session = await requirePermission("inventory:manage");
    const { id } = await params;
    const item = await findScopedItem(id, session);
    const data = updateSchema.parse(await request.json());

    // Stock quantity is NEVER edited here — only through movements — so the
    // ledger stays the single source of truth for currentStock.
    const update: Prisma.InventoryItemUpdateInput = {};
    if (data.name !== undefined) update.name = data.name;
    if (data.category !== undefined) update.category = data.category;
    if (data.unit !== undefined) update.unit = data.unit;
    if (data.minimumStock !== undefined) update.minimumStock = data.minimumStock;
    if (data.costPerUnit !== undefined) update.costPerUnit = data.costPerUnit;
    if (data.supplierName !== undefined) update.supplierName = data.supplierName;
    if (data.expiryDate !== undefined) {
      update.expiryDate = data.expiryDate ? new Date(data.expiryDate) : null;
    }
    if (data.isActive !== undefined) update.isActive = data.isActive;
    if (data.archived === true) {
      update.archivedAt = new Date();
      update.isActive = false;
    } else if (data.archived === false) {
      update.archivedAt = null;
    }

    const updated = await protectedTransaction(async tx => {
      await acquireInventorySharedLocks(tx, [item.branchId]);
      const locked = await lockItemForUpdate(tx, id);
      await assertFinishedStockEditable(tx, id, { retire: data.archived === true || data.isActive === false, changingUnit: data.unit !== undefined && data.unit !== locked.unit });
      return tx.inventoryItem.update({ where: { id }, data: update });
    }, { cafeId: item.cafeId, branchId: item.branchId });

    await audit({
      cafeId: item.cafeId,
      userId: session.id,
      action: data.archived === true ? "INVENTORY_ITEM_ARCHIVED" : "INVENTORY_ITEM_UPDATED",
      entity: "InventoryItem",
      entityId: id,
      details: { name: updated.name, branchId: item.branchId },
    });

    return NextResponse.json({ item: publicInventoryItem(updated) });
  } catch (error) {
    return handleApiError(error);
  }
}

// Soft delete (archive) — never hard-delete, to keep ledger history.
export async function DELETE(_request: NextRequest, { params }: Params) {
  try {
    const session = await requirePermission("inventory:manage");
    const { id } = await params;
    const item = await findScopedItem(id, session);

    await protectedTransaction(async tx => {
      await acquireInventorySharedLocks(tx, [item.branchId]);
      await lockItemForUpdate(tx, id);
      await assertFinishedStockEditable(tx, id, { retire: true });
      await tx.inventoryItem.update({ where: { id }, data: { archivedAt: new Date(), isActive: false } });
    }, { cafeId: item.cafeId, branchId: item.branchId });

    await audit({
      cafeId: item.cafeId,
      userId: session.id,
      action: "INVENTORY_ITEM_ARCHIVED",
      entity: "InventoryItem",
      entityId: id,
      details: { name: item.name, branchId: item.branchId },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleApiError(error);
  }
}
