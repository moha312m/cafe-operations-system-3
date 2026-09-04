// VAR-010 (SH-17) — no unaccepted count pins anything on anybody, and the
// span a difference crossed is a record, not a guess.
//
// A count taken FOR a handover is not yet evidence: it is a proposal the
// incoming custodian has not looked at. Opening variance cases at
// confirmation would mean a shortage is investigated — and somebody's custody
// named on it — before anyone accepted that the figure is right. So a count
// carrying an accountability context confirms exactly as it always did and
// opens nothing, returning instead the binding the later acceptance needs.
//
// The deferral is on the CONTEXT, not on tolerance and not on disposition. A
// line inside tolerance, outside it, or dead on the expected figure all defer
// alike, because what defers them is who has to answer for the count, and
// that question has the same answer for all three.
//
// Acceptance is the other half, and it is deliberately NOT wired here: SH-20,
// SH-21 and SH-22 own the transactions that call it. What SH-17 owns is that
// the writer exists, is transactional, prices every non-zero accepted line
// without consulting tolerance, and records an unresolved span rather than
// inventing a custody to blame.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { db, tag, teardownTaggedCafe } from "./helpers/db";
import { confirmCountSession } from "@/lib/stock-count";
import { openVarianceCase } from "@/lib/variance-case";
import {
  openHandoverVarianceCases,
  persistVarianceSpan,
} from "@/lib/stock-variance-attribution";

const MARKER = tag("VAR010");

let cafeId: string;
let branchId: string;
let managerId: string;
let shiftId: string;
let custodyId: string;      // the closing (outgoing) STOCK custody
let cashCustodyId: string;  // deliberately never linked to a stock span
let branchCustodyId: string;

let priorHandoverId: string;
let acceptingHandoverId: string;

const PRIOR_ACCEPTED_AT = new Date("2026-08-01T06:00:00Z");
const ACCEPTED_AT = new Date("2026-08-01T18:00:00Z");

let itemSeq = 0;
let keySeq = 0;

async function newItem(): Promise<string> {
  itemSeq += 1;
  const item = await db.inventoryItem.create({
    data: {
      cafeId,
      branchId,
      name: `${MARKER} item ${itemSeq}`,
      unit: "KG",
      costPerUnit: 450,
      currentStock: "12.000",
    },
  });
  return item.id;
}

type LineSpec = {
  itemId: string;
  counted: number;
  expected: number;
  disposition: "VARIANCE_CONFIRMED" | "WITHIN_TOLERANCE" | "RESOLVED_WITHIN_TOLERANCE";
};

/** A SUBMITTED session whose every line already has a terminal answer. */
async function submittedSession(args: {
  context?: "NONE" | "HANDOVER" | "BRANCH_OPENING_VERIFICATION";
  handoverId?: string | null;
  openingBranchCustodyPeriodId?: string | null;
  status?: "SUBMITTED" | "CONFIRMED";
  lines: LineSpec[];
  /**
   * Items given a line and never observed: in scope, PENDING, no figure and
   * no count point. What a handover count leaves behind for a shelf nobody
   * reached (SH-21).
   */
  unobserved?: string[];
}): Promise<{ id: string; lineIds: Record<string, string> }> {
  const session = await db.stockCountSession.create({
    data: {
      cafeId,
      branchId,
      shiftId,
      custodyPeriodId: custodyId,
      type: "FULL",
      scopeDerivation: "ALL_ELIGIBLE",
      status: args.status ?? "SUBMITTED",
      initiatedById: managerId,
      accountabilityContext: args.context ?? "NONE",
      handoverId: args.handoverId ?? null,
      openingBranchCustodyPeriodId: args.openingBranchCustodyPeriodId ?? null,
      lines: {
        create: [
          ...args.lines.map((l) => ({
            inventoryItemId: l.itemId,
            unit: "KG" as const,
            expectedQuantity: l.expected,
            countedQuantity: l.counted,
            effectiveCountedQuantity: l.counted,
            varianceQuantity: Number((l.counted - l.expected).toFixed(3)),
            disposition: l.disposition,
            confidence: "VERIFIED" as const,
            costImpact: Math.abs(l.counted - l.expected) * 450,
            costImpactAvailable: true,
            countedAt: ACCEPTED_AT,
            // The count point capture takes under the item's row lock. A
            // figure and its cursor are one observation; capture never writes
            // one without the other.
            itemVersion: BigInt(41),
            expectedBasis: "LOCKED_ITEM_VERSION",
          })),
          ...(args.unobserved ?? []).map((itemId) => ({
            inventoryItemId: itemId,
            unit: "KG" as const,
          })),
        ],
      },
    },
    select: { id: true, lines: { select: { id: true, inventoryItemId: true } } },
  });
  const lineIds: Record<string, string> = {};
  for (const l of session.lines) lineIds[l.inventoryItemId] = l.id;
  return { id: session.id, lineIds };
}

const confirm = (sessionId: string) =>
  confirmCountSession({
    sessionId,
    confirmedById: managerId,
    idempotencyKey: `${MARKER}-key-${(keySeq += 1)}`,
  });

/** A verified boundary on the prior, completed handover — the opening observation. */
async function priorVerifiedBoundary(itemId: string): Promise<string> {
  const b = await db.handoverStockBoundary.create({
    data: {
      handoverId: priorHandoverId,
      inventoryItemId: itemId,
      source: "PHYSICAL_COUNT",
      verified: true,
      quantity: "12.000",
      itemVersion: BigInt(41),
    },
  });
  return b.id;
}

/** The closing boundary this acceptance writes. */
async function closingBoundary(itemId: string): Promise<string> {
  const b = await db.handoverStockBoundary.create({
    data: {
      handoverId: acceptingHandoverId,
      inventoryItemId: itemId,
      source: "PHYSICAL_COUNT",
      verified: true,
      quantity: "11.500",
      itemVersion: BigInt(42),
    },
  });
  return b.id;
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

  // At most one OPEN custody per branch per scope, so the two the span
  // crosses are recorded as the closed history they would be in life.
  const custody = (
    scope: "STOCK" | "CASH",
    holderType: "USER" | "BRANCH",
    status: "OPEN" | "CLOSED" = "OPEN"
  ) =>
    db.custodyPeriod.create({
      data: {
        cafeId,
        branchId,
        scope,
        holderType,
        status,
        openedById: managerId,
        endedAt: status === "CLOSED" ? PRIOR_ACCEPTED_AT : null,
      },
    });
  custodyId = (await custody("STOCK", "USER")).id;
  cashCustodyId = (await custody("CASH", "USER")).id;
  branchCustodyId = (await custody("STOCK", "BRANCH", "CLOSED")).id;

  const handover = (acceptedAt: Date, outgoingStockCustodyId: string | null) =>
    db.handoverSession.create({
      data: {
        cafeId,
        branchId,
        outgoingShiftId: shiftId,
        outgoingUserId: managerId,
        status: "COMPLETED",
        acceptedAt,
        completedAt: acceptedAt,
        outgoingStockCustodyId,
      },
    });
  priorHandoverId = (await handover(PRIOR_ACCEPTED_AT, custodyId)).id;
  acceptingHandoverId = (await handover(ACCEPTED_AT, custodyId)).id;
});

after(() => teardownTaggedCafe(cafeId, [], { disconnect: true }));

// ── deferral at confirmation ───────────────────────────────────────────

describe("VAR-010 an accountability-bound count opens nothing", () => {
  test("a count answering to nobody but itself still opens its cases", async () => {
    const itemId = await newItem();
    const s = await submittedSession({
      lines: [{ itemId, counted: 11.5, expected: 12, disposition: "VARIANCE_CONFIRMED" }],
    });

    const r = await confirm(s.id);
    assert.equal(r.status, "CONFIRMED");
    assert.equal(r.varianceCaseIds.length, 1, "the NONE path is untouched by SH-17");
    assert.equal(r.deferred, null, "and there is nothing deferred to report");

    const opened = await db.varianceCase.findUniqueOrThrow({
      where: { stockCountLineId: s.lineIds[itemId] },
    });
    assert.equal(opened.custodyPeriodId, custodyId, "exactly as it opened before M22");
    assert.equal(opened.attribution, "NOT_APPLICABLE");
  });

  test("a handover count confirms, opens nothing, and hands back its binding", async () => {
    const itemId = await newItem();
    const s = await submittedSession({
      context: "HANDOVER",
      handoverId: acceptingHandoverId,
      lines: [{ itemId, counted: 11.5, expected: 12, disposition: "VARIANCE_CONFIRMED" }],
    });

    const r = await confirm(s.id);
    assert.equal(r.status, "CONFIRMED");
    assert.deepEqual(r.varianceCaseIds, [], "nobody is investigated for an unaccepted count");
    assert.deepEqual(r.deferred, {
      context: "HANDOVER",
      handoverId: acceptingHandoverId,
      openingBranchCustodyPeriodId: null,
    });

    assert.equal(
      await db.varianceCase.count({ where: { stockCountLineId: s.lineIds[itemId] } }),
      0
    );
    const stored = await db.stockCountSession.findUniqueOrThrow({ where: { id: s.id } });
    assert.equal(stored.status, "CONFIRMED", "the count itself is still closed");
    assert.ok(stored.confirmedAt);
  });

  test("a branch opening verification defers to its branch custody", async () => {
    const itemId = await newItem();
    const s = await submittedSession({
      context: "BRANCH_OPENING_VERIFICATION",
      openingBranchCustodyPeriodId: branchCustodyId,
      lines: [{ itemId, counted: 11.5, expected: 12, disposition: "VARIANCE_CONFIRMED" }],
    });

    const r = await confirm(s.id);
    assert.deepEqual(r.varianceCaseIds, []);
    assert.deepEqual(r.deferred, {
      context: "BRANCH_OPENING_VERIFICATION",
      handoverId: null,
      openingBranchCustodyPeriodId: branchCustodyId,
    });
  });

  test("tolerance does not decide the deferral — the context does", async () => {
    const outside = await newItem();
    const inside = await newItem();
    const exact = await newItem();
    const s = await submittedSession({
      context: "HANDOVER",
      handoverId: acceptingHandoverId,
      lines: [
        { itemId: outside, counted: 9, expected: 12, disposition: "VARIANCE_CONFIRMED" },
        { itemId: inside, counted: 11.9, expected: 12, disposition: "WITHIN_TOLERANCE" },
        { itemId: exact, counted: 12, expected: 12, disposition: "RESOLVED_WITHIN_TOLERANCE" },
      ],
    });

    const r = await confirm(s.id);
    assert.deepEqual(r.varianceCaseIds, []);
    assert.equal(r.deferred?.context, "HANDOVER");
    assert.equal(
      await db.varianceCase.count({ where: { stockCountLineId: { in: Object.values(s.lineIds) } } }),
      0,
      "no line of any disposition opened a generic case"
    );
  });

  test("confirming again returns the same binding rather than losing it", async () => {
    const itemId = await newItem();
    const s = await submittedSession({
      context: "HANDOVER",
      handoverId: acceptingHandoverId,
      lines: [{ itemId, counted: 11.5, expected: 12, disposition: "VARIANCE_CONFIRMED" }],
    });

    const first = await confirm(s.id);
    assert.equal(first.alreadyConfirmed, false);

    const again = await confirm(s.id);
    assert.equal(again.alreadyConfirmed, true, "the count is confirmed, and saying so is truthful");
    assert.deepEqual(
      again.deferred,
      first.deferred,
      "a retry that dropped the binding would leave acceptance nothing to key on"
    );
    assert.deepEqual(again.varianceCaseIds, []);
  });
});

// ── the span ───────────────────────────────────────────────────────────

describe("VAR-010 the unresolved span", () => {
  test("a span records the boundaries it crossed and every stock custody in between", async () => {
    const itemId = await newItem();
    const from = await priorVerifiedBoundary(itemId);
    const to = await closingBoundary(itemId);
    const lineId = (
      await submittedSession({
        status: "CONFIRMED",
        lines: [{ itemId, counted: 11.5, expected: 12, disposition: "VARIANCE_CONFIRMED" }],
      })
    ).lineIds[itemId];

    const { caseId } = await db.$transaction((tx) =>
      openVarianceCase(tx, {
        cafeId,
        branchId,
        type: "STOCK",
        openedById: managerId,
        source: { kind: "STOCK_LINE", stockCountLineId: lineId },
        quantityVariance: -0.5,
        confidence: "VERIFIED",
        financialImpact: { available: true, value: 225 },
        attribution: "PERIOD_UNRESOLVED",
      })
    );

    const { spanId } = await db.$transaction((tx) =>
      persistVarianceSpan(tx, {
        varianceCaseId: caseId,
        inventoryItemId: itemId,
        toBoundaryId: to,
        toVerifiedAt: ACCEPTED_AT,
        verdict: {
          attribution: "PERIOD_UNRESOLVED",
          custodyPeriodId: null,
          span: {
            fromBoundaryId: from,
            fromVerifiedAt: PRIOR_ACCEPTED_AT,
            unverifiedBoundaryCount: 2,
            custodyPeriodIds: [custodyId, branchCustodyId],
          },
        },
      })
    );

    const spans = await db.stockVarianceSpan.findMany({
      where: { varianceCaseId: caseId },
      include: { custodyLinks: true },
    });
    assert.equal(spans.length, 1, "one case, one span");
    assert.equal(spans[0].id, spanId);
    assert.equal(spans[0].fromBoundaryId, from);
    assert.deepEqual(spans[0].fromVerifiedAt, PRIOR_ACCEPTED_AT);
    assert.equal(spans[0].toBoundaryId, to);
    assert.equal(spans[0].unverifiedBoundaryCount, 2);
    assert.deepEqual(
      spans[0].custodyLinks.map((l) => l.custodyPeriodId).sort(),
      [custodyId, branchCustodyId].sort(),
      "every custody the span crossed is joinable, so the dashboard need not parse JSON"
    );
    assert.ok(
      !spans[0].custodyLinks.some((l) => l.custodyPeriodId === cashCustodyId),
      "and a cash custody has no business in a stock span"
    );

    // One custody, named once. A second link would double the period in every
    // aggregate that joins through this table.
    await assert.rejects(() =>
      db.stockVarianceSpanCustody.create({
        data: { spanId, custodyPeriodId: custodyId },
      })
    );

    // The period a span names cannot be deleted out from under it.
    await assert.rejects(() => db.custodyPeriod.delete({ where: { id: custodyId } }));
  });
});

// ── the accepted-evidence writer ───────────────────────────────────────

describe("VAR-010 the accepted handover writer", () => {
  test("every non-zero accepted line becomes a case, whatever tolerance called it", async () => {
    const outside = await newItem();
    const inside = await newItem();
    const exact = await newItem();
    for (const id of [outside, inside, exact]) await priorVerifiedBoundary(id);
    const boundaryByItemId = new Map<string, string>();
    for (const id of [outside, inside, exact]) boundaryByItemId.set(id, await closingBoundary(id));

    const s = await submittedSession({
      status: "CONFIRMED",
      context: "HANDOVER",
      handoverId: acceptingHandoverId,
      lines: [
        { itemId: outside, counted: 9, expected: 12, disposition: "VARIANCE_CONFIRMED" },
        { itemId: inside, counted: 11.9, expected: 12, disposition: "WITHIN_TOLERANCE" },
        { itemId: exact, counted: 12, expected: 12, disposition: "RESOLVED_WITHIN_TOLERANCE" },
      ],
    });

    const result = await db.$transaction((tx) =>
      openHandoverVarianceCases(tx, {
        cafeId,
        branchId,
        handoverId: acceptingHandoverId,
        acceptedSessionId: s.id,
        outgoingCustodyPeriodId: custodyId,
        boundaryByItemId,
        openedById: managerId,
      })
    );

    assert.equal(
      result.caseIds.length,
      2,
      "a difference somebody physically observed is recorded even when tolerance forgave it"
    );
    assert.equal(result.skippedZeroVariance, 1, "and only an exact figure is skipped");

    const insideCase = await db.varianceCase.findUniqueOrThrow({
      where: { stockCountLineId: s.lineIds[inside] },
    });
    assert.equal(insideCase.attribution, "VERIFIED_SHIFT");
    assert.equal(insideCase.custodyPeriodId, custodyId);
    assert.equal(insideCase.acceptedHandoverId, acceptingHandoverId);

    assert.equal(
      await db.varianceCase.count({ where: { stockCountLineId: s.lineIds[exact] } }),
      0,
      "zero variance is not a difference"
    );

    // Called twice — the second acceptance of the same evidence must not
    // double the investigation.
    const repeat = await db.$transaction((tx) =>
      openHandoverVarianceCases(tx, {
        cafeId,
        branchId,
        handoverId: acceptingHandoverId,
        acceptedSessionId: s.id,
        outgoingCustodyPeriodId: custodyId,
        boundaryByItemId,
        openedById: managerId,
      })
    );
    assert.deepEqual(
      repeat.caseIds.sort(),
      result.caseIds.sort(),
      "the same cases come back rather than new ones"
    );
    assert.equal(
      await db.varianceCase.count({
        where: { stockCountLineId: { in: [s.lineIds[outside], s.lineIds[inside]] } },
      }),
      2
    );
  });

  test("a shelf nobody looked at accuses nobody", async () => {
    // SH-21 reachability. The accepted session of a handover may now carry
    // lines for shelves nobody reached. Those lines were kept out of this
    // writer only by coincidence: `effectiveCountEvidence` collapses an
    // absent figure to 0, 0 - 0 is 0, and `variance === 0` skipped them under
    // the label "zero variance".
    //
    // That is the wrong label for the wrong reason, and it was one arithmetic
    // change away from becoming an accusation. If an unobserved line ever
    // carried a non-null `expectedQuantity` — a stale write, a later feature
    // that fills in the book figure at scope time — the collapsed 0 would
    // become a full shortage of everything the book says is there, opened as
    // a case, attributed to a custody and costed. Nobody looked at the shelf,
    // and somebody would answer for it.
    //
    // So the skip is explicit and comes first, and it reports itself under
    // its own name.
    const observed = await newItem();
    const unreached = await newItem();
    const alsoUnreached = await newItem();
    await priorVerifiedBoundary(observed);
    const boundaryByItemId = new Map<string, string>();
    boundaryByItemId.set(observed, await closingBoundary(observed));
    // The unreached items get carried, unverified boundaries — what SH-15
    // writes for them.
    for (const id of [unreached, alsoUnreached]) {
      const row = await db.handoverStockBoundary.create({
        data: {
          handoverId: acceptingHandoverId, inventoryItemId: id,
          source: "SYSTEM_CARRIED", verified: false,
          quantity: "12.000", itemVersion: BigInt(42),
        },
      });
      boundaryByItemId.set(id, row.id);
    }

    const s = await submittedSession({
      status: "CONFIRMED",
      context: "HANDOVER",
      handoverId: acceptingHandoverId,
      lines: [{ itemId: observed, counted: 9, expected: 12, disposition: "VARIANCE_CONFIRMED" }],
      unobserved: [unreached, alsoUnreached],
    });

    const result = await db.$transaction((tx) =>
      openHandoverVarianceCases(tx, {
        cafeId,
        branchId,
        handoverId: acceptingHandoverId,
        acceptedSessionId: s.id,
        outgoingCustodyPeriodId: custodyId,
        boundaryByItemId,
        openedById: managerId,
      })
    );

    assert.equal(result.caseIds.length, 1, "only the shelf somebody stood in front of");
    assert.equal(
      result.skippedUnobserved, 2,
      "the two gaps are skipped under their own name, not as zero variances",
    );
    assert.equal(
      result.skippedZeroVariance, 0,
      "and are not miscounted as differences that happened to come to nothing",
    );

    for (const id of [unreached, alsoUnreached]) {
      assert.equal(
        await db.varianceCase.count({ where: { stockCountLineId: s.lineIds[id] } }), 0,
        "no case",
      );
    }
    assert.equal(
      await db.stockVarianceSpan.count({
        where: { inventoryItemId: { in: [unreached, alsoUnreached] } },
      }),
      0,
      "no span",
    );

    // The observed line keeps SH-17 semantics untouched, custody linkage
    // included.
    const opened = await db.varianceCase.findUniqueOrThrow({
      where: { stockCountLineId: s.lineIds[observed] },
    });
    assert.equal(opened.attribution, "VERIFIED_SHIFT");
    assert.equal(opened.custodyPeriodId, custodyId);
    assert.equal(opened.acceptedHandoverId, acceptingHandoverId);
    assert.equal(Number(opened.quantityVariance), -3);
  });

  test("an unobserved line is skipped even when the book figure would make it a shortage", async () => {
    // The failure the explicit skip exists to prevent, constructed directly:
    // a line nobody reached whose `expectedQuantity` says twelve. Under the
    // old `variance === 0` guard the resolver would read this as counted-zero
    // against expected-twelve — a total loss, opened as a case, attributed
    // and costed, for a shelf nobody looked at.
    const itemId = await newItem();
    await priorVerifiedBoundary(itemId);
    const boundaryByItemId = new Map([[itemId, await closingBoundary(itemId)]]);

    const s = await submittedSession({
      status: "CONFIRMED",
      context: "HANDOVER",
      handoverId: acceptingHandoverId,
      lines: [],
      unobserved: [itemId],
    });
    await db.stockCountLine.update({
      where: { id: s.lineIds[itemId] },
      data: { expectedQuantity: "12.000" },
    });

    const result = await db.$transaction((tx) =>
      openHandoverVarianceCases(tx, {
        cafeId, branchId, handoverId: acceptingHandoverId, acceptedSessionId: s.id,
        outgoingCustodyPeriodId: custodyId, boundaryByItemId, openedById: managerId,
      })
    );

    assert.deepEqual(result.caseIds, [], "nobody is accused of losing what nobody counted");
    assert.deepEqual(result.spanIds, []);
    assert.equal(result.skippedUnobserved, 1);
    assert.equal(
      await db.varianceCase.count({ where: { stockCountLineId: s.lineIds[itemId] } }), 0
    );
  });

  test("an item never counted before gets a span and names nobody", async () => {
    const itemId = await newItem();
    const to = await closingBoundary(itemId);
    const s = await submittedSession({
      status: "CONFIRMED",
      context: "HANDOVER",
      handoverId: acceptingHandoverId,
      lines: [{ itemId, counted: 11.5, expected: 12, disposition: "VARIANCE_CONFIRMED" }],
    });

    const result = await db.$transaction((tx) =>
      openHandoverVarianceCases(tx, {
        cafeId,
        branchId,
        handoverId: acceptingHandoverId,
        acceptedSessionId: s.id,
        outgoingCustodyPeriodId: custodyId,
        boundaryByItemId: new Map([[itemId, to]]),
        openedById: managerId,
      })
    );
    assert.equal(result.caseIds.length, 1);
    assert.equal(result.spanIds.length, 1);

    const opened = await db.varianceCase.findUniqueOrThrow({
      where: { stockCountLineId: s.lineIds[itemId] },
      include: { varianceSpan: { include: { custodyLinks: true } } },
    });
    assert.equal(opened.attribution, "PERIOD_UNRESOLVED");
    assert.equal(opened.custodyPeriodId, null, "an unresolved span names no custody");
    assert.equal(opened.assignedResponsibilityUserId, null, "and no person");
    assert.ok(opened.varianceSpan, "the boundaries it does know are recorded instead");
    assert.equal(opened.varianceSpan?.fromBoundaryId, null);
    assert.equal(opened.varianceSpan?.toBoundaryId, to);
    assert.deepEqual(
      opened.varianceSpan?.custodyLinks.map((l) => l.custodyPeriodId),
      [custodyId],
      "the closing stock custody is on the span even though it is not blamed"
    );
  });
});
