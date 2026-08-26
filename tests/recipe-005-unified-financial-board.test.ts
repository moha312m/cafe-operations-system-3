import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { recipeFingerprint } from "@/lib/recipes";
import { db, fixture, tag } from "./helpers/db";
import { as, login, requireServer } from "./helpers/http";

const OWNER = "owner@demo.com";
const CASHIER = "cashier@demo.com";
const MANAGER = "manager@demo.com";

after(async () => { await db.$disconnect(); });
before(async () => {
  await requireServer();
  await login(OWNER, "owner1234");
  await login(CASHIER, "cashier123");
  await login(MANAGER, "manager123");
});

async function setup(label: string) {
  const fx = await fixture();
  const category = await db.menuCategory.findFirstOrThrow({ where: { cafeId: fx.cafeId } });
  const costed = await db.inventoryItem.findFirstOrThrow({
    where: { cafeId: fx.cafeId, unit: "KG", costPerUnit: { gt: 0 } },
  });
  const missingCost = await db.inventoryItem.create({
    data: {
      cafeId: fx.cafeId,
      branchId: fx.branchId,
      name: tag(`${label}-missing-cost`),
      unit: "KG",
      currentStock: 0,
      costPerUnit: 0,
    },
  });
  const product = await db.product.create({
    data: {
      cafeId: fx.cafeId,
      categoryId: category.id,
      name: tag(label),
      basePrice: 40,
      variants: {
        create: [
          { name: "Verified", price: 40, sortOrder: 1 },
          { name: "Missing cost", price: 50, sortOrder: 2 },
          { name: "Needs confirmation", price: 60, sortOrder: 3 },
          { name: "Missing recipe", price: 70, sortOrder: 4 },
        ],
      },
    },
    include: { variants: { orderBy: { sortOrder: "asc" } } },
  });
  const owner = await db.user.findUniqueOrThrow({ where: { email: OWNER } });
  const verified = await db.recipe.create({
    data: {
      cafeId: fx.cafeId,
      productId: product.id,
      variantId: product.variants[0].id,
      items: { create: [{ inventoryItemId: costed.id, quantity: 20, unit: "GRAM" }] },
    },
    include: { items: true },
  });
  await db.recipe.update({
    where: { id: verified.id },
    data: {
      verifiedById: owner.id,
      verifiedAt: new Date(),
      verifiedFingerprint: recipeFingerprint(verified.items),
    },
  });
  await db.recipe.create({
    data: {
      cafeId: fx.cafeId,
      productId: product.id,
      variantId: product.variants[1].id,
      items: { create: [{ inventoryItemId: missingCost.id, quantity: 20, unit: "GRAM" }] },
    },
  });
  await db.recipe.create({
    data: {
      cafeId: fx.cafeId,
      productId: product.id,
      variantId: product.variants[2].id,
      items: { create: [{ inventoryItemId: costed.id, quantity: 20, unit: "GRAM" }] },
    },
  });
  return { fx, product, costed, missingCost };
}

async function cleanup(productId: string, inventoryItemId: string) {
  await db.recipe.deleteMany({ where: { productId } });
  await db.product.delete({ where: { id: productId } });
  await db.inventoryItem.delete({ where: { id: inventoryItemId } });
}

describe("RECIPE-005 unified recipe and financial board", () => {
  test("the review API returns honest per-configuration financials and next actions", async () => {
    const c = await setup("R5-BOARD");
    try {
      const response = await as(OWNER, "/api/recipes/review");
      assert.equal(response.status, 200, response.text);
      const body = JSON.parse(response.text) as {
        rows: Array<Record<string, unknown>>;
        summary: Record<string, number>;
      };
      const rows = body.rows.filter((row) => row.productId === c.product.id);
      assert.equal(rows.length, 4, "one row per sellable size");

      const verified = rows.find((row) => row.variantName === "Verified")!;
      assert.equal(verified.costStatus, "AVAILABLE");
      assert.equal(verified.sellingPrice, 40);
      assert.equal(verified.cost, 0.02 * Number(c.costed.costPerUnit));
      assert.equal(typeof verified.profit, "number");
      assert.equal(typeof verified.margin, "number");
      assert.equal(verified.nextAction, null);

      const missingCost = rows.find((row) => row.variantName === "Missing cost")!;
      assert.equal(missingCost.cost, null);
      assert.equal(missingCost.profit, null);
      assert.equal(missingCost.margin, null);
      assert.deepEqual(missingCost.issues, ["MISSING_COST"]);
      assert.equal(missingCost.nextAction, "ENTER_COST");

      const unconfirmed = rows.find((row) => row.variantName === "Needs confirmation")!;
      assert.equal(unconfirmed.cost, null);
      assert.deepEqual(unconfirmed.issues, ["NOT_CONFIRMED"]);
      assert.equal(unconfirmed.nextAction, "CONFIRM");

      const missingRecipe = rows.find((row) => row.variantName === "Missing recipe")!;
      assert.equal(missingRecipe.cost, null);
      assert.ok((missingRecipe.issues as string[]).includes("MISSING_VARIANT_RECIPE"));
      assert.equal(missingRecipe.nextAction, "CREATE_RECIPE");

      assert.ok(body.summary.costAvailable >= 1);
      assert.ok(body.summary.needsReview >= 3);
    } finally {
      await cleanup(c.product.id, c.missingCost.id);
    }
  });

  test("cashiers cannot read unified recipe profitability", async () => {
    const response = await as(CASHIER, "/api/recipes/review");
    assert.equal(response.status, 403);
  });

  test("revenue access without profit access cannot read recipe profitability", async () => {
    const manager = await db.user.findUniqueOrThrow({ where: { email: MANAGER } });
    await db.userPermissionOverride.upsert({
      where: {
        userId_permissionKey: {
          userId: manager.id,
          permissionKey: "finance.view_profit",
        },
      },
      create: {
        userId: manager.id,
        permissionKey: "finance.view_profit",
        allowed: false,
      },
      update: { allowed: false },
    });
    try {
      const response = await as(MANAGER, "/api/recipes/review");
      assert.equal(response.status, 403, "revenue visibility must not expose profit or margin");
    } finally {
      await db.userPermissionOverride.deleteMany({
        where: { userId: manager.id, permissionKey: "finance.view_profit" },
      });
    }
  });

  test("an all-variant default opens with its resolved ingredients instead of an empty override", async () => {
    const c = await setup("R5-SHARED-EDITOR");
    try {
      const owner = await db.user.findUniqueOrThrow({ where: { email: OWNER } });
      const shared = await db.recipe.create({
        data: {
          cafeId: c.fx.cafeId,
          productId: c.product.id,
          appliesToAllVariants: true,
          items: { create: [{ inventoryItemId: c.costed.id, quantity: 18, unit: "GRAM" }] },
        },
        include: { items: true },
      });
      await db.recipe.update({
        where: { id: shared.id },
        data: {
          verifiedById: owner.id,
          verifiedAt: new Date(),
          verifiedFingerprint: recipeFingerprint(shared.items, { appliesToAllVariants: true }),
        },
      });

      const inheritedVariant = c.product.variants[3];
      const response = await as(
        OWNER,
        `/api/products/${c.product.id}/recipe?variantId=${inheritedVariant.id}`
      );
      assert.equal(response.status, 200, response.text);
      const body = JSON.parse(response.text) as {
        recipe: Array<{ inventoryItemId: string; quantity: string }>;
        recipeSource: string;
      };
      assert.equal(body.recipeSource, "PRODUCT_DEFAULT_ALL_VARIANTS");
      assert.equal(body.recipe.length, 1, "the editor must show the recipe that made the row trusted");
      assert.equal(body.recipe[0].inventoryItemId, c.costed.id);
      assert.equal(Number(body.recipe[0].quantity), 18);
    } finally {
      await cleanup(c.product.id, c.missingCost.id);
    }
  });

  test("unconfirmed exact recipes never report trusted financial output", async () => {
    const c = await setup("R5-UNCONFIRMED");
    try {
      const unconfirmed = c.product.variants[2];
      const getResponse = await as(
        OWNER,
        `/api/products/${c.product.id}/recipe?variantId=${unconfirmed.id}`
      );
      assert.equal(getResponse.status, 200, getResponse.text);
      const getBody = JSON.parse(getResponse.text) as Record<string, unknown>;
      assert.equal(getBody.costStatus, "RECIPE_INCOMPLETE");
      assert.equal(getBody.cost, null);
      assert.equal(getBody.profit, null);
      assert.equal(getBody.margin, null);

      const verified = c.product.variants[0];
      const putResponse = await as(
        OWNER,
        `/api/products/${c.product.id}/recipe?variantId=${verified.id}`,
        {
          method: "PUT",
          body: JSON.stringify({
            items: [{
              inventoryItemId: c.costed.id,
              quantity: 21,
              unit: "GRAM",
              wastePercentage: 0,
            }],
          }),
        }
      );
      assert.equal(putResponse.status, 200, putResponse.text);
      const putBody = JSON.parse(putResponse.text) as Record<string, unknown>;
      assert.equal(putBody.costStatus, "RECIPE_INCOMPLETE");
      assert.equal(putBody.cost, null);
      assert.equal(putBody.profit, null);
      assert.equal(putBody.margin, null);
    } finally {
      await cleanup(c.product.id, c.missingCost.id);
    }
  });

  test("recipe profitability is scoped to the selected branch price and ingredient cost", async () => {
    const c = await setup("R5-BRANCH");
    const branch = await db.branch.create({
      data: { cafeId: c.fx.cafeId, name: tag("R5-cost-branch") },
    });
    try {
      const branchIngredient = await db.inventoryItem.create({
        data: {
          cafeId: c.fx.cafeId,
          branchId: branch.id,
          name: c.costed.name,
          unit: c.costed.unit,
          currentStock: 10,
          costPerUnit: Number(c.costed.costPerUnit) * 2,
        },
      });
      await db.productBranchPrice.create({
        data: {
          productId: c.product.id,
          branchId: branch.id,
          price: Number(c.product.basePrice) + 10,
        },
      });

      const response = await as(OWNER, `/api/recipes/review?branchId=${branch.id}`);
      assert.equal(response.status, 200, response.text);
      const body = JSON.parse(response.text) as {
        selectedBranchId: string;
        rows: Array<Record<string, unknown>>;
      };
      const row = body.rows.find(
        (candidate) => candidate.productId === c.product.id && candidate.variantName === "Verified"
      )!;
      assert.equal(body.selectedBranchId, branch.id);
      assert.equal(row.sellingPrice, 50, "the branch price shift must apply to the variant");
      assert.equal(
        row.cost,
        0.02 * Number(branchIngredient.costPerUnit),
        "COGS must use the same branch ingredient that stock deduction uses"
      );
    } finally {
      await cleanup(c.product.id, c.missingCost.id);
      await db.branch.delete({ where: { id: branch.id } });
    }
  });

  test("the product recipe endpoint edits one exact variant without touching its sibling", async () => {
    const c = await setup("R5-EDITOR");
    try {
      const missingVariant = c.product.variants[3];
      const sibling = c.product.variants[0];
      const beforeSibling = await db.recipe.findFirstOrThrow({ where: { variantId: sibling.id } });
      const response = await as(OWNER, `/api/products/${c.product.id}/recipe?variantId=${missingVariant.id}`, {
        method: "PUT",
        body: JSON.stringify({
          items: [{
            inventoryItemId: c.costed.id,
            quantity: 25,
            unit: "GRAM",
            wastePercentage: 0,
          }],
        }),
      });
      assert.equal(response.status, 200, response.text);

      const exact = await db.recipe.findFirstOrThrow({
        where: { productId: c.product.id, variantId: missingVariant.id },
        include: { items: true },
      });
      assert.equal(Number(exact.items[0].quantity), 25);
      const afterSibling = await db.recipe.findFirstOrThrow({ where: { variantId: sibling.id } });
      assert.equal(afterSibling.id, beforeSibling.id, "editing one size cannot replace another size's recipe");
    } finally {
      await cleanup(c.product.id, c.missingCost.id);
    }
  });
});
