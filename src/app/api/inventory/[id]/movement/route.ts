import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireKey, handleApiError, ApiError } from "@/lib/api";
import { audit } from "@/lib/audit";
import { round2, signedDelta, TXN_AUDIT_ACTION } from "@/lib/inventory";
import { applyStockMutation } from "@/lib/ledger";
import { publicInventoryItem } from "@/lib/public-shape";
import { round3 } from "@/lib/costing";
import { findScopedItem } from "../route";

type Params = { params: Promise<{ id: string }> };

// Manual stock movements. TRANSFER_IN/OUT are excluded here — those only
// happen through /api/inventory/transfer so both branches stay in sync.
const movementSchema = z.object({
  type: z.enum(["PURCHASE", "USAGE", "WASTE", "ADJUSTMENT", "RETURN"]),
  quantity: z.number({ message: "الكمية يجب أن تكون رقم" }),
  unitCost: z.number().min(0).optional(),
  note: z.string().max(500).optional(),
});

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const session = await requireKey("inventory.transactions");
    const { id } = await params;
    const item = await findScopedItem(id, session);
    const data = movementSchema.parse(await request.json());

    // ADJUSTMENT may be ±; everything else must be a positive amount.
    if (data.type !== "ADJUSTMENT" && data.quantity <= 0) {
      throw new ApiError(400, "الكمية لازم تكون أكبر من صفر");
    }
    if (data.type === "ADJUSTMENT" && data.quantity === 0) {
      throw new ApiError(400, "التسوية لازم تكون بقيمة موجبة أو سالبة");
    }

    const delta = round3(signedDelta(data.type, data.quantity));
    const current = Number(item.currentStock);
    const newStock = round3(current + delta);
    if (newStock < 0) {
      throw new ApiError(400, "لا توجد كمية كافية في المخزون");
    }

    // Value the movement: purchases use the entered cost (or current),
    // consumption (usage/waste) is valued at the item's cost so waste
    // reports are meaningful. Adjustments/returns follow any given cost.
    const unitCost =
      data.unitCost ??
      (data.type === "PURCHASE" || data.type === "USAGE" || data.type === "WASTE"
        ? Number(item.costPerUnit)
        : undefined);
    const totalCost =
      unitCost !== undefined ? round2(Math.abs(delta) * unitCost) : null;

    // Interactive form, not the array form this route used to use: an array
    // `$transaction` cannot hold `SELECT … FOR UPDATE` across statements, so
    // it could never satisfy the ledger contract.
    const updated = await db.$transaction(async (tx) => {
      await applyStockMutation(tx, {
        inventoryItemId: id,
        cafeId: item.cafeId,
        branchId: item.branchId,
        type: data.type,
        quantity: delta,
        unitCost: unitCost ?? null,
        totalCost,
        note: data.note || null,
        createdById: session.id,
        // A purchase refreshes the reference cost per unit.
        newCostPerUnit:
          data.type === "PURCHASE" && data.unitCost !== undefined ? data.unitCost : null,
        insufficientMessage: "لا توجد كمية كافية في المخزون",
      });
      return tx.inventoryItem.findUniqueOrThrow({ where: { id } });
    });

    await audit({
      cafeId: item.cafeId,
      userId: session.id,
      action: TXN_AUDIT_ACTION[data.type],
      entity: "InventoryItem",
      entityId: id,
      details: {
        name: item.name,
        branchId: item.branchId,
        type: data.type,
        quantity: delta,
        oldStock: current,
        newStock,
      },
    });

    return NextResponse.json({ item: publicInventoryItem(updated) });
  } catch (error) {
    return handleApiError(error);
  }
}
