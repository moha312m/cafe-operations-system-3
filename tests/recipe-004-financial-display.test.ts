import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { db, fixture, tag } from "./helpers/db";
import { as, login, requireServer } from "./helpers/http";
import { recipeFingerprint } from "@/lib/recipes";

const OWNER = "owner@demo.com";

after(async () => { await db.$disconnect(); });
before(async () => {
  await requireServer();
  await login(OWNER, "owner1234");
});

async function setup(label: string) {
  const fx = await fixture();
  const category = await db.menuCategory.findFirstOrThrow({ where: { cafeId: fx.cafeId } });
  const beans = await db.inventoryItem.findFirstOrThrow({
    where: { cafeId: fx.cafeId, unit: "KG", costPerUnit: { gt: 0 } },
  });
  const product = await db.product.create({
    data: {
      cafeId: fx.cafeId,
      categoryId: category.id,
      name: tag(label),
      basePrice: 40,
      variants: {
        create: [
          { name: "Small", price: 40, sortOrder: 1 },
          { name: "Large", price: 70, sortOrder: 2 },
        ],
      },
    },
    include: { variants: { orderBy: { sortOrder: "asc" } } },
  });
  return { fx, beans, product, small: product.variants[0], large: product.variants[1] };
}

async function cleanup(productId: string) {
  await db.recipe.deleteMany({ where: { productId } });
  await db.product.delete({ where: { id: productId } });
}

async function confirmRecipe(recipeId: string, appliesToAllVariants = false) {
  const owner = await db.user.findUniqueOrThrow({ where: { email: OWNER } });
  const recipe = await db.recipe.findUniqueOrThrow({ where: { id: recipeId }, include: { items: true } });
  await db.recipe.update({
    where: { id: recipeId },
    data: {
      verifiedById: owner.id,
      verifiedAt: new Date(),
      verifiedFingerprint: recipeFingerprint(recipe.items, { appliesToAllVariants }),
    },
  });
}

describe("RECIPE-004 honest configuration COGS displays", () => {
  test("a variant report uses its exact recipe and never borrows the default", async () => {
    const c = await setup("R4A");
    try {
      await db.recipe.create({
        data: {
          cafeId: c.fx.cafeId,
          productId: c.product.id,
          items: { create: [{ inventoryItemId: c.beans.id, quantity: 18, unit: "GRAM" }] },
        },
      });
      const smallRecipe = await db.recipe.create({
        data: {
          cafeId: c.fx.cafeId,
          productId: c.product.id,
          variantId: c.small.id,
          items: { create: [{ inventoryItemId: c.beans.id, quantity: 20, unit: "GRAM" }] },
        },
      });
      await confirmRecipe(smallRecipe.id);

      const response = await as(OWNER, "/api/reports/product-cost");
      assert.equal(response.status, 200, response.text);
      const body = JSON.parse(response.text) as { rows: Array<Record<string, unknown>> };
      const rows = body.rows.filter((row) => row.productId === c.product.id);
      assert.equal(rows.length, 2, "the financial report must show sellable configurations, not one generic product");

      const small = rows.find((row) => row.variantId === c.small.id)!;
      const large = rows.find((row) => row.variantId === c.large.id)!;
      assert.equal(small.cost, 0.02 * Number(c.beans.costPerUnit), "Small uses its exact 20g recipe");
      assert.equal(typeof small.profit, "number");
      assert.equal(large.cost, null, "Large must not borrow the 18g default recipe");
      assert.equal(large.profit, null, "incomplete Large profitability is unavailable, not fabricated");
      assert.equal(large.costStatus, "RECIPE_INCOMPLETE");

      const menuResponse = await as(OWNER, "/api/products");
      assert.equal(menuResponse.status, 200, menuResponse.text);
      const menuBody = JSON.parse(menuResponse.text) as { products: Array<Record<string, unknown>> };
      const menuProduct = menuBody.products.find((product) => product.id === c.product.id)!;
      assert.equal(menuProduct.costStatus, "MULTIPLE_CONFIGURATIONS");
      assert.equal(menuProduct.cost, null, "a generic product row must not pretend one size is the whole product");
      assert.equal(menuProduct.profit, null);
    } finally { await cleanup(c.product.id); }
  });

  test("an incompatible exact recipe produces no numeric user-facing cost", async () => {
    const c = await setup("R4D");
    try {
      await db.recipe.create({
        data: {
          cafeId: c.fx.cafeId,
          productId: c.product.id,
          variantId: c.large.id,
          items: { create: [{ inventoryItemId: c.beans.id, quantity: 20, unit: "ML" }] },
        },
      });
      const response = await as(OWNER, "/api/reports/product-cost");
      const body = JSON.parse(response.text) as { rows: Array<Record<string, unknown>> };
      const large = body.rows.find((row) => row.variantId === c.large.id)!;
      assert.equal(large.cost, null, "an incompatible line must not contribute a misleading zero");
      assert.equal(large.margin, null);
      assert.deepEqual(large.issues, ["INCOMPATIBLE_UNIT"]);
    } finally { await cleanup(c.product.id); }
  });

  test("an explicitly all-variant default is a valid common cost source", async () => {
    const c = await setup("R4F");
    try {
      const sharedRecipe = await db.recipe.create({
        data: {
          cafeId: c.fx.cafeId,
          productId: c.product.id,
          appliesToAllVariants: true,
          items: { create: [{ inventoryItemId: c.beans.id, quantity: 25, unit: "GRAM" }] },
        },
      });
      await confirmRecipe(sharedRecipe.id, true);
      const response = await as(OWNER, "/api/reports/product-cost");
      const body = JSON.parse(response.text) as { rows: Array<Record<string, unknown>> };
      const rows = body.rows.filter((row) => row.productId === c.product.id);
      assert.equal(rows.length, 2);
      const expectedCost = Math.round(0.025 * Number(c.beans.costPerUnit) * 100) / 100;
      assert.ok(rows.every((row) => row.cost === expectedCost), JSON.stringify(rows));
      assert.ok(rows.every((row) => row.recipeSource === "PRODUCT_DEFAULT_ALL_VARIANTS"));
    } finally { await cleanup(c.product.id); }
  });
});
