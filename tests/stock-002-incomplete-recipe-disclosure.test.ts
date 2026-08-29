// STOCK-002 — a partly-resolvable recipe must not pass as a complete one.
//
// Serving deducts what a configuration theoretically consumes. When nothing
// at all resolves, the module already states the rule it works to: the gap is
// "reported so the gap is visible rather than silently absorbed", and a
// PRODUCT_WITHOUT_RECIPE_SERVED row is written.
//
// The disclosure was gated on `lines.length === 0` — on nothing resolving —
// rather than on whether the resolution was COMPLETE. A configuration whose
// base ingredient resolves and whose second ingredient does not (an
// incompatible unit, an unmapped add-on) therefore deducted the part it
// understood and said nothing about the part it did not. The unresolved
// ingredient's consumption became zero by omission, so theoretical stock
// overstated the shelf and the next physical count would read the difference
// as a shortage somebody's shift is answerable for.
//
// `theoreticalConsumption` already computes `complete` and the reasons; this
// suite holds serving to reporting them.
//
// What must NOT change: serving is never blocked by a recipe gap, and no
// quantity is ever guessed for the part that did not resolve.

import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import { deductStockForOrder, auditDeduction } from "@/lib/stock-deduction";
import { db, fixture, type Fixture } from "./helpers/db";

after(async () => { await db.$disconnect(); });

const MARKER = "PH1-STOCK002";

type Ctx = Awaited<ReturnType<typeof scaffold>>;

/**
 * A drink whose recipe half-resolves.
 *
 * Both ingredients are stocked by mass. The syrup line asks for its 30 in ML —
 * a volume — so the line is structurally unusable and drops out of the
 * consumption, while the beans line resolves cleanly. That is the shape of
 * every real partial: something in the configuration cannot be turned into a
 * quantity, and the rest can.
 */
async function scaffold(tag: string) {
  const fx: Fixture = await fixture();
  const cat = await db.menuCategory.findFirstOrThrow({
    where: { cafeId: fx.cafeId }, orderBy: { createdAt: "asc" },
  });
  const beans = await db.inventoryItem.create({
    data: {
      cafeId: fx.cafeId, branchId: fx.branchId,
      name: `${tag} beans`, unit: "KG", costPerUnit: 450, currentStock: 20,
    },
  });
  const syrup = await db.inventoryItem.create({
    data: {
      cafeId: fx.cafeId, branchId: fx.branchId,
      name: `${tag} syrup`, unit: "KG", costPerUnit: 60, currentStock: 20,
    },
  });
  const product = await db.product.create({
    data: { cafeId: fx.cafeId, categoryId: cat.id, name: `${tag} drink`, basePrice: 80 },
  });
  await db.recipe.create({
    data: {
      cafeId: fx.cafeId, productId: product.id,
      items: {
        create: [
          { inventoryItemId: beans.id, quantity: "0.018", unit: "KG", wastePercentage: 0 },
          { inventoryItemId: syrup.id, quantity: "30", unit: "ML", wastePercentage: 0 },
        ],
      },
    },
  });
  return { fx, product, beans, syrup, tag };
}

async function teardown(c: Ctx) {
  const orders = await db.order.findMany({
    where: { customerName: { startsWith: c.tag } }, select: { id: true },
  });
  const ids = orders.map((o) => o.id);
  if (ids.length) {
    await db.inventoryTransaction.deleteMany({ where: { orderId: { in: ids } } });
    await db.order.deleteMany({ where: { id: { in: ids } } });
  }
  await db.auditLog.deleteMany({ where: { entityId: { in: ids } } });
  await db.recipe.deleteMany({ where: { productId: c.product.id } });
  await db.product.delete({ where: { id: c.product.id } });
  await db.inventoryItem.deleteMany({ where: { id: { in: [c.beans.id, c.syrup.id] } } });
}

async function orderFor(c: Ctx) {
  const last = await db.order.aggregate({
    where: { branchId: c.fx.branchId }, _max: { orderNumber: true },
  });
  return db.order.create({
    data: {
      cafeId: c.fx.cafeId, branchId: c.fx.branchId,
      orderNumber: (last._max.orderNumber ?? 0) + 1,
      type: "TAKEAWAY", status: "CONFIRMED", source: "CASHIER_POS",
      customerName: c.tag,
      subtotal: 80, taxAmount: 0, discountAmount: 0, serviceChargeAmount: 0,
      total: 80, remainingAmount: 80, paymentStatus: "PENDING_COLLECTION",
      createdById: (await db.user.findFirstOrThrow({ where: { cafeId: c.fx.cafeId } })).id,
      items: {
        create: [{
          productId: c.product.id, productName: c.product.name,
          unitPrice: 80, quantity: 1, lineTotal: 80,
        }],
      },
    },
  });
}

describe("STOCK-002 incomplete recipe disclosure", () => {
  test("a half-resolved configuration is reported as incomplete, with its reason", async () => {
    const c = await scaffold(MARKER);
    try {
      const order = await orderFor(c);
      const result = await deductStockForOrder(db, order.id, null);

      assert.ok(
        Array.isArray(result.configurationsWithIncompleteRecipe),
        "serving must report configurations it could only partly resolve"
      );
      const labels = result.configurationsWithIncompleteRecipe.map((x) => x.label);
      assert.deepEqual(
        labels, [c.product.name],
        "the half-resolved drink must be named"
      );
      assert.ok(
        result.configurationsWithIncompleteRecipe[0].issues.includes("INCOMPATIBLE_UNIT"),
        "the disclosure must carry why it could not resolve"
      );
    } finally {
      await teardown(c);
    }
  });

  test("the part that did resolve is still deducted, and the part that did not is not guessed", async () => {
    const c = await scaffold(MARKER);
    try {
      const order = await orderFor(c);
      const result = await deductStockForOrder(db, order.id, null);

      assert.deepEqual(
        result.deducted, [{ name: `${c.tag} beans`, quantity: 0.018 }],
        "the resolvable ingredient still comes off the shelf"
      );
      const syrup = await db.inventoryItem.findUniqueOrThrow({ where: { id: c.syrup.id } });
      assert.equal(
        Number(syrup.currentStock), 20,
        "no quantity may be invented for the ingredient that did not resolve"
      );
      assert.deepEqual(
        result.productsWithoutRecipe, [],
        "a partial is not a missing recipe — it keeps its own category"
      );
    } finally {
      await teardown(c);
    }
  });

  test("the incompleteness reaches the audit trail", async () => {
    const c = await scaffold(MARKER);
    try {
      const order = await orderFor(c);
      const result = await deductStockForOrder(db, order.id, null);
      await auditDeduction(
        c.fx.cafeId, c.fx.branchId, null, order.id, order.orderNumber, result
      );

      const row = await db.auditLog.findFirst({
        where: { entityId: order.id, action: "PRODUCT_WITH_INCOMPLETE_RECIPE_SERVED" },
      });
      assert.ok(
        row,
        "a shift answerable for a stock variance must be able to see that the theoretical figure was never complete"
      );
      const details = row.details as Record<string, unknown>;
      assert.equal(details.productName, c.product.name);
      assert.ok(Array.isArray(details.issues) && (details.issues as string[]).includes("INCOMPATIBLE_UNIT"));
    } finally {
      await teardown(c);
    }
  });
});
