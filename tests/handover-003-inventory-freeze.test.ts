import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { db, tag, teardownTaggedCafe } from "./helpers/db";
import { applyStockMutation } from "@/lib/ledger";

const MARKER = tag("HANDOVER003");
const MIGRATION = "prisma/migrations/20260830234911_inventory_freeze/migration.sql";
let cafeId: string;
let branchId: string;
let otherBranchId: string;
let actorId: string;
let otherCafeActorId: string;
let otherCafeId: string;
let handoverId: string;
let competingHandoverId: string;
let itemId: string;

type FreezeLib = typeof import("@/lib/inventory-freeze");
const freezeLib = (): Promise<FreezeLib> => import("@/lib/inventory-freeze");

async function tableExists() {
  const rows = await db.$queryRaw<{ exists: boolean }[]>`
    SELECT to_regclass('public."InventoryFreeze"') IS NOT NULL AS exists
  `;
  return rows[0]?.exists === true;
}

async function clearFreezes() {
  if (await tableExists()) {
    await db.$executeRawUnsafe('DELETE FROM "InventoryFreeze" WHERE "cafeId" = $1', cafeId);
  }
  await db.auditLog.deleteMany({
    where: { cafeId, action: { in: ["INVENTORY_FROZEN", "INVENTORY_FREEZE_RELEASED"] } },
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

async function waitForUnGrantedAdvisory(observer: PrismaClient, pid: number) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const rows = await observer.$queryRaw<{ waiting: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM pg_locks
         WHERE pid = ${pid}
           AND locktype = 'advisory'
           AND granted = false
      ) AS waiting
    `;
    if (rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`backend ${pid} never appeared as an advisory-lock waiter`);
}

before(async () => {
  const cafe = await db.cafe.create({
    data: {
      name: `${MARKER} cafe`, slug: MARKER.toLowerCase(), settings: { create: {} },
      branches: { create: [{ name: `${MARKER} main` }, { name: `${MARKER} other` }] },
    },
    include: { branches: true },
  });
  cafeId = cafe.id;
  branchId = cafe.branches[0].id;
  otherBranchId = cafe.branches[1].id;

  const actor = await db.user.create({
    data: {
      cafeId, branchId, email: `${MARKER}-actor@example.invalid`,
      passwordHash: "no-login", name: `${MARKER} actor`, role: "BRANCH_MANAGER",
    },
  });
  actorId = actor.id;

  const foreignCafe = await db.cafe.create({
    data: {
      name: `${MARKER} foreign`, slug: `${MARKER.toLowerCase()}-foreign`,
      settings: { create: {} }, branches: { create: [{ name: "foreign" }] },
    }, include: { branches: true },
  });
  otherCafeId = foreignCafe.id;
  const foreignActor = await db.user.create({
    data: {
      cafeId: foreignCafe.id, branchId: foreignCafe.branches[0].id,
      email: `${MARKER}-foreign@example.invalid`, passwordHash: "no-login",
      name: `${MARKER} foreign`, role: "BRANCH_MANAGER",
    },
  });
  otherCafeActorId = foreignActor.id;

  // Both of these exist only to be the outgoing shift of a COMPLETED
  // handover below, so they are history, not live drawers. Saying so
  // explicitly is truer to what they represent — and one cashier cannot hold
  // two open drawers at one branch.
  const shift = await db.shift.create({
    data: {
      cafeId, branchId, cashierId: actorId, shiftNumber: 910001,
      openingCashAmount: 0, expectedCashAmount: 0,
      status: "CLOSED", closedAt: new Date(),
    },
  });
  const otherShift = await db.shift.create({
    data: {
      cafeId, branchId, cashierId: actorId, shiftNumber: 910002,
      openingCashAmount: 0, expectedCashAmount: 0,
      status: "CLOSED", closedAt: new Date(),
    },
  });
  handoverId = (await db.handoverSession.create({
    data: {
      cafeId, branchId, outgoingShiftId: shift.id, outgoingUserId: actorId,
      status: "COMPLETED", completedAt: new Date(),
    },
  })).id;
  competingHandoverId = (await db.handoverSession.create({
    data: {
      cafeId, branchId, outgoingShiftId: otherShift.id, outgoingUserId: actorId,
      status: "COMPLETED", completedAt: new Date(),
    },
  })).id;
  itemId = (await db.inventoryItem.create({
    data: { cafeId, branchId, name: `${MARKER} beans`, unit: "KG", currentStock: 10 },
  })).id;
});

beforeEach(clearFreezes);

after(() => teardownTaggedCafe([cafeId, otherCafeId], [], { disconnect: true }));

describe("HANDOVER-003 M16 inventory freeze schema", () => {
  test("M16 is additive and declares the lifecycle constraints", async () => {
    assert.doesNotThrow(() => readFileSync(MIGRATION, "utf8"), "M16 must exist at its allocation");
    const sql = readFileSync(MIGRATION, "utf8");
    assert.match(sql, /CREATE TABLE "InventoryFreeze"/);
    assert.match(sql, /InventoryFreeze_one_active_per_branch/);
    assert.match(sql, /WHERE "releasedAt" IS NULL/);
    assert.match(sql, /InventoryFreeze_release_pair_consistent/);
    assert.doesNotMatch(sql, /(?:^|\n)\s*(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
  });

  test("the migrated database exposes the partial unique index and five foreign keys", async () => {
    const indexes = await db.$queryRaw<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'InventoryFreeze'
    `;
    assert.ok(indexes.some((i) =>
      i.indexname === "InventoryFreeze_one_active_per_branch" &&
      /UNIQUE/.test(i.indexdef) && /releasedAt.*IS NULL/.test(i.indexdef)
    ));
    const fks = await db.$queryRaw<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
        FROM pg_constraint
       WHERE conrelid = '"InventoryFreeze"'::regclass AND contype = 'f'
    `;
    assert.equal(fks[0].count, 5);
  });
});

describe("HANDOVER-003 lifecycle and audit", () => {
  test("acquire is active-idempotent and audits only the transition", async () => {
    const { acquireInventoryFreeze, activeFreezeFor } = await freezeLib();
    const first = await db.$transaction((tx) => acquireInventoryFreeze(tx, {
      cafeId, branchId, handoverId, startedById: actorId,
    }));
    const replay = await db.$transaction((tx) => acquireInventoryFreeze(tx, {
      cafeId, branchId, handoverId, startedById: actorId,
    }));
    assert.equal(first.alreadyHeld, false);
    assert.deepEqual(replay, { freezeId: first.freezeId, alreadyHeld: true });
    assert.deepEqual(await db.$transaction((tx) => activeFreezeFor(tx, branchId)), {
      freezeId: first.freezeId, handoverId,
    });
    assert.equal(await db.auditLog.count({ where: { cafeId, action: "INVENTORY_FROZEN" } }), 1);
  });

  test("another handover cannot own the active branch freeze", async () => {
    const { acquireInventoryFreeze } = await freezeLib();
    await db.$transaction((tx) => acquireInventoryFreeze(tx, {
      cafeId, branchId, handoverId, startedById: actorId,
    }));
    await assert.rejects(
      () => db.$transaction((tx) => acquireInventoryFreeze(tx, {
        cafeId, branchId, handoverId: competingHandoverId, startedById: actorId,
      })),
      (error: { status?: number }) => error.status === 409
    );
  });

  test("release is idempotent, audited once, and never resurrects the same handover", async () => {
    const { acquireInventoryFreeze, releaseInventoryFreeze } = await freezeLib();
    await db.$transaction((tx) => acquireInventoryFreeze(tx, {
      cafeId, branchId, handoverId, startedById: actorId,
    }));
    assert.deepEqual(
      await db.$transaction((tx) => releaseInventoryFreeze(tx, { handoverId, actorId })),
      { released: true }
    );
    assert.deepEqual(
      await db.$transaction((tx) => releaseInventoryFreeze(tx, { handoverId, actorId })),
      { released: false }
    );
    assert.equal(await db.auditLog.count({ where: { cafeId, action: "INVENTORY_FREEZE_RELEASED" } }), 1);
    await assert.rejects(
      () => db.$transaction((tx) => acquireInventoryFreeze(tx, {
        cafeId, branchId, handoverId, startedById: actorId,
      })),
      (error: { status?: number }) => error.status === 409
    );
    const rows = await db.$queryRaw<{ releasedAt: Date | null }[]>`
      SELECT "releasedAt" FROM "InventoryFreeze" WHERE "handoverId" = ${handoverId}
    `;
    assert.ok(rows[0]?.releasedAt);
  });

  test("acquisition rolls back and tenancy mismatches are refused", async () => {
    const { acquireInventoryFreeze } = await freezeLib();
    await assert.rejects(() => db.$transaction(async (tx) => {
      await acquireInventoryFreeze(tx, { cafeId, branchId, handoverId, startedById: actorId });
      throw new Error("rollback");
    }), /rollback/);
    const count = await db.$queryRaw<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM "InventoryFreeze" WHERE "cafeId" = ${cafeId}
    `;
    assert.equal(count[0].count, 0);
    await assert.rejects(
      () => db.$transaction((tx) => acquireInventoryFreeze(tx, {
        cafeId, branchId: otherBranchId, handoverId, startedById: actorId,
      })),
      (error: { status?: number }) => error.status === 409
    );
    await assert.rejects(
      () => db.$transaction((tx) => acquireInventoryFreeze(tx, {
        cafeId, branchId, handoverId, startedById: otherCafeActorId,
      })),
      (error: { status?: number }) => error.status === 403
    );
  });
});

describe("HANDOVER-003 PostgreSQL advisory protocol", () => {
  test("keys are PostgreSQL-derived signed bigints and shared acquisition is sorted/deduplicated", { timeout: 10_000 }, async () => {
    const { inventoryBranchLockKey, acquireInventorySharedLocks } = await freezeLib();
    await db.$transaction(async (tx) => {
      const key = await inventoryBranchLockKey(tx, branchId);
      const direct = await tx.$queryRaw<{ key: bigint }[]>`
        SELECT hashtextextended(${branchId}::text, 1313035600::bigint) AS key
      `;
      assert.equal(key, direct[0].key);
      assert.equal(typeof key, "bigint");
      const acquired = await acquireInventorySharedLocks(tx, [otherBranchId, branchId, branchId]);
      assert.equal(new Set(acquired.keys.map(String)).size, acquired.keys.length);
      assert.deepEqual(acquired.keys, [...acquired.keys].sort((a, b) => a < b ? -1 : a > b ? 1 : 0));
      const inverse = await acquireInventorySharedLocks(tx, [branchId, otherBranchId]);
      assert.deepEqual(inverse.keys, acquired.keys, "A→B and B→A must acquire identical key order");
    });
    const negative = await db.$queryRaw<{ value: string; key: bigint }[]>`
      SELECT value, hashtextextended(value, 1313035600::bigint) AS key
        FROM (SELECT 'negative-' || n AS value FROM generate_series(1, 1000) n) candidates
       WHERE hashtextextended(value, 1313035600::bigint) < 0
       LIMIT 1
    `;
    assert.ok(negative[0]?.key < BigInt(0), "the fixture must exercise signed-negative output");
    assert.equal(
      await db.$transaction((tx) => inventoryBranchLockKey(tx, negative[0].value)),
      negative[0].key
    );
  });

  test("an existing mutator SHARED lock delays freeze EXCLUSIVE until commit", { timeout: 10_000 }, async () => {
    const { acquireInventoryFreeze } = await freezeLib();
    const mutator = new PrismaClient();
    const freezer = new PrismaClient();
    const observer = new PrismaClient();
    const mutationReady = deferred();
    const allowMutationCommit = deferred();
    const freezeStarted = deferred();
    let freezePid = 0;
    const mutation = mutator.$transaction(async (tx) => {
      await applyStockMutation(tx, {
        inventoryItemId: itemId, cafeId, branchId, type: "ADJUSTMENT", quantity: 1,
      });
      mutationReady.resolve();
      await allowMutationCommit.promise;
    });
    await mutationReady.promise;
    const freezing = freezer.$transaction(async (tx) => {
      freezePid = Number((await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0].pid);
      freezeStarted.resolve();
      return acquireInventoryFreeze(tx, { cafeId, branchId, handoverId, startedById: actorId });
    });
    await freezeStarted.promise;
    await waitForUnGrantedAdvisory(observer, freezePid);
    allowMutationCommit.resolve();
    await mutation;
    assert.equal((await freezing).alreadyHeld, false);
    await Promise.all([mutator.$disconnect(), freezer.$disconnect(), observer.$disconnect()]);
  });

  test("a committed freeze makes the waiting mutation reject before its stock write", { timeout: 10_000 }, async () => {
    const { acquireInventoryFreeze } = await freezeLib();
    const freezer = new PrismaClient();
    const mutator = new PrismaClient();
    const observer = new PrismaClient();
    const freezeReady = deferred();
    const allowFreezeCommit = deferred();
    const mutationStarted = deferred();
    let mutationPid = 0;
    const before = Number((await db.inventoryItem.findUniqueOrThrow({ where: { id: itemId } })).currentStock);
    const freezing = freezer.$transaction(async (tx) => {
      await acquireInventoryFreeze(tx, { cafeId, branchId, handoverId, startedById: actorId });
      freezeReady.resolve();
      await allowFreezeCommit.promise;
    });
    await freezeReady.promise;
    const mutation = mutator.$transaction(async (tx) => {
      mutationPid = Number((await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0].pid);
      mutationStarted.resolve();
      return applyStockMutation(tx, {
        inventoryItemId: itemId, cafeId, branchId, type: "ADJUSTMENT", quantity: 1,
      });
    });
    const outcome = mutation.then(() => null, (error) => error as { status?: number });
    await mutationStarted.promise;
    await waitForUnGrantedAdvisory(observer, mutationPid);
    allowFreezeCommit.resolve();
    await freezing;
    assert.equal((await outcome)?.status, 409);
    assert.equal(Number((await db.inventoryItem.findUniqueOrThrow({ where: { id: itemId } })).currentStock), before);
    await Promise.all([freezer.$disconnect(), mutator.$disconnect(), observer.$disconnect()]);
  });

  test("a rolled-back freeze releases EXCLUSIVE and allows the waiting mutation", { timeout: 10_000 }, async () => {
    const { acquireInventoryFreeze } = await freezeLib();
    const freezer = new PrismaClient();
    const mutator = new PrismaClient();
    const observer = new PrismaClient();
    const freezeReady = deferred();
    const allowFreezeRollback = deferred();
    const mutationStarted = deferred();
    let mutationPid = 0;
    const freezing = freezer.$transaction(async (tx) => {
      await acquireInventoryFreeze(tx, { cafeId, branchId, handoverId, startedById: actorId });
      freezeReady.resolve();
      await allowFreezeRollback.promise;
      throw new Error("rollback freeze");
    });
    const freezeOutcome = freezing.then(() => null, (error) => error as Error);
    await freezeReady.promise;
    const mutation = mutator.$transaction(async (tx) => {
      mutationPid = Number((await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0].pid);
      mutationStarted.resolve();
      return applyStockMutation(tx, {
        inventoryItemId: itemId, cafeId, branchId, type: "ADJUSTMENT", quantity: 1,
      });
    });
    await mutationStarted.promise;
    await waitForUnGrantedAdvisory(observer, mutationPid);
    allowFreezeRollback.resolve();
    assert.match((await freezeOutcome)?.message ?? "", /rollback freeze/);
    assert.equal((await mutation).stockAfter > 0, true);
    await Promise.all([freezer.$disconnect(), mutator.$disconnect(), observer.$disconnect()]);
  });

  test("transaction-scoped advisory locks disappear when the transaction ends", { timeout: 10_000 }, async () => {
    const { acquireInventorySharedLocks } = await freezeLib();
    const holder = new PrismaClient();
    const observer = new PrismaClient();
    const lockReady = deferred();
    const allowCommit = deferred();
    let holderPid = 0;
    const holding = holder.$transaction(async (tx) => {
      holderPid = Number((await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0].pid);
      await acquireInventorySharedLocks(tx, [branchId]);
      lockReady.resolve();
      await allowCommit.promise;
    });
    await lockReady.promise;
    const countLocks = async () => Number((await observer.$queryRaw<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM pg_locks
       WHERE pid = ${holderPid} AND locktype = 'advisory' AND granted = true
    `)[0].count);
    assert.ok(await countLocks() > 0);
    allowCommit.resolve();
    await holding;
    assert.equal(await countLocks(), 0);
    await Promise.all([holder.$disconnect(), observer.$disconnect()]);
  });

  test("a matching-token mutator delays release until its SHARED transaction commits", { timeout: 10_000 }, async () => {
    const { acquireInventoryFreeze, releaseInventoryFreeze } = await freezeLib();
    await db.$transaction((tx) => acquireInventoryFreeze(tx, {
      cafeId, branchId, handoverId, startedById: actorId,
    }));
    const mutator = new PrismaClient();
    const releaser = new PrismaClient();
    const observer = new PrismaClient();
    const mutationReady = deferred();
    const allowMutationCommit = deferred();
    const releaseStarted = deferred();
    let releasePid = 0;
    const mutation = mutator.$transaction(async (tx) => {
      await applyStockMutation(tx, {
        inventoryItemId: itemId, cafeId, branchId, type: "ADJUSTMENT", quantity: 1,
        freezeToken: handoverId,
      });
      mutationReady.resolve();
      await allowMutationCommit.promise;
    });
    await mutationReady.promise;
    const release = releaser.$transaction(async (tx) => {
      releasePid = Number((await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0].pid);
      releaseStarted.resolve();
      return releaseInventoryFreeze(tx, { handoverId, actorId });
    });
    await releaseStarted.promise;
    await waitForUnGrantedAdvisory(observer, releasePid);
    allowMutationCommit.resolve();
    await mutation;
    assert.deepEqual(await release, { released: true });
    await Promise.all([mutator.$disconnect(), releaser.$disconnect(), observer.$disconnect()]);
  });

  test("same transaction upgrades SHARED to EXCLUSIVE without self-deadlock", { timeout: 10_000 }, async () => {
    const { acquireInventoryFreeze, releaseInventoryFreeze } = await freezeLib();
    await db.$transaction((tx) => acquireInventoryFreeze(tx, {
      cafeId, branchId, handoverId, startedById: actorId,
    }));
    const result = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '3000ms'");
      await applyStockMutation(tx, {
        inventoryItemId: itemId, cafeId, branchId, type: "ADJUSTMENT", quantity: 1,
        freezeToken: handoverId,
      });
      return releaseInventoryFreeze(tx, { handoverId, actorId });
    });
    assert.deepEqual(result, { released: true });
  });

  test("an already-held EXCLUSIVE lock can safely call acquireInventoryFreeze", { timeout: 10_000 }, async () => {
    const { acquireInventoryExclusiveLock, acquireInventoryFreeze } = await freezeLib();
    const result = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '3000ms'");
      await acquireInventoryExclusiveLock(tx, branchId);
      return acquireInventoryFreeze(tx, { cafeId, branchId, handoverId, startedById: actorId });
    });
    assert.equal(result.alreadyHeld, false);
  });
});
