import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, test } from "node:test";
import * as XLSX from "xlsx";
import { recipeFingerprint } from "@/lib/recipes";
import { db, tag, testIngredients, teardownTaggedCafe } from "./helpers/db";
import { as, BASE, requireServer } from "./helpers/http";

import { countCafe, COUNT_PASSWORD, type CountCafe } from "./helpers/count";
let OWNER = "", BARISTA = "";
let owned: CountCafe | null = null;
let cookie = "";
beforeEach(async () => {
  await requireServer();
  owned = await countCafe("RECIPE006");
  OWNER = owned.owner.email;
  BARISTA = owned.waiter.email;
  const r = await fetch(BASE + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: OWNER, password: COUNT_PASSWORD }) });
  assert.equal(r.status, 200);
  cookie = r.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
});
afterEach(async () => { if (owned) { const cafeId = owned.cafeId; owned = null; await teardownTaggedCafe(cafeId); } });
after(async () => { await db.$disconnect(); });

async function setup() {
  assert.ok(owned);
  const fx = owned;
  const category = await db.menuCategory.create({ data: { cafeId: fx.cafeId, name: tag("R6-category") } });
  const ingredients = await testIngredients({ cafeId: fx.cafeId, branchId: fx.branchId, productId: "unused", unitPrice: 0 }, tag("R6"));
  const product = await db.product.create({ data: { cafeId: fx.cafeId, categoryId: category.id, name: tag("R6-drink"), basePrice: 51, costPrice: 7, variants: { create: [{ name: "Small", price: 40 }, { name: "Large", price: 70 }] } }, include: { variants: { orderBy: { price: "asc" } } } });
  const addOn = await db.addOn.create({ data: { cafeId: fx.cafeId, name: tag("R6-addon"), price: 11 } });
  const owner = await db.user.findUniqueOrThrow({ where: { email: OWNER } });
  const recipe = await db.recipe.create({ data: { cafeId: fx.cafeId, productId: product.id, appliesToAllVariants: true, items: { create: [{ inventoryItemId: ingredients.beans.id, quantity: 18, unit: "GRAM", wastePercentage: 2.5 }] } }, include: { items: true } });
  await db.recipe.update({ where: { id: recipe.id }, data: { verifiedById: owner.id, verifiedAt: new Date(), verifiedFingerprint: recipeFingerprint(recipe.items, { appliesToAllVariants: true }) } });
  const branch = await db.branch.findUniqueOrThrow({ where: { id: ingredients.beans.branchId } });
  return { fx, product, addOn, recipe, branch, ...ingredients };
}
type Ctx = Awaited<ReturnType<typeof setup>>;
type Raw = Record<string, unknown>;
type Preview = { rows: { rowNumber: number; errors: string[] }[]; previewToken: string; stats: { errors: number; recipes: number } };
function row(c: Ctx, extra: Raw = {}): Raw {
  return { recipeId: c.recipe.id, scope: "PRODUCT_DEFAULT", productId: c.product.id, productName: c.product.name, inventoryItemId: c.beans.id, ingredientName: c.beans.name, ingredientBranchId: c.branch.id, ingredientBranchName: c.branch.name, quantity: 18, unit: "GRAM", wastePercentage: 2.5, appliesToAllVariants: true, notApplicable: false, ...extra };
}
async function preview(rows: Raw[], mode = "replace") {
  const r = await as<Preview>(OWNER, "/api/recipe-import/preview", { method: "POST", body: JSON.stringify({ rows, mode }) });
  assert.equal(r.status, 200, r.text.slice(0, 250));
  return r.body;
}
async function apply(rows: Raw[], p: Preview, mode = "replace") {
  return as(OWNER, "/api/recipe-import", { method: "POST", body: JSON.stringify({ rows, mode, previewToken: p.previewToken, fileName: "r6.xlsx" }) });
}
async function current(c: Ctx) { return db.recipe.findUniqueOrThrow({ where: { id: c.recipe.id }, include: { items: true } }); }
async function cleanup(c: Ctx) {
  if (owned?.cafeId === c.fx.cafeId) owned = null;
  await teardownTaggedCafe(c.fx.cafeId);
}

describe("RECIPE-006 bounded spreadsheet exchange", () => {
  test("product SKU resolves only within the cafe and agrees with supplied identity", async () => {
    const c = await setup();
    try {
      await db.product.update({ where: { id: c.product.id }, data: { sku: "B4-DRINK" } });
      const rows = [row(c, { productId: undefined, productName: undefined, productSku: "B4-DRINK", quantity: 22 })];
      const p = await preview(rows);
      assert.equal(p.stats.errors, 0, "SKU-only product mapping must resolve the existing product");
      assert.equal((await apply(rows, p)).status, 200);
      assert.equal(Number((await current(c)).items[0].quantity), 22);
      assert.ok((await preview([row(c, { productSku: "FOREIGN-SKU" })])).stats.errors > 0, "SKU and ID must agree");
      assert.ok((await preview([row(c, { productId: undefined, productName: undefined, productSku: "FOREIGN-SKU" })])).stats.errors > 0);
      const exported = await fetch(BASE + "/api/recipe-import/export", { headers: { cookie } });
      const workbook = XLSX.read(await exported.arrayBuffer(), { type: "array" });
      const exportedRows = XLSX.utils.sheet_to_json<Raw>(workbook.Sheets["Recipes"]);
      assert.equal(exportedRows.find(r => r.recipeId === c.recipe.id)?.productSku, "B4-DRINK");
      assert.equal((await db.product.findUniqueOrThrow({ where: { id: c.product.id } })).sku, "B4-DRINK");
    } finally { await cleanup(c); }
  });
  // Catches exporting effective per-size copies or omitting real scopes/flags.
  test("XLSX export contains actual default, variant and addon recipes once", async () => {
    const c = await setup();
    try {
      const variant = await db.recipe.create({ data: { cafeId: c.fx.cafeId, productId: c.product.id, variantId: c.product.variants[0].id, items: { create: [{ inventoryItemId: c.milk.id, quantity: 125.125, unit: "ML", wastePercentage: 1.25 }] } } });
      const addon = await db.recipe.create({ data: { cafeId: c.fx.cafeId, addOnId: c.addOn.id, notApplicable: true, notApplicableReason: "sealed bottle" } });
      const r = await fetch(BASE + "/api/recipe-import/export", { headers: { cookie } });
      assert.equal(r.status, 200);
      assert.match(r.headers.get("content-type") || "", /spreadsheetml/);
      const book = XLSX.read(await r.arrayBuffer(), { type: "array" });
      const rows = XLSX.utils.sheet_to_json<Raw>(book.Sheets["Recipes"]);
      const own = rows.filter(r => [c.recipe.id, variant.id, addon.id].includes(String(r.recipeId)));
      assert.equal(own.length, 3, "all-variants default is exported once, not as effective large copy");
      assert.equal(own.find(r => r.recipeId === c.recipe.id)?.appliesToAllVariants, true);
      assert.equal(own.find(r => r.recipeId === c.recipe.id)?.ingredientBranchId, c.branch.id);
      assert.equal(own.find(r => r.recipeId === variant.id)?.quantity, 125.125);
      assert.equal(own.find(r => r.recipeId === addon.id)?.notApplicableReason, "sealed bottle");
      const p = await preview(own);
      assert.equal(p.stats.errors, 0, "exported actual recipes round-trip");
    } finally { await cleanup(c); }
  });

  // Catches preview writes and imports touching unrelated operational values.
  test("preview is read-only; changed recipe needs confirmation and preserves stocks and prices", async () => {
    const c = await setup();
    try {
      const before = await current(c);
      const stock = await db.inventoryItem.findUniqueOrThrow({ where: { id: c.beans.id } });
      const rows = [row(c, { quantity: 22.125 })];
      const p = await preview(rows);
      assert.equal(p.stats.errors, 0);
      assert.deepEqual(await current(c), before, "preview must write nothing");
      const result = await apply(rows, p);
      assert.equal(result.status, 200, result.text);
      const changed = await current(c);
      assert.equal(Number(changed.items[0].quantity), 22.125);
      assert.equal(changed.verifiedAt, null);
      assert.equal(changed.verifiedFingerprint, null);
      assert.deepEqual(await db.inventoryItem.findUniqueOrThrow({ where: { id: c.beans.id } }), stock);
      const product = await db.product.findUniqueOrThrow({ where: { id: c.product.id }, include: { variants: true } });
      assert.equal(Number(product.basePrice), 51);
      assert.equal(Number(product.costPrice), 7);
      assert.deepEqual(product.variants.map(v => Number(v.price)).sort((a,b) => a-b), [40,70]);
      assert.equal(Number((await db.addOn.findUniqueOrThrow({ where: { id: c.addOn.id } })).price), 11);
      assert.equal(await db.auditLog.count({ where: { cafeId: c.fx.cafeId, entityId: c.recipe.id, action: "RECIPE_IMPORTED" } }), 1);
    } finally { await cleanup(c); }
  });

  test("unchanged import retains valid confirmation and line identity", async () => {
    const c = await setup();
    try {
      const before = await current(c), rows = [row(c)];
      const p = await preview(rows);
      assert.equal((await apply(rows, p)).status, 200);
      assert.deepEqual(await current(c), before);
    } finally { await cleanup(c); }
  });

  test("new-only skips existing recipes but creates an explicitly declared addon", async () => {
    const c = await setup();
    try {
      const before = await current(c);
      const rows = [row(c, { quantity: 99 }), { scope: "ADDON", addOnId: c.addOn.id, addOnName: c.addOn.name, notApplicable: true, notApplicableReason: "sealed bottle", appliesToAllVariants: false }];
      const p = await preview(rows, "new-only");
      assert.equal((await apply(rows, p, "new-only")).status, 200);
      assert.deepEqual(await current(c), before);
      const created = await db.recipe.findFirstOrThrow({ where: { addOnId: c.addOn.id }, include: { items: true } });
      assert.equal(created.notApplicable, true);
      assert.equal(created.notApplicableReason, "sealed bottle");
      assert.equal(created.items.length, 0);
    } finally { await cleanup(c); }
  });

  // Catches silent ID fallback, guessed numeric values and silent DB rounding.
  test("invalid references, duplicates and precision are preview errors and cannot apply", async () => {
    const c = await setup();
    try {
      const cases: Raw[][] = [
        [row(c, { inventoryItemId: "missing" })], [row(c, { ingredientName: c.milk.name })],
        [row(c, { ingredientBranchId: "missing" })], [row(c, { productId: "missing" })],
        [row(c, { variantId: c.product.variants[0].id })], [row(c), row(c)],
        [row(c, { unit: "ML" })], [row(c, { quantity: "" })], [row(c, { quantity: 0 })],
        [row(c, { quantity: 18.0001 })], [row(c, { wastePercentage: 1.001 })],
        [row(c, { notApplicable: true, notApplicableReason: "sealed" })],
      ];
      for (const rows of cases) {
        const p = await preview(rows);
        assert.ok(p.stats.errors > 0, JSON.stringify(rows));
        assert.ok(p.rows.some(r => r.errors.length > 0));
        const result = await apply(rows, p);
        assert.ok(result.status >= 400, "invalid file cannot partly import");
        assert.equal(Number((await current(c)).items[0].quantity), 18);
      }
    } finally { await cleanup(c); }
  });

  test("name-only matching rejects ambiguity and foreign tenant identifiers", async () => {
    const c = await setup();
    const other = await db.cafe.create({ data: { name: tag("R6-other"), slug: tag("r6-other").toLowerCase() } });
    let duplicate: string | null = null;
    try {
      const category = await db.menuCategory.create({ data: { cafeId: other.id, name: "other" } });
      const foreign = await db.product.create({ data: { cafeId: other.id, categoryId: category.id, name: c.product.name, basePrice: 10 } });
      assert.ok((await preview([row(c, { productId: foreign.id })])).stats.errors > 0);
      const copy = await db.inventoryItem.create({ data: { cafeId: c.fx.cafeId, branchId: c.branch.id, name: c.beans.name, unit: "GRAM", costPerUnit: 1 } });
      duplicate = copy.id;
      assert.ok((await preview([row(c, { inventoryItemId: undefined })])).stats.errors > 0, "ingredient name+branch has two identities");
      assert.equal(Number((await current(c)).items[0].quantity), 18);
    } finally {
      if (duplicate) await db.inventoryItem.delete({ where: { id: duplicate } });
      await db.cafe.delete({ where: { id: other.id } });
      await cleanup(c);
    }
  });

  test("stale or tampered preview refuses the entire commit", async () => {
    const c = await setup();
    try {
      const rows = [row(c, { quantity: 22 })], p = await preview(rows);
      assert.ok((await apply([row(c, { quantity: 99 })], p)).status >= 400);
      await db.recipeItem.update({ where: { id: c.recipe.items[0].id }, data: { quantity: 19 } });
      assert.equal((await apply(rows, p)).status, 409);
      assert.equal(Number((await current(c)).items[0].quantity), 19);
      assert.equal(await db.auditLog.count({ where: { entityId: c.recipe.id, action: "RECIPE_IMPORTED" } }), 0);
    } finally { await cleanup(c); }
  });

  test("audit failure rolls back every recipe in the imported file", async () => {
    const c = await setup();
    const fn = "ph1_r6_block_import_audit", trg = "ph1_r6_block_import_audit_trg";
    try {
      const rows = [row(c, { quantity: 22 }), { scope: "ADDON", addOnId: c.addOn.id, notApplicable: true, notApplicableReason: "sealed", appliesToAllVariants: false }];
      const p = await preview(rows);
      await db.$executeRawUnsafe("CREATE FUNCTION " + fn + "() RETURNS trigger AS $f$ BEGIN IF NEW.action = 'RECIPE_IMPORTED' AND NEW.\"cafeId\" = '" + c.fx.cafeId + "' THEN RAISE EXCEPTION 'R6 audit failure'; END IF; RETURN NEW; END; $f$ LANGUAGE plpgsql");
      await db.$executeRawUnsafe('CREATE TRIGGER ' + trg + ' BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION ' + fn + '()');
      assert.ok((await apply(rows, p)).status >= 400);
      assert.equal(Number((await current(c)).items[0].quantity), 18);
      assert.equal(await db.recipe.count({ where: { addOnId: c.addOn.id } }), 0);
    } finally {
      await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS ' + trg + ' ON "AuditLog"');
      await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS ' + fn + '()');
      await cleanup(c);
    }
  });

  test("recipe capability is required for export, preview and apply", async () => {
    for (const [path, init] of [["/api/recipe-import/export", {}], ["/api/recipe-import/preview", { method: "POST", body: JSON.stringify({ rows: [], mode: "replace" }) }], ["/api/recipe-import", { method: "POST", body: JSON.stringify({ rows: [], mode: "replace" }) }]] as const) {
      assert.equal((await as(BARISTA, path, init)).status, 403);
    }
  });
});
