// VAR-003 — keep the shop open unless the owner says otherwise.
//
// Whether a variance stops a handover is a business decision, not a product
// constant. A café that finds an 18 g coffee discrepancy every evening and a
// café that treats any shortage as a stop-the-line event are both being
// reasonable; the software's job is to hold whichever one an owner chose.
// So the defaults are permissive, every existing café keeps them, and
// blocking only happens when somebody turned it on.
//
// The sharp edge is item 12 in the other direction. An impact nobody could
// quantify must NOT block. It is tempting to treat "we don't know what this
// cost" as the dangerous case and stop the shop — but that turns missing cost
// data into an operational outage, and missing cost data is exactly what a
// café with an incomplete recipe book has every day. Unknown is not
// "presumed large". `caseIsBlocking` returns false whenever
// `financialImpactAvailable` is false, whatever the policy says, and that is
// asserted below under a policy that would otherwise block.
//
// This is also M10, and it is additive. Revision 1 added these columns by
// editing an already-applied migration, which is the thing that makes a
// deployed database and a repository disagree forever. The last test asserts
// that did not happen here: the variance-case migration is byte-identical to
// what its own commit recorded, and appears in exactly one commit.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { db, tag, teardownTaggedCafe } from "./helpers/db";
import {
  caseIsBlocking, openVarianceCase, resolveRecountPolicy, resolveVarianceBlocking,
} from "@/lib/variance-case";

const MARKER = tag("VAR003");
let cafeId: string;
let branchId: string;
let openerId: string;
let lineId: string;

before(async () => {
  const cafe = await db.cafe.create({
    data: {
      name: `${MARKER} cafe`, slug: MARKER.toLowerCase(),
      settings: { create: {} },
      branches: { create: [{ name: `${MARKER} main` }] },
    },
    include: { branches: true },
  });
  cafeId = cafe.id;
  branchId = cafe.branches[0].id;

  const mk = async (suffix: string, role: "CASHIER" | "BRANCH_MANAGER") =>
    (await db.user.create({
      data: {
        email: `${MARKER}-${suffix}@example.invalid`, name: `${MARKER}-${suffix}`,
        passwordHash: "no-login-path", role, cafeId, branchId,
      },
    })).id;
  openerId = await mk("opener", "BRANCH_MANAGER");

  const itemId = (await db.inventoryItem.create({
    data: {
      cafeId, branchId, name: `${MARKER} beans`, unit: "KG",
      costPerUnit: 450, currentStock: "12.000",
    },
  })).id;
  const sessionId = (await db.stockCountSession.create({
    data: {
      cafeId, branchId, type: "FULL", scopeDerivation: "ALL_ELIGIBLE",
      initiatedById: openerId,
    },
  })).id;
  lineId = (await db.stockCountLine.create({
    data: {
      sessionId, inventoryItemId: itemId, unit: "KG",
      expectedQuantity: "12.000", countedQuantity: "11.500", varianceQuantity: "-0.500",
    },
  })).id;
});

after(() => teardownTaggedCafe(cafeId, [], { disconnect: true }));

const setPolicy = (data: Record<string, unknown>) =>
  db.cafeSettings.update({ where: { cafeId }, data });

const clearCases = async () => {
  await db.shift.updateMany({ where: { cafeId }, data: { cashVarianceCaseId: null } });
  await db.varianceCase.deleteMany({ where: { cafeId } });
};

describe("VAR-003 variance blocking and recount policy", () => {
  test("the defaults keep the shop open", async () => {
    const policy = await resolveVarianceBlocking(cafeId);
    assert.equal(policy.blocksHandover, false, "a new café blocks nothing");
    assert.equal(policy.hardBlockAmount, null, "and sets no threshold");
  });

  test("every café that existed before this migration reads the permissive default", async () => {
    // Backfill, not just a column default. An existing shop must not wake up
    // signed into blocking it never agreed to.
    //
    // "Existed before" has to be decided by the migration's own recorded
    // timestamp, not by "every settings row present when this file started".
    // The latter is whatever the database happened to be carrying — on a
    // long-lived one it is genuinely pre-migration rows, and on a freshly
    // migrated one it is rows created minutes ago that only ever saw the
    // column defaults. The old form also required that population to be
    // non-empty, which made a pristine database fail a check about history it
    // does not have. Where nothing pre-dates the migration there is nothing
    // that could have been signed up, and that is a truthful pass.
    const applied = await db.$queryRaw<{ finished_at: Date | null }[]>`
      SELECT "finished_at" FROM "_prisma_migrations"
       WHERE "migration_name" = '20260828190000_variance_policy'
       LIMIT 1
    `;
    const migratedAt = applied[0]?.finished_at ?? null;
    assert.ok(migratedAt, "the variance-policy migration must be recorded as applied");

    const rows = await db.cafeSettings.findMany({
      where: { cafe: { createdAt: { lt: migratedAt } } },
      select: {
        id: true, varianceBlocksHandover: true, varianceHardBlockAmount: true,
        recountRequiredOutsideTolerance: true, recountMaxAttempts: true, allowSelfRecount: true,
      },
    });
    for (const r of rows) {
      assert.equal(r.varianceBlocksHandover, false, `${r.id} blocks nothing`);
      assert.equal(r.varianceHardBlockAmount, null);
      assert.equal(r.recountRequiredOutsideTolerance, true, "recount stays required");
      assert.equal(r.recountMaxAttempts, 2);
      assert.equal(r.allowSelfRecount, true);
    }
  });

  test("with blocking on and a 500 threshold, 600 blocks and 100 does not", async () => {
    await setPolicy({ varianceBlocksHandover: true, varianceHardBlockAmount: "500.00" });
    const policy = await resolveVarianceBlocking(cafeId);
    assert.equal(policy.blocksHandover, true);
    assert.equal(policy.hardBlockAmount, 500);

    assert.equal(
      caseIsBlocking({ policy, amountVariance: -600, financialImpactAvailable: true }),
      true,
      "past the line the owner drew"
    );
    assert.equal(
      caseIsBlocking({ policy, amountVariance: 600, financialImpactAvailable: true }),
      true,
      "a surplus is as much a discrepancy as a shortage"
    );
    assert.equal(
      caseIsBlocking({ policy, amountVariance: -100, financialImpactAvailable: true }),
      false,
      "inside it, the shop keeps working"
    );
    assert.equal(
      caseIsBlocking({ policy, amountVariance: -500, financialImpactAvailable: true }),
      true,
      "exactly at the threshold blocks — the amount is the block amount"
    );
  });

  test("an impact nobody can quantify never blocks, whatever the policy says", async () => {
    // Item 12 in the opposite direction. Treating "unknown" as "presumed
    // large" would turn an incomplete recipe book into a daily outage.
    await setPolicy({ varianceBlocksHandover: true, varianceHardBlockAmount: "500.00" });
    const policy = await resolveVarianceBlocking(cafeId);

    assert.equal(
      caseIsBlocking({ policy, amountVariance: -9999, financialImpactAvailable: false }),
      false,
      "an unpriced variance must not stop the shop, however large it looks"
    );
    assert.equal(
      caseIsBlocking({ policy, amountVariance: null, financialImpactAvailable: false }),
      false
    );
  });

  test("blocking on with no threshold blocks any quantified variance", async () => {
    // "On, but no number" is a coherent instruction: stop for anything we can
    // actually price. It still cannot block on an unknown.
    await setPolicy({ varianceBlocksHandover: true, varianceHardBlockAmount: null });
    const policy = await resolveVarianceBlocking(cafeId);
    assert.equal(policy.hardBlockAmount, null);

    assert.equal(
      caseIsBlocking({ policy, amountVariance: -1, financialImpactAvailable: true }), true
    );
    assert.equal(
      caseIsBlocking({ policy, amountVariance: -1, financialImpactAvailable: false }), false,
      "still not on an unknown"
    );
  });

  test("openVarianceCase writes the blocking verdict the policy implies", async () => {
    await clearCases();
    await setPolicy({ varianceBlocksHandover: true, varianceHardBlockAmount: "500.00" });

    const big = await db.$transaction((tx) =>
      openVarianceCase(tx, {
        cafeId, branchId, type: "STOCK", openedById: openerId,
        source: { kind: "STOCK_LINE", stockCountLineId: lineId },
        amountVariance: -600,
        financialImpact: { available: true, value: 600 },
      })
    );
    assert.equal(
      (await db.varianceCase.findUniqueOrThrow({ where: { id: big.caseId } })).blocking,
      true,
      "the case records the verdict rather than recomputing it at read time"
    );

    await clearCases();
    const unpriced = await db.$transaction((tx) =>
      openVarianceCase(tx, {
        cafeId, branchId, type: "STOCK", openedById: openerId,
        source: { kind: "STOCK_LINE", stockCountLineId: lineId },
        amountVariance: -600,
        financialImpact: { available: false, reason: "MISSING_COST" },
      })
    );
    assert.equal(
      (await db.varianceCase.findUniqueOrThrow({ where: { id: unpriced.caseId } })).blocking,
      false,
      "and an unpriced one is non-blocking even at the same figure"
    );
  });

  test("a case opened under the default policy is non-blocking", async () => {
    await clearCases();
    await setPolicy({ varianceBlocksHandover: false, varianceHardBlockAmount: null });
    const { caseId } = await db.$transaction((tx) =>
      openVarianceCase(tx, {
        cafeId, branchId, type: "STOCK", openedById: openerId,
        source: { kind: "STOCK_LINE", stockCountLineId: lineId },
        amountVariance: -9999,
        financialImpact: { available: true, value: 9999 },
      })
    );
    assert.equal(
      (await db.varianceCase.findUniqueOrThrow({ where: { id: caseId } })).blocking,
      false,
      "no owner said to stop, so nothing stops"
    );
  });

  test("resolveRecountPolicy returns exactly what the owner stored", async () => {
    await setPolicy({
      recountRequiredOutsideTolerance: true, recountMaxAttempts: 2, allowSelfRecount: true,
    });
    assert.deepEqual(
      await resolveRecountPolicy(cafeId),
      { required: true, maxAttempts: 2, allowSelf: true }
    );

    await setPolicy({ recountMaxAttempts: 1 });
    assert.equal((await resolveRecountPolicy(cafeId)).maxAttempts, 1, "one attempt is reflected");

    await setPolicy({ allowSelfRecount: false });
    assert.equal(
      (await resolveRecountPolicy(cafeId)).allowSelf, false,
      "a café that wants an independent second pair of eyes gets one"
    );

    await setPolicy({ recountRequiredOutsideTolerance: false });
    assert.equal((await resolveRecountPolicy(cafeId)).required, false);
  });

  test("no task in this plan edited a migration a prior task applied", async () => {
    // Item 7, asserted rather than promised. Editing an applied migration is
    // how a deployed database and a repository come to disagree permanently:
    // the checksum stops matching, and no later migration can fix a file that
    // already ran somewhere else.
    const applied = [
      "20260828160000_tender_reconciliation",
      "20260828170000_handover_session",
      "20260828180000_variance_case",
    ];
    for (const name of applied) {
      const path = `prisma/migrations/${name}/migration.sql`;

      const commits = execFileSync("git", ["log", "--format=%H", "--", path], {
        encoding: "utf8",
      }).trim().split("\n").filter(Boolean);
      assert.equal(
        commits.length, 1,
        `${name} appears in ${commits.length} commits — it must be written once and never touched`
      );

      const committed = execFileSync("git", ["show", `${commits[0]}:${path}`], {
        encoding: "utf8",
      });
      const onDisk = readFileSync(path, "utf8");
      assert.equal(
        onDisk.replace(/\r\n/g, "\n"),
        committed.replace(/\r\n/g, "\n"),
        `${name} differs from the blob its own commit recorded`
      );
    }
  });
});
