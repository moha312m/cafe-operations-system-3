import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireKey, handleApiError, ApiError, requireFeature } from "@/lib/api";
import type { Prisma } from "@prisma/client";
import { auditInTransaction } from "@/lib/audit";
import { weightedAverageCost } from "@/lib/purchases";
import { PurchaseArithmeticError, purchaseLine, purchaseAmount, purchaseStockAfter } from "@/lib/purchase-arithmetic";
import { applyStockMutation, lockItemForUpdate, MissingInventoryItemError } from "@/lib/ledger";
import { acquireInventorySharedLocks } from "@/lib/inventory-freeze";
import { protectedTransaction } from "@/lib/protected-transaction";
import { lockPurchaseInvoice } from "@/lib/transaction-locks";

type Params = { params: Promise<{ id: string }> };

// Only a row that is genuinely absent is a missing item. A lock timeout or
// deadlock is contention, and stays one.
async function lockLineItem(tx: Prisma.TransactionClient, inventoryItemId: string) {
  try {
    return await lockItemForUpdate(tx, inventoryItemId);
  } catch (error) {
    if (error instanceof MissingInventoryItemError) throw new ApiError(400, "خامة غير موجودة");
    throw error;
  }
}

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
    // Everything in one transaction: stock rows + item updates + confirm flag
    // + both audit actions. Lock order: branch freeze gate, invoice, then
    // every distinct item in ID order.
    const stockAdds = await protectedTransaction(async (tx) => {
      const adds: { itemId: string; qty: number; newStock: number; newCost: number }[] = [];
      await acquireInventorySharedLocks(tx, [inv.branchId]);
      await lockPurchaseInvoice(tx, id);
      // A draft edit may have committed while confirmation waited for this
      // lock. Use its stored lines and totals, never the earlier pre-check.
      const current = await tx.purchaseInvoice.findUniqueOrThrow({ where: { id }, include: { items: true } });
      // Claim under the invoice row lock before touching stock. A concurrent
      // confirmation rechecks this predicate after the first transaction ends.
      const claimed = await tx.purchaseInvoice.updateMany({
        where: { id, status: "DRAFT", confirmedAt: null },
        data: { status: "CONFIRMED", confirmedAt: now },
      });
      if (claimed.count !== 1) throw new ApiError(400, "الفاتورة لم تعد مسودة متاحة للتأكيد");
      // Two invoices sharing items lock them in one order, so they cannot
      // deadlock. Lines are still processed one by one, in invoice order.
      for (const itemId of [...new Set(current.items.map((line) => line.inventoryItemId))].sort()) {
        await lockLineItem(tx, itemId);
      }
      for (const line of current.items) {
        // Re-read under the lock already held: a duplicate line sees the
        // balance and cost the previous line just wrote.
        const locked = await lockLineItem(tx, line.inventoryItemId);

        const { quantity: qty, unitCost } = purchaseLine(Number(line.quantity), Number(line.unitCost));
        const totalCost = purchaseAmount(Number(line.totalCost));
        const oldStock = locked.currentStock;
        const newCost = weightedAverageCost(oldStock, locked.costPerUnitExact, qty, unitCost);
        purchaseStockAfter(oldStock, qty); // refuse column overflow before any write

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
          totalCost,
          note: `إضافة من فاتورة شراء رقم ${inv.invoiceNumber}`,
          createdById: session.id,
          newCostPerUnit: newCost,
        });

        adds.push({
          itemId: line.inventoryItemId, qty, newStock: applied.stockAfter, newCost,
        });
      }

      // The audit rows are part of the confirmation: if either cannot be
      // written, the stock, cost and claim roll back with it.
      await auditInTransaction(tx, {
        cafeId: inv.cafeId, userId: session.id, action: "PURCHASE_INVOICE_CONFIRMED",
        entity: "PurchaseInvoice", entityId: id,
        details: { branchId: inv.branchId, purchaseInvoiceId: id, invoiceNumber: inv.invoiceNumber, itemCount: current.items.length, oldValue: "DRAFT", newValue: "CONFIRMED" },
      });
      for (const a of adds) {
        await auditInTransaction(tx, {
          cafeId: inv.cafeId, userId: session.id, action: "PURCHASE_STOCK_ADDED",
          entity: "InventoryItem", entityId: a.itemId,
          details: { branchId: inv.branchId, purchaseInvoiceId: id, inventoryItemId: a.itemId, quantity: a.qty, newStock: a.newStock, newCostPerUnit: a.newCost },
        });
      }

      return adds;
    }, { cafeId: inv.cafeId, branchId: inv.branchId });

    return NextResponse.json({ ok: true, itemsAdded: stockAdds.length });
  } catch (error) {
    if (error instanceof PurchaseArithmeticError) return handleApiError(new ApiError(400, error.message));
    return handleApiError(error);
  }
}
