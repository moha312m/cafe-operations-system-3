import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { db, tag, teardownTaggedCafe } from "./helpers/db";
import {
  fullCountDue,
  fullCountDueInTransaction,
  resolvePeriodicFullCount,
} from "@/lib/stock-count-policy";
import { businessDateInTz, DEFAULT_TZ } from "@/lib/date-range";

const MARKER = tag("COUNT016");
let cafeId: string;
let otherCafeId: string;
let branchId: string;
let otherCafeBranchId: string;
let initiatorId: string;

async function setCafeSchedule(schedule: "DAILY_LAST_HANDOVER" | "WEEKLY" | "MANUAL_ONLY", weekday: number | null) {
  await db.cafeSettings.update({
    where: { cafeId },
    data: { periodicFullCountSchedule: schedule, periodicFullCountWeekday: weekday },
  });
}

async function clearBranchOverride() {
  await db.branch.update({
    where: { id: branchId },
    data: {
      periodicFullCountScheduleOverride: null,
      periodicFullCountWeekdayOverride: null,
    },
  });
}

before(async () => {
  const cafe = await db.cafe.create({
    data: {
      name: `${MARKER} cafe`, slug: `${MARKER.toLowerCase()}-cafe`,
      settings: { create: {} }, branches: { create: { name: `${MARKER} branch` } },
    },
    include: { branches: true },
  });
  cafeId = cafe.id;
  branchId = cafe.branches[0].id;
  const initiator = await db.user.create({
    data: {
      cafeId, branchId,
      email: `${MARKER.toLowerCase()}@periodic-count.test`,
      passwordHash: "test-only", name: `${MARKER} initiator`, role: "INVENTORY_MANAGER",
    },
  });
  initiatorId = initiator.id;

  const otherCafe = await db.cafe.create({
    data: {
      name: `${MARKER} other cafe`, slug: `${MARKER.toLowerCase()}-other`,
      settings: { create: {} }, branches: { create: { name: `${MARKER} other branch` } },
    },
    include: { branches: true },
  });
  otherCafeId = otherCafe.id;
  otherCafeBranchId = otherCafe.branches[0].id;
});

after(async () => {
  await teardownTaggedCafe([cafeId, otherCafeId]);
});

describe("COUNT-016 periodic full-count boundaries", () => {
  test("new cafe defaults to MANUAL_ONLY with no weekday", async () => {
    const settings = await db.cafeSettings.findUniqueOrThrow({ where: { cafeId } });
    assert.equal(settings.periodicFullCountSchedule, "MANUAL_ONLY");
    assert.equal(settings.periodicFullCountWeekday, null);
  });

  test("a NULL branch override inherits the cafe schedule and provenance", async () => {
    await setCafeSchedule("WEEKLY", 1);
    await clearBranchOverride();
    const resolved = await resolvePeriodicFullCount(cafeId, branchId);
    assert.deepEqual(resolved, {
      schedule: "WEEKLY", weekday: 1,
      source: { schedule: "CAFE", weekday: "CAFE" },
    });
  });

  test("branch schedule and weekday overrides win with branch provenance", async () => {
    await setCafeSchedule("WEEKLY", 1);
    await db.branch.update({
      where: { id: branchId },
      data: { periodicFullCountScheduleOverride: "DAILY_LAST_HANDOVER", periodicFullCountWeekdayOverride: null },
    });
    const resolved = await resolvePeriodicFullCount(cafeId, branchId);
    assert.deepEqual(resolved, {
      schedule: "DAILY_LAST_HANDOVER", weekday: null,
      source: { schedule: "BRANCH", weekday: "BRANCH" },
    });
  });

  test("cross-cafe branch resolution is rejected", async () => {
    await assert.rejects(
      () => resolvePeriodicFullCount(cafeId, otherCafeBranchId),
      /branch|cafe|ÙØ±Ø¹|ÙƒØ§ÙÙŠÙ‡/i,
    );
  });

  test("database constraints reject invalid cafe schedule combinations", async () => {
    for (const [schedule, weekday] of [
      ["WEEKLY", null], ["WEEKLY", -1], ["WEEKLY", 7], ["MANUAL_ONLY", 1],
    ] as const) {
      await assert.rejects(() => db.cafeSettings.update({
        where: { cafeId }, data: { periodicFullCountSchedule: schedule, periodicFullCountWeekday: weekday },
      }));
    }
  });

  test("database constraints reject invalid branch override combinations", async () => {
    for (const [schedule, weekday] of [
      [null, 1], ["WEEKLY", null], ["WEEKLY", -1], ["WEEKLY", 7], ["MANUAL_ONLY", 1],
    ] as const) {
      await assert.rejects(() => db.branch.update({
        where: { id: branchId },
        data: { periodicFullCountScheduleOverride: schedule, periodicFullCountWeekdayOverride: weekday },
      }));
    }
  });

  test("MANUAL_ONLY is never due for either target", async () => {
    await setCafeSchedule("MANUAL_ONLY", null);
    await clearBranchOverride();
    for (const target of ["BRANCH_CUSTODY", "SHIFT_TO_SHIFT"] as const) {
      const verdict = await fullCountDue({ cafeId, branchId, at: new Date("2026-09-01T10:00:00Z"), target });
      assert.equal(verdict.due, false);
      assert.equal(verdict.reason, target === "SHIFT_TO_SHIFT" ? "SHIFT_TO_SHIFT" : "MANUAL_ONLY");
    }
  });

  test("DAILY is due only for intentional branch custody", async () => {
    await setCafeSchedule("DAILY_LAST_HANDOVER", null);
    await clearBranchOverride();
    const due = await fullCountDue({ cafeId, branchId, at: new Date("2026-09-01T10:00:00Z"), target: "BRANCH_CUSTODY" });
    const notDue = await fullCountDue({ cafeId, branchId, at: new Date("2026-09-01T10:00:00Z"), target: "SHIFT_TO_SHIFT" });
    assert.equal(due.due, true);
    assert.equal(due.reason, "DAILY_BRANCH_CUSTODY");
    assert.equal(notDue.due, false);
    assert.equal(notDue.reason, "SHIFT_TO_SHIFT");
  });

  test("WEEKLY uses the business-date weekday, not raw instant weekday", async () => {
    await setCafeSchedule("WEEKLY", 1);
    await clearBranchOverride();
    const beforeThree = await fullCountDue({ cafeId, branchId, at: new Date("2026-08-31T23:30:00Z"), target: "BRANCH_CUSTODY" });
    const atThree = await fullCountDue({ cafeId, branchId, at: new Date("2026-09-01T00:00:00Z"), target: "BRANCH_CUSTODY" });
    assert.deepEqual(
      { due: beforeThree.due, businessDate: beforeThree.businessDate, reason: beforeThree.reason },
      { due: true, businessDate: "2026-08-31", reason: "WEEKLY_MATCHING_BRANCH_CUSTODY" },
    );
    assert.deepEqual(
      { due: atThree.due, businessDate: atThree.businessDate, reason: atThree.reason },
      { due: false, businessDate: "2026-09-01", reason: "WEEKLY_NON_MATCHING_WEEKDAY" },
    );
  });

  test("WEEKLY never fires for SHIFT_TO_SHIFT on either side of 03:00", async () => {
    await setCafeSchedule("WEEKLY", 1);
    await clearBranchOverride();
    for (const at of [new Date("2026-08-31T23:59:59Z"), new Date("2026-09-01T00:00:00Z")]) {
      const verdict = await fullCountDue({ cafeId, branchId, at, target: "SHIFT_TO_SHIFT" });
      assert.equal(verdict.due, false);
      assert.equal(verdict.reason, "SHIFT_TO_SHIFT");
    }
  });

  test("prior confirmed, locked, and submitted FULL counts never suppress the boundary", async () => {
    await setCafeSchedule("DAILY_LAST_HANDOVER", null);
    await clearBranchOverride();
    for (const status of ["CONFIRMED", "LOCKED", "SUBMITTED"] as const) {
      await db.stockCountSession.create({
        data: {
          cafeId, branchId, initiatedById: initiatorId,
          type: "FULL", status, mode: "BLIND", scopeDerivation: "ALL_ELIGIBLE",
        },
      });
    }
    const verdict = await fullCountDue({ cafeId, branchId, at: new Date("2026-09-01T10:00:00Z"), target: "BRANCH_CUSTODY" });
    assert.equal(verdict.due, true);
    assert.equal("lastFullCountBusinessDate" in verdict, false);
    assert.equal(verdict.reason, "DAILY_BRANCH_CUSTODY");
  });

  test("businessDateInTz observes Cairo's 03:00 cutoff across civil boundaries", () => {
    assert.equal(businessDateInTz(new Date("2026-08-31T23:59:59Z"), DEFAULT_TZ), "2026-08-31");
    assert.equal(businessDateInTz(new Date("2026-09-01T00:00:00Z"), DEFAULT_TZ), "2026-09-01");
    assert.equal(businessDateInTz(new Date("2026-01-01T00:30:00Z"), DEFAULT_TZ), "2025-12-31");
    assert.equal(businessDateInTz(new Date("2024-03-01T00:30:00Z"), DEFAULT_TZ), "2024-02-29");
  });

  test("businessDateInTz remains timezone-safe through Cairo's DST history", () => {
    assert.equal(businessDateInTz(new Date("2024-04-25T23:30:00Z"), DEFAULT_TZ), "2024-04-25");
    assert.equal(businessDateInTz(new Date("2024-04-26T00:30:00Z"), DEFAULT_TZ), "2024-04-26");
  });

  test("M15 contains only the approved schema changes and no prohibited DML", () => {
    const sql = readFileSync("prisma/migrations/20260830233911_handover_branch_configuration/migration.sql", "utf8");
    assert.match(sql, /CREATE TYPE "PeriodicFullCountSchedule"/);
    assert.doesNotMatch(sql, /\b(?:UPDATE|INSERT|DELETE|TRUNCATE)\b/i);
  });

  test("fullCountDue does not infer target from shift state or suppress a prior count", () => {
    const src = readFileSync("src/lib/stock-count-policy.ts", "utf8");
    const start = src.indexOf("export async function fullCountDue");
    const body = src.slice(start);
    for (const forbidden of ["stockCountSession", "getActiveShift", "custodyReadyAt", "custodyGateReason"]) {
      assert.equal(body.includes(forbidden), false, `fullCountDue must not use ${forbidden}`);
    }
    assert.equal(body.includes("ALREADY_COUNTED_TODAY"), false);
  });

  test("transactional due verdict matches every target, schedule, and 03:00 boundary", async () => {
    const cases = [
      { schedule: "DAILY_LAST_HANDOVER", weekday: null, at: "2026-09-01T10:00:00Z", target: "BRANCH_CUSTODY" },
      { schedule: "DAILY_LAST_HANDOVER", weekday: null, at: "2026-09-01T10:00:00Z", target: "SHIFT_TO_SHIFT" },
      { schedule: "WEEKLY", weekday: 1, at: "2026-08-31T23:30:00Z", target: "BRANCH_CUSTODY" },
      { schedule: "WEEKLY", weekday: 1, at: "2026-09-01T00:00:00Z", target: "BRANCH_CUSTODY" },
      { schedule: "WEEKLY", weekday: 1, at: "2026-08-31T23:30:00Z", target: "SHIFT_TO_SHIFT" },
      { schedule: "MANUAL_ONLY", weekday: null, at: "2026-09-01T10:00:00Z", target: "BRANCH_CUSTODY" },
    ] as const;

    for (const sample of cases) {
      await setCafeSchedule(sample.schedule, sample.weekday);
      await clearBranchOverride();
      const args = {
        cafeId,
        branchId,
        at: new Date(sample.at),
        target: sample.target,
      };
      const global = await fullCountDue(args);
      const transactional = await db.$transaction((tx) => fullCountDueInTransaction(tx, args));
      assert.deepEqual(transactional, global);
    }
  });

  test("transactional due sees uncommitted schedule and performs no writes", async () => {
    await setCafeSchedule("MANUAL_ONLY", null);
    await clearBranchOverride();
    const queries: string[] = [];
    const client = new PrismaClient({
      datasourceUrl: process.env.DATABASE_URL,
      log: [{ emit: "event", level: "query" }],
    });
    client.$on("query", (event) => queries.push(event.query));

    try {
      await client.$transaction(async (tx) => {
        await tx.branch.update({
          where: { id: branchId },
          data: {
            periodicFullCountScheduleOverride: "DAILY_LAST_HANDOVER",
            periodicFullCountWeekdayOverride: null,
          },
        });
        queries.length = 0;

        const verdict = await fullCountDueInTransaction(tx, {
          cafeId,
          branchId,
          at: new Date("2026-09-01T10:00:00Z"),
          target: "BRANCH_CUSTODY",
        });

        assert.deepEqual(
          { due: verdict.due, schedule: verdict.schedule, reason: verdict.reason },
          { due: true, schedule: "DAILY_LAST_HANDOVER", reason: "DAILY_BRANCH_CUSTODY" },
          "the supplied transaction must expose its uncommitted schedule override",
        );
        assert.equal(
          queries.some((sql) => /\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(sql)),
          false,
          "the measured resolver window must contain reads only",
        );

        await tx.branch.update({
          where: { id: branchId },
          data: {
            periodicFullCountScheduleOverride: null,
            periodicFullCountWeekdayOverride: null,
          },
        });
      });
    } finally {
      await client.$disconnect();
    }
  });

  test("transactional due rejects a branch from another cafe", async () => {
    await assert.rejects(
      db.$transaction((tx) => fullCountDueInTransaction(tx, {
        cafeId,
        branchId: otherCafeBranchId,
        at: new Date("2026-09-01T10:00:00Z"),
        target: "BRANCH_CUSTODY",
      })),
      /branch|cafe/i,
    );
  });
});
