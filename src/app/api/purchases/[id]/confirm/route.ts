import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireKey, handleApiError, ApiError, requireFeature } from "@/lib/api";
import { audit } from "@/lib/audit";
import { weightedAverageCost } from "@/lib/purchases";
import { applyStockMutation, lockItemForUpdate } from "@/lib/ledger";

type Params = { params: Promise<{ id: string }> };

// POST /api/purchases/[id]/confirm — confirm a DRAFT invoice: add each item's
// quantity to inventory, create a PURCHASE transaction, and roll the item's
// costPerUnit forward with a weighted average. Idempotent via confirmedAt.
export async function POST(_request: NextRequest, { params }: Params) {
  try {
    const session = await requireKey("purchases.confirm");
    await requireFeature(session, "inventoryEnabled");
    await requireFeature(session, "purchasesEnabled");
    const { id } = await params;

    const inv = await db.purchaseInvoice.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!inv) throw new ApiError(404, "الفاتورة غير موجودة");
    if (session.role !== "SUPER_ADMIN" && inv.cafeId !== session.cafeId) {
      throw new ApiError(403, "ليس لديك صلاحية لتنفيذ هذا الإجراء");
    }
    if (session.branchId && inv.branchId !== session.branchId) {
      throw new ApiError(403, "الفاتورة تبع فرع تاني");
    }
    // Double-add guard.
    if (inv.status === "CONFIRMED" || inv.confirmedAt) {
      throw new ApiError(400, "الفاتورة مؤكدة بالفعل");
    }
    if (inv.status === "CANCELLED") throw new ApiError(400, "الفاتورة ملغية");
    if (inv.items.length === 0) throw new ApiError(400, "الفاتورة لا تحتوي على أصناف");

    const now = new Date();
    // Everything in one transaction: stock rows + item updates + confirm flag.
    const stockAdds = await db.$transaction(async (tx) => {
      const adds: { itemId: string; qty: number; newStock: number; newCost: number }[] = [];
      for (const line of inv.items) {
        // The locked read replaces a plain findUnique: the balance this
        // arithmetic is based on must be the one nothing else can move
        // until this transaction commits.
        const locked = await lockItemForUpdate(tx, line.inventoryItemId).catch(() => null);
        if (!locked) throw new ApiError(400, "خامة غير موجودة");

        const qty = Number(line.quantity);
        const unitCost = Number(line.unitCost);
        const oldStock = locked.currentStock;
        const newCost = weightedAverageCost(oldStock, locked.costPerUnit, qty, unitCost);

        // Previously `round2(oldStock + qty)` — two decimals on a
        // Decimal(12,3) column, so an 18 g receipt landed as 20 g and
        // invented coffee nobody delivered. The guarded writer is round3
        // throughout, which is what the column was widened for.
        const applied = await applyStockMutation(tx, {
          inventoryItemId: line.inventoryItemId,
          cafeId: inv.cafeId,
          branchId: inv.branchId,
          type: "PURCHASE",
          quantity: qty, // positive delta
          unitCost,
          totalCost: Number(line.totalCost),
          note: `إضافة من فاتورة شراء رقم ${inv.invoiceNumber}`,
          createdById: session.id,
          newCostPerUnit: newCost,
        });

        adds.push({
          itemId: line.inventoryItemId, qty, newStock: applied.stockAfter, newCost,
        });
      }

      await tx.purchaseInvoice.update({
        where: { id },
        data: { status: "CONFIRMED", confirmedAt: now },
      });
      return adds;
    });

    await audit({
      cafeId: inv.cafeId, userId: session.id, action: "PURCHASE_INVOICE_CONFIRMED",
      entity: "PurchaseInvoice", entityId: id,
      details: { branchId: inv.branchId, purchaseInvoiceId: id, invoiceNumber: inv.invoiceNumber, itemCount: inv.items.length, oldValue: "DRAFT", newValue: "CONFIRMED" },
    });
    for (const a of stockAdds) {
      await audit({
        cafeId: inv.cafeId, userId: session.id, action: "PURCHASE_STOCK_ADDED",
        entity: "InventoryItem", entityId: a.itemId,
        details: { branchId: inv.branchId, purchaseInvoiceId: id, inventoryItemId: a.itemId, quantity: a.qty, newStock: a.newStock, newCostPerUnit: a.newCost },
      });
    }

    return NextResponse.json({ ok: true, itemsAdded: stockAdds.length });
  } catch (error) {
    return handleApiError(error);
  }
}
