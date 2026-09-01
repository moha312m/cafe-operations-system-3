import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { db, fixture, tag, type Fixture } from "./helpers/db";
import { as, login, requireServer } from "./helpers/http";
import { applyStockMutation, ledgerDeltaAbove } from "@/lib/ledger";

const MARKER = tag("LEDGER007");
const OWNER = "owner@demo.com";
let fx: Fixture;
let ownerId: string;
let secondBranchId: string;
let sourceHandoverId: string;
let destinationHandoverId: string;
const itemIds: string[] = [];
const handoverIds: string[] = [];
const shiftIds: string[] = [];

type FreezeLib = typeof import("@/lib/inventory-freeze");
const freezeLib = (): Promise<FreezeLib> => import("@/lib/inventory-freeze");

async function ingredient(branchId: string, suffix: string, stock = 10) {
  const item = await db.inventoryItem.create({
    data: {
      cafeId: fx.cafeId, branchId, name: `${MARKER} ${suffix}`,
      unit: "KG", currentStock: stock, costPerUnit: 100,
    },
  });
  itemIds.push(item.id);
  return item;
}

async function makeHandover(branchId: string, n: number) {
  const latest = await db.shift.findFirst({
    where: { branchId }, orderBy: { shiftNumber: "desc" }, select: { shiftNumber: true },
  });
  const shift = await db.shift.create({
    data: {
      cafeId: fx.cafeId, branchId, cashierId: ownerId,
      shiftNumber: Math.max(920000 + n, (latest?.shiftNumber ?? 0) + 1),
      openingCashAmount: 0, expectedCashAmount: 0,
    },
  });
  shiftIds.push(shift.id);
  const h = await db.handoverSession.create({
    data: {
      cafeId: fx.cafeId, branchId, outgoingShiftId: shift.id, outgoingUserId: ownerId,
      status: "COMPLETED", completedAt: new Date(),
    },
  });
  handoverIds.push(h.id);
  return h.id;
}

async function freeze(branchId: string, handoverId: string) {
  const { acquireInventoryFreeze } = await freezeLib();
  return db.$transaction((tx) => acquireInventoryFreeze(tx, {
    cafeId: fx.cafeId, branchId, handoverId, startedById: ownerId,
  }));
}

async function clearFreezes() {
  await db.$executeRawUnsafe('DELETE FROM "InventoryFreeze" WHERE "cafeId" = $1', fx.cafeId);
  await db.auditLog.deleteMany({
    where: { cafeId: fx.cafeId, action: { in: ["INVENTORY_FROZEN", "INVENTORY_FREEZE_RELEASED"] } },
  });
}

before(async () => {
  fx = await fixture();
  ownerId = (await db.user.findUniqueOrThrow({ where: { email: OWNER } })).id;
  secondBranchId = (await db.branch.findFirstOrThrow({
    where: { cafeId: fx.cafeId, id: { not: fx.branchId } }, orderBy: { createdAt: "asc" },
  })).id;
  sourceHandoverId = await makeHandover(fx.branchId, 1);
  destinationHandoverId = await makeHandover(secondBranchId, 2);
  await requireServer();
  await login(OWNER, "owner1234");
});

beforeEach(clearFreezes);

after(async () => {
  await clearFreezes();
  if (itemIds.length) {
    await db.inventoryTransaction.deleteMany({ where: { inventoryItemId: { in: itemIds } } });
    await db.inventoryItem.deleteMany({ where: { id: { in: itemIds } } });
  }
  await db.handoverSession.deleteMany({ where: { id: { in: handoverIds } } });
  await db.shift.deleteMany({ where: { id: { in: shiftIds } } });
  await db.$disconnect();
});

describe("LEDGER-007 centralized freeze guard", () => {
  test("the freeze library and guarded writer contract are available", async () => {
    await assert.doesNotReject(() => freezeLib());
    const item = await ingredient(fx.branchId, "contract", 1);
    await assert.doesNotReject(() => db.$transaction((tx) => applyStockMutation(tx, {
      inventoryItemId: item.id, cafeId: fx.cafeId, branchId: fx.branchId,
      type: "ADJUSTMENT", quantity: 1, freezeToken: null,
    })));
  });

  test("no token and a wrong token reject before stock or ledger mutation", async () => {
    const item = await ingredient(fx.branchId, "reject", 10);
    await freeze(fx.branchId, sourceHandoverId);
    const beforeTransactions = await db.inventoryTransaction.count({ where: { inventoryItemId: item.id } });
    for (const token of [null, "wrong-handover"]) {
      await assert.rejects(
        () => db.$transaction((tx) => applyStockMutation(tx, {
          inventoryItemId: item.id, cafeId: fx.cafeId, branchId: fx.branchId,
          type: "USAGE", quantity: -1, freezeToken: token,
        })),
        (error: { status?: number }) => error.status === 409
      );
    }
    assert.equal(Number((await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).currentStock), 10);
    assert.equal(await db.inventoryTransaction.count({ where: { inventoryItemId: item.id } }), beforeTransactions);
  });

  test("a matching internal token succeeds and preserves attribution", async () => {
    const item = await ingredient(fx.branchId, "matching", 10);
    await freeze(fx.branchId, sourceHandoverId);
    const result = await db.$transaction((tx) => applyStockMutation(tx, {
      inventoryItemId: item.id, cafeId: fx.cafeId, branchId: fx.branchId,
      type: "ADJUSTMENT", quantity: 2, freezeToken: sourceHandoverId,
      attribution: { custodyPeriodId: null, shiftId: null },
    }));
    assert.equal(result.stockAfter, 12);
    assert.equal(result.custodyPeriodId, null);
    assert.equal(result.shiftId, null);
  });

  test("every transaction type reaches the same guard while another branch remains writable", async () => {
    const item = await ingredient(fx.branchId, "types", 50);
    const other = await ingredient(secondBranchId, "other", 50);
    await freeze(fx.branchId, sourceHandoverId);
    for (const type of [
      "PURCHASE", "USAGE", "WASTE", "ADJUSTMENT", "TRANSFER_IN", "TRANSFER_OUT", "RETURN", "COUNT_REBASE",
    ] as const) {
      await assert.rejects(() => db.$transaction((tx) => applyStockMutation(tx, {
        inventoryItemId: item.id, cafeId: fx.cafeId, branchId: fx.branchId,
        type, quantity: type === "USAGE" || type === "WASTE" || type === "TRANSFER_OUT" ? -1 : 1,
      })), (error: { status?: number }) => error.status === 409, type);
    }
    await assert.doesNotReject(() => db.$transaction((tx) => applyStockMutation(tx, {
      inventoryItemId: other.id, cafeId: fx.cafeId, branchId: secondBranchId,
      type: "ADJUSTMENT", quantity: 1,
    })));
  });

  test("reads and ledgerDeltaAbove remain available during a freeze", async () => {
    const item = await ingredient(fx.branchId, "reads", 10);
    await freeze(fx.branchId, sourceHandoverId);
    const listed = await as<{ items: { id: string }[] }>(OWNER, `/api/inventory?branchId=${fx.branchId}`);
    assert.ok(listed.status < 300, listed.text);
    assert.ok(listed.body.items.some((row) => row.id === item.id));
    assert.deepEqual(await ledgerDeltaAbove(db, item.id, BigInt(0)), { delta: 0, movementCount: 0 });
  });

  test("same-transaction guarded mutations share one durable active-freeze lookup", async () => {
    const item = await ingredient(fx.branchId, "baseline", 10);
    const client = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
    let activeLookups = 0;
    client.$on("query", (event) => {
      if (/FROM\s+(?:"public"\.)?"InventoryFreeze"/.test(event.query) && /releasedAt/.test(event.query)) {
        activeLookups += 1;
      }
    });
    await client.$transaction(async (tx) => {
      await applyStockMutation(tx, {
        inventoryItemId: item.id, cafeId: fx.cafeId, branchId: fx.branchId,
        type: "ADJUSTMENT", quantity: 1,
      });
      await applyStockMutation(tx, {
        inventoryItemId: item.id, cafeId: fx.cafeId, branchId: fx.branchId,
        type: "ADJUSTMENT", quantity: 1,
      });
    });
    await client.$disconnect();
    assert.equal(activeLookups, 1);
  });
});

describe("LEDGER-007 transfer freeze and tenancy safety", () => {
  test("a frozen source or destination leaves no surviving transfer half", async () => {
    for (const frozen of ["source", "destination"] as const) {
      await clearFreezes();
      const source = await ingredient(fx.branchId, `transfer-${frozen}`, 10);
      if (frozen === "source") await freeze(fx.branchId, sourceHandoverId);
      else await freeze(secondBranchId, destinationHandoverId);
      const response = await as(OWNER, "/api/inventory/transfer", {
        method: "POST",
        body: JSON.stringify({ inventoryItemId: source.id, toBranchId: secondBranchId, quantity: 1 }),
      });
      assert.equal(response.status, 409, response.text);
      assert.equal(Number((await db.inventoryItem.findUniqueOrThrow({ where: { id: source.id } })).currentStock), 10);
      assert.equal(await db.inventoryTransaction.count({ where: { inventoryItemId: source.id } }), 0);
      assert.equal(await db.inventoryItem.count({
        where: { branchId: secondBranchId, name: source.name, unit: source.unit },
      }), 0);
    }
  });

  test("an unauthorized destination is rejected without waiting on that branch advisory lock", async () => {
    const { acquireInventoryExclusiveLock } = await freezeLib();
    const foreign = await db.cafe.create({
      data: {
        name: `${MARKER} lock foreign`, slug: `${MARKER.toLowerCase()}-lock-foreign`,
        settings: { create: {} }, branches: { create: [{ name: "foreign" }] },
      }, include: { branches: true },
    });
    const source = await ingredient(fx.branchId, "tenant-order", 10);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const lockedSignal = new Promise<void>((resolve) => { locked = resolve; });
    const holder = db.$transaction(async (tx) => {
      await acquireInventoryExclusiveLock(tx, foreign.branches[0].id);
      locked();
      await gate;
    });
    await lockedSignal;
    try {
      const response = await as(OWNER, "/api/inventory/transfer", {
        method: "POST",
        signal: AbortSignal.timeout(2_000),
        body: JSON.stringify({ inventoryItemId: source.id, toBranchId: foreign.branches[0].id, quantity: 1 }),
      });
      assert.equal(response.status, 400);
    } finally {
      release();
      await holder;
      await db.branch.deleteMany({ where: { cafeId: foreign.id } });
      await db.cafeSettings.deleteMany({ where: { cafeId: foreign.id } });
      await db.cafe.delete({ where: { id: foreign.id } });
    }
  });
});
