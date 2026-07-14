import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requirePermission, handleApiError, ApiError } from "@/lib/api";
import { audit } from "@/lib/audit";
import type { SessionUser } from "@/lib/auth";
import type { Prisma } from "@prisma/client";

type Params = { params: Promise<{ id: string }> };

// Loads an item and enforces cafe + branch scope in one place.
export async function findScopedItem(id: string, session: SessionUser) {
  const item = await db.inventoryItem.findUnique({ where: { id } });
  if (!item) throw new ApiError(404, "الخامة مش موجودة");
  if (session.role !== "SUPER_ADMIN" && item.cafeId !== session.cafeId) {
    throw new ApiError(403, "ليس لديك صلاحية لتنفيذ هذا الإجراء");
  }
  if (session.branchId && item.branchId !== session.branchId) {
    throw new ApiError(403, "ليس لديك صلاحية على فرع تاني");
  }
  return item;
}

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

    const updated = await db.inventoryItem.update({ where: { id }, data: update });

    await audit({
      cafeId: item.cafeId,
      userId: session.id,
      action: data.archived === true ? "INVENTORY_ITEM_ARCHIVED" : "INVENTORY_ITEM_UPDATED",
      entity: "InventoryItem",
      entityId: id,
      details: { name: updated.name, branchId: item.branchId },
    });

    return NextResponse.json({ item: updated });
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

    await db.inventoryItem.update({
      where: { id },
      data: { archivedAt: new Date(), isActive: false },
    });

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
