import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "@prisma/client";
import { loadResaleModule } from "./helpers/resale-offline";

class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }
function fixture({ carried = false, stock = 10, mode = "STRICT", deferred = false } = {}) {
  const calls: { excludeBase?: boolean }[] = [];
  const movements: Record<string, unknown>[] = [];
  const item = { id: "line", productId: "product", variantId: null, productName: "Prepared category", variantName: null, quantity: 2, addOns: [], stockModeSnapshot: "FINISHED_GOOD" as "RECIPE" | "FINISHED_GOOD" | null, stockAcceptedAt: new Date(), stockProductIdSnapshot: "product", finishedStockCafeId: "c", finishedStockBranchId: "b", finishedStockItemId: "piece", finishedStockUnit: "PIECE", finishedStockQuantity: 2, finishedStockTransactionId: null as string | null, finishedStockDeductedAt: null };
  const inventory = { id: "piece", cafeId: "c", branchId: "b", name: "piece", unit: "PIECE", currentStock: stock };
  const order = { id: "o", orderNumber: 1, cafeId: "c", branchId: "b", inventoryEnforcementMode: mode, stockDeductedAt: carried ? new Date() : null, status: deferred ? "SERVED" : "READY", items: [item] };
  const tx = {
    order: { findUnique: async () => order, update: async () => {} },
    orderItem: { update: async ({ data }: { data: object }) => Object.assign(item, data) },
    deferredStockDeduction: { findFirst: async () => deferred ? { id: "d" } : null },
    inventoryItem: { findUnique: async () => inventory, findFirst: async () => inventory },
  };
  const app = loadResaleModule<typeof import("@/lib/stock-deduction")>("src/lib/stock-deduction.ts", {
    "@/lib/api": { ApiError }, "@/lib/db": { db: {} },
    "@/lib/audit": { audit: async () => {}, auditInTransaction: async () => {} },
    "@/lib/inventory-freeze": { acquireInventorySharedLocks: async () => {} },
    "@/lib/recipes": { theoreticalConsumption: async (args: { excludeBase?: boolean }) => { calls.push(args); return { lines: [{ inventoryItemId: "piece", quantityInStockUnit: args.excludeBase ? 1 : 20 }], complete: true, issues: [] }; } },
    "@/lib/ledger": { MissingInventoryItemError: class extends Error {}, lockItemForUpdate: async () => ({ currentStock: stock, unit: "PIECE", costPerUnitExact: new Prisma.Decimal(2.5) }), applyStockMutation: async (_tx: unknown, input: Record<string, unknown>) => { movements.push(input); return { transactionId: "usage" }; } },
  });
  return { app, tx, item, calls, movements };
}

test("offline mixed approval counts prepared demand sharing finished stock without new prepared refusals", async () => {
  const stock = { id: "piece", name: "piece", unit: "PIECE", currentStock: 2 };
  const app = loadResaleModule<typeof import("@/lib/stock-availability")>("src/lib/stock-availability.ts", { "@/lib/db": { db: {} }, "@/lib/sale-consumption": { cartLineConsumption: async (_tx: unknown, _scope: unknown, line: { label: string }) => ({ finishedItem: line.label === "FG" ? stock : null, recipe: { issues: line.label === "unknown" ? ["MISSING_RECIPE"] : [], lines: line.label === "prepared" ? [{ inventoryItemId: "piece", quantityInStockUnit: 1 }] : [] } }) } });
  const tx = { inventoryItem: { findMany: async () => [stock] } };
  const line = (label: string) => ({ label, productId: "p", variantId: null, addOnIds: [], quantity: 2, sharedFinishedStockOnly: label !== "FG" });
  const result = await (app.checkCartAvailability)({ cafeId: "c", branchId: "b", mode: "STRICT", lines: [line("FG"), line("prepared"), line("unknown")] }, tx);
  assert.equal(result.knownConsumption[0].required, 3);
  assert.deepEqual(Array.from(result.refusals, (r: { kind: string }) => r.kind), ["INSUFFICIENT"]);
});

test("offline shared demand retains known prepared consumption when another add-on is unresolved", async () => {
  const stock = { id: "piece", name: "piece", unit: "PIECE", currentStock: 2 };
  const app = loadResaleModule<typeof import("@/lib/stock-availability")>("src/lib/stock-availability.ts", { "@/lib/db": { db: {} }, "@/lib/sale-consumption": { cartLineConsumption: async (_tx: unknown, _scope: unknown, line: { label: string }) => ({ finishedItem: line.label === "FG" ? stock : null, recipe: { issues: line.label === "FG" ? [] : ["MISSING_ADDON_RECIPE"], lines: line.label === "FG" ? [] : [{ inventoryItemId: "piece", quantityInStockUnit: 1 }] } }) } });
  const tx = { inventoryItem: { findMany: async () => [stock] } };
  const result = await app.checkCartAvailability({ cafeId: "c", branchId: "b", mode: "OVERRIDE_ALL", lines: [{ productId: "p", variantId: null, addOnIds: [], quantity: 2, label: "FG" }, { productId: "recipe", variantId: null, addOnIds: ["missing"], quantity: 1, label: "prepared", sharedFinishedStockOnly: true }] }, tx);
  assert.equal(result.knownConsumption[0].required, 3);
  assert.equal(result.ok, false);
});
test("offline: finished base excludes recipe; its add-on shares one aggregate movement", async () => {
  const f = fixture();
  await (f.app.deductStockForOrder)(f.tx, "o", "actor");
  assert.equal(f.calls[0].excludeBase, true);
  assert.equal(f.movements.length, 1);
  assert.equal(f.movements[0].quantity, -3);
  assert.equal(f.item.finishedStockTransactionId, "usage");
});
test("offline: recipe completion cannot suppress remaining finished goods", async () => {
  const f = fixture({ carried: true });
  await (f.app.deductStockForOrder)(f.tx, "o", "actor");
  assert.equal(f.calls.length, 0);
  assert.equal(f.movements[0].quantity, -2);
});

test("offline recipe-only and legacy consumption retains the saved permissive policy", async () => {
  for (const mode of [null, "RECIPE"] as const) {
    const f = fixture({ stock: 1, mode: "OVERRIDE_ALL" });
    f.item.stockModeSnapshot = mode;
    await f.app.deductStockForOrder(f.tx, "o", "actor");
    assert.equal(f.calls[0].excludeBase, false);
    assert.equal(f.movements[0].quantity, -20);
    assert.equal(f.movements[0].allowNegative, true);
    assert.equal(f.item.finishedStockTransactionId, null);
  }
});

test("offline carry consumes finished-line add-ons without consuming its base or linking usage", async () => {
  const f = fixture();
  await f.app.deductStockForOrder(f.tx, "o", "actor", undefined, { boundary: "CARRY_RECIPES" });
  assert.equal(f.movements[0].quantity, -1);
  assert.equal(f.item.finishedStockTransactionId, null);
});
test("offline: normal finished shortages refuse even with permissive recipe policy", async () => {
  const f = fixture({ stock: 1, mode: "OVERRIDE_ALL" });
  await assert.rejects(() => (f.app.deductStockForOrder)(f.tx, "o", "actor"));
  assert.equal(f.movements.length, 0);
});
test("offline: full deferred usage may become negative, never net against returns", async () => {
  const f = fixture({ stock: 1, deferred: true });
  await (f.app.deductStockForOrder)(f.tx, "o", "actor", undefined, { boundary: "DEFERRED", forceAllowNegative: true });
  assert.equal(f.movements[0].quantity, -3);
});
test("offline: force-negative option cannot escape the served deferred boundary", async () => {
  const f = fixture({ stock: 1 });
  await assert.rejects(() => (f.app.deductStockForOrder)(f.tx, "o", "actor", undefined, { forceAllowNegative: true }));
  assert.equal(f.movements.length, 0);
});

test("offline real recipe engine: finished bases exclude base ingredients; actual add-ons still convert units", async () => {
  const ingredient = { id: "beans", name: "beans", unit: "KG", costPerUnit: 100, isActive: true, archivedAt: null };
  const recipe = (quantity: number) => ({ id: "recipe", notApplicable: false, verifiedAt: null, verifiedById: null, verifiedFingerprint: null, appliesToAllVariants: false, items: [{ inventoryItemId: "beans", quantity, unit: "GRAM", wastePercentage: 0, inventoryItem: ingredient }] });
  const tx = { recipe: { findFirst: async ({ where }: { where: { addOnId?: string } }) => recipe(where.addOnId ? 5 : 100) }, productVariant: { count: async () => 0 } };
  const app = loadResaleModule<typeof import("@/lib/recipes")>("src/lib/recipes.ts", { "@/lib/db": { db: tx } });
  const consume = app.theoreticalConsumption;
  const finished = await consume({ productId: "p", variantId: null, addOnIds: ["shot"], quantity: 2, excludeBase: true }, tx);
  assert.equal(finished.lines[0].quantityInStockUnit, 0.01);
  const legacy = await consume({ productId: "p", variantId: null, addOnIds: ["shot"], quantity: 2 }, tx);
  assert.equal(legacy.lines[0].quantityInStockUnit, 0.21);
});

for (const [name, recipeQuantity] of [["finished-only", 0], ["finished plus same-stock add-on", 1]] as const) {
  test("offline actual availability aggregates " + name + " before acceptance", async () => {
    const stock = { id: "piece", name: "piece", unit: "PIECE", currentStock: 1 };
    const app = loadResaleModule<typeof import("@/lib/stock-availability")>("src/lib/stock-availability.ts", { "@/lib/db": { db: {} }, "@/lib/sale-consumption": { cartLineConsumption: async () => ({ finishedItem: stock, recipe: { issues: [], lines: recipeQuantity ? [{ inventoryItemId: "piece", quantityInStockUnit: recipeQuantity }] : [] } }) } });
    const tx = { inventoryItem: { findMany: async () => [stock] } };
    const result = await (app.checkCartAvailability)({ cafeId: "c", branchId: "b", mode: "OVERRIDE_ALL", lines: [{ productId: "p", variantId: null, addOnIds: [], quantity: 2, label: "FG" }] }, tx);
    assert.equal(result.ok, false);
    assert.equal(result.knownConsumption[0].required, 2 + recipeQuantity);
    assert.ok(result.refusals[0].kind === "INSUFFICIENT");
    assert.equal(result.refusals[0].finished, true);
  });
}
