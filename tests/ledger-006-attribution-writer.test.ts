import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import {
  applyStockMutation,
  ledgerDeltaAbove,
  resolveStockAttribution,
  type StockMutation,
} from "@/lib/ledger";
import { db, tag, teardownTaggedCafe } from "./helpers/db";

const MARKER = tag("LEDGER006");
let cafeId: string;
let sourceBranchId: string;
let destinationBranchId: string;
let userA: string;
let userB: string;

type HasIndependentAttributionOverride =
  "custodyPeriodId" extends keyof StockMutation
    ? true
    : "shiftId" extends keyof StockMutation
      ? true
      : false;
const noIndependentAttributionOverrides: HasIndependentAttributionOverride = false;
void noIndependentAttributionOverrides;

before(async () => {
  const cafe = await db.cafe.create({
    data: {
      name: `${MARKER} cafe`,
      slug: MARKER.toLowerCase(),
      settings: { create: {} },
      branches: { create: [{ name: `${MARKER} source` }, { name: `${MARKER} destination` }] },
    },
    include: { branches: { orderBy: { createdAt: "asc" } } },
  });
  cafeId = cafe.id;
  sourceBranchId = cafe.branches[0].id;
  destinationBranchId = cafe.branches[1].id;

  const createUser = async (suffix: string) => (await db.user.create({
    data: {
      cafeId, branchId: sourceBranchId,
      email: `${MARKER}-${suffix}@example.invalid`, name: `${MARKER}-${suffix}`,
      passwordHash: "no-login-path", role: "CASHIER",
    },
  })).id;
  userA = await createUser("a");
  userB = await createUser("b");
});

after(() => teardownTaggedCafe(cafeId, [], { disconnect: true }));

async function item(branchId = sourceBranchId, stock = 10) {
  return db.inventoryItem.create({
    data: {
      cafeId, branchId, name: `${MARKER} item ${crypto.randomUUID()}`,
      unit: "KG", costPerUnit: 1, currentStock: stock,
    },
  });
}

async function shift(branchId: string, cashierId = userA) {
  const last = await db.shift.aggregate({ where: { branchId }, _max: { shiftNumber: true } });
  return db.shift.create({
    data: {
      cafeId, branchId, cashierId, shiftNumber: (last._max.shiftNumber ?? 0) + 1,
      openingCashAmount: 0, expectedCashAmount: 0,
    },
  });
}

async function closeOpenStockCustody(branchId: string) {
  await db.custodyPeriod.updateMany({
    where: { branchId, scope: "STOCK", status: "OPEN" }, data: { status: "CLOSED", endedAt: new Date() },
  });
}

async function stockCustody(
  branchId: string,
  data: Record<string, unknown> = {}
) {
  await closeOpenStockCustody(branchId);
  return db.custodyPeriod.create({
    data: { cafeId, branchId, scope: "STOCK", ...data } as never,
  });
}

async function mutate(inventoryItemId: string, branchId = sourceBranchId, extra: Partial<StockMutation> = {}) {
  return db.$transaction((tx) => applyStockMutation(tx, {
    inventoryItemId, type: "ADJUSTMENT", quantity: 1, cafeId, branchId, ...extra,
  }));
}

describe("LEDGER-006 stock-custody attribution writer", () => {
  test("stamps an active STOCK custody and its responsible shift", async () => {
    const responsible = await shift(sourceBranchId);
    const custody = await stockCustody(sourceBranchId, { responsibleShiftId: responsible.id });
    const result = await mutate((await item()).id);
    const row = await db.inventoryTransaction.findUniqueOrThrow({ where: { id: result.transactionId } });

    assert.deepEqual(
      { custodyPeriodId: row.custodyPeriodId, shiftId: row.shiftId },
      { custodyPeriodId: custody.id, shiftId: responsible.id }
    );
    assert.deepEqual(
      { custodyPeriodId: result.custodyPeriodId, shiftId: result.shiftId },
      { custodyPeriodId: custody.id, shiftId: responsible.id }
    );
  });

  test("writes a null pair when no STOCK custody is open", async () => {
    await closeOpenStockCustody(sourceBranchId);
    const result = await mutate((await item()).id);
    const row = await db.inventoryTransaction.findUniqueOrThrow({ where: { id: result.transactionId } });

    assert.deepEqual(
      { custodyPeriodId: row.custodyPeriodId, shiftId: row.shiftId },
      { custodyPeriodId: null, shiftId: null }
    );
    assert.deepEqual(
      { custodyPeriodId: result.custodyPeriodId, shiftId: result.shiftId },
      { custodyPeriodId: null, shiftId: null }
    );
  });

  test("uses an explicit attribution snapshot verbatim instead of resolving branch state", async () => {
    const responsible = await shift(sourceBranchId);
    await stockCustody(sourceBranchId, { responsibleShiftId: responsible.id });
    const explicitShift = await shift(destinationBranchId);
    const explicitCustody = await stockCustody(destinationBranchId, { responsibleShiftId: explicitShift.id });
    const result = await mutate((await item()).id, sourceBranchId, {
      attribution: { custodyPeriodId: explicitCustody.id, shiftId: explicitShift.id },
    });
    const row = await db.inventoryTransaction.findUniqueOrThrow({ where: { id: result.transactionId } });

    assert.deepEqual(
      { custodyPeriodId: row.custodyPeriodId, shiftId: row.shiftId },
      { custodyPeriodId: explicitCustody.id, shiftId: explicitShift.id }
    );
    assert.deepEqual(
      { custodyPeriodId: result.custodyPeriodId, shiftId: result.shiftId },
      { custodyPeriodId: explicitCustody.id, shiftId: explicitShift.id }
    );
  });

  test("keeps STOCK responsibility on the custody shift when a SHARED coworker has another open shift", async () => {
    const responsible = await shift(sourceBranchId, userA);
    const coworkerShift = await shift(sourceBranchId, userB);
    const custody = await stockCustody(sourceBranchId, {
      responsibleShiftId: responsible.id,
      participants: { create: [{ userId: userA, role: "PRIMARY" }, { userId: userB, role: "SHARED" }] },
    });
    const result = await mutate((await item()).id, sourceBranchId, { createdById: userB });

    assert.notEqual(responsible.id, coworkerShift.id);
    assert.deepEqual(
      { custodyPeriodId: result.custodyPeriodId, shiftId: result.shiftId },
      { custodyPeriodId: custody.id, shiftId: responsible.id }
    );
  });

  test("keeps BRANCH custody evidence without fabricating a shift", async () => {
    const custody = await stockCustody(sourceBranchId, { holderType: "BRANCH" });
    const result = await mutate((await item()).id);
    const row = await db.inventoryTransaction.findUniqueOrThrow({ where: { id: result.transactionId } });

    assert.deepEqual(
      { custodyPeriodId: row.custodyPeriodId, shiftId: row.shiftId },
      { custodyPeriodId: custody.id, shiftId: null }
    );
  });

  test("uses the destination STOCK custody for a TRANSFER_IN movement", async () => {
    const sourceShift = await shift(sourceBranchId);
    const destinationShift = await shift(destinationBranchId);
    const sourceCustody = await stockCustody(sourceBranchId, { responsibleShiftId: sourceShift.id });
    const destinationCustody = await stockCustody(destinationBranchId, { responsibleShiftId: destinationShift.id });
    const result = await mutate((await item(destinationBranchId)).id, destinationBranchId, { type: "TRANSFER_IN" });

    assert.notEqual(sourceCustody.id, destinationCustody.id);
    assert.deepEqual(
      { custodyPeriodId: result.custodyPeriodId, shiftId: result.shiftId },
      { custodyPeriodId: destinationCustody.id, shiftId: destinationShift.id }
    );
  });

  test("resolves and inserts inside the caller transaction, so rollback leaves no movement", async () => {
    const custody = await stockCustody(sourceBranchId, { responsibleShiftId: (await shift(sourceBranchId)).id });
    const inventoryItem = await item();

    await assert.rejects(() => db.$transaction(async (tx) => {
      const result = await applyStockMutation(tx, {
        inventoryItemId: inventoryItem.id, type: "ADJUSTMENT", quantity: 1, cafeId, branchId: sourceBranchId,
      });
      assert.equal(result.custodyPeriodId, custody.id);
      throw new Error("deliberate rollback");
    }));

    assert.equal(await db.inventoryTransaction.count({ where: { inventoryItemId: inventoryItem.id } }), 0);
  });

  test("resolver is read-only and returns responsibility from the custody row", async () => {
    const responsible = await shift(sourceBranchId);
    const unrelatedOpenShift = await shift(sourceBranchId, userB);
    const custody = await stockCustody(sourceBranchId, { responsibleShiftId: responsible.id });
    const observed: string[] = [];
    const observer = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL, log: [{ emit: "event", level: "query" }] });
    observer.$on("query", (event) => observed.push(event.query));

    try {
      const resolved = await observer.$transaction((tx) => resolveStockAttribution(tx, sourceBranchId));
      assert.notEqual(responsible.id, unrelatedOpenShift.id);
      assert.deepEqual(resolved, { custodyPeriodId: custody.id, shiftId: responsible.id });
      assert.ok(observed.length > 0, "the resolver must query through its supplied transaction");
      assert.ok(observed.every((sql) => /^\s*(?:BEGIN|COMMIT|ROLLBACK|SELECT)\b/i.test(sql)), observed.join("\n"));
    } finally {
      await observer.$disconnect();
    }
  });

  test("retains exact item-version increments and ledgerDeltaAbove quantity semantics", async () => {
    await closeOpenStockCustody(sourceBranchId);
    const inventoryItem = await item(sourceBranchId, 0);
    const previousVersion = inventoryItem.ledgerVersion;
    const first = await mutate(inventoryItem.id, sourceBranchId, { quantity: 1 });
    const second = await mutate(inventoryItem.id, sourceBranchId, { quantity: -0.25 });

    assert.equal(first.itemVersion, previousVersion + BigInt(1));
    assert.equal(second.itemVersion, first.itemVersion + BigInt(1));
    assert.deepEqual(
      await ledgerDeltaAbove(db, inventoryItem.id, previousVersion),
      { delta: 0.75, movementCount: 2 }
    );
  });
});
