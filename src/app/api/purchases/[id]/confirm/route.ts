import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireKey, handleApiError, ApiError, requireFeature } from "@/lib/api";
import { audit } from "@/lib/audit";
import { round2, weightedAverageCost } from "@/lib/purchases";

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
        const item = await tx.inventoryItem.findUnique({
          where: { id: line.inventoryItemId },
          select: { id: true, currentStock: true, costPerUnit: true },
        });
        if (!item) throw new ApiError(400, "خامة غير موجودة");

        const qty = Number(line.quantity);
        const unitCost = Number(line.unitCost);
        const oldStock = Number(item.currentStock);
        const newStock = round2(oldStock + qty);
        const newCost = weightedAverageCost(oldStock, Number(item.costPerUnit), qty, unitCost);

        await tx.inventoryTransaction.create({
          data: {
            cafeId: inv.cafeId,
            branchId: inv.branchId,
            inventoryItemId: item.id,
            type: "PURCHASE",
            quantity: qty, // positive delta
            unitCost,
            totalCost: Number(line.totalCost),
            note: `إضافة من فاتورة شراء رقم ${inv.invoiceNumber}`,
            createdById: session.id,
          },
        });
        await tx.inventoryItem.update({
          where: { id: item.id },
          data: { currentStock: newStock, costPerUnit: newCost },
        });
        adds.push({ itemId: item.id, qty, newStock, newCost });
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
