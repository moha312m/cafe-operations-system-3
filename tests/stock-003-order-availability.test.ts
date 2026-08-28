// STOCK-003 — POS must refuse an order it cannot make from branch stock.
//
// This is deliberately an HTTP-boundary test. The defect being fixed is not
// merely a stock helper returning the wrong number: POST /api/orders currently
// accepts the sale, and can therefore create the order/payment before the
// existing final stock check runs at SERVED.
//
// RED contract for the first TDD step:
//   * known recipe demand > branch stock, with negative stock disabled, is a
//     current-state conflict and must be refused BEFORE an Order is created;
//   * the refusal is read-only — no Payment, stock balance, or ledger write.

import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { requireServer, as } from "./helpers/http";
import { countCafe, countItem, type CountCafe } from "./helpers/count";

let fx: CountCafe;
let productId: string;
let ingredientId: string;

before(async () => {
  await requireServer();
  fx = await countCafe("STOCK003");

  await db.cafe.update({
    where: { id: fx.cafeId },
    data: { allowNegativeStock: false },
  });

  const category = await db.menuCategory.create({
    data: { cafeId: fx.cafeId, name: `${fx.marker} drinks` },
  });
  const product = await db.product.create({
    data: {
      cafeId: fx.cafeId,
      categoryId: category.id,
      name: `${fx.marker} Milkshake`,
      basePrice: "90.00",
    },
  });
  productId = product.id;

  const ingredient = await countItem(fx, "Ice Cream", {
    stock: 0,
    costPerUnit: 120,
  });
  ingredientId = ingredient.id;

  await db.recipe.create({
    data: {
      cafeId: fx.cafeId,
      productId,
      items: {
        create: [{
          inventoryItemId: ingredientId,
          quantity: "0.220",
          unit: "KG",
        }],
      },
    },
  });
});

after(() =>
  teardownTaggedCafe(fx ? [fx.cafeId] : [], [], { disconnect: true })
);

test("POST /api/orders blocks a known zero-stock ingredient before creating any sale side effect", async () => {
  const beforeOrderCount = await db.order.count({ where: { cafeId: fx.cafeId } });
  const beforePaymentCount = await db.payment.count({ where: { cafeId: fx.cafeId } });
  const beforeLedgerCount = await db.inventoryTransaction.count({
    where: { cafeId: fx.cafeId, inventoryItemId: ingredientId },
  });
  const beforeIngredient = await db.inventoryItem.findUniqueOrThrow({
    where: { id: ingredientId },
    select: { currentStock: true },
  });

  const r = await as<{ error?: string }>(fx.owner.email, "/api/orders", {
    method: "POST",
    body: JSON.stringify({
      branchId: fx.branchId,
      type: "TAKEAWAY",
      collectionMode: "PENDING",
      items: [{ productId, quantity: 1, addOnIds: [] }],
    }),
  });

  assert.equal(
    r.status,
    409,
    `zero-stock recipe must be refused before order creation; got ${r.status}: ${r.text}`
  );
  assert.match(
    r.body.error ?? "",
    /Ice Cream|آيس كريم|كمية كافية|غير متوفرة/i
  );

  assert.equal(
    await db.order.count({ where: { cafeId: fx.cafeId } }),
    beforeOrderCount,
    "a blocked availability check must not create an Order"
  );
  assert.equal(
    await db.payment.count({ where: { cafeId: fx.cafeId } }),
    beforePaymentCount,
    "a blocked availability check must not create a Payment"
  );
  assert.equal(
    await db.inventoryTransaction.count({
      where: { cafeId: fx.cafeId, inventoryItemId: ingredientId },
    }),
    beforeLedgerCount,
    "pre-sale availability is read-only and must not write the stock ledger"
  );

  const afterIngredient = await db.inventoryItem.findUniqueOrThrow({
    where: { id: ingredientId },
    select: { currentStock: true },
  });
  assert.equal(
    afterIngredient.currentStock.toString(),
    beforeIngredient.currentStock.toString(),
    "pre-sale availability must not mutate currentStock"
  );
});
