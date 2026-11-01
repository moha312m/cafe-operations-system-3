import assert from "node:assert/strict";
import test from "node:test";
import { loadResaleModule } from "./helpers/resale-offline";

class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }
const boundaries = { "@/lib/api": { ApiError }, "@/lib/db": { db: {} }, "@/lib/inventory-freeze": { acquireInventorySharedLocks: async () => {} } };
test("offline acceptance: legacy pending QR is never converted", async () => {
  const app = loadResaleModule<typeof import("@/lib/sale-consumption")>("src/lib/sale-consumption.ts", boundaries);
  let writes = 0;
  const tx = { order: { findUnique: async () => ({ id: "o", items: [{ stockModeSnapshot: null }] }) }, orderItem: { update: async () => { writes++; } } };
  await (app.finalizeOrderConsumption)(tx, "o", new Date());
  assert.equal(writes, 0);
});
test("offline acceptance: provisional catalog identities are server-derived and binding-free", () => {
  const app = loadResaleModule<typeof import("@/lib/sale-consumption")>("src/lib/sale-consumption.ts", boundaries);
  const result = (app.provisionalConsumption)({ id: "p", stockMode: "FINISHED_GOOD" }, "v");
  assert.equal(result.stockModeSnapshot, "FINISHED_GOOD");
  assert.equal(result.stockProductIdSnapshot, "p");
  assert.equal(result.stockVariantIdSnapshot, "v");
  assert.equal("finishedStockItemId" in result, false);
  assert.equal("stockAcceptedAt" in result, false);
});

function acceptanceFixture({ enabled = true, missingProduct = false, foreignBranch = false, deletedPreparedVariant = false } = {}) {
  const line = { id: "line", productId: "p", variantId: null, quantity: 2, stockModeSnapshot: deletedPreparedVariant ? "RECIPE" : "FINISHED_GOOD", stockProductIdSnapshot: "p", stockVariantIdSnapshot: deletedPreparedVariant ? "deleted-variant" : null, stockAcceptedAt: null as Date | null, voidedAt: null, productName: "piece", addOns: [] };
  const stock = { id: "original", cafeId: "c", branchId: foreignBranch ? "other" : "b", unit: "PIECE", isActive: true, archivedAt: null };
  const product = { id: "p", cafeId: "c", stockMode: "FINISHED_GOOD", isActive: true, isAvailable: true };
  const writes: object[] = [];
  const tx = { $queryRaw: async () => [], order: { findUnique: async () => ({ id: "o", cafeId: "c", branchId: "b", inventoryEnforcementMode: "STRICT", items: [line] }) }, orderItem: { update: async ({ data }: { data: object }) => { writes.push(data); } }, cafeSettings: { findUnique: async () => ({ finishedGoodsSalesEnabled: enabled, inventoryEnabled: true }) }, product: { findFirst: async () => missingProduct ? null : product }, productVariant: { count: async () => 0 }, productStockBinding: { findFirst: async () => ({ product, variant: null, branch: { isActive: true, cafeId: "c" }, unit: "PIECE", inventoryItem: stock }) } };
  const app = loadResaleModule<typeof import("@/lib/sale-consumption")>("src/lib/sale-consumption.ts", { ...boundaries, "@/lib/stock-availability": { checkCartAvailability: async () => ({ ok: true }) } });
  return { app, tx, writes };
}

test("offline approval includes prepared lines as shared finished-stock demand only", async () => {
  const f = acceptanceFixture();
  const order = await f.tx.order.findUnique();
  order.items.push({ ...order.items[0], id: "prepared", productId: "prepared", stockProductIdSnapshot: "prepared", stockModeSnapshot: "RECIPE", stockAcceptedAt: new Date() });
  f.tx.order.findUnique = async () => order;
  let captured: { lines: { productId: string; stockMode: string; sharedFinishedStockOnly?: boolean }[] } | undefined;
  const app = loadResaleModule<typeof import("@/lib/sale-consumption")>("src/lib/sale-consumption.ts", { ...boundaries, "@/lib/stock-availability": { checkCartAvailability: async (input: typeof captured) => { captured = input; return { ok: true }; } } });
  await (app.finalizeOrderConsumption)(f.tx, "o", new Date());
  assert.equal(captured?.lines.length, 2);
  assert.equal(captured?.lines[1].stockMode, "RECIPE");
  assert.equal(captured?.lines[1].sharedFinishedStockOnly, true);
});
test("offline acceptance: exact identities and sold quantity freeze at approval", async () => {
  const f = acceptanceFixture();
  await (f.app.finalizeOrderConsumption)(f.tx, "o", new Date());
  assert.equal((f.writes[0] as { finishedStockItemId: string }).finishedStockItemId, "original");
  assert.equal((f.writes[0] as { finishedStockQuantity: number }).finishedStockQuantity, 2);
});
for (const [name, options] of [["gate off", { enabled: false }], ["deleted provisional finished catalog", { missingProduct: true }], ["foreign stock branch", { foreignBranch: true }], ["deleted prepared variant becoming a finished base", { deletedPreparedVariant: true }]] as const) {
  test("offline acceptance refuses " + name, async () => {
    const f = acceptanceFixture(options);
    await assert.rejects(() => (f.app.finalizeOrderConsumption)(f.tx, "o", new Date()));
    assert.equal(f.writes.length, 0);
  });
}

test("offline menu API gives cost-authorized managers stock choices for binding editor", async () => {
  const stock = [{ id: "stock", name: "piece", branchId: "b" }];
  const app = loadResaleModule<typeof import("@/app/api/products/route")>("src/app/api/products/route.ts", {
    "next/server": { NextResponse: { json: (value: object) => value } },
    "@/lib/api": { ApiError, requirePermission: async () => ({ role: "CAFE_OWNER", cafeId: "c", branchId: null }), resolveCafeId: () => "c", handleApiError: (error: Error) => { throw error; } },
    "@/lib/db": { db: { product: { findMany: async () => [{ id: "p", basePrice: 10, variants: [] }] }, inventoryItem: { findMany: async () => stock } } },
    "@/lib/permissions": { hasPermission: () => true }, "@/lib/recipes": { configurationFinancials: async () => ({ costStatus: "AVAILABLE" }) },
    "@/lib/price-authorization": {}, "@/lib/audit": {},
  });
  const response = await (app.GET)({ nextUrl: { searchParams: new URLSearchParams() } }) as unknown as { bindingStockItems: typeof stock };
  assert.equal(response.bindingStockItems, stock);
});
