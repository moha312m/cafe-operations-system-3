// Imports only BOM rows whose product name has one unambiguous match in the
// supplied menu workbook. The BOM's own SKU column is deliberately not used:
// it conflicts with the product workbook for 51 of its 52 rows.
import { PrismaClient } from "@prisma/client";
import { TEST_DATABASE_URL, assertTestDatabaseMarker } from "./test-db.mjs";
import { readRows, parseProducts, reconcileRecipes, recipeIngredientLines } from "./nextcup-source.mjs";

function option(name) {
  const at = process.argv.indexOf(name);
  return at < 0 ? null : process.argv[at + 1];
}

const productsPath = option("--products");
const recipesPath = option("--recipes");
const cafeId = option("--cafe-id");
const apply = process.argv.includes("--apply");
if (!productsPath || !recipesPath || !cafeId) {
  throw new Error("Usage: node scripts/import-nextcup-recipes.mjs --products <xlsx> --recipes <csv> --cafe-id <id> [--apply]");
}

const products = parseProducts(readRows(productsPath)).products;
const reconciliation = reconcileRecipes(readRows(recipesPath), products);
const matched = reconciliation
  .filter(row => row.matchedProductSku)
  .map(row => ({ ...row, ...recipeIngredientLines(row) }));
if (matched.length !== 33) throw new Error(`Expected 33 exact-name recipe matches, found ${matched.length}`);
if (matched.some(row => row.lines.length === 0)) throw new Error("A matched recipe has no measured ingredients");

const db = new PrismaClient({ datasourceUrl: TEST_DATABASE_URL });
try {
  await assertTestDatabaseMarker(db);
  const cafe = await db.cafe.findUnique({ where: { id: cafeId }, select: { id: true, name: true } });
  if (!cafe) throw new Error(`Cafe ${cafeId} does not exist in the disposable test DB`);
  const materialKeys = new Set(matched.flatMap(row => row.lines.map(line => `${line.name}:${line.unit}`)));
  const summary = {
    mode: apply ? "APPLY" : "DRY_RUN", cafe, database: "cafe_ops_test@127.0.0.1:5434",
    recipesToImport: matched.length, recipesHeldForReview: reconciliation.length - matched.length,
    materialsToCreateOrReuse: materialKeys.size,
    optionalIngredientsNotFixed: matched.flatMap(row => row.skipped.map(value => ({ product: row.productName, value }))),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!apply) process.exitCode = 0;
  else {
    await db.$transaction(async tx => {
      const branches = await tx.branch.findMany({ where: { cafeId, isActive: true }, select: { id: true } });
      if (!branches.length) throw new Error("No active branch found for the target cafe");
      const materials = new Map();
      for (const branch of branches) {
        for (const key of materialKeys) {
          const [name, unit] = key.split(":");
          let item = await tx.inventoryItem.findFirst({
            where: { cafeId, branchId: branch.id, name, unit, archivedAt: null },
            select: { id: true },
          });
          if (!item) {
            item = await tx.inventoryItem.create({
              data: { cafeId, branchId: branch.id, name, unit, category: "Imported recipe material", currentStock: 0, minimumStock: 0, costPerUnit: 0 },
              select: { id: true },
            });
          }
          materials.set(`${branch.id}:${key}`, item.id);
        }
      }
      const defaultBranchId = branches[0].id;
      for (const recipe of matched) {
        const product = await tx.product.findUnique({ where: { cafeId_sku: { cafeId, sku: recipe.matchedProductSku } }, select: { id: true } });
        if (!product) throw new Error(`Product SKU ${recipe.matchedProductSku} disappeared during recipe import`);
        const existing = await tx.recipe.findFirst({ where: { productId: product.id, variantId: null, addOnId: null }, select: { id: true } });
        const parent = existing
          ? await tx.recipe.update({ where: { id: existing.id }, data: { verifiedById: null, verifiedAt: null, verifiedFingerprint: null, updatedById: null } })
          : await tx.recipe.create({ data: { cafeId, productId: product.id } });
        await tx.recipeItem.deleteMany({ where: { recipeId: parent.id } });
        await tx.recipeItem.createMany({ data: recipe.lines.map(line => ({
          recipeId: parent.id, inventoryItemId: materials.get(`${defaultBranchId}:${line.name}:${line.unit}`),
          quantity: line.quantity, unit: line.unit, wastePercentage: 0,
        })) });
      }
    }, { timeout: 120000, maxWait: 10000 });
    const [recipeCount, recipeItems, materialCount] = await Promise.all([
      db.recipe.count({ where: { cafeId, product: { sku: { not: null } } } }),
      db.recipeItem.count({ where: { recipe: { cafeId, product: { sku: { not: null } } } } }),
      db.inventoryItem.count({ where: { cafeId, category: "Imported recipe material", archivedAt: null } }),
    ]);
    console.log(JSON.stringify({ importedRecipes: recipeCount, importedRecipeItems: recipeItems, materialsAcrossBranches: materialCount }, null, 2));
  }
} finally {
  await db.$disconnect();
}
