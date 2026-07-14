import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  requirePermission,
  resolveCafeId,
  handleApiError,
  ApiError,
} from "@/lib/api";
import { audit } from "@/lib/audit";
import { round2 } from "@/lib/inventory";

const transferSchema = z.object({
  inventoryItemId: z.string(), // the source-branch item being transferred
  toBranchId: z.string(),
  quantity: z.number().positive("الكمية لازم تكون أكبر من صفر"),
  note: z.string().max(500).optional(),
  cafeId: z.string().optional(),
});

// Transfer stock from the item's branch to another branch of the same
// cafe. Creates TRANSFER_OUT (source) + TRANSFER_IN (destination) and
// keeps both item balances in sync. The destination item is matched by
// (name, unit) or created if missing.
export async function POST(request: NextRequest) {
  try {
    const session = await requirePermission("inventory:manage");
    const data = transferSchema.parse(await request.json());
    const cafeId = resolveCafeId(session, data.cafeId);

    const source = await db.inventoryItem.findUnique({
      where: { id: data.inventoryItemId },
    });
    if (!source || source.cafeId !== cafeId) {
      throw new ApiError(404, "الخامة مش موجودة");
    }
    // Branch-pinned staff may only send FROM their own branch.
    if (session.branchId && source.branchId !== session.branchId) {
      throw new ApiError(403, "ليس لديك صلاحية على فرع تاني");
    }
    if (data.toBranchId === source.branchId) {
      throw new ApiError(400, "الفرع المستلم لازم يكون مختلف عن المصدر");
    }
    const toBranch = await db.branch.findFirst({
      where: { id: data.toBranchId, cafeId },
    });
    if (!toBranch) throw new ApiError(400, "الفرع المستلم مش موجود");

    const qty = round2(data.quantity);
    if (Number(source.currentStock) < qty) {
      throw new ApiError(400, "لا توجد كمية كافية للتحويل");
    }

    await db.$transaction(async (tx) => {
      // Source: decrement + TRANSFER_OUT
      await tx.inventoryItem.update({
        where: { id: source.id },
        data: { currentStock: round2(Number(source.currentStock) - qty) },
      });
      await tx.inventoryTransaction.create({
        data: {
          cafeId,
          branchId: source.branchId,
          inventoryItemId: source.id,
          type: "TRANSFER_OUT",
          quantity: -qty,
          unitCost: source.costPerUnit,
          totalCost: round2(qty * Number(source.costPerUnit)),
          note: `تحويل لفرع ${toBranch.name}${data.note ? ` — ${data.note}` : ""}`,
          createdById: session.id,
        },
      });

      // Destination: find matching item or create one, then increment + TRANSFER_IN
      let dest = await tx.inventoryItem.findFirst({
        where: {
          cafeId,
          branchId: data.toBranchId,
          name: source.name,
          unit: source.unit,
          archivedAt: null,
        },
      });
      if (!dest) {
        dest = await tx.inventoryItem.create({
          data: {
            cafeId,
            branchId: data.toBranchId,
            name: source.name,
            category: source.category,
            unit: source.unit,
            currentStock: 0,
            minimumStock: source.minimumStock,
            costPerUnit: source.costPerUnit,
            supplierName: source.supplierName,
          },
        });
      }
      await tx.inventoryItem.update({
        where: { id: dest.id },
        data: { currentStock: round2(Number(dest.currentStock) + qty) },
      });
      await tx.inventoryTransaction.create({
        data: {
          cafeId,
          branchId: data.toBranchId,
          inventoryItemId: dest.id,
          type: "TRANSFER_IN",
          quantity: qty,
          unitCost: source.costPerUnit,
          totalCost: round2(qty * Number(source.costPerUnit)),
          note: `تحويل من فرع ${(await tx.branch.findUnique({ where: { id: source.branchId } }))?.name ?? ""}${data.note ? ` — ${data.note}` : ""}`,
          createdById: session.id,
        },
      });
    });

    await audit({
      cafeId,
      userId: session.id,
      action: "INVENTORY_TRANSFERRED",
      entity: "InventoryItem",
      entityId: source.id,
      details: {
        name: source.name,
        quantity: qty,
        fromBranchId: source.branchId,
        toBranchId: data.toBranchId,
      },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleApiError(error);
  }
}
