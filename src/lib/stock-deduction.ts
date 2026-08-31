import type { Prisma, PrismaClient } from "@prisma/client";
import { audit } from "@/lib/audit";
import { round2, round3 } from "@/lib/costing";
import { theoreticalConsumption } from "@/lib/recipes";
import { applyStockMutation, lockItemForUpdate, type StockAttributionSnapshot } from "@/lib/ledger";
import { allowsKnownShortage } from "@/lib/inventory-policy";

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
  userId: string | null,
  attribution?: StockAttributionSnapshot
): Promise<{
  deducted: { name: string; quantity: number }[];
  productsWithoutRecipe: string[];
  configurationsWithIncompleteRecipe: { label: string; issues: string[] }[];
}> {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    include: {
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
  // The policy this ORDER was accepted under, not the one the café is running
  // now. The two moments of an order's inventory lifecycle — availability at
  // the till and this locked deduction — can be hours apart, and the owner can
  // change the setting in between. Reading it fresh here made the change
  // retroactive, in both directions: an order accepted permissively could no
  // longer be handed over once policy tightened, and an order accepted under
  // STRICT could have a shortage waived that the till would have refused.
  //
  // The snapshot is taken at creation from CafeSettings and is never client
  // -supplied, so this is still the café's own decision — just the one that
  // was actually in force when the customer was told yes.
  const mode = order.inventoryEnforcementMode;
  const allowNegative = allowsKnownShortage(mode);

  // What each line theoretically consumes, resolved from the exact sold
  // configuration — product, size, and add-ons — rather than from the product
  // alone. Recipes name cafe-level inventory items; stock comes off the
  // ORDER'S BRANCH copy, matched by name+unit.
  const productsWithoutRecipe: string[] = [];
  const configurationsWithIncompleteRecipe: { label: string; issues: string[] }[] = [];
  const need = new Map<string, { name: string; unit: string; qty: number }>();

  for (const item of order.items) {
    if (!item.productId) continue;
    const consumption = await theoreticalConsumption({
      productId: item.productId,
      variantId: item.variantId ?? null,
      addOnIds: item.addOns.map((a) => a.addOnId).filter(Boolean) as string[],
      quantity: item.quantity,
    });
    const label = item.variantName ? `${item.productName} (${item.variantName})` : item.productName;

    // A configuration we cannot resolve is recorded and skipped, exactly as
    // before: an unconfigured recipe must never stop a customer being served.
    // It is reported so the gap is visible rather than silently absorbed.
    if (consumption.lines.length === 0) {
      if (!productsWithoutRecipe.includes(label)) productsWithoutRecipe.push(label);
      continue;
    }

    // Half-resolved is its own gap, and the same rule covers it. What did
    // resolve is deducted below; what did not contributes nothing, so leaving
    // it undisclosed would let a zero-by-omission stand as a measured figure
    // and be read later as somebody's stock shortage. No quantity is guessed
    // for the missing part — only the fact that it is missing, and why.
    if (!consumption.complete && !configurationsWithIncompleteRecipe.some((c) => c.label === label)) {
      configurationsWithIncompleteRecipe.push({ label, issues: consumption.issues });
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
    // The locked read is what makes the sufficiency check meaningful: without
    // it, two concurrent orders could both see enough stock for the last
    // portion and both serve it.
    const item = await lockItemForUpdate(tx, itemId).catch(() => null);
    if (!item) continue;
    const after = round3(item.currentStock - req.qty);
    if (after < 0 && !allowNegative) {
      throw new StockError(
        `لا توجد كمية كافية من الخامة «${req.name}» (المتاح ${item.currentStock}، المطلوب ${req.qty})`
      );
    }
    await applyStockMutation(tx, {
      inventoryItemId: itemId,
      cafeId,
      branchId,
      orderId,
      type: "USAGE",
      quantity: -req.qty,
      unitCost: item.costPerUnit,
      totalCost: round2(req.qty * item.costPerUnit),
      note: `خصم تلقائي بسبب الطلب رقم ${order.orderNumber}`,
      createdById: userId,
      attribution,
      // The sufficiency decision is made above, with the café's own policy
      // and its own message; the writer must not second-guess it.
      allowNegative: true,
    });
    deducted.push({ name: req.name, quantity: req.qty });
  }

  return { deducted, productsWithoutRecipe, configurationsWithIncompleteRecipe };
}

// Post-transaction audit writes (called after commit).
export async function auditDeduction(
  cafeId: string,
  branchId: string,
  userId: string | null,
  orderId: string,
  orderNumber: number,
  result: {
    deducted: { name: string; quantity: number }[];
    productsWithoutRecipe: string[];
    configurationsWithIncompleteRecipe?: { label: string; issues: string[] }[];
  }
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
  // Recorded separately from a missing recipe: this one DID deduct, so the
  // distinction a reconciliation needs is not "was there a recipe" but "was
  // the figure it produced complete".
  for (const c of result.configurationsWithIncompleteRecipe ?? []) {
    await audit({
      cafeId,
      userId,
      action: "PRODUCT_WITH_INCOMPLETE_RECIPE_SERVED",
      entity: "Order",
      entityId: orderId,
      details: { orderNumber, branchId, productName: c.label, issues: c.issues },
    });
  }
}
