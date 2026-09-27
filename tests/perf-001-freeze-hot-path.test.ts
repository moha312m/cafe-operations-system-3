import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { PrismaClient } from "@prisma/client";
import { db, closeOpenShifts, tag, teardownTaggedCafe } from "./helpers/db";
import { applyStockMutation } from "@/lib/ledger";
import { deductStockForOrder } from "@/lib/stock-deduction";
import {
  acquireInventoryExclusiveLock,
  acquireInventoryFreeze,
  acquireInventorySharedLocks,
  activeFreezeFor,
  InventoryFrozenError,
  releaseInventoryFreeze,
} from "@/lib/inventory-freeze";

const MARKER = tag("PERF001");
const runtimeFiles = [
  "src/lib/inventory-freeze.ts",
  "src/lib/ledger.ts",
  "src/lib/stock-deduction.ts",
  "src/lib/stock-rebase.ts",
  "src/app/api/inventory/transfer/route.ts",
  "src/app/api/purchases/[id]/confirm/route.ts",
];

let cafeId: string;
let branchId: string;
let actorId: string;
let handoverSequence = 0;

type QueryCounts = { total: number; sharedLocks: number; activeFreezes: number };
type QueryClient = PrismaClient & {
  $on(eventType: "query", callback: (event: { query: string }) => void): void;
};

function newQueryClient(): QueryClient {
  return new PrismaClient({
    datasourceUrl: process.env.DATABASE_URL,
    log: [{ emit: "event", level: "query" }],
  }) as unknown as QueryClient;
}

function queryCounts(client: QueryClient) {
  const counts: QueryCounts = { total: 0, sharedLocks: 0, activeFreezes: 0 };
  client.$on("query", (event) => {
    counts.total += 1;
    if (/pg_advisory_xact_lock_shared/i.test(event.query)) counts.sharedLocks += 1;
    if (/FROM\s+(?:"public"\.)?"InventoryFreeze"/i.test(event.query) && /"releasedAt"/i.test(event.query) && /"branchId"/i.test(event.query) && /\bLIMIT\b/i.test(event.query)) {
      counts.activeFreezes += 1;
    }
  });
  return counts;
}

async function item(label: string, stock = 100) {
  return db.inventoryItem.create({
    data: { cafeId, branchId, name: `${MARKER} ${label}`, unit: "KG", currentStock: stock, costPerUnit: 10 },
  });
}

async function handover(label: string) {
  handoverSequence += 1;
  // One drawer per cashier: close the one a previous test left open rather
  // than deleting it, so its evidence survives.
  await closeOpenShifts(branchId, actorId);
  const shift = await db.shift.create({
    data: {
      cafeId, branchId, cashierId: actorId, shiftNumber: 980000 + handoverSequence,
      openingCashAmount: 0, expectedCashAmount: 0,
    },
  });
  return db.handoverSession.create({
    data: {
      cafeId, branchId, outgoingShiftId: shift.id, outgoingUserId: actorId,
      status: "COMPLETED", completedAt: new Date(),
    },
  });
}

async function clearFreezes() {
  await db.$executeRawUnsafe('DELETE FROM "InventoryFreeze" WHERE "cafeId" = $1', cafeId);
}

async function guardedCalls(client: QueryClient, n: number) {
  const inventory = await item(`hot-${n}`);
  const counts = queryCounts(client);
  await client.$transaction(async (tx) => {
    for (let i = 0; i < n; i += 1) {
      await applyStockMutation(tx, {
        inventoryItemId: inventory.id, cafeId, branchId, type: "ADJUSTMENT", quantity: 1,
        attribution: { custodyPeriodId: null, shiftId: null },
      });
    }
  });
  return counts;
}

async function servedMeasurement(client: QueryClient, ingredientCount: number) {
  const category = await db.menuCategory.create({ data: { cafeId, name: `${MARKER} category ${ingredientCount}` } });
  const ingredients = await Promise.all(Array.from({ length: ingredientCount }, (_, index) => item(`served-${ingredientCount}-${index}`)));
  const product = await db.product.create({ data: { cafeId, categoryId: category.id, name: `${MARKER} product ${ingredientCount}`, basePrice: 10 } });
  await db.recipe.create({
    data: {
      cafeId, productId: product.id,
      items: { create: ingredients.map((inventoryItem) => ({ inventoryItemId: inventoryItem.id, quantity: 1, unit: "KG" })) },
    },
  });
  const order = await db.order.create({
    data: {
      cafeId, branchId, orderNumber: 990000 + handoverSequence++, type: "TAKEAWAY", status: "READY",
      source: "CASHIER_POS", subtotal: 10, total: 10, remainingAmount: 10,
      items: { create: { productId: product.id, productName: product.name, unitPrice: 10, quantity: 1, lineTotal: 10 } },
    },
  });
  const counts = queryCounts(client);
  const started = performance.now();
  await client.$transaction(async (tx) => {
    await deductStockForOrder(tx, order.id, actorId, { custodyPeriodId: null, shiftId: null });
    await tx.order.update({ where: { id: order.id }, data: { status: "SERVED", stockDeductedAt: new Date(), servedAt: new Date() } });
  });
  return { counts, elapsed: performance.now() - started };
}

before(async () => {
  const cafe = await db.cafe.create({
    data: {
      name: `${MARKER} cafe`, slug: MARKER.toLowerCase(), settings: { create: {} },
      branches: { create: { name: `${MARKER} branch` } },
    }, include: { branches: true },
  });
  cafeId = cafe.id;
  branchId = cafe.branches[0]!.id;
  actorId = (await db.user.create({
    data: {
      cafeId, branchId, email: `${MARKER}@example.invalid`, passwordHash: "no-login",
      name: MARKER, role: "BRANCH_MANAGER",
    },
  })).id;
});

after(async () => teardownTaggedCafe(cafeId, [], { disconnect: true }));

describe("PERF-001 freeze hot path", () => {
  test("memoizes guarded same-branch lookup and shared-lock SQL for 1, 8, and 20 mutations", async () => {
    const observed: Array<{ n: number; counts: QueryCounts }> = [];
    for (const n of [1, 8, 20]) {
      await clearFreezes();
      const client = newQueryClient();
      try {
        const counts = await guardedCalls(client, n);
        observed.push({ n, counts });
      } finally {
        await client.$disconnect();
      }
    }
    assert.deepEqual(observed.map(({ n, counts }) => [n, counts.activeFreezes, counts.sharedLocks]), [
      [1, 1, 1], [8, 1, 1], [20, 1, 1],
    ]);
  });

  test("does not inherit cached null across transactions after an exclusive freezer commits", async () => {
    await clearFreezes();
    const inventory = await item("isolation");
    const h = await handover("isolation");
    await db.$transaction(async (tx) => {
      await acquireInventorySharedLocks(tx, [branchId]);
      assert.equal(await activeFreezeFor(tx, branchId), null);
    });
    await db.$transaction((tx) => acquireInventoryFreeze(tx, {
      cafeId, branchId, handoverId: h.id, startedById: actorId,
    }));
    await assert.rejects(
      () => db.$transaction((tx) => applyStockMutation(tx, {
        inventoryItemId: inventory.id, cafeId, branchId, type: "ADJUSTMENT", quantity: 1,
      })),
      InventoryFrozenError
    );
  });

  test("invalidates a cached active freeze after release and rereads durable state", async () => {
    await clearFreezes();
    const h = await handover("release");
    await db.$transaction((tx) => acquireInventoryFreeze(tx, {
      cafeId, branchId, handoverId: h.id, startedById: actorId,
    }));
    const client = newQueryClient();
    const counts = queryCounts(client);
    try {
      await client.$transaction(async (tx) => {
        await acquireInventorySharedLocks(tx, [branchId]);
        assert.deepEqual(await activeFreezeFor(tx, branchId), { freezeId: (await db.inventoryFreeze.findUniqueOrThrow({ where: { handoverId: h.id } })).id, handoverId: h.id });
        assert.deepEqual(await releaseInventoryFreeze(tx, { handoverId: h.id, actorId }), { released: true });
        const beforePostReleaseLookup = counts.activeFreezes;
        assert.equal(await activeFreezeFor(tx, branchId), null);
        assert.equal(counts.activeFreezes, beforePostReleaseLookup + 1);
      });
    } finally {
      await client.$disconnect();
    }
  });

  test("replaces cached null with the exact new freeze after same-transaction upgrade", async () => {
    await clearFreezes();
    const h = await handover("acquire");
    await db.$transaction(async (tx) => {
      await acquireInventorySharedLocks(tx, [branchId]);
      assert.equal(await activeFreezeFor(tx, branchId), null);
      await acquireInventoryExclusiveLock(tx, branchId);
      const acquired = await acquireInventoryFreeze(tx, { cafeId, branchId, handoverId: h.id, startedById: actorId });
      assert.deepEqual(await activeFreezeFor(tx, branchId), { freezeId: acquired.freezeId, handoverId: h.id });
    });
  });

  test("keeps frozen multi-item mutations atomic", async () => {
    await clearFreezes();
    const first = await item("atomic-first");
    const second = await item("atomic-second");
    const h = await handover("atomic");
    await db.$transaction((tx) => acquireInventoryFreeze(tx, { cafeId, branchId, handoverId: h.id, startedById: actorId }));
    await assert.rejects(() => db.$transaction(async (tx) => {
      await applyStockMutation(tx, { inventoryItemId: first.id, cafeId, branchId, type: "USAGE", quantity: -1 });
      await applyStockMutation(tx, { inventoryItemId: second.id, cafeId, branchId, type: "USAGE", quantity: -1 });
    }), InventoryFrozenError);
    assert.equal(await db.inventoryTransaction.count({ where: { inventoryItemId: { in: [first.id, second.id] }, type: "USAGE" } }), 0);
    assert.equal(Number((await db.inventoryItem.findUniqueOrThrow({ where: { id: first.id } })).currentStock), 100);
    assert.equal(Number((await db.inventoryItem.findUniqueOrThrow({ where: { id: second.id } })).currentStock), 100);
  });

  test("contains no runtime freeze bypass and keeps writer guard ordering", () => {
    const sources = runtimeFiles.map((file) => readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")).join("\n");
    assert.doesNotMatch(sources, /\b(?:DISABLE_FREEZE|SKIP_FREEZE_CHECK|SKIP_INVENTORY_FREEZE|freezeGuardEnabled|benchmark\s*mode|performance\s*mode)\b/i);
    assert.doesNotMatch(sources, /NODE_ENV\s*===\s*["']test["']/);
    const ledger = readFileSync("src/lib/ledger.ts", "utf8");
    const writer = ledger.slice(ledger.indexOf("export async function applyStockMutation"));
    assert.ok(writer.indexOf("acquireInventorySharedLocks") < writer.indexOf("activeFreezeFor"));
    assert.ok(writer.indexOf("activeFreezeFor") < writer.indexOf("lockItemForUpdate"));
  });

  test("measures actual 8- and 20-ingredient served deductions with constant freeze overhead", async () => {
    await clearFreezes();
    const client = newQueryClient();
    try {
      for (const ingredientCount of [8, 20]) {
        const samples = [] as number[];
        const queryTotals = [] as number[];
        for (let run = 0; run < 3; run += 1) {
          const measured = await servedMeasurement(client, ingredientCount);
          samples.push(measured.elapsed);
          queryTotals.push(measured.counts.total);
          assert.equal(measured.counts.activeFreezes, 1, `${ingredientCount} ingredients: one active-freeze SELECT`);
          assert.equal(measured.counts.sharedLocks, 1, `${ingredientCount} ingredients: one SHARED lock`);
        }
        samples.sort((a, b) => a - b);
        queryTotals.sort((a, b) => a - b);
        console.log(`[PERF-001] ingredients=${ingredientCount} totalSql=${queryTotals[1]} p50=${samples[1]!.toFixed(2)}ms p95=${samples[2]!.toFixed(2)}ms`);
        assert.ok(samples[0]! >= 0, `${ingredientCount} ingredient timing samples recorded`);
      }
    } finally {
      await client.$disconnect();
    }
  });
});
