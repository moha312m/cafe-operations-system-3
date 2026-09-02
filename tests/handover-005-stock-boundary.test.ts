// HANDOVER-005 — every ingredient gets a boundary, and an uncounted one says so.
//
// `StockCountLine` only exists for an item that was IN SCOPE. Under SELECTED
// most of the shelf has no line at all, and reading "no line" as "no
// variance" is the silent zero this milestone exists to prevent. So the
// boundary is the artifact rather than the count: one row per active branch
// item, counted or not.
//
// A counted item carries PHYSICAL_COUNT evidence and is verified. An
// uncounted one carries the book figure, is flagged unverified, and produces
// no variance and names nobody — an unverified boundary must have nowhere to
// record a difference it cannot know.
//
// The whole point is that quantity and cursor describe the SAME instant. A
// counted figure paired with a later ledger cursor would be a boundary that
// looks like evidence and is not, so a line whose count point was never
// locked is refused outright rather than repaired.

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Prisma } from "@prisma/client";
import type { InventoryUnit } from "@prisma/client";
import { db, tag, teardownTaggedCafe } from "./helpers/db";

const MARKER = tag("HANDOVER005");
const MIGRATION_NAME = "20260831001911_handover_stock_boundary";
const MIGRATION = `prisma/migrations/${MIGRATION_NAME}/migration.sql`;

type BoundaryLib = typeof import("@/lib/handover-boundary");
const boundaryLib = (): Promise<BoundaryLib> => import("@/lib/handover-boundary");

const statusIs = (status: number) => (error: unknown) =>
  (error as { status?: number }).status === status;

/**
 * Exactly seven eligible items, so "2 of 7 counted leaves 5 carried" is a
 * statement about the shelf rather than about whichever fixtures happened to
 * survive an earlier test. `golf` is deliberately unpriced.
 */
const ITEM_SPECS = [
  { key: "alpha", unit: "KG" as InventoryUnit, cost: 91, stock: 12.5, version: BigInt(41) },
  { key: "bravo", unit: "LITER" as InventoryUnit, cost: 47, stock: 3.25, version: BigInt(42) },
  { key: "charlie", unit: "BOX" as InventoryUnit, cost: 15, stock: 8, version: BigInt(43) },
  { key: "delta", unit: "PIECE" as InventoryUnit, cost: 4, stock: 100, version: BigInt(44) },
  { key: "echo", unit: "KG" as InventoryUnit, cost: 60, stock: 0.75, version: BigInt(45) },
  { key: "foxtrot", unit: "LITER" as InventoryUnit, cost: 22, stock: 9.125, version: BigInt(46) },
  { key: "golf", unit: "BOX" as InventoryUnit, cost: 0, stock: 5, version: BigInt(47) },
];

let cafeId: string;
let branchId: string;
let otherBranchId: string;
let userId: string;
let shiftId: string;
const itemIds: Record<string, string> = {};
let archivedId: string;
let inactiveId: string;
let rejectionReasonId: string;

async function createHandover(args: {
  status?: "DRAFT" | "COMPLETED" | "REJECTED";
  acceptedAt?: Date | null;
} = {}) {
  const status = args.status ?? "COMPLETED";
  return db.handoverSession.create({
    data: {
      cafeId,
      branchId,
      outgoingShiftId: shiftId,
      outgoingUserId: userId,
      status,
      acceptedAt: args.acceptedAt ?? null,
      completedAt: status === "COMPLETED" ? new Date() : null,
      rejectedAt: status === "REJECTED" ? new Date() : null,
      // A refusal with no stated reason is refused by the database itself.
      rejectionReasonCodeId: status === "REJECTED" ? rejectionReasonId : null,
    },
  });
}

/** A CONFIRMED count session with one line per named item. */
async function createCountSession(args: {
  handoverId?: string | null;
  lines: Array<{
    key: string;
    countedQuantity: number;
    itemVersion: bigint | null;
    unitCostSnapshot?: number | null;
    unitCostSource?: string | null;
  }>;
}) {
  const session = await db.stockCountSession.create({
    data: {
      cafeId,
      branchId,
      shiftId,
      type: "CRITICAL",
      status: "CONFIRMED",
      scopeDerivation: "CRITICAL_ONLY",
      initiatedById: userId,
      accountabilityContext: args.handoverId ? "HANDOVER" : "NONE",
      handoverId: args.handoverId ?? null,
    },
  });
  const lines: Record<string, string> = {};
  for (const spec of args.lines) {
    const item = ITEM_SPECS.find((i) => i.key === spec.key);
    const line = await db.stockCountLine.create({
      data: {
        sessionId: session.id,
        inventoryItemId: itemIds[spec.key],
        unit: item ? item.unit : "KG",
        countedQuantity: spec.countedQuantity,
        effectiveCountedQuantity: spec.countedQuantity,
        expectedQuantity: spec.countedQuantity,
        varianceQuantity: 0,
        itemVersion: spec.itemVersion,
        expectedBasis: spec.itemVersion === null ? null : "LOCKED_ITEM_VERSION",
        countedAt: new Date(),
        counterId: userId,
        disposition: "WITHIN_TOLERANCE",
        unitCostSnapshot: spec.unitCostSnapshot ?? null,
        unitCostSource: spec.unitCostSource ?? null,
        unitCostCapturedAt: spec.unitCostSnapshot == null ? null : new Date(),
      },
    });
    lines[spec.key] = line.id;
  }
  return { session, lines };
}

/** Build and persist in one transaction, the way SH-20 eventually will. */
async function buildAndPersist(handoverId: string, acceptedSessionId: string | null) {
  const lib = await boundaryLib();
  return db.$transaction(async (tx) => {
    const built = await lib.buildStockBoundary(tx, {
      cafeId,
      branchId,
      handoverId,
      acceptedSessionId,
    });
    const written = await lib.persistStockBoundary(tx, { handoverId, lines: built.lines });
    return { built, written };
  });
}

const rowsFor = (handoverId: string) =>
  db.handoverStockBoundary.findMany({
    where: { handoverId },
    orderBy: { inventoryItemId: "asc" },
  });

before(async () => {
  const cafe = await db.cafe.create({
    data: {
      name: MARKER + " cafe",
      slug: (MARKER + "-cafe").toLowerCase(),
      settings: { create: { stockCountPolicy: "HYBRID", handoverCountType: "CRITICAL" } },
      branches: { create: [{ name: MARKER + " main" }, { name: MARKER + " other" }] },
    },
    include: { branches: true },
  });
  cafeId = cafe.id;
  branchId = cafe.branches[0].id;
  otherBranchId = cafe.branches[1].id;

  const user = await db.user.create({
    data: {
      cafeId,
      branchId,
      email: MARKER + "-user@example.invalid",
      passwordHash: "no-login",
      name: MARKER + " user",
      role: "BRANCH_MANAGER",
    },
  });
  userId = user.id;
  shiftId = (await db.shift.create({
    data: {
      cafeId,
      branchId,
      cashierId: userId,
      shiftNumber: 950001,
      openingCashAmount: 0,
      expectedCashAmount: 0,
    },
  })).id;

  for (const spec of ITEM_SPECS) {
    const item = await db.inventoryItem.create({
      data: {
        cafeId,
        branchId,
        name: MARKER + " " + spec.key,
        unit: spec.unit,
        costPerUnit: spec.cost,
        currentStock: spec.stock,
        ledgerVersion: spec.version,
        isCritical: true,
      },
    });
    itemIds[spec.key] = item.id;
  }
  archivedId = (await db.inventoryItem.create({
    data: {
      cafeId, branchId, name: MARKER + " archived", unit: "BOX",
      costPerUnit: 30, currentStock: 4, isCritical: true, archivedAt: new Date(),
    },
  })).id;
  inactiveId = (await db.inventoryItem.create({
    data: {
      cafeId, branchId, name: MARKER + " inactive", unit: "PIECE",
      costPerUnit: 30, currentStock: 4, isCritical: true, isActive: false,
    },
  })).id;
  rejectionReasonId = (await db.reasonCode.create({
    data: { cafeId, domain: "HANDOVER", code: MARKER + "-REFUSED", label: "مرفوض" },
  })).id;
  // A sibling branch's item must never appear in this branch's boundary.
  await db.inventoryItem.create({
    data: {
      cafeId, branchId: otherBranchId, name: MARKER + " sibling", unit: "KG",
      costPerUnit: 12, currentStock: 6, isCritical: true,
    },
  });
});

beforeEach(async () => {
  for (const spec of ITEM_SPECS) {
    await db.inventoryItem.update({
      where: { id: itemIds[spec.key] },
      data: {
        costPerUnit: spec.cost,
        currentStock: spec.stock,
        ledgerVersion: spec.version,
        isActive: true,
        archivedAt: null,
      },
    });
  }
  await db.inventoryItem.update({
    where: { id: archivedId },
    data: { isActive: true, archivedAt: new Date() },
  });
  await db.inventoryItem.update({
    where: { id: inactiveId },
    data: { isActive: false, archivedAt: null },
  });
});

after(() => teardownTaggedCafe([cafeId], [
  // Boundaries hold Restrict references to count lines, so they must go
  // before the purge reaches the sessions those lines hang off.
  () => db.handoverStockBoundary.deleteMany({ where: { handover: { cafeId } } }),
  () => db.handoverSession.updateMany({
    where: { cafeId },
    data: { acceptedStockCountSessionId: null },
  }),
  () => db.stockCountRecount.deleteMany({ where: { line: { session: { cafeId } } } }),
  () => db.stockCountLine.deleteMany({ where: { session: { cafeId } } }),
  () => db.stockCountSession.deleteMany({ where: { cafeId } }),
], { disconnect: true }));

describe("HANDOVER-005 M19 schema and additive migration", () => {
  test("the allocated M19 migration adds the boundary vocabulary and touches no historical row", () => {
    const allocation = JSON.parse(readFileSync(".migration-allocation.json", "utf8"));
    const m19 = allocation.allocations.find((row: { concept: string }) => row.concept === "M19");
    assert.equal(m19.name, MIGRATION_NAME, "M19 must use its allocated directory name");

    const sql = readFileSync(MIGRATION, "utf8");
    assert.match(sql, /CREATE TYPE "BoundarySource"/, "M19 must create the BoundarySource type");
    assert.match(sql, /PHYSICAL_COUNT/);
    assert.match(sql, /SYSTEM_CARRIED/);
    assert.match(sql, /CREATE TABLE "HandoverStockBoundary"/);
    assert.match(
      sql,
      /CREATE UNIQUE INDEX[^;]*HandoverStockBoundary_handoverId_inventoryItemId_key/,
      "one boundary per handover per item is a database guarantee, not a convention"
    );
    // Statement-initial only: `ON DELETE RESTRICT` is a constraint clause and
    // not a statement that touches a historical row. DROP is listed because a
    // generated diff will happily propose dropping a table the datamodel does
    // not know about.
    assert.doesNotMatch(sql, /(?:^|\n)\s*(?:UPDATE|INSERT|DELETE|TRUNCATE|DROP)\b/i);
  });

  test("a boundary row has nowhere to record a variance it cannot know", () => {
    const model = Prisma.dmmf.datamodel.models.find((m) => m.name === "HandoverStockBoundary");
    assert.ok(model, "HandoverStockBoundary must exist in the datamodel");
    const offenders = model.fields
      .map((f) => f.name)
      .filter((name) => /variance|expected|blame|responsible|counter/i.test(name));
    assert.deepEqual(
      offenders,
      [],
      "an unverified boundary must have nowhere to record a difference or name anybody"
    );
  });
});

describe("HANDOVER-005 boundary construction", () => {
  test("a SELECTED count over 2 of 7 items still produces a boundary for all 7", async () => {
    const handover = await createHandover();
    const counted = await createCountSession({
      handoverId: handover.id,
      lines: [
        { key: "alpha", countedQuantity: 10, itemVersion: BigInt(41) },
        { key: "bravo", countedQuantity: 2, itemVersion: BigInt(42) },
      ],
    });

    const { built } = await buildAndPersist(handover.id, counted.session.id);

    assert.equal(built.lines.length, 7, "every active item gets a boundary, counted or not");
    assert.equal(built.verifiedCount, 2);
    assert.equal(built.carriedCount, 5);

    const rows = await rowsFor(handover.id);
    assert.equal(rows.length, 7);
    assert.equal(rows.filter((r) => r.source === "PHYSICAL_COUNT" && r.verified).length, 2);
    assert.equal(rows.filter((r) => r.source === "SYSTEM_CARRIED" && !r.verified).length, 5);
    assert.equal(rows.filter((r) => r.verified && r.stockCountLineId === null).length, 0);
    assert.equal(rows.filter((r) => !r.verified && r.stockCountLineId !== null).length, 0);
  });

  test("a carried row's quantity and cursor come from the same locked read", async () => {
    const handover = await createHandover();
    const counted = await createCountSession({
      handoverId: handover.id,
      lines: [{ key: "alpha", countedQuantity: 10, itemVersion: BigInt(41) }],
    });

    await buildAndPersist(handover.id, counted.session.id);
    const rows = await rowsFor(handover.id);
    const carried = rows.find((r) => r.inventoryItemId === itemIds.charlie);

    assert.ok(carried, "charlie was never counted and still needs a boundary");
    assert.equal(carried.source, "SYSTEM_CARRIED");
    assert.equal(carried.verified, false);
    assert.equal(Number(carried.quantity), 8, "the carried figure is the book figure");
    assert.equal(carried.itemVersion, BigInt(43), "and the cursor it is true at");
  });

  test("a verified row takes the superseding recount's figure and cursor together", async () => {
    const handover = await createHandover();
    const counted = await createCountSession({
      handoverId: handover.id,
      lines: [{ key: "alpha", countedQuantity: 10, itemVersion: BigInt(41) }],
    });
    await db.stockCountRecount.create({
      data: {
        lineId: counted.lines.alpha,
        attempt: 1,
        kind: "INDEPENDENT",
        countedQuantity: 33,
        expectedQuantity: 10,
        varianceQuantity: 23,
        itemVersion: BigInt(71),
        counterId: userId,
      },
    });

    await buildAndPersist(handover.id, counted.session.id);
    const rows = await rowsFor(handover.id);
    const verified = rows.find((r) => r.inventoryItemId === itemIds.alpha);

    assert.ok(verified, "alpha was counted and must be verified");
    assert.equal(verified.source, "PHYSICAL_COUNT");
    assert.equal(verified.verified, true);
    assert.equal(Number(verified.quantity), 33, "the evidence in force, not the first attempt");
    assert.equal(verified.itemVersion, BigInt(71), "and that evidence's own cursor, never a mix");
  });

  test("only the passed accepted session may supply physical evidence", async () => {
    const handover = await createHandover();
    const first = await createCountSession({
      handoverId: handover.id,
      lines: [{ key: "alpha", countedQuantity: 10, itemVersion: BigInt(41) }],
    });
    const second = await createCountSession({
      handoverId: handover.id,
      lines: [{ key: "bravo", countedQuantity: 2, itemVersion: BigInt(42) }],
    });

    await buildAndPersist(handover.id, second.session.id);
    const rows = await rowsFor(handover.id);

    const bravo = rows.find((r) => r.inventoryItemId === itemIds.bravo);
    assert.ok(bravo);
    assert.equal(bravo.source, "PHYSICAL_COUNT");
    assert.equal(bravo.stockCountLineId, second.lines.bravo);

    const alpha = rows.find((r) => r.inventoryItemId === itemIds.alpha);
    assert.ok(alpha);
    assert.equal(
      alpha.source,
      "SYSTEM_CARRIED",
      "a sibling session of the same handover is not the accepted evidence"
    );
    const citedFirst = rows.filter((r) => r.stockCountLineId === first.lines.alpha);
    assert.deepEqual(citedFirst, [], "no boundary may cite the superseded session's line");
  });
});

describe("HANDOVER-005 what a carried boundary may and may not say", () => {
  test("a carried row prices from the locked item, and stays NULL when unpriced", async () => {
    const handover = await createHandover();
    const { built } = await buildAndPersist(handover.id, null);

    const charlie = built.lines.find((l) => l.inventoryItemId === itemIds.charlie);
    assert.ok(charlie);
    assert.equal(charlie.unitCostSnapshot, 15);
    assert.equal(charlie.unitCostSource, "INVENTORY_ITEM_COST_PER_UNIT");

    const golf = built.lines.find((l) => l.inventoryItemId === itemIds.golf);
    assert.ok(golf);
    assert.equal(golf.unitCostSnapshot, null, "an unpriced item is not priced at zero");
    assert.equal(golf.unitCostSource, null);
  });

  test("a verified row copies the accepted cost evidence rather than repricing it", async () => {
    const handover = await createHandover();
    const counted = await createCountSession({
      handoverId: handover.id,
      lines: [{
        key: "alpha",
        countedQuantity: 10,
        itemVersion: BigInt(41),
        unitCostSnapshot: 55,
        unitCostSource: "INVENTORY_ITEM_COST_PER_UNIT",
      }],
    });
    // The shelf price moves after the count was judged.
    await db.inventoryItem.update({ where: { id: itemIds.alpha }, data: { costPerUnit: 123 } });

    await buildAndPersist(handover.id, counted.session.id);
    const rows = await rowsFor(handover.id);
    const alpha = rows.find((r) => r.inventoryItemId === itemIds.alpha);

    assert.ok(alpha);
    assert.equal(
      Number(alpha.unitCostSnapshot),
      55,
      "a historical count judgement must not be repriced later"
    );
    assert.equal(alpha.unitCostSource, "INVENTORY_ITEM_COST_PER_UNIT");
  });
});

describe("HANDOVER-005 the shelf, and the evidence it will not invent", () => {
  test("an archived or inactive item gets no boundary at all", async () => {
    const handover = await createHandover();
    const { built } = await buildAndPersist(handover.id, null);

    const ids = built.lines.map((l) => l.inventoryItemId);
    assert.ok(!ids.includes(archivedId), "an archived item is not part of the shelf");
    assert.ok(!ids.includes(inactiveId), "nor is an inactive one");
    assert.equal(built.lines.length, 7);
  });

  test("a handover with no accepted session produces an all-carried boundary", async () => {
    const handover = await createHandover();
    const { built } = await buildAndPersist(handover.id, null);

    assert.equal(built.lines.length, 7);
    assert.equal(built.verifiedCount, 0);
    assert.equal(built.carriedCount, 7);
    assert.ok(built.lines.every((l) => l.source === "SYSTEM_CARRIED" && !l.verified));
    assert.ok(built.lines.every((l) => l.stockCountLineId === null));
  });

  test("counted evidence with no count point is refused, not repaired", async () => {
    const handover = await createHandover();
    const counted = await createCountSession({
      handoverId: handover.id,
      lines: [{ key: "alpha", countedQuantity: 10, itemVersion: null }],
    });

    await assert.rejects(
      () => buildAndPersist(handover.id, counted.session.id),
      statusIs(409),
      "a counted figure with no cursor is not evidence and must not be written"
    );

    assert.deepEqual(await rowsFor(handover.id), [], "nothing partial may survive the refusal");

    const alphaRows = await db.handoverStockBoundary.findMany({
      where: { handoverId: handover.id, inventoryItemId: itemIds.alpha },
    });
    assert.deepEqual(
      alphaRows,
      [],
      "no current-ledgerVersion fallback and no SYSTEM_CARRIED downgrade"
    );
  });
});

describe("HANDOVER-005 boundary persistence", () => {
  const carriedLine = (inventoryItemId: string, quantity: number, itemVersion: bigint) => ({
    inventoryItemId,
    source: "SYSTEM_CARRIED" as const,
    verified: false,
    quantity,
    itemVersion,
    stockCountLineId: null,
    unitCostSnapshot: 60,
    unitCostSource: "INVENTORY_ITEM_COST_PER_UNIT",
  });

  test("one boundary per handover per item is refused a second time", async () => {
    const handover = await createHandover();
    const lib = await boundaryLib();
    const line = carriedLine(itemIds.alpha, 12.5, BigInt(41));
    await db.$transaction((tx) =>
      lib.persistStockBoundary(tx, { handoverId: handover.id, lines: [line] })
    );

    await assert.rejects(
      () => db.$transaction((tx) =>
        lib.persistStockBoundary(tx, { handoverId: handover.id, lines: [line] })
      ),
      "a second boundary for the same pair is a second answer to one question"
    );
    assert.equal((await rowsFor(handover.id)).length, 1);
  });

  test("persistence rolls back with the transaction that called it", async () => {
    const handover = await createHandover();
    const lib = await boundaryLib();

    await assert.rejects(() =>
      db.$transaction(async (tx) => {
        const built = await lib.buildStockBoundary(tx, {
          cafeId,
          branchId,
          handoverId: handover.id,
          acceptedSessionId: null,
        });
        await lib.persistStockBoundary(tx, { handoverId: handover.id, lines: built.lines });
        throw new Error(MARKER + " caller failed after writing");
      })
    );

    assert.deepEqual(
      await rowsFor(handover.id),
      [],
      "a boundary is only true if its caller committed"
    );
  });

  test("the count line a boundary cites cannot be deleted underneath it", async () => {
    const handover = await createHandover();
    const counted = await createCountSession({
      handoverId: handover.id,
      lines: [{ key: "alpha", countedQuantity: 10, itemVersion: BigInt(41) }],
    });
    await buildAndPersist(handover.id, counted.session.id);

    await assert.rejects(
      () => db.stockCountLine.delete({ where: { id: counted.lines.alpha } }),
      "a boundary is unreadable once the observation behind it is gone"
    );
  });
});

describe("HANDOVER-005 the boundary a later count measures against", () => {
  const echoLine = (quantity: number, itemVersion: bigint) => ({
    inventoryItemId: itemIds.echo,
    source: "SYSTEM_CARRIED" as const,
    verified: false,
    quantity,
    itemVersion,
    stockCountLineId: null,
    unitCostSnapshot: 60,
    unitCostSource: "INVENTORY_ITEM_COST_PER_UNIT",
  });

  test("the newest accepted boundary wins, and a rejected handover is not one", async () => {
    const lib = await boundaryLib();
    const older = await createHandover({ acceptedAt: new Date("2026-08-20T09:00:00.000Z") });
    const newer = await createHandover({ acceptedAt: new Date("2026-08-25T09:00:00.000Z") });
    const refused = await createHandover({
      status: "REJECTED",
      acceptedAt: new Date("2026-08-28T09:00:00.000Z"),
    });
    await db.$transaction(async (tx) => {
      await lib.persistStockBoundary(tx, { handoverId: older.id, lines: [echoLine(1, BigInt(11))] });
      await lib.persistStockBoundary(tx, { handoverId: newer.id, lines: [echoLine(2, BigInt(22))] });
      await lib.persistStockBoundary(tx, { handoverId: refused.id, lines: [echoLine(3, BigInt(33))] });
    });

    const found = await lib.lastAcceptedBoundary({
      branchId,
      inventoryItemId: itemIds.echo,
      before: new Date("2026-09-01T00:00:00.000Z"),
    });

    assert.ok(found, "a completed handover left a boundary here");
    assert.equal(found.quantity, 2, "the newest COMPLETED boundary, not the rejected one");
    assert.equal(found.itemVersion, BigInt(22));
    assert.equal(found.verified, false);
    assert.deepEqual(found.acceptedAt, new Date("2026-08-25T09:00:00.000Z"));
  });

  test("an item that has never had a boundary reports none rather than a zero", async () => {
    const lib = await boundaryLib();
    const found = await lib.lastAcceptedBoundary({
      branchId,
      inventoryItemId: itemIds.foxtrot,
      before: new Date("2026-09-01T00:00:00.000Z"),
    });
    assert.equal(found, null, "never counted is not the same as counted zero");
  });
});
