// RECIPE-001 — a sold configuration must resolve to the recipe it was made from.
//
// The old model hung ingredients off a product. A large latte and a small
// latte therefore deducted the same 200ml of milk and reported the same cost,
// which made the large look more profitable purely because nothing recorded
// that it uses more. Any variance charged to a barista on that basis would
// have been invented.
//
// Recipes are now scoped: a product default, a specific variant, or an add-on.
// A default does NOT quietly stand in for a variant — somebody has to say the
// same preparation really applies to every size, and that statement is
// recorded. Absent it, the variant is INCOMPLETE and says why.

import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  resolveEffectiveRecipe, theoreticalConsumption, RecipeIssue,
} from "@/lib/recipes";
import { productCostStrict } from "@/lib/costing";
import { db, fixture, testIngredients, cleanupIngredients } from "./helpers/db";

after(async () => { await db.$disconnect(); });

type Ctx = Awaited<ReturnType<typeof scaffold>>;

/** A throwaway product with two sizes and its own ingredients. */
async function scaffold(tag: string) {
  const fx = await fixture();
  const cat = await db.menuCategory.findFirstOrThrow({ where: { cafeId: fx.cafeId } });
  // The test brings its own ingredients. Pinning the café's «بن» and «لبن» by
  // name tied every conversion and cost below to one menu's spelling, and the
  // costs the assertions expect to prices nothing here declared.
  const { beans, milk } = await testIngredients(fx, tag);
  const product = await db.product.create({
    data: {
      cafeId: fx.cafeId, categoryId: cat.id, name: `${tag} drink`, basePrice: 50,
      variants: { create: [{ name: "Small", price: 40 }, { name: "Large", price: 70 }] },
    },
    include: { variants: { orderBy: { price: "asc" } } },
  });
  return { fx, product, small: product.variants[0], large: product.variants[1], beans, milk, tag };
}
async function teardown(c: Ctx) {
  await db.recipe.deleteMany({ where: { productId: c.product.id } });
  await db.product.delete({ where: { id: c.product.id } });
  await cleanupIngredients({ beans: c.beans, milk: c.milk });
}
const addRecipe = (
  c: Ctx,
  scope: { variantId?: string },
  items: { inventoryItemId: string; quantity: number; unit: "GRAM" | "KG" | "ML" | "LITER" | "PIECE" }[],
  extra: Record<string, unknown> = {}
) =>
  db.recipe.create({
    data: {
      cafeId: c.fx.cafeId, productId: c.product.id, variantId: scope.variantId ?? null,
      ...extra,
      items: { create: items.map((i) => ({ ...i })) },
    },
    include: { items: true },
  });

describe("RECIPE-001 variant-aware recipe architecture", () => {
  // ── A + D: what the migration did, and did not, claim ──
  //
  // The carry-across in 20260825090000 reads ProductRecipeItem and then drops
  // it, so it can only ever produce rows on a database that predates the
  // migration. A fresh install has nothing to carry and legitimately ends up
  // with none — this test used to demand at least one, and to demand exactly
  // the fifteen ingredient rows one café happened to hold on the day it was
  // written, so it failed on every clean database and on any café whose menu
  // had moved on since.
  //
  // What is worth guarding is not the row count but the restraint: the
  // carry-across must claim no more than the old model could express.
  //
  // Checking only the rows would leave nothing asserted wherever none exist —
  // which is every clean database — so the statement that produces them is
  // read directly. That holds the migration to its restraint everywhere,
  // including where it has nothing to carry.
  test("A+D: migrated recipes claim no more than the old model could express", async () => {
    const sql = await readFile(
      join(process.cwd(), "prisma/migrations/20260825090000_variant_aware_recipes/migration.sql"),
      "utf8"
    );
    const insert = sql.slice(sql.indexOf('INSERT INTO "Recipe"'));
    const columns = insert.slice(0, insert.indexOf(")"));
    assert.ok(columns.includes('"productId"'), "the carry-across still lands on Recipe");
    for (const claim of ["variantId", "verifiedAt", "verifiedById", "appliesToAllVariants"]) {
      assert.ok(
        !columns.includes(`"${claim}"`),
        `the migration must not stamp ${claim} — the old model could not express it`
      );
    }

    // And wherever migrated rows survive, they must still show that restraint.
    const migrated = await db.recipe.findMany({
      where: { id: { startsWith: "mig_" } },
      include: { items: true },
    });
    for (const r of migrated) {
      assert.ok(r.items.length > 0, "a carried-across recipe kept its ingredient rows");
      assert.equal(r.variantId, null, "migrated rows are product defaults");
      assert.equal(r.verifiedAt, null, "nobody has confirmed these — the old model could not express sizes");
      assert.equal(r.appliesToAllVariants, false, "and nobody has said one size fits all");
    }
  });

  // ── B + C: PostgreSQL NULLs do not make a uniqueness rule ──
  test("B: a second product-default recipe is rejected by the database", async () => {
    const c = await scaffold("R1B");
    try {
      await addRecipe(c, {}, [{ inventoryItemId: c.beans.id, quantity: 18, unit: "GRAM" }]);
      await assert.rejects(
        () => addRecipe(c, {}, [{ inventoryItemId: c.milk.id, quantity: 200, unit: "ML" }]),
        "two defaults for one product would be two different truths"
      );
    } finally { await teardown(c); }
  });

  test("C: a second recipe for the same variant is rejected by the database", async () => {
    const c = await scaffold("R1C");
    try {
      await addRecipe(c, { variantId: c.small.id }, [{ inventoryItemId: c.beans.id, quantity: 18, unit: "GRAM" }]);
      await assert.rejects(
        () => addRecipe(c, { variantId: c.small.id }, [{ inventoryItemId: c.milk.id, quantity: 150, unit: "ML" }])
      );
    } finally { await teardown(c); }
  });

  test("duplicate ingredient lines inside one recipe are rejected", async () => {
    const c = await scaffold("R1DUP");
    try {
      await assert.rejects(
        () => addRecipe(c, {}, [
          { inventoryItemId: c.beans.id, quantity: 18, unit: "GRAM" },
          { inventoryItemId: c.beans.id, quantity: 4, unit: "GRAM" },
        ]),
        "two lines for one ingredient would double the deduction silently"
      );
    } finally { await teardown(c); }
  });

  // ── E: no variants, default applies ──
  test("E: a product without variants resolves its default recipe", async () => {
    const c = await scaffold("R1E");
    try {
      await db.productVariant.deleteMany({ where: { productId: c.product.id } });
      await addRecipe(c, {}, [{ inventoryItemId: c.beans.id, quantity: 18, unit: "GRAM" }]);
      const r = await resolveEffectiveRecipe(c.product.id, null);
      assert.equal(r.source, "PRODUCT_DEFAULT");
      assert.equal(r.items.length, 1);
      assert.equal(Number(r.items[0].quantity), 18);
    } finally { await teardown(c); }
  });

  // ── F + G + I: sizes are different drinks ──
  test("F+G+I: each size resolves its own quantities", async () => {
    const c = await scaffold("R1F");
    try {
      await addRecipe(c, {}, [{ inventoryItemId: c.milk.id, quantity: 200, unit: "ML" }]);
      await addRecipe(c, { variantId: c.small.id }, [{ inventoryItemId: c.milk.id, quantity: 150, unit: "ML" }]);
      await addRecipe(c, { variantId: c.large.id }, [{ inventoryItemId: c.milk.id, quantity: 300, unit: "ML" }]);

      const s = await resolveEffectiveRecipe(c.product.id, c.small.id);
      const l = await resolveEffectiveRecipe(c.product.id, c.large.id);
      assert.equal(s.source, "VARIANT");
      assert.equal(l.source, "VARIANT");
      assert.equal(Number(s.items[0].quantity), 150, "small uses its own recipe, not the default");
      assert.equal(Number(l.items[0].quantity), 300, "large uses more milk, as it actually does");
      assert.notEqual(Number(s.items[0].quantity), Number(l.items[0].quantity));
    } finally { await teardown(c); }
  });

  // ── H + N: the default does not quietly cover a size ──
  test("H: a variant with no recipe is incomplete, not silently defaulted", async () => {
    const c = await scaffold("R1H");
    try {
      await addRecipe(c, {}, [{ inventoryItemId: c.milk.id, quantity: 200, unit: "ML" }]);
      const r = await resolveEffectiveRecipe(c.product.id, c.large.id);
      assert.equal(r.source, "NONE", "a small recipe must not be served up for a large");
      assert.ok(
        r.issues.includes(RecipeIssue.MISSING_VARIANT_RECIPE),
        `expected MISSING_VARIANT_RECIPE, got ${r.issues.join(",")}`
      );
    } finally { await teardown(c); }
  });

  test("N: the default covers variants only when someone has said so", async () => {
    const c = await scaffold("R1N");
    try {
      await addRecipe(c, {}, [{ inventoryItemId: c.milk.id, quantity: 200, unit: "ML" }], {
        appliesToAllVariants: true,
      });
      const r = await resolveEffectiveRecipe(c.product.id, c.large.id);
      assert.equal(r.source, "PRODUCT_DEFAULT_ALL_VARIANTS");
      assert.equal(Number(r.items[0].quantity), 200);
    } finally { await teardown(c); }
  });

  // ── M: siblings are independent ──
  test("M: one unconfigured size does not spoil its sibling", async () => {
    const c = await scaffold("R1M");
    try {
      await addRecipe(c, { variantId: c.small.id }, [{ inventoryItemId: c.milk.id, quantity: 150, unit: "ML" }]);
      const s = await resolveEffectiveRecipe(c.product.id, c.small.id);
      const l = await resolveEffectiveRecipe(c.product.id, c.large.id);
      assert.equal(s.source, "VARIANT");
      assert.equal(s.issues.length, 0);
      assert.equal(l.source, "NONE");
    } finally { await teardown(c); }
  });

  // ── N/O/P/Q: units ──
  test("N+O: g↔kg and ml↔L convert exactly", async () => {
    const c = await scaffold("R1U");
    try {
      // beans are stocked in KG, the recipe speaks grams; milk in LITER, ml.
      await addRecipe(c, { variantId: c.small.id }, [
        { inventoryItemId: c.beans.id, quantity: 18, unit: "GRAM" },
        { inventoryItemId: c.milk.id, quantity: 250, unit: "ML" },
      ]);
      const t = await theoreticalConsumption({
        productId: c.product.id, variantId: c.small.id, addOnIds: [], quantity: 1,
      });
      const byItem = new Map(t.lines.map((l) => [l.inventoryItemId, l]));
      assert.equal(byItem.get(c.beans.id)!.quantityInStockUnit, 0.018, "18 g is 0.018 kg");
      assert.equal(byItem.get(c.milk.id)!.quantityInStockUnit, 0.25, "250 ml is 0.25 L");
      assert.equal(t.complete, true);
    } finally { await teardown(c); }
  });

  test("P: an incompatible unit is refused, not quietly ignored", async () => {
    const c = await scaffold("R1P");
    try {
      // beans are a mass; asking for millilitres of them is meaningless.
      await addRecipe(c, { variantId: c.small.id }, [
        { inventoryItemId: c.beans.id, quantity: 18, unit: "ML" },
      ]);
      const r = await resolveEffectiveRecipe(c.product.id, c.small.id);
      assert.ok(
        r.issues.includes(RecipeIssue.INCOMPATIBLE_UNIT),
        `expected INCOMPATIBLE_UNIT, got ${r.issues.join(",")}`
      );
    } finally { await teardown(c); }
  });

  test("Q: a non-positive quantity is refused", async () => {
    const c = await scaffold("R1Q");
    try {
      await addRecipe(c, { variantId: c.small.id }, [
        { inventoryItemId: c.beans.id, quantity: 0, unit: "GRAM" },
      ]);
      const r = await resolveEffectiveRecipe(c.product.id, c.small.id);
      assert.ok(r.issues.includes(RecipeIssue.INVALID_QUANTITY));
    } finally { await teardown(c); }
  });

  // ── R + S: costing must not launder a broken row into zero ──
  test("R: a sound recipe costs out", async () => {
    const c = await scaffold("R1R");
    try {
      const r = await addRecipe(c, { variantId: c.small.id }, [
        { inventoryItemId: c.beans.id, quantity: 18, unit: "GRAM" },
      ]);
      const cost = productCostStrict(
        await db.recipeItem.findMany({ where: { recipeId: r.id }, include: { inventoryItem: true } })
      );
      assert.equal(cost.ok, true);
      // 0.018 kg × 450 = 8.10
      assert.equal(cost.total, 8.1);
    } finally { await teardown(c); }
  });

  test("S: an incompatible unit makes cost unavailable, never zero", async () => {
    const c = await scaffold("R1S");
    try {
      const r = await addRecipe(c, { variantId: c.small.id }, [
        { inventoryItemId: c.beans.id, quantity: 18, unit: "ML" },
      ]);
      const cost = productCostStrict(
        await db.recipeItem.findMany({ where: { recipeId: r.id }, include: { inventoryItem: true } })
      );
      assert.equal(cost.ok, false, "a row we cannot convert must not be costed at 0");
      assert.ok(cost.issues.includes(RecipeIssue.INCOMPATIBLE_UNIT));
    } finally { await teardown(c); }
  });

  // ── U: one resolved recipe feeds both answers ──
  test("U: consumption and COGS come from the same resolved quantities", async () => {
    const c = await scaffold("R1CONS");
    try {
      await addRecipe(c, { variantId: c.large.id }, [
        { inventoryItemId: c.beans.id, quantity: 20, unit: "GRAM" },
        { inventoryItemId: c.milk.id, quantity: 300, unit: "ML" },
      ]);
      const t = await theoreticalConsumption({
        productId: c.product.id, variantId: c.large.id, addOnIds: [], quantity: 2,
      });
      // 2 × 20 g = 0.04 kg ; 2 × 300 ml = 0.6 L
      const byItem = new Map(t.lines.map((l) => [l.inventoryItemId, l]));
      assert.equal(byItem.get(c.beans.id)!.quantityInStockUnit, 0.04);
      assert.equal(byItem.get(c.milk.id)!.quantityInStockUnit, 0.6);
      // 0.04 × 450 + 0.6 × 38 = 18 + 22.8 = 40.8
      assert.equal(t.cost, 40.8, "cost is derived from the very same lines");
    } finally { await teardown(c); }
  });
});
