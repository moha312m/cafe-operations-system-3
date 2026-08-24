import type { Prisma, PrismaClient } from "@prisma/client";
import { audit } from "@/lib/audit";
import { round2, round3 } from "@/lib/costing";
import { theoreticalConsumption } from "@/lib/recipes";

type Tx = Prisma.TransactionClient | PrismaClient;

export class StockError extends Error {}

// Deduct all recipe ingredients for an order when it becomes SERVED.
//
// Guarantees:
//  • runs inside a transaction (atomic: all-or-nothing)
//  • double-deduction guarded by Order.stockDeductedAt
//  • products without a recipe are skipped (audited, never block serving)
//  • insufficient stock throws unless the cafe allows negative stock
//  • one USAGE InventoryTransaction per ingredient, tagged with orderId
//
// Returns a summary; the caller sets stockDeductedAt and writes the
// order-level audit.
export async function deductStockForOrder(
  tx: Tx,
  orderId: string,
  userId: string | null
): Promise<{
  deducted: { name: string; quantity: number }[];
  productsWithoutRecipe: string[];
}> {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    include: {
      cafe: { select: { allowNegativeStock: true } },
      // variantId and the chosen add-ons decide what was actually made: a
      // large latte is not a small one, and an extra shot is more beans.
      items: {
        select: {
          productId: true, variantId: true, productName: true, variantName: true,
          quantity: true, addOns: { select: { addOnId: true } },
        },
      },
    },
  });
  if (!order) throw new StockError("الطلب مش موجود");
  if (order.stockDeductedAt) {
    throw new StockError("تم خصم المخزون لهذا الطلب من قبل");
  }

  const branchId = order.branchId;
  const cafeId = order.cafeId;
  const allowNegative = order.cafe.allowNegativeStock;

  // What each line theoretically consumes, resolved from the exact sold
  // configuration — product, size, and add-ons — rather than from the product
  // alone. Recipes name cafe-level inventory items; stock comes off the
  // ORDER'S BRANCH copy, matched by name+unit.
  const productsWithoutRecipe: string[] = [];
  const need = new Map<string, { name: string; unit: string; qty: number }>();

  for (const item of order.items) {
    if (!item.productId) continue;
    const consumption = await theoreticalConsumption({
      productId: item.productId,
      variantId: item.variantId ?? null,
      addOnIds: item.addOns.map((a) => a.addOnId).filter(Boolean) as string[],
      quantity: item.quantity,
    });

    // A configuration we cannot resolve is recorded and skipped, exactly as
    // before: an unconfigured recipe must never stop a customer being served.
    // It is reported so the gap is visible rather than silently absorbed.
    if (consumption.lines.length === 0) {
      const label = item.variantName ? `${item.productName} (${item.variantName})` : item.productName;
      if (!productsWithoutRecipe.includes(label)) productsWithoutRecipe.push(label);
      continue;
    }

    for (const line of consumption.lines) {
      const cafeItem = await tx.inventoryItem.findUnique({ where: { id: line.inventoryItemId } });
      if (!cafeItem) continue;
      const branchItem = await tx.inventoryItem.findFirst({
        where: {
          cafeId, branchId, name: cafeItem.name, unit: cafeItem.unit, archivedAt: null,
        },
      });
      if (!branchItem) {
        if (!allowNegative) {
          throw new StockError(`الخامة «${cafeItem.name}» غير متوفرة في الفرع`);
        }
        continue;
      }
      const cur = need.get(branchItem.id);
      if (cur) cur.qty = round3(cur.qty + line.quantityInStockUnit);
      else need.set(branchItem.id, {
        name: branchItem.name, unit: branchItem.unit, qty: line.quantityInStockUnit,
      });
    }
  }

  // Verify sufficiency first (unless negative allowed), then apply.
  const deducted: { name: string; quantity: number }[] = [];
  for (const [itemId, req] of need) {
    const item = await tx.inventoryItem.findUnique({ where: { id: itemId } });
    if (!item) continue;
    const after = round3(Number(item.currentStock) - req.qty);
    if (after < 0 && !allowNegative) {
      throw new StockError(
        `لا توجد كمية كافية من الخامة «${req.name}» (المتاح ${Number(item.currentStock)}، المطلوب ${req.qty})`
      );
    }
    await tx.inventoryItem.update({
      where: { id: itemId },
      data: { currentStock: after },
    });
    await tx.inventoryTransaction.create({
      data: {
        cafeId,
        branchId,
        inventoryItemId: itemId,
        orderId,
        type: "USAGE",
        quantity: -req.qty,
        unitCost: item.costPerUnit,
        totalCost: round2(req.qty * Number(item.costPerUnit)),
        note: `خصم تلقائي بسبب الطلب رقم ${order.orderNumber}`,
        createdById: userId,
      },
    });
    deducted.push({ name: req.name, quantity: req.qty });
  }

  return { deducted, productsWithoutRecipe };
}

// Post-transaction audit writes (called after commit).
export async function auditDeduction(
  cafeId: string,
  branchId: string,
  userId: string | null,
  orderId: string,
  orderNumber: number,
  result: { deducted: { name: string; quantity: number }[]; productsWithoutRecipe: string[] }
) {
  if (result.deducted.length > 0) {
    await audit({
      cafeId,
      userId,
      action: "STOCK_DEDUCTED_FOR_ORDER",
      entity: "Order",
      entityId: orderId,
      details: { orderNumber, branchId, deducted: result.deducted },
    });
  }
  for (const name of result.productsWithoutRecipe) {
    await audit({
      cafeId,
      userId,
      action: "PRODUCT_WITHOUT_RECIPE_SERVED",
      entity: "Order",
      entityId: orderId,
      details: { orderNumber, productName: name },
    });
  }
}
