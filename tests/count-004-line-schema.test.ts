// COUNT-004 — keep the original figure, the working figure, and the version apart.
//
// Three things land as one row because they ARE one row, and conflating any
// two of them destroys the evidence:
//
//   countedQuantity           what the counter actually wrote down. Written
//                             once, never updated. If a correction could
//                             overwrite it, the original observation would be
//                             gone and no investigation could ever ask what
//                             was first reported.
//
//   effectiveCountedQuantity  what the business acts on. Equals the counted
//                             figure until an APPROVED correction supersedes
//                             it. Rebase, variance and export all read THIS.
//
//   itemVersion               the count point (T7). Provenance, not
//                             decoration: it says which committed movements
//                             the expected figure included, so a movement
//                             posted mid-count can be replayed rather than
//                             mistaken for a shortage.
//
// The other load-bearing rule here is about cost. `costImpact` is nullable
// and paired with `costImpactAvailable`. A missing cost must read back as
// NULL, never as 0 — "we do not know what this shortage cost" and "this
// shortage cost nothing" are opposite statements, and writing 0 for the first
// would let an unknown quietly become an exoneration.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { db, tag } from "./helpers/db";
import {
  TERMINAL_DISPOSITIONS, isTerminal, DISPOSITION_TRANSITIONS,
} from "@/lib/count-disposition";
import type { CountLineDisposition } from "@prisma/client";

const MARKER = tag("COUNT004");
let cafeId: string;
let branchId: string;
let userId: string;
let sessionId: string;
let itemId: string;

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

  userId = (await db.user.create({
    data: {
      email: `${MARKER}@example.invalid`, name: MARKER,
      passwordHash: "no-login-path", role: "BRANCH_MANAGER", cafeId, branchId,
    },
  })).id;

  itemId = (await db.inventoryItem.create({
    data: {
      cafeId, branchId, name: `${MARKER} beans`, unit: "KG",
      costPerUnit: 450, currentStock: "12.018",
    },
  })).id;

  sessionId = (await db.stockCountSession.create({
    data: {
      cafeId, branchId, type: "FULL", scopeDerivation: "ALL_ELIGIBLE",
      initiatedById: userId,
    },
  })).id;
});

after(async () => {
  await db.stockCountLine.deleteMany({ where: { session: { cafeId } } });
  await db.stockCountSession.deleteMany({ where: { cafeId } });
  await db.inventoryItem.deleteMany({ where: { cafeId } });
  await db.user.deleteMany({ where: { cafeId } });
  await db.cafe.deleteMany({ where: { id: cafeId } });
  await db.$disconnect();
});

function line(data: Record<string, unknown> = {}) {
  return db.stockCountLine.create({
    data: { sessionId, inventoryItemId: itemId, unit: "KG", ...data },
  });
}

const clearLines = () => db.stockCountLine.deleteMany({ where: { sessionId } });

describe("COUNT-004 count line schema and dispositions", () => {
  test("a gram-level counted quantity reads back exactly", async () => {
    await clearLines();
    const l = await line({ countedQuantity: "12.018", expectedQuantity: "12.000" });
    assert.equal(Number(l.countedQuantity), 12.018, "18 g is 18 g on the page and in the row");
    assert.equal(Number(l.expectedQuantity), 12);
  });

  test("the effective figure is stored independently of the original", async () => {
    // They differ exactly when an approved correction has superseded the
    // original. The original must still be readable afterwards.
    await clearLines();
    const l = await line({
      countedQuantity: "10.000", effectiveCountedQuantity: "11.500",
    });
    assert.equal(Number(l.countedQuantity), 10, "the original observation stands");
    assert.equal(Number(l.effectiveCountedQuantity), 11.5, "the working figure differs");
  });

  test("itemVersion stores a BigInt and round-trips", async () => {
    await clearLines();
    const l = await line({
      itemVersion: BigInt(4207), expectedBasis: "LOCKED_ITEM_VERSION",
    });
    assert.equal(l.itemVersion, BigInt(4207));
    assert.equal(
      l.expectedBasis, "LOCKED_ITEM_VERSION",
      "the line states the rule its expectation was captured under"
    );
  });

  test("a missing cost reads back as null, never as zero", async () => {
    // The distinction this column pair exists to preserve. Writing 0 for an
    // unknown cost would turn "we cannot value this shortage" into "this
    // shortage was free", and the second is an exoneration nobody granted.
    await clearLines();
    const l = await line({
      countedQuantity: "9.000",
      costImpactAvailable: false,
      costUnavailableReason: "لا توجد تكلفة موثوقة للصنف",
    });
    assert.equal(l.costImpact, null, "unknown is null");
    assert.notEqual(l.costImpact, 0);
    assert.equal(l.costImpactAvailable, false);
    assert.ok(l.costUnavailableReason, "and it says why it is unknown");

    const priced = await db.stockCountLine.create({
      data: {
        sessionId, inventoryItemId: itemId, unit: "KG",
        costImpact: "125.50", costImpactAvailable: true,
      },
    }).catch(() => null);
    // The (sessionId, inventoryItemId) unique blocks a second line for the
    // same item, which is itself correct — so check the priced case by update.
    assert.equal(priced, null, "one line per item per session");
    const updated = await db.stockCountLine.update({
      where: { id: l.id }, data: { costImpact: "125.50", costImpactAvailable: true },
    });
    assert.equal(Number(updated.costImpact), 125.5);
  });

  test("disposition defaults to PENDING and confidence to UNVERIFIABLE", async () => {
    // Both defaults are the conservative reading: nothing has been decided,
    // and no theoretical figure has been shown to be trustworthy yet.
    await clearLines();
    const l = await line();
    assert.equal(l.disposition, "PENDING");
    assert.equal(
      l.confidence, "UNVERIFIABLE",
      "a figure is untrusted until something proves otherwise"
    );
  });

  test("(sessionId, inventoryItemId) rejects a duplicate line", async () => {
    await clearLines();
    await line();
    await assert.rejects(
      () => line(),
      (e: { code?: string }) => e.code === "P2002",
      "one shelf, one line — two would be two answers about one ingredient"
    );
  });

  test("deleting a session cascades its lines, but a counted item cannot be deleted", async () => {
    // `Restrict` on inventoryItem is deliberate: a confirmed count is
    // evidence, and removing an ingredient must not erase the record of it
    // having been counted.
    await clearLines();
    const spareSession = await db.stockCountSession.create({
      data: {
        cafeId, branchId, type: "FULL", scopeDerivation: "ALL_ELIGIBLE",
        initiatedById: userId, status: "CONFIRMED", confirmedAt: new Date(),
      },
    });
    const spareItem = await db.inventoryItem.create({
      data: { cafeId, branchId, name: `${MARKER} spare`, unit: "KG", costPerUnit: 1 },
    });
    await db.stockCountLine.create({
      data: { sessionId: spareSession.id, inventoryItemId: spareItem.id, unit: "KG" },
    });

    await assert.rejects(
      () => db.inventoryItem.delete({ where: { id: spareItem.id } }),
      (e: { code?: string }) => e.code === "P2003",
      "deleting an ingredient must not erase the evidence it was counted"
    );

    await db.stockCountSession.delete({ where: { id: spareSession.id } });
    assert.equal(
      await db.stockCountLine.count({ where: { sessionId: spareSession.id } }), 0,
      "but the session owns its lines"
    );
    await db.inventoryItem.delete({ where: { id: spareItem.id } });
  });

  test("exactly three dispositions are terminal", async () => {
    const all = await db.$queryRaw<{ label: string }[]>`
      SELECT e.enumlabel AS label FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'CountLineDisposition' ORDER BY e.enumsortorder
    `;
    const values = all.map((v) => v.label) as CountLineDisposition[];
    assert.deepEqual(values, [
      "PENDING", "COUNTED", "WITHIN_TOLERANCE", "OUTSIDE_TOLERANCE",
      "RECOUNT_REQUIRED", "RESOLVED_WITHIN_TOLERANCE", "VARIANCE_CONFIRMED",
    ]);

    assert.deepEqual([...TERMINAL_DISPOSITIONS], [
      "WITHIN_TOLERANCE", "RESOLVED_WITHIN_TOLERANCE", "VARIANCE_CONFIRMED",
    ]);
    for (const d of values) {
      assert.equal(
        isTerminal(d), (TERMINAL_DISPOSITIONS as readonly string[]).includes(d),
        `${d} terminality must match the declared set`
      );
    }
  });

  test("every non-terminal disposition has a path to a terminal one", async () => {
    // The defect this prevents: a shop with a real 2 kg shortage that can
    // never close its count because OUTSIDE_TOLERANCE has no exit. Walked
    // programmatically rather than eyeballed, so a future edit that strands
    // a state fails here.
    const terminal = new Set<string>(TERMINAL_DISPOSITIONS);
    const states = Object.keys(DISPOSITION_TRANSITIONS) as CountLineDisposition[];

    for (const start of states) {
      if (terminal.has(start)) continue;
      const seen = new Set<string>([start]);
      const queue: CountLineDisposition[] = [start];
      let reached = false;
      while (queue.length && !reached) {
        const current = queue.shift()!;
        for (const next of DISPOSITION_TRANSITIONS[current] ?? []) {
          if (terminal.has(next)) { reached = true; break; }
          if (!seen.has(next)) { seen.add(next); queue.push(next); }
        }
      }
      assert.ok(reached, `${start} can never reach a terminal disposition — the count could not close`);
    }

    // And a terminal disposition is genuinely an exit.
    for (const t of TERMINAL_DISPOSITIONS) {
      assert.deepEqual(
        DISPOSITION_TRANSITIONS[t], [],
        `${t} is terminal and must lead nowhere`
      );
    }
  });
});
