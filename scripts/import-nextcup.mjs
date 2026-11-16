// One-off, repeatable import of the supplied Next Cup exports into the
// explicitly marked disposable test database. Dry-run unless --apply is set.
import { PrismaClient } from "@prisma/client";
import { TEST_DATABASE_URL, assertTestDatabaseMarker } from "./test-db.mjs";
import { readRows, parseProducts, parseSales, reconcileRecipes, sourceHash } from "./nextcup-source.mjs";

function option(name) {
  const at = process.argv.indexOf(name);
  return at < 0 ? null : process.argv[at + 1];
}
const paths = { products: option("--products"), sales: option("--sales"), recipes: option("--recipes") };
const cafeId = option("--cafe-id");
const apply = process.argv.includes("--apply");
if (Object.values(paths).some(value => !value) || !cafeId) {
  throw new Error("Usage: node scripts/import-nextcup.mjs --products <xlsx> --sales <csv> --recipes <csv> --cafe-id <id> [--apply]");
}

const parsedProducts = parseProducts(readRows(paths.products));
const parsedSales = parseSales(readRows(paths.sales));
const recipes = reconcileRecipes(readRows(paths.recipes), parsedProducts.products);
const productSkus = new Set(parsedProducts.products.map(row => row.sku));
const missingSaleSkus = [...new Set(parsedSales.sales.map(row => row.sku).filter(sku => !productSkus.has(sku)))];
if (missingSaleSkus.length) throw new Error(`Sales SKUs absent from product workbook: ${missingSaleSkus.join(", ")}`);
if (parsedProducts.rejected.length !== 1 || parsedProducts.rejected[0].row !== 188) {
  throw new Error("Product workbook rejected rows changed; inspect before import");
}
if (recipes.length !== 52 || recipes.filter(row => row.skuMatchesName).length !== 1) {
  throw new Error("Recipe reconciliation changed; inspect before import");
}

const db = new PrismaClient({ datasourceUrl: TEST_DATABASE_URL });
try {
  await assertTestDatabaseMarker(db);
  const cafe = await db.cafe.findUnique({ where: { id: cafeId }, select: { id: true, name: true } });
  if (!cafe) throw new Error(`Cafe ${cafeId} does not exist in the disposable test DB`);
  const hash = sourceHash(paths.sales);
  const existing = await db.historicalSaleLine.count({ where: { cafeId, sourceHash: hash } });
  const preview = {
    mode: apply ? "APPLY" : "DRY_RUN", cafe,
    database: "cafe_ops_test@127.0.0.1:5434",
    products: parsedProducts.products.length,
    invalidProductRows: parsedProducts.rejected,
    historicalSaleLines: parsedSales.sales.length,
    historicalSalesTotal: parsedSales.footerTotal,
    saleDateRange: [parsedSales.sales.reduce((min, row) => row.saleDate < min ? row.saleDate : min, "9999-99-99"), parsedSales.sales.reduce((max, row) => row.saleDate > max ? row.saleDate : max, "0000-00-00")],
    existingLinesFromThisFile: existing,
    recipesHeldForReview: recipes.length,
    recipesWithMatchingNames: recipes.filter(row => row.matchedProductSku).length,
    recipesWithMatchingSkuAndName: recipes.filter(row => row.skuMatchesName).length,
  };
  console.log(JSON.stringify(preview, null, 2));
  if (!apply) process.exitCode = 0;
  else {
    const otherSourceCount = await db.historicalSaleLine.count({ where: { cafeId, sourceHash: { not: hash } } });
    if (otherSourceCount) throw new Error("Another sales source is already imported for this cafe; reconcile before changing it");
    await db.$transaction(async tx => {
      const categories = await tx.menuCategory.findMany({ where: { cafeId }, select: { id: true, name: true } });
      const categoryByName = new Map(categories.map(row => [row.name, row.id]));
      for (const name of [...new Set(parsedProducts.products.map(row => row.category))]) {
        if (categoryByName.has(name)) continue;
        const created = await tx.menuCategory.create({ data: { cafeId, name } });
        categoryByName.set(name, created.id);
      }
      // Historical order items keep their foreign keys; these records leave
      // the selling catalog without erasing earlier manual test evidence.
      await tx.product.updateMany({ where: { cafeId, sku: null }, data: { isActive: false, showInPOS: false, showInCustomerMenu: false, isAvailable: false } });
      const sourceSkus = parsedProducts.products.map(row => row.sku);
      await tx.product.updateMany({ where: { cafeId, sku: { not: null, notIn: sourceSkus } }, data: { isActive: false, showInPOS: false, showInCustomerMenu: false, isAvailable: false } });
      for (const [index, row] of parsedProducts.products.entries()) {
        const sellable = row.category !== "manufacturing";
        const data = { name: row.name, categoryId: categoryByName.get(row.category), basePrice: row.price,
          isActive: true, showInPOS: sellable, showInCustomerMenu: sellable, isAvailable: sellable, sortOrder: index };
        await tx.product.upsert({ where: { cafeId_sku: { cafeId, sku: row.sku } },
          create: { cafeId, sku: row.sku, ...data }, update: data });
      }
      await tx.menuCategory.updateMany({
        where: { cafeId, name: { notIn: [...categoryByName.keys()].filter(name => parsedProducts.products.some(row => row.category === name)) } },
        data: { isActive: false, showInCustomerMenu: false },
      });
      if (existing === 0) {
        for (let i = 0; i < parsedSales.sales.length; i += 500) {
          await tx.historicalSaleLine.createMany({ data: parsedSales.sales.slice(i, i + 500).map(row => ({ cafeId, sourceHash: hash, ...row })) });
        }
      } else if (existing !== parsedSales.sales.length) {
        throw new Error(`Partial existing sales import: ${existing} rows`);
      }
    }, { timeout: 120000, maxWait: 10000 });
    const [productCount, saleSummary] = await Promise.all([
      db.product.count({ where: { cafeId, sku: { not: null }, isActive: true } }),
      db.historicalSaleLine.aggregate({ where: { cafeId, sourceHash: hash }, _count: true, _sum: { total: true } }),
    ]);
    console.log(JSON.stringify({ importedProducts: productCount, importedSaleLines: saleSummary._count,
      importedSalesTotal: Number(saleSummary._sum.total ?? 0), recipesImported: 0 }, null, 2));
  }
} finally {
  await db.$disconnect();
}
