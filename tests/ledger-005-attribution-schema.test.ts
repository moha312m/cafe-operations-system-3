import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { db, fixture, tag, type Fixture } from "./helpers/db";

const MARKER = tag("LEDGER005");
const M12 = "20260830230911_custody_holder_and_ledger_attribution";
let fx: Fixture;
let userId: string;
const itemIds: string[] = [];

before(async () => {
  fx = await fixture();
  userId = (await db.user.findFirstOrThrow({ where: { branchId: fx.branchId } })).id;
});

after(async () => {
  if (itemIds.length) {
    await db.inventoryTransaction.deleteMany({ where: { inventoryItemId: { in: itemIds } } });
    await db.inventoryItem.deleteMany({ where: { id: { in: itemIds } } });
  }
  await db.$disconnect();
});

async function item() {
  const created = await db.inventoryItem.create({
    data: {
      cafeId: fx.cafeId, branchId: fx.branchId, name: `${MARKER} item ${itemIds.length}`,
      unit: "KG", costPerUnit: 1, currentStock: 0,
    },
  });
  itemIds.push(created.id);
  return created;
}

async function shift() {
  const last = await db.shift.aggregate({ where: { branchId: fx.branchId }, _max: { shiftNumber: true } });
  return db.shift.create({
    data: {
      cafeId: fx.cafeId, branchId: fx.branchId, cashierId: userId,
      shiftNumber: (last._max.shiftNumber ?? 0) + 1, openingCashAmount: 0, expectedCashAmount: 0,
    },
  });
}

async function custody() {
  return db.custodyPeriod.create({
    data: { cafeId: fx.cafeId, branchId: fx.branchId, scope: "STOCK", status: "CLOSED" },
  });
}

async function movement(inventoryItemId: string, extra: Record<string, unknown> = {}) {
  return db.inventoryTransaction.create({
    data: {
      cafeId: fx.cafeId, branchId: fx.branchId, inventoryItemId, type: "ADJUSTMENT",
      quantity: 1, itemVersion: BigInt(1), ...extra,
    } as never,
  });
}

describe("LEDGER-005 historical attribution schema", () => {
  test("persists nullable custody-period and shift attribution on a movement", async () => {
    const inventoryItem = await item();
    const linkedShift = await shift();
    const period = await custody();
    const transaction = await movement(inventoryItem.id, {
      custodyPeriodId: period.id, shiftId: linkedShift.id,
    });
    const saved = await db.inventoryTransaction.findUniqueOrThrow({ where: { id: transaction.id } });
    assert.equal(saved.custodyPeriodId, period.id);
    assert.equal(saved.shiftId, linkedShift.id);
  });

  test("deleting an attributed shift preserves its transaction and item version", async () => {
    const inventoryItem = await item();
    const linkedShift = await shift();
    const transaction = await movement(inventoryItem.id, { shiftId: linkedShift.id });
    await db.shift.delete({ where: { id: linkedShift.id } });
    const saved = await db.inventoryTransaction.findUniqueOrThrow({ where: { id: transaction.id } });
    assert.equal(saved.shiftId, null);
    assert.equal(saved.itemVersion, BigInt(1));
  });

  test("deleting an attributed custody period preserves its transaction", async () => {
    const inventoryItem = await item();
    const period = await custody();
    const transaction = await movement(inventoryItem.id, { custodyPeriodId: period.id });
    await db.custodyPeriod.delete({ where: { id: period.id } });
    const saved = await db.inventoryTransaction.findUniqueOrThrow({ where: { id: transaction.id } });
    assert.equal(saved.custodyPeriodId, null);
  });

  test("retains item-local ledger uniqueness while attribution is nullable", async () => {
    const inventoryItem = await item();
    await movement(inventoryItem.id);
    await assert.rejects(() => movement(inventoryItem.id), /unique|P2002/i);
  });

  test("indexes custody-period type and shift attribution for ledger queries", async () => {
    const indexes = await db.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'InventoryTransaction'
    `;
    const definitions = indexes.map((row) => row.indexdef.replaceAll('"', ''));
    assert.ok(definitions.some((index) => /\(custodyPeriodId, type\)/.test(index)));
    assert.ok(definitions.some((index) => /\(shiftId\)/.test(index)));
  });

  test("M12 migration contains no historical data update", () => {
    const path = `prisma/migrations/${M12}/migration.sql`;
    assert.equal(existsSync(path), true, "the allocated M12 migration must exist");
    const sql = readFileSync(path, "utf8");
    assert.doesNotMatch(sql, /^\s*(?:UPDATE|INSERT|DELETE|TRUNCATE)\b/gim);
  });
});
