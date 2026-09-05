// VAR-011 (SH-22 · S1) — a span may close on a boundary or on an accepted
// opening count line, and the database permits exactly one of them.
//
// M22 gave `StockVarianceSpan.toBoundaryId` NOT NULL because the only thing
// that could close a span was a handover's `HandoverStockBoundary`. SH-22's
// branch opening verification produces no boundary at all: the difference is
// found by the accepted opening count itself, measured against the position
// the branch was left holding. The alternatives were both worse than a second
// column — a synthetic boundary would put a handover's artifact on a record
// no handover produced, and a single polymorphic `toEvidenceId` could carry
// no foreign key and could not say what it pointed at.
//
// ── WHY THIS SUITE BUILDS ROWS DIRECTLY ──
//
// Every proof here is about what the DATABASE refuses, not about what a
// workflow reaches. A CHECK constraint that only ever sees well-formed input
// from a service is a constraint nobody has tested; the whole point of
// writing it is the row that should never exist, and the only way to attempt
// that row is to attempt it. The reachable-workflow proofs live in
// `handover-010-branch-custody.test.ts`, which drives production routes and
// never constructs a span by hand.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { db, tag, teardownTaggedCafe } from "./helpers/db";

const MARKER = tag("VAR011");

let cafeId: string;
let branchId: string;
let managerId: string;
let shiftId: string;
let custodyId: string;
let handoverId: string;
let sessionId: string;

let seq = 0;
const nextId = (what: string) => `${MARKER}-${what}-${(seq += 1)}`;

/** An ingredient this suite owns. */
async function newItem(): Promise<string> {
  const item = await db.inventoryItem.create({
    data: {
      cafeId,
      branchId,
      name: nextId("item"),
      unit: "KG",
      costPerUnit: 450,
      currentStock: "12.000",
    },
  });
  return item.id;
}

/** A boundary row on the completed handover — the old closing arm. */
async function newBoundary(inventoryItemId: string): Promise<string> {
  const b = await db.handoverStockBoundary.create({
    data: {
      handoverId,
      inventoryItemId,
      source: "PHYSICAL_COUNT",
      verified: true,
      quantity: "12.000",
      itemVersion: BigInt(41),
    },
  });
  return b.id;
}

/** A count line on this suite's session — the new closing arm. */
async function newCountLine(inventoryItemId: string): Promise<string> {
  const line = await db.stockCountLine.create({
    data: {
      sessionId,
      inventoryItemId,
      unit: "KG",
      expectedQuantity: "12.000",
      countedQuantity: "11.500",
      effectiveCountedQuantity: "11.500",
      varianceQuantity: "-0.500",
      itemVersion: BigInt(42),
      expectedBasis: "LOCKED_ITEM_VERSION",
      disposition: "VARIANCE_CONFIRMED",
      confidence: "VERIFIED",
    },
  });
  return line.id;
}

/** A case for a span to hang from. One case, one span. */
async function newCase(stockCountLineId: string): Promise<string> {
  const c = await db.varianceCase.create({
    data: {
      cafeId,
      branchId,
      type: "STOCK",
      quantityVariance: "-0.500",
      confidence: "VERIFIED",
      attribution: "PERIOD_UNRESOLVED",
      stockCountLineId,
      openedById: managerId,
    },
  });
  return c.id;
}

/** The raw insert, so the database rather than Prisma's types decides. */
function insertSpan(args: {
  varianceCaseId: string;
  inventoryItemId: string;
  toBoundaryId: string | null;
  toStockCountLineId: string | null;
}) {
  return db.$executeRawUnsafe(
    `INSERT INTO "StockVarianceSpan"
       ("id", "varianceCaseId", "inventoryItemId", "toBoundaryId",
        "toStockCountLineId", "toVerifiedAt", "unverifiedBoundaryCount")
     VALUES ($1, $2, $3, $4, $5, now(), 0)`,
    nextId("span"),
    args.varianceCaseId,
    args.inventoryItemId,
    args.toBoundaryId,
    args.toStockCountLineId,
  );
}

before(async () => {
  cafeId = (
    await db.cafe.create({
      data: { name: `${MARKER} cafe`, slug: MARKER.toLowerCase(), settings: { create: {} } },
    })
  ).id;
  branchId = (await db.branch.create({ data: { cafeId, name: `${MARKER} branch` } })).id;
  managerId = (
    await db.user.create({
      data: {
        email: `${MARKER}-manager@example.invalid`,
        name: `${MARKER} manager`,
        passwordHash: "no-login-path",
        role: "BRANCH_MANAGER",
        cafeId,
        branchId,
      },
    })
  ).id;
  shiftId = (
    await db.shift.create({
      data: {
        cafeId,
        branchId,
        cashierId: managerId,
        shiftNumber: 1,
        openingCashAmount: 0,
        expectedCashAmount: 0,
      },
    })
  ).id;
  custodyId = (
    await db.custodyPeriod.create({
      data: { cafeId, branchId, scope: "STOCK", holderType: "USER", openedById: managerId },
    })
  ).id;
  handoverId = (
    await db.handoverSession.create({
      data: {
        cafeId,
        branchId,
        outgoingShiftId: shiftId,
        outgoingUserId: managerId,
        status: "COMPLETED",
        acceptedAt: new Date(),
        completedAt: new Date(),
        outgoingStockCustodyId: custodyId,
      },
    })
  ).id;
  sessionId = (
    await db.stockCountSession.create({
      data: {
        cafeId,
        branchId,
        shiftId,
        custodyPeriodId: custodyId,
        type: "FULL",
        scopeDerivation: "ALL_ELIGIBLE",
        status: "CONFIRMED",
        initiatedById: managerId,
      },
    })
  ).id;
});

after(() => teardownTaggedCafe(cafeId, [], { disconnect: true }));

// ── the two arms ───────────────────────────────────────────────────────

describe("VAR-011 exactly one closing arm", () => {
  test("the boundary arm is still valid, and leaves the new column NULL", async () => {
    const itemId = await newItem();
    const caseId = await newCase(await newCountLine(itemId));
    await insertSpan({
      varianceCaseId: caseId,
      inventoryItemId: itemId,
      toBoundaryId: await newBoundary(itemId),
      toStockCountLineId: null,
    });

    const span = await db.stockVarianceSpan.findUniqueOrThrow({
      where: { varianceCaseId: caseId },
    });
    assert.ok(span.toBoundaryId, "the handover arm still carries the boundary");
    assert.equal(
      span.toStockCountLineId,
      null,
      "and says nothing about a count line, because no count line closed it",
    );
  });

  test("the stock-count-line arm is valid, and leaves the boundary NULL", async () => {
    const itemId = await newItem();
    const lineId = await newCountLine(itemId);
    const caseId = await newCase(lineId);
    await insertSpan({
      varianceCaseId: caseId,
      inventoryItemId: itemId,
      toBoundaryId: null,
      toStockCountLineId: lineId,
    });

    const span = await db.stockVarianceSpan.findUniqueOrThrow({
      where: { varianceCaseId: caseId },
    });
    assert.equal(span.toStockCountLineId, lineId);
    assert.equal(
      span.toBoundaryId,
      null,
      "an opening verification writes no boundary, so it claims none",
    );
  });

  test("neither arm is refused — a span that records a gap nothing found", async () => {
    const itemId = await newItem();
    const caseId = await newCase(await newCountLine(itemId));
    await assert.rejects(
      () =>
        insertSpan({
          varianceCaseId: caseId,
          inventoryItemId: itemId,
          toBoundaryId: null,
          toStockCountLineId: null,
        }),
      /StockVarianceSpan_one_closing_evidence/,
    );
    assert.equal(await db.stockVarianceSpan.count({ where: { varianceCaseId: caseId } }), 0);
  });

  test("both arms are refused — one gap cannot have two things that found it", async () => {
    const itemId = await newItem();
    const lineId = await newCountLine(itemId);
    const caseId = await newCase(lineId);
    const boundaryId = await newBoundary(itemId);
    await assert.rejects(
      () =>
        insertSpan({
          varianceCaseId: caseId,
          inventoryItemId: itemId,
          toBoundaryId: boundaryId,
          toStockCountLineId: lineId,
        }),
      /StockVarianceSpan_one_closing_evidence/,
    );
    assert.equal(await db.stockVarianceSpan.count({ where: { varianceCaseId: caseId } }), 0);
  });
});

// ── the key the new arm carries, which the old one deliberately does not ──

describe("VAR-011 the closing line is a real reference", () => {
  test("a stock-count-line id that matches nothing is refused", async () => {
    const itemId = await newItem();
    const caseId = await newCase(await newCountLine(itemId));
    await assert.rejects(
      () =>
        insertSpan({
          varianceCaseId: caseId,
          inventoryItemId: itemId,
          toBoundaryId: null,
          toStockCountLineId: `${MARKER}-no-such-line`,
        }),
      /StockVarianceSpan_toStockCountLineId_fkey/,
    );
  });

  test("the line a span closed on cannot be deleted out from under it", async () => {
    const itemId = await newItem();
    const lineId = await newCountLine(itemId);
    const caseId = await newCase(lineId);
    await insertSpan({
      varianceCaseId: caseId,
      inventoryItemId: itemId,
      toBoundaryId: null,
      toStockCountLineId: lineId,
    });

    // RESTRICT, not CASCADE: the accepted line IS the evidence that found the
    // gap, and a span pointing at a deleted line would record a difference
    // with nothing behind it.
    await assert.rejects(
      () => db.stockCountLine.delete({ where: { id: lineId } }),
      /StockVarianceSpan_toStockCountLineId_fkey|Foreign key constraint/,
    );
    assert.equal(await db.stockCountLine.count({ where: { id: lineId } }), 1);
  });

  test("two spans cannot claim the same closing line", async () => {
    const itemId = await newItem();
    const lineId = await newCountLine(itemId);
    const first = await newCase(lineId);
    await insertSpan({
      varianceCaseId: first,
      inventoryItemId: itemId,
      toBoundaryId: null,
      toStockCountLineId: lineId,
    });

    const otherItemId = await newItem();
    const second = await newCase(await newCountLine(otherItemId));
    await assert.rejects(
      () =>
        insertSpan({
          varianceCaseId: second,
          inventoryItemId: otherItemId,
          toBoundaryId: null,
          toStockCountLineId: lineId,
        }),
      // PostgreSQL reports the offending KEY rather than the index name.
      /"toStockCountLineId"[\s\S]*already exists/,
    );
  });

  test("but any number of boundary rows may leave the new arm NULL", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const itemId = await newItem();
      const caseId = await newCase(await newCountLine(itemId));
      await insertSpan({
        varianceCaseId: caseId,
        inventoryItemId: itemId,
        toBoundaryId: await newBoundary(itemId),
        toStockCountLineId: null,
      });
      ids.push(caseId);
    }

    // PostgreSQL's unique indexes do not consider NULLs equal, which is what
    // lets the existing arm keep working under a UNIQUE on the new one.
    const rows = await db.stockVarianceSpan.findMany({
      where: { varianceCaseId: { in: ids } },
      select: { toStockCountLineId: true },
    });
    assert.equal(rows.length, 3, "three boundary-armed spans coexist");
    assert.ok(rows.every((r) => r.toStockCountLineId === null));
  });
});

// ── the migration itself ───────────────────────────────────────────────

describe("VAR-011 the migration invents nothing", () => {
  test("M23 contains no backfill", () => {
    const sql = readFileSync(
      path.join(
        process.cwd(),
        "prisma/migrations/20260831005911_variance_span_opening_evidence/migration.sql",
      ),
      "utf8",
    );

    // Comments are prose about the change and may legitimately mention the
    // words; the statements are what the database executes.
    const statements = sql
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith("--"));

    for (const verb of ["UPDATE", "INSERT", "DELETE"]) {
      // `ON UPDATE CASCADE` is a clause of a constraint, not a statement.
      const stray = statements.filter((line) =>
        new RegExp(`^\\s*${verb}\\b`, "i").test(line),
      );
      assert.deepEqual(
        stray,
        [],
        `M23 must not ${verb} anything — an existing row's verdict is nobody's to invent`,
      );
    }

    const body = statements.join("\n");
    assert.ok(
      /ALTER COLUMN "toBoundaryId" DROP NOT NULL/.test(body),
      "the old arm becomes optional",
    );
    assert.ok(
      /ADD COLUMN\s+"toStockCountLineId" TEXT/.test(body),
      "the new arm is added nullable, so existing rows need no value",
    );
  });

  test("no span anywhere is missing both arms", async () => {
    // Nothing in the database may hold a span without evidence. A backfill
    // would show up here as a row nobody's workflow created.
    const orphaned = await db.stockVarianceSpan.count({
      where: { toBoundaryId: null, toStockCountLineId: null },
    });
    assert.equal(orphaned, 0, "the CHECK makes an armless span unrepresentable");
  });
});
