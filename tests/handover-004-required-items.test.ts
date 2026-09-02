import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { InventoryUnit } from "@prisma/client";
import { db, tag, teardownTaggedCafe } from "./helpers/db";

const MARKER = tag("HANDOVER004");
const MIGRATION_NAME = "20260831000911_handover_evidence_binding_and_required_items";
const MIGRATION = `prisma/migrations/${MIGRATION_NAME}/migration.sql`;

type RequiredItemsLib = typeof import("@/lib/handover-required-items");
const requiredItemsLib = (): Promise<RequiredItemsLib> => import("@/lib/handover-required-items");

let cafeId: string;
let branchId: string;
let otherBranchId: string;
let otherCafeId: string;
let otherCafeBranchId: string;
let userId: string;
let otherCafeUserId: string;
let shiftId: string;
let otherBranchShiftId: string;
let otherCafeShiftId: string;
let branchCustodyId: string;
let criticalId: string;
let regularId: string;
let archivedId: string;
let inactiveId: string;

const statusIs = (status: number) => (error: unknown) =>
  (error as { status?: number }).status === status;

async function configure(args: {
  mode: "FULL" | "SELECTED";
  schedule?: "DAILY_LAST_HANDOVER" | "WEEKLY" | "MANUAL_ONLY";
  weekday?: number | null;
}) {
  const schedule = args.schedule ?? "MANUAL_ONLY";
  const weekday = args.weekday ?? null;
  await db.cafeSettings.update({
    where: { cafeId },
    data: {
      stockCountPolicy: "HYBRID",
      handoverCountType: args.mode === "FULL" ? "FULL" : "CRITICAL",
      periodicFullCountSchedule: schedule,
      periodicFullCountWeekday: schedule === "WEEKLY" ? weekday : null,
    },
  });
  await db.branch.update({
    where: { id: branchId },
    data: {
      stockCountPolicyOverride: null,
      handoverCountTypeOverride: null,
      periodicFullCountScheduleOverride: null,
      periodicFullCountWeekdayOverride: null,
    },
  });
}

async function createHandover(args: {
  cafeId?: string;
  branchId?: string;
  shiftId?: string;
  userId?: string;
  stockCountSessionId?: string | null;
} = {}) {
  return db.handoverSession.create({
    data: {
      cafeId: args.cafeId ?? cafeId,
      branchId: args.branchId ?? branchId,
      outgoingShiftId: args.shiftId ?? shiftId,
      outgoingUserId: args.userId ?? userId,
      status: "COMPLETED",
      completedAt: new Date(),
      stockCountSessionId: args.stockCountSessionId ?? null,
    },
  });
}

function manualPlan(
  target: "SHIFT_TO_SHIFT" | "BRANCH_CUSTODY" = "SHIFT_TO_SHIFT",
  items: Array<{
    inventoryItemId: string;
    itemNameSnapshot: string;
    unitSnapshot: InventoryUnit;
    isCriticalSnapshot: boolean;
  }> = [{
    inventoryItemId: criticalId,
    itemNameSnapshot: `${MARKER} critical`,
    unitSnapshot: "KG" as const,
    isCriticalSnapshot: true,
  }],
) {
  return {
    cafeId,
    branchId,
    target,
    mode: "SELECTED" as const,
    trigger: "REGULAR_MODE" as const,
    businessDate: "2026-09-01",
    periodic: { schedule: "MANUAL_ONLY" as const, weekday: null },
    configSnapshotAt: new Date("2026-09-01T10:00:00.000Z"),
    items,
  };
}

async function persistedHandover(plan = manualPlan()) {
  const handover = await createHandover();
  const { persistRequiredItems } = await requiredItemsLib();
  await db.$transaction((tx) => persistRequiredItems(tx, { handoverId: handover.id, plan }));
  return handover;
}

async function createCountSession(args: {
  handoverId?: string | null;
  cafeId?: string;
  branchId?: string;
  shiftId?: string;
  userId?: string;
  context?: "NONE" | "HANDOVER" | "BRANCH_OPENING_VERIFICATION";
  openingBranchCustodyPeriodId?: string | null;
  type?: "CRITICAL" | "FULL";
  lockedByHandoverId?: string | null;
  itemIds?: string[];
}) {
  const session = await db.stockCountSession.create({
    data: {
      cafeId: args.cafeId ?? cafeId,
      branchId: args.branchId ?? branchId,
      shiftId: args.shiftId ?? shiftId,
      type: args.type ?? "CRITICAL",
      status: "CONFIRMED",
      scopeDerivation: (args.type ?? "CRITICAL") === "FULL" ? "ALL_ELIGIBLE" : "CRITICAL_ONLY",
      initiatedById: args.userId ?? userId,
      accountabilityContext: args.context ?? "HANDOVER",
      handoverId: args.handoverId ?? null,
      openingBranchCustodyPeriodId: args.openingBranchCustodyPeriodId ?? null,
      lockedByHandoverId: args.lockedByHandoverId ?? null,
    },
  });
  const ids = args.itemIds ?? [criticalId];
  for (const inventoryItemId of ids) {
    const item = await db.inventoryItem.findUniqueOrThrow({ where: { id: inventoryItemId } });
    await db.stockCountLine.create({
      data: {
        sessionId: session.id,
        inventoryItemId,
        unit: item.unit,
        countedQuantity: 1,
        effectiveCountedQuantity: 1,
        expectedQuantity: 1,
        varianceQuantity: 0,
        countedAt: new Date(),
        counterId: args.userId ?? userId,
        disposition: "WITHIN_TOLERANCE",
      },
    });
  }
  return session;
}

before(async () => {
  const cafe = await db.cafe.create({
    data: {
      name: `${MARKER} cafe`,
      slug: `${MARKER}-cafe`.toLowerCase(),
      settings: { create: { stockCountPolicy: "HYBRID", handoverCountType: "CRITICAL" } },
      branches: { create: [{ name: `${MARKER} main` }, { name: `${MARKER} other` }] },
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
      email: `${MARKER}-user@example.invalid`,
      passwordHash: "no-login",
      name: `${MARKER} user`,
      role: "BRANCH_MANAGER",
    },
  });
  userId = user.id;
  shiftId = (await db.shift.create({
    data: { cafeId, branchId, cashierId: userId, shiftNumber: 940001, openingCashAmount: 0, expectedCashAmount: 0 },
  })).id;
  otherBranchShiftId = (await db.shift.create({
    data: { cafeId, branchId: otherBranchId, cashierId: userId, shiftNumber: 940002, openingCashAmount: 0, expectedCashAmount: 0 },
  })).id;
  branchCustodyId = (await db.custodyPeriod.create({
    data: { cafeId, branchId, scope: "STOCK", holderType: "BRANCH", status: "OPEN" },
  })).id;

  const foreign = await db.cafe.create({
    data: {
      name: `${MARKER} foreign`,
      slug: `${MARKER}-foreign`.toLowerCase(),
      settings: { create: {} },
      branches: { create: [{ name: `${MARKER} foreign branch` }] },
    },
    include: { branches: true },
  });
  otherCafeId = foreign.id;
  otherCafeBranchId = foreign.branches[0].id;
  const foreignUser = await db.user.create({
    data: {
      cafeId: otherCafeId,
      branchId: otherCafeBranchId,
      email: `${MARKER}-foreign@example.invalid`,
      passwordHash: "no-login",
      name: `${MARKER} foreign`,
      role: "BRANCH_MANAGER",
    },
  });
  otherCafeUserId = foreignUser.id;
  otherCafeShiftId = (await db.shift.create({
    data: { cafeId: otherCafeId, branchId: otherCafeBranchId, cashierId: otherCafeUserId, shiftNumber: 940003, openingCashAmount: 0, expectedCashAmount: 0 },
  })).id;

  const items = await Promise.all([
    db.inventoryItem.create({ data: { cafeId, branchId, name: `${MARKER} critical`, unit: "KG", costPerUnit: 91, isCritical: true } }),
    db.inventoryItem.create({ data: { cafeId, branchId, name: `${MARKER} regular`, unit: "LITER", costPerUnit: 47, isCritical: false } }),
    db.inventoryItem.create({ data: { cafeId, branchId, name: `${MARKER} archived`, unit: "BOX", isCritical: true, archivedAt: new Date() } }),
    db.inventoryItem.create({ data: { cafeId, branchId, name: `${MARKER} inactive`, unit: "PIECE", isCritical: true, isActive: false } }),
  ]);
  [criticalId, regularId, archivedId, inactiveId] = items.map((item) => item.id);
});

beforeEach(async () => {
  await configure({ mode: "SELECTED" });
  await db.inventoryItem.update({ where: { id: criticalId }, data: { name: `${MARKER} critical`, unit: "KG", isCritical: true, isActive: true, archivedAt: null, costPerUnit: 91 } });
  await db.inventoryItem.update({ where: { id: regularId }, data: { name: `${MARKER} regular`, unit: "LITER", isCritical: false, isActive: true, archivedAt: null, costPerUnit: 47 } });
  await db.inventoryItem.update({ where: { id: archivedId }, data: { isCritical: true, isActive: true, archivedAt: new Date() } });
  await db.inventoryItem.update({ where: { id: inactiveId }, data: { isCritical: true, isActive: false, archivedAt: null } });
});

after(() => teardownTaggedCafe([cafeId, otherCafeId], [
  () => db.handoverSession.updateMany({
    where: { cafeId: { in: [cafeId, otherCafeId] } },
    data: { acceptedStockCountSessionId: null },
  }),
  () => db.handoverRequiredItem.updateMany({
    where: { handover: { cafeId: { in: [cafeId, otherCafeId] } } },
    data: { satisfiedByLineId: null },
  }),
  () => db.stockCountLine.deleteMany({
    where: { session: { cafeId: { in: [cafeId, otherCafeId] } } },
  }),
  () => db.stockCountSession.deleteMany({
    where: { cafeId: { in: [cafeId, otherCafeId] } },
  }),
], { disconnect: true }));

describe("HANDOVER-004 M18 schema and legacy safety", () => {
  test("allocation and additive migration create exactly the approved evidence vocabulary", async () => {
    const allocation = JSON.parse(readFileSync(".migration-allocation.json", "utf8"));
    const m18 = allocation.allocations.find((row: { concept: string }) => row.concept === "M18");
    assert.deepEqual(m18, {
      concept: "M18",
      slug: "handover_evidence_binding_and_required_items",
      timestamp: "20260831000911",
      name: MIGRATION_NAME,
    });
    const sql = readFileSync(MIGRATION, "utf8");
    assert.doesNotMatch(sql, /(?:^|\n)\s*(?:UPDATE|INSERT|DELETE|TRUNCATE)\b/i);
    assert.match(sql, /StockCountSession_accountability_context_check/);
  });

  test("PostgreSQL exposes exact enums, nullable legacy targets, and only the truthful NONE default", async () => {
    const enums = await db.$queryRaw<{ typname: string; values: string[] }[]>`
      SELECT t.typname, array_agg(e.enumlabel ORDER BY e.enumsortorder)::text[] AS values
        FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
       WHERE t.typname IN ('HandoverTarget','HandoverStockMode','RequiredItemTrigger','StockCountAccountabilityContext')
       GROUP BY t.typname ORDER BY t.typname
    `;
    assert.deepEqual(Object.fromEntries(enums.map((row) => [row.typname, row.values])), {
      HandoverStockMode: ["FULL", "SELECTED"],
      HandoverTarget: ["SHIFT_TO_SHIFT", "BRANCH_CUSTODY"],
      RequiredItemTrigger: ["REGULAR_MODE", "PERIODIC_DAILY", "PERIODIC_WEEKLY", "MANUAL_FULL"],
      StockCountAccountabilityContext: ["NONE", "HANDOVER", "BRANCH_OPENING_VERIFICATION"],
    });
    const columns = await db.$queryRaw<{ table_name: string; column_name: string; is_nullable: string; column_default: string | null }[]>`
      SELECT table_name, column_name, is_nullable, column_default
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND ((table_name = 'HandoverSession' AND column_name IN ('target','resolvedTarget'))
           OR (table_name = 'StockCountSession' AND column_name = 'accountabilityContext'))
       ORDER BY table_name, column_name
    `;
    assert.deepEqual(columns, [
      { table_name: "HandoverSession", column_name: "resolvedTarget", is_nullable: "YES", column_default: null },
      { table_name: "HandoverSession", column_name: "target", is_nullable: "YES", column_default: null },
      { table_name: "StockCountSession", column_name: "accountabilityContext", is_nullable: "NO", column_default: "'NONE'::\"StockCountAccountabilityContext\"" },
    ]);
    const legacy = await createHandover();
    const stored = await db.$queryRaw<{ target: string | null; resolvedTarget: string | null }[]>`
      SELECT "target"::text, "resolvedTarget"::text FROM "HandoverSession" WHERE id = ${legacy.id}
    `;
    assert.deepEqual(stored[0], { target: null, resolvedTarget: null });
  });

  test("accountability CHECK accepts exactly the three legal forms", async () => {
    const handover = await createHandover();
    const legal = [
      ["NONE", null, null],
      ["HANDOVER", handover.id, null],
      ["BRANCH_OPENING_VERIFICATION", null, branchCustodyId],
    ] as const;
    for (const [context, handoverId, openingId] of legal) {
      const id = randomUUID();
      await db.$executeRawUnsafe(
        `INSERT INTO "StockCountSession" ("id","cafeId","branchId","type","status","mode","scopeDerivation","initiatedById","accountabilityContext","handoverId","openingBranchCustodyPeriodId","createdAt","updatedAt") VALUES ($1,$2,$3,'CRITICAL','DRAFT','BLIND','CRITICAL_ONLY',$4,$5::"StockCountAccountabilityContext",$6,$7,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
        id, cafeId, branchId, userId, context, handoverId, openingId,
      );
      await db.stockCountSession.delete({ where: { id } });
    }
  });

  test("accountability CHECK rejects every mixed or missing binding", async () => {
    const handover = await createHandover();
    const illegal = [
      ["NONE", handover.id, null], ["NONE", null, branchCustodyId], ["NONE", handover.id, branchCustodyId],
      ["HANDOVER", null, null], ["HANDOVER", null, branchCustodyId], ["HANDOVER", handover.id, branchCustodyId],
      ["BRANCH_OPENING_VERIFICATION", null, null], ["BRANCH_OPENING_VERIFICATION", handover.id, null], ["BRANCH_OPENING_VERIFICATION", handover.id, branchCustodyId],
    ] as const;
    for (const [context, handoverId, openingId] of illegal) {
      await assert.rejects(() => db.$executeRawUnsafe(
        `INSERT INTO "StockCountSession" ("id","cafeId","branchId","type","status","mode","scopeDerivation","initiatedById","accountabilityContext","handoverId","openingBranchCustodyPeriodId","createdAt","updatedAt") VALUES ($1,$2,$3,'CRITICAL','DRAFT','BLIND','CRITICAL_ONLY',$4,$5::"StockCountAccountabilityContext",$6,$7,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
        randomUUID(), cafeId, branchId, userId, context, handoverId, openingId,
      ));
    }
  });

  test("unique evidence bindings and RESTRICT foreign keys preserve external evidence", async () => {
    const handover = await persistedHandover();
    const session = await createCountSession({ handoverId: handover.id });
    const { settleRequiredItems } = await requiredItemsLib();
    await db.$transaction((tx) => settleRequiredItems(tx, { handoverId: handover.id, acceptedSessionId: session.id }));
    await assert.rejects(() => db.inventoryItem.delete({ where: { id: criticalId } }));
    const line = await db.stockCountLine.findFirstOrThrow({ where: { sessionId: session.id } });
    await assert.rejects(() => db.stockCountLine.delete({ where: { id: line.id } }));
    const duplicate = await createHandover();
    await assert.rejects(() => db.$executeRawUnsafe(
      `INSERT INTO "HandoverRequiredItem" ("id","handoverId","inventoryItemId","itemNameSnapshot","unitSnapshot","isCriticalSnapshot","createdAt","updatedAt") VALUES ($1,$2,$3,$4,'KG',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
      randomUUID(), duplicate.id, criticalId, "duplicate",
    ).then(() => db.$executeRawUnsafe(
      `INSERT INTO "HandoverRequiredItem" ("id","handoverId","inventoryItemId","itemNameSnapshot","unitSnapshot","isCriticalSnapshot","createdAt","updatedAt") VALUES ($1,$2,$3,$4,'KG',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
      randomUUID(), duplicate.id, criticalId, "duplicate two",
    )));
  });

  test("required rows follow aggregate deletion when no external accountability session blocks it", async () => {
    const handover = await persistedHandover();
    assert.equal(await db.handoverRequiredItem.count({ where: { handoverId: handover.id } }), 1);
    await db.handoverSession.delete({ where: { id: handover.id } });
    assert.equal(await db.handoverRequiredItem.count({ where: { handoverId: handover.id } }), 0);
  });
});

describe("HANDOVER-004 authoritative required-item planning", () => {
  test("regular SELECTED uses only authoritative active critical scope and exact snapshots", async () => {
    await configure({ mode: "SELECTED" });
    const { planRequiredItems } = await requiredItemsLib();
    const plan = await db.$transaction((tx) => planRequiredItems(tx, {
      cafeId, branchId, at: new Date("2026-09-01T10:00:00Z"), target: "SHIFT_TO_SHIFT",
    }));
    assert.equal(plan.mode, "SELECTED");
    assert.equal(plan.trigger, "REGULAR_MODE");
    assert.deepEqual(plan.items, [{
      inventoryItemId: criticalId,
      itemNameSnapshot: `${MARKER} critical`,
      unitSnapshot: "KG",
      isCriticalSnapshot: true,
    }]);
    assert.equal("costPerUnit" in plan.items[0], false);
    assert.equal(plan.items.some((item) => [archivedId, inactiveId].includes(item.inventoryItemId)), false);
  });

  test("regular FULL uses every active unarchived item in authoritative order", async () => {
    await configure({ mode: "FULL" });
    const { planRequiredItems } = await requiredItemsLib();
    const plan = await db.$transaction((tx) => planRequiredItems(tx, {
      cafeId, branchId, at: new Date("2026-09-01T10:00:00Z"), target: "SHIFT_TO_SHIFT",
    }));
    assert.equal(plan.mode, "FULL");
    assert.equal(plan.trigger, "REGULAR_MODE");
    assert.deepEqual(plan.items.map((item) => item.inventoryItemId), [criticalId, regularId]);
  });

  test("SHIFT_TO_SHIFT never widens for daily or weekly schedules", async () => {
    const { planRequiredItems } = await requiredItemsLib();
    for (const periodic of [
      { schedule: "DAILY_LAST_HANDOVER" as const, weekday: null },
      { schedule: "WEEKLY" as const, weekday: 2 },
    ]) {
      await configure({ mode: "SELECTED", ...periodic });
      const plan = await db.$transaction((tx) => planRequiredItems(tx, {
        cafeId, branchId, at: new Date("2026-09-01T10:00:00Z"), target: "SHIFT_TO_SHIFT",
      }));
      assert.equal(plan.mode, "SELECTED");
      assert.equal(plan.trigger, "REGULAR_MODE");
      assert.deepEqual(plan.items.map((item) => item.inventoryItemId), [criticalId]);
    }
  });

  test("BRANCH_CUSTODY widens daily and on the matching weekly business weekday", async () => {
    const { planRequiredItems } = await requiredItemsLib();
    for (const periodic of [
      { schedule: "DAILY_LAST_HANDOVER" as const, weekday: null, trigger: "PERIODIC_DAILY" },
      { schedule: "WEEKLY" as const, weekday: 2, trigger: "PERIODIC_WEEKLY" },
    ]) {
      await configure({ mode: "SELECTED", schedule: periodic.schedule, weekday: periodic.weekday });
      const plan = await db.$transaction((tx) => planRequiredItems(tx, {
        cafeId, branchId, at: new Date("2026-09-01T10:00:00Z"), target: "BRANCH_CUSTODY",
      }));
      assert.equal(plan.mode, "FULL");
      assert.equal(plan.trigger, periodic.trigger);
      assert.deepEqual(plan.items.map((item) => item.inventoryItemId), [criticalId, regularId]);
    }
  });

  test("wrong weekly day stays regular while manual FULL keeps precedence over a due schedule", async () => {
    const { planRequiredItems } = await requiredItemsLib();
    await configure({ mode: "SELECTED", schedule: "WEEKLY", weekday: 3 });
    const regular = await db.$transaction((tx) => planRequiredItems(tx, {
      cafeId, branchId, at: new Date("2026-09-01T10:00:00Z"), target: "BRANCH_CUSTODY",
    }));
    assert.equal(regular.trigger, "REGULAR_MODE");
    assert.equal(regular.mode, "SELECTED");
    await configure({ mode: "SELECTED", schedule: "DAILY_LAST_HANDOVER" });
    const manual = await db.$transaction((tx) => planRequiredItems(tx, {
      cafeId, branchId, at: new Date("2026-09-01T10:00:00Z"), target: "BRANCH_CUSTODY", manualFullCount: true,
    }));
    assert.equal(manual.trigger, "MANUAL_FULL");
    assert.equal(manual.mode, "FULL");
  });

  test("planning reuses Cairo's 03:00 business boundary", async () => {
    const { planRequiredItems } = await requiredItemsLib();
    const before = await db.$transaction((tx) => planRequiredItems(tx, {
      cafeId, branchId, at: new Date("2026-01-01T00:30:00Z"), target: "SHIFT_TO_SHIFT",
    }));
    const afterBoundary = await db.$transaction((tx) => planRequiredItems(tx, {
      cafeId, branchId, at: new Date("2026-01-01T01:00:00Z"), target: "SHIFT_TO_SHIFT",
    }));
    assert.equal(before.businessDate, "2025-12-31");
    assert.equal(afterBoundary.businessDate, "2026-01-01");
  });

  test("planning sees transaction-local configuration/items and emits no evidence writes", async () => {
    const { planRequiredItems } = await requiredItemsLib();
    const before = await db.handoverRequiredItem.count();
    const plan = await db.$transaction(async (tx) => {
      await tx.inventoryItem.update({ where: { id: regularId }, data: { isCritical: true, name: `${MARKER} tx-visible` } });
      return planRequiredItems(tx, {
        cafeId, branchId, at: new Date("2026-09-01T10:00:00Z"), target: "SHIFT_TO_SHIFT",
      });
    });
    assert.deepEqual(plan.items.map((item) => item.inventoryItemId), [criticalId, regularId]);
    assert.equal(plan.items.find((item) => item.inventoryItemId === regularId)?.itemNameSnapshot, `${MARKER} tx-visible`);
    assert.equal(await db.handoverRequiredItem.count(), before);
  });

  test("disabled or invalid handover configuration is refused without fallback writes", async () => {
    const { planRequiredItems } = await requiredItemsLib();
    await db.cafeSettings.update({ where: { cafeId }, data: { stockCountPolicy: "NO_SHIFT_COUNT" } });
    await assert.rejects(() => db.$transaction((tx) => planRequiredItems(tx, {
      cafeId, branchId, at: new Date("2026-09-01T10:00:00Z"), target: "SHIFT_TO_SHIFT",
    })), statusIs(400));
  });
});

describe("HANDOVER-004 immutable persistence", () => {
  test("first persistence writes the complete snapshot and exact required count only", async () => {
    const handover = await createHandover();
    const plan = manualPlan();
    const { persistRequiredItems } = await requiredItemsLib();
    const result = await db.$transaction((tx) => persistRequiredItems(tx, { handoverId: handover.id, plan }));
    assert.deepEqual(result, { handoverId: handover.id, requiredItemCount: 1, replayed: false });
    const stored = await db.handoverSession.findUniqueOrThrow({ where: { id: handover.id }, include: { requiredItems: true } });
    assert.equal(stored.target, "SHIFT_TO_SHIFT");
    assert.equal(stored.resolvedTarget, null);
    assert.equal(stored.acceptedStockCountSessionId, null);
    assert.equal(stored.requiredItemCount, 1);
    assert.equal(stored.requiredItems[0].itemNameSnapshot, `${MARKER} critical`);
  });

  test("caller rollback removes both scalar snapshot and required rows", async () => {
    const handover = await createHandover();
    const { persistRequiredItems } = await requiredItemsLib();
    await assert.rejects(() => db.$transaction(async (tx) => {
      await persistRequiredItems(tx, { handoverId: handover.id, plan: manualPlan() });
      throw new Error("ROLLBACK_SH14");
    }), /ROLLBACK_SH14/);
    const stored = await db.handoverSession.findUniqueOrThrow({ where: { id: handover.id } });
    assert.equal(stored.target, null);
    assert.equal(await db.handoverRequiredItem.count({ where: { handoverId: handover.id } }), 0);
  });

  test("identical replay is read-only while any immutable difference conflicts", async () => {
    const handover = await createHandover();
    const plan = manualPlan();
    const { persistRequiredItems } = await requiredItemsLib();
    await db.$transaction((tx) => persistRequiredItems(tx, { handoverId: handover.id, plan }));
    const row = await db.handoverRequiredItem.findFirstOrThrow({ where: { handoverId: handover.id } });
    const replay = await db.$transaction((tx) => persistRequiredItems(tx, { handoverId: handover.id, plan }));
    assert.equal(replay.replayed, true);
    assert.equal((await db.handoverRequiredItem.findUniqueOrThrow({ where: { id: row.id } })).updatedAt.getTime(), row.updatedAt.getTime());
    await assert.rejects(() => db.$transaction((tx) => persistRequiredItems(tx, {
      handoverId: handover.id,
      plan: { ...plan, items: [{ ...plan.items[0], itemNameSnapshot: "rewritten" }] },
    })), statusIs(409));
    assert.equal((await db.handoverRequiredItem.findUniqueOrThrow({ where: { id: row.id } })).itemNameSnapshot, `${MARKER} critical`);
  });

  test("original target cannot be rewritten and resolved target remains deferred", async () => {
    const handover = await persistedHandover();
    const { persistRequiredItems } = await requiredItemsLib();
    await assert.rejects(() => db.$transaction((tx) => persistRequiredItems(tx, {
      handoverId: handover.id,
      plan: { ...manualPlan(), target: "BRANCH_CUSTODY" },
    })), statusIs(409));
    const stored = await db.handoverSession.findUniqueOrThrow({ where: { id: handover.id } });
    assert.equal(stored.target, "SHIFT_TO_SHIFT");
    assert.equal(stored.resolvedTarget, null);
  });

  test("live configuration and item edits cannot rewrite a stored snapshot", async () => {
    const handover = await persistedHandover();
    const { persistRequiredItems } = await requiredItemsLib();
    await configure({ mode: "FULL", schedule: "DAILY_LAST_HANDOVER" });
    await db.inventoryItem.update({ where: { id: criticalId }, data: { name: `${MARKER} renamed`, unit: "BOX", isCritical: false } });
    const replay = await db.$transaction((tx) => persistRequiredItems(tx, { handoverId: handover.id, plan: manualPlan() }));
    assert.equal(replay.replayed, true);
    const required = await db.handoverRequiredItem.findFirstOrThrow({ where: { handoverId: handover.id } });
    assert.deepEqual(
      { name: required.itemNameSnapshot, unit: required.unitSnapshot, critical: required.isCriticalSnapshot },
      { name: `${MARKER} critical`, unit: "KG", critical: true },
    );
  });

  test("tenant, branch, and duplicate plan IDs are refused before mutation", async () => {
    const foreign = await createHandover({ cafeId: otherCafeId, branchId: otherCafeBranchId, shiftId: otherCafeShiftId, userId: otherCafeUserId });
    const local = await createHandover();
    const { persistRequiredItems } = await requiredItemsLib();
    await assert.rejects(() => db.$transaction((tx) => persistRequiredItems(tx, { handoverId: foreign.id, plan: manualPlan() })), statusIs(400));
    const duplicatePlan = manualPlan("SHIFT_TO_SHIFT", [manualPlan().items[0], manualPlan().items[0]]);
    await assert.rejects(() => db.$transaction((tx) => persistRequiredItems(tx, { handoverId: local.id, plan: duplicatePlan })), statusIs(400));
    assert.equal(await db.handoverRequiredItem.count({ where: { handoverId: local.id } }), 0);
  });
});

describe("HANDOVER-004 provisional settlement", () => {
  test("matching lines satisfy required rows, omissions are deterministic, and extras are ignored", async () => {
    const plan = manualPlan("SHIFT_TO_SHIFT", [manualPlan().items[0], {
      inventoryItemId: regularId,
      itemNameSnapshot: `${MARKER} regular`,
      unitSnapshot: "LITER",
      isCriticalSnapshot: false,
    }]);
    const handover = await persistedHandover(plan);
    const session = await createCountSession({ handoverId: handover.id, itemIds: [criticalId, archivedId] });
    const { settleRequiredItems } = await requiredItemsLib();
    const result = await db.$transaction((tx) => settleRequiredItems(tx, {
      handoverId: handover.id, acceptedSessionId: session.id, omissionNote: "  manager review  ",
    }));
    assert.deepEqual(result.omitted, [{
      inventoryItemId: regularId,
      itemNameSnapshot: `${MARKER} regular`,
      omissionNote: "manager review",
    }]);
    const rows = await db.handoverRequiredItem.findMany({ where: { handoverId: handover.id }, orderBy: { inventoryItemId: "asc" } });
    const satisfied = rows.find((row) => row.inventoryItemId === criticalId)!;
    const omitted = rows.find((row) => row.inventoryItemId === regularId)!;
    assert.ok(satisfied.satisfiedByLineId);
    assert.equal(satisfied.omitted, false);
    assert.equal(satisfied.omissionNote, null);
    assert.equal(omitted.satisfiedByLineId, null);
    assert.equal(omitted.omitted, true);
    assert.equal(omitted.omissionNote, "manager review");
    assert.equal(rows.some((row) => row.inventoryItemId === archivedId), false);
  });

  test("blank omission note becomes null and settlement never writes final handover fields", async () => {
    const handover = await persistedHandover();
    const session = await createCountSession({ handoverId: handover.id, itemIds: [] });
    const { settleRequiredItems } = await requiredItemsLib();
    await db.$transaction((tx) => settleRequiredItems(tx, { handoverId: handover.id, acceptedSessionId: session.id, omissionNote: "   " }));
    const required = await db.handoverRequiredItem.findFirstOrThrow({ where: { handoverId: handover.id } });
    const stored = await db.handoverSession.findUniqueOrThrow({ where: { id: handover.id } });
    assert.equal(required.omitted, true);
    assert.equal(required.omissionNote, null);
    assert.equal(stored.acceptedStockCountSessionId, null);
    assert.equal(stored.resolvedTarget, null);
    assert.equal(stored.target, "SHIFT_TO_SHIFT");
  });

  test("cafe, branch, handover binding, and accountability context are enforced", async () => {
    const handover = await persistedHandover();
    const another = await createHandover();
    const foreign = await createCountSession({
      handoverId: handover.id,
      cafeId: otherCafeId,
      branchId: otherCafeBranchId,
      shiftId: otherCafeShiftId,
      userId: otherCafeUserId,
      itemIds: [],
    });
    const branchMismatch = await createCountSession({ handoverId: handover.id, branchId: otherBranchId, shiftId: otherBranchShiftId, itemIds: [] });
    const wrongHandover = await createCountSession({ handoverId: another.id });
    const none = await createCountSession({ context: "NONE", handoverId: null });
    const opening = await createCountSession({ context: "BRANCH_OPENING_VERIFICATION", handoverId: null, openingBranchCustodyPeriodId: branchCustodyId });
    const { settleRequiredItems } = await requiredItemsLib();
    for (const session of [foreign, branchMismatch, wrongHandover, none, opening]) {
      await assert.rejects(() => db.$transaction((tx) => settleRequiredItems(tx, {
        handoverId: handover.id, acceptedSessionId: session.id,
      })), (error: unknown) => [400, 409].includes((error as { status?: number }).status ?? 0));
    }
  });

  test("workflow-attached count is distinct from the provisional accepted session", async () => {
    const workflow = await createCountSession({ context: "NONE", handoverId: null });
    const handover = await createHandover({ stockCountSessionId: workflow.id });
    const { persistRequiredItems, settleRequiredItems } = await requiredItemsLib();
    await db.$transaction((tx) => persistRequiredItems(tx, { handoverId: handover.id, plan: manualPlan() }));
    const accepted = await createCountSession({ handoverId: handover.id });
    await db.$transaction((tx) => settleRequiredItems(tx, { handoverId: handover.id, acceptedSessionId: accepted.id }));
    const stored = await db.handoverSession.findUniqueOrThrow({ where: { id: handover.id } });
    assert.equal(stored.stockCountSessionId, workflow.id);
    assert.equal(stored.acceptedStockCountSessionId, null);
  });

  test("a later handover-bound recount session may replace provisional evidence", async () => {
    const handover = await persistedHandover();
    const first = await createCountSession({ handoverId: handover.id });
    const recount = await createCountSession({ handoverId: handover.id });
    const { settleRequiredItems } = await requiredItemsLib();
    await db.$transaction((tx) => settleRequiredItems(tx, { handoverId: handover.id, acceptedSessionId: first.id }));
    const firstLine = (await db.handoverRequiredItem.findFirstOrThrow({ where: { handoverId: handover.id } })).satisfiedByLineId;
    await db.$transaction((tx) => settleRequiredItems(tx, { handoverId: handover.id, acceptedSessionId: recount.id }));
    const recountLine = (await db.handoverRequiredItem.findFirstOrThrow({ where: { handoverId: handover.id } })).satisfiedByLineId;
    assert.notEqual(recountLine, firstLine);
    assert.equal((await db.stockCountLine.findUniqueOrThrow({ where: { id: recountLine! } })).sessionId, recount.id);
  });

  test("final accepted binding allows identical replay but forbids replacement", async () => {
    const handover = await persistedHandover();
    const final = await createCountSession({ handoverId: handover.id });
    const replacement = await createCountSession({ handoverId: handover.id });
    const { settleRequiredItems } = await requiredItemsLib();
    await db.$transaction((tx) => settleRequiredItems(tx, { handoverId: handover.id, acceptedSessionId: final.id }));
    await db.handoverSession.update({ where: { id: handover.id }, data: { acceptedStockCountSessionId: final.id } });
    const replay = await db.$transaction((tx) => settleRequiredItems(tx, { handoverId: handover.id, acceptedSessionId: final.id }));
    assert.equal(replay.replayed, true);
    await assert.rejects(() => db.$transaction((tx) => settleRequiredItems(tx, {
      handoverId: handover.id, acceptedSessionId: replacement.id,
    })), statusIs(409));
  });
});

describe("HANDOVER-004 SH-22 immutable source proof", () => {
  test("opening scope can be reconstructed after live config and item metadata change", async () => {
    const handover = await persistedHandover();
    await configure({ mode: "FULL", schedule: "DAILY_LAST_HANDOVER" });
    await db.inventoryItem.update({ where: { id: criticalId }, data: { name: `${MARKER} live rename`, unit: "BOX", isCritical: false } });
    const source = await db.handoverSession.findUniqueOrThrow({
      where: { id: handover.id },
      select: {
        target: true,
        stockMode: true,
        requiredItemTrigger: true,
        requiredItemCount: true,
        periodicScheduleSnapshot: true,
        periodicWeekdaySnapshot: true,
        configSnapshotAt: true,
        businessDateSnapshot: true,
        requiredItems: { select: { inventoryItemId: true, itemNameSnapshot: true, unitSnapshot: true, isCriticalSnapshot: true } },
      },
    });
    assert.deepEqual(source, {
      target: "SHIFT_TO_SHIFT",
      stockMode: "SELECTED",
      requiredItemTrigger: "REGULAR_MODE",
      requiredItemCount: 1,
      periodicScheduleSnapshot: "MANUAL_ONLY",
      periodicWeekdaySnapshot: null,
      configSnapshotAt: new Date("2026-09-01T10:00:00.000Z"),
      businessDateSnapshot: "2026-09-01",
      requiredItems: [{
        inventoryItemId: criticalId,
        itemNameSnapshot: `${MARKER} critical`,
        unitSnapshot: "KG",
        isCriticalSnapshot: true,
      }],
    });
  });
});
