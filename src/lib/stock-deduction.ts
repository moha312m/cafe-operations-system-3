import type { Prisma, PrismaClient } from "@prisma/client";
import { audit } from "@/lib/audit";
import { convertQuantity, round2, round3 } from "@/lib/costing";

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
      items: { select: { productId: true, productName: true, quantity: true } },
    },
  });
  if (!order) throw new StockError("الطلب مش موجود");
  if (order.stockDeductedAt) {
    throw new StockError("تم خصم المخزون لهذا الطلب من قبل");
  }

  const branchId = order.branchId;
  const cafeId = order.cafeId;
  const allowNegative = order.cafe.allowNegativeStock;

  // Aggregate required raw amount per (product) → recipe, scaled by the
  // ordered item quantity. Recipes reference cafe-level inventory items;
  // stock is deducted from the ORDER'S BRANCH copy matched by name+unit.
  const productIds = [...new Set(order.items.map((i) => i.productId).filter(Boolean))] as string[];
  const recipes = await tx.productRecipeItem.findMany({
    where: { productId: { in: productIds } },
    include: {
      inventoryItem: { select: { name: true, unit: true } },
    },
  });
  const recipeByProduct = new Map<string, typeof recipes>();
  for (const r of recipes) {
    const arr = recipeByProduct.get(r.productId) ?? [];
    arr.push(r);
    recipeByProduct.set(r.productId, arr);
  }

  const productsWithoutRecipe: string[] = [];
  // Map of "branch inventory item id" → total raw quantity to remove
  // (expressed in that item's own storage unit).
  const need = new Map<string, { name: string; unit: string; qty: number }>();

  for (const item of order.items) {
    if (!item.productId) continue;
    const recipe = recipeByProduct.get(item.productId);
    if (!recipe || recipe.length === 0) {
      if (!productsWithoutRecipe.includes(item.productName)) {
        productsWithoutRecipe.push(item.productName);
      }
      continue;
    }
    for (const r of recipe) {
      // Find the branch's stock row for this ingredient (by name+unit).
      const branchItem = await tx.inventoryItem.findFirst({
        where: {
          cafeId,
          branchId,
          name: r.inventoryItem.name,
          unit: r.inventoryItem.unit,
          archivedAt: null,
        },
      });
      if (!branchItem) {
        if (!allowNegative) {
          throw new StockError(`الخامة «${r.inventoryItem.name}» غير متوفرة في الفرع`);
        }
        continue; // allowNegative + no branch row → nothing to deduct
      }
      const perUnitInItemUnit = convertQuantity(
        Number(r.quantity) * (1 + Number(r.wastePercentage) / 100),
        r.unit,
        branchItem.unit
      );
      const totalRaw = round3(perUnitInItemUnit * item.quantity);
      const cur = need.get(branchItem.id);
      if (cur) cur.qty = round3(cur.qty + totalRaw);
      else need.set(branchItem.id, { name: branchItem.name, unit: branchItem.unit, qty: totalRaw });
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
