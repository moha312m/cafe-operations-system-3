import assert from "node:assert/strict";
import test from "node:test";
import { loadResaleModule } from "./helpers/resale-offline";

test("offline finished cost is exact branch reference cost and never product manual cost", async () => {
  const app = loadResaleModule<typeof import("@/lib/recipes")>("src/lib/recipes.ts", { "@/lib/db": { db: { product: { findUnique: async () => ({ stockMode: "FINISHED_GOOD", cafeId: "c", costPrice: 1000 }) }, productStockBinding: { findFirst: async () => ({ inventoryItem: { costPerUnit: 3, unit: "PIECE", archivedAt: null, isActive: true } }) }, recipe: { findFirst: async () => null } } } });
  const result = await (app.configurationFinancials)({ productId: "p", variantId: null, branchId: "b", sellingPrice: 10 });
  assert.equal(result.cost, 3);
  assert.equal(result.profit, 7);
});

test("offline finished history guards retain units and pending obligations while allowing settled archive", async () => {
  class ApiError extends Error {}
  const app = loadResaleModule<typeof import("@/lib/finished-stock-history")>("src/lib/finished-stock-history.ts", { "@/lib/api": { ApiError } });
  const tx = { productStockBinding: { count: async () => 0 }, orderItem: { count: async () => 1 }, finishedGoodsReturn: { count: async () => 0 } };
  await assert.rejects(() => app.assertFinishedStockEditable(tx, "i", { changingUnit: true }));
  await assert.rejects(() => app.assertFinishedStockEditable(tx, "i", { retire: true }));
  tx.orderItem.count = async () => 0;
  tx.finishedGoodsReturn.count = async () => 1;
  await assert.rejects(() => app.assertFinishedStockEditable(tx, "i", { retire: true }));
  tx.finishedGoodsReturn.count = async () => 0;
  await app.assertFinishedStockEditable(tx, "i", { retire: true });
});

test("offline existing receiving arithmetic keeps PIECE reference cost weighted", () => {
  const app = loadResaleModule<typeof import("@/lib/purchases")>("src/lib/purchases.ts");
  assert.equal(app.weightedAverageCost(10, 2, 10, 4), 3);
  assert.equal(app.paymentStatusFor(80, 0), "UNPAID");
});

test("offline finished bases cannot become eligible for prepared-recipe variance costing", async () => {
  const app = loadResaleModule<typeof import("@/lib/recipes")>("src/lib/recipes.ts", { "@/lib/db": { db: { product: { findUnique: async () => ({ stockMode: "FINISHED_GOOD" }) }, recipe: { findFirst: async () => { throw new Error("Finished base must not consult prepared verification"); } } } } });
  const result = await app.isEligibleForVarianceCosting({ productId: "p", variantId: null });
  assert.equal(result.eligible, false);
});
test("offline missing finished reference cost leaves margin unavailable", async () => {
  const app = loadResaleModule<typeof import("@/lib/recipes")>("src/lib/recipes.ts", { "@/lib/db": { db: { product: { findUnique: async () => ({ stockMode: "FINISHED_GOOD", cafeId: "c" }) }, productStockBinding: { findFirst: async () => ({ inventoryItem: { costPerUnit: 0, unit: "PIECE", archivedAt: null, isActive: true } }) }, recipe: { findFirst: async () => null } } } });
  const result = await (app.configurationFinancials)({ productId: "p", variantId: null, branchId: "b", sellingPrice: 10 });
  assert.equal(result.costStatus, "MISSING_COST");
  assert.equal(result.cost, null);
  assert.equal(result.margin, null);
});
