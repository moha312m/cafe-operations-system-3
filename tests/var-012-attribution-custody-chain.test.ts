// VAR-012 (SH-25) — attribution follows the shelf, not the person who let go
// of it.
//
// A boundary is written when custody changes hands. Read backwards, from a
// span that ENDS at it, the interesting party is the custody being
// discharged. Read forwards, from a span that STARTS at it, the interesting
// party is the one that received the shelf and held it afterwards — the
// handover's SUCCESSOR.
//
// `resolveVarianceAttribution` read the opening boundary the first way while
// using it the second way: it took `outgoingStockCustodyId`, the custody
// discharged AT that boundary, and handed it to a classifier whose rule is
// "one custody from the verified opening to the verified close, or nobody".
// In any real chain those two are different periods by construction, so the
// rule mismatched every time and the verdict was always PERIOD_UNRESOLVED.
// `mayAssignByAttribution` refuses that verdict, so stock shortages could
// never be pinned on anyone — the accountability the whole module exists for
// was unreachable, and it failed silently, in the safe direction.
//
// It went unnoticed because the one suite that exercised the mapping built
// both of its handovers with the SAME outgoing custody and no successor at
// all, so the wrong reading happened to produce the right answer (VAR-010,
// repaired alongside this file).
//
// Hence a chain of three. Two custodies cannot tell a successor mapping apart
// from "just use the closing custody", because with C1 → C2 those are the
// same period. Three can: measured from the first boundary the answer is C2,
// measured from the second it is C3, and the old reading says C1 and C2. Each
// case below therefore names the answers it must NOT give.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { db, tag, teardownTaggedCafe } from "./helpers/db";
import {
  persistVarianceSpan,
  resolveVarianceAttribution,
} from "@/lib/stock-variance-attribution";
import { openVarianceCase } from "@/lib/variance-case";

const MARKER = tag("VAR012");

let cafeId: string;
let branchId: string;
let managerId: string;
let shiftId: string;

// The chain. C1 hands to C2 at T1, C2 hands to C3 at T2.
let c1: string;
let c2: string;
let c3: string;
let branchCustody: string;

let h1: string; // C1 → C2, carries the verified opening boundary B1
let h2: string; // C2 → C3, carries the verified boundary B2
let hBranch: string; // C2 → the branch itself
// The acceptance in flight, at T3. A boundary hangs on it to act as closing
// evidence; the resolver never treats it as an OPENING one, because
// `acceptedBefore` is strictly before the count and this handover's
// acceptance IS the count's closing moment.
let hClosing: string;

const T1 = new Date("2026-09-01T06:00:00Z");
const T2 = new Date("2026-09-01T14:00:00Z");
const T3 = new Date("2026-09-01T22:00:00Z");

let itemSeq = 0;

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

function custody(status: "OPEN" | "CLOSED", holderType: "USER" | "BRANCH", endedAt: Date | null) {
  return db.custodyPeriod.create({
    data: {
      cafeId,
      branchId,
      scope: "STOCK",
      holderType,
      status,
      openedById: managerId,
      endedAt,
    },
  });
}

function handover(args: {
  acceptedAt: Date;
  outgoing: string;
  incoming: string | null;
}) {
  return db.handoverSession.create({
    data: {
      cafeId,
      branchId,
      outgoingShiftId: shiftId,
      outgoingUserId: managerId,
      status: "COMPLETED",
      acceptedAt: args.acceptedAt,
      completedAt: args.acceptedAt,
      outgoingStockCustodyId: args.outgoing,
      // The half the defect ignored. A completed handover always has one:
      // `transferCustody` creates the successor or throws.
      incomingStockCustodyId: args.incoming,
    },
  });
}

/**
 * One counted line, so a case can be opened the way production opens it.
 *
 * `openVarianceCase` reads the line's session for the café that owns it, so a
 * synthetic id will not do — the span writer is being exercised here, not
 * bypassed.
 */
async function countedLine(itemId: string): Promise<string> {
  const session = await db.stockCountSession.create({
    data: {
      cafeId,
      branchId,
      shiftId,
      custodyPeriodId: c3,
      type: "FULL",
      scopeDerivation: "ALL_ELIGIBLE",
      status: "CONFIRMED",
      initiatedById: managerId,
      lines: {
        create: [
          {
            inventoryItemId: itemId,
            unit: "KG" as const,
            expectedQuantity: 12,
            countedQuantity: 11.5,
            effectiveCountedQuantity: 11.5,
            varianceQuantity: -0.5,
            disposition: "VARIANCE_CONFIRMED" as const,
            confidence: "VERIFIED" as const,
            countedAt: T3,
            itemVersion: BigInt(41),
            expectedBasis: "LOCKED_ITEM_VERSION",
          },
        ],
      },
    },
    select: { lines: { select: { id: true } } },
  });
  return session.lines[0].id;
}

function boundary(args: { handoverId: string; itemId: string; verified: boolean; qty: string }) {
  return db.handoverStockBoundary.create({
    data: {
      handoverId: args.handoverId,
      inventoryItemId: args.itemId,
      source: "PHYSICAL_COUNT",
      verified: args.verified,
      quantity: args.qty,
      itemVersion: BigInt(41),
    },
  });
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

  // Closed history behind the live one, as it would be in life. The database
  // allows exactly one OPEN custody per branch per scope, so C3 is the only
  // live period and the branch-held one is recorded as the closed episode it
  // would be after the branch handed the shelf back.
  c1 = (await custody("CLOSED", "USER", T1)).id;
  c2 = (await custody("CLOSED", "USER", T2)).id;
  c3 = (await custody("OPEN", "USER", null)).id;
  branchCustody = (await custody("CLOSED", "BRANCH", T3)).id;

  h1 = (await handover({ acceptedAt: T1, outgoing: c1, incoming: c2 })).id;
  h2 = (await handover({ acceptedAt: T2, outgoing: c2, incoming: c3 })).id;
  hBranch = (await handover({ acceptedAt: T2, outgoing: c2, incoming: branchCustody })).id;
  hClosing = (await handover({ acceptedAt: T3, outgoing: c3, incoming: null })).id;

  // Three distinct periods, or the proof proves nothing.
  assert.equal(new Set([c1, c2, c3]).size, 3);
});

after(() => teardownTaggedCafe(cafeId, [], { disconnect: true }));

const resolve = (itemId: string, countedAt: Date, custodyPeriodId: string | null) =>
  resolveVarianceAttribution({ branchId, inventoryItemId: itemId, countedAt, custodyPeriodId });

describe("VAR-012 the custody chain names the holder, not the predecessor", () => {
  test("hop 1 — measured from C1→C2's boundary, the answer is C2", async () => {
    const itemId = await newItem();
    await boundary({ handoverId: h1, itemId, verified: true, qty: "12.000" });

    // Counted while C2 held the shelf, closing against C2 — the ordinary
    // shift-to-shift case, and the one that could never resolve before.
    const verdict = await resolve(itemId, T2, c2);

    assert.equal(
      verdict.attribution,
      "VERIFIED_SHIFT",
      "a verified opening and a verified close under ONE custody is that custody's answer"
    );
    assert.equal(verdict.custodyPeriodId, c2, "the successor of the opening boundary held it");

    // The two wrong answers, named. C1 is what the old mapping returned —
    // the custody that had already let go — and C3 is what a naive "latest
    // custody" reading would return.
    assert.notEqual(verdict.custodyPeriodId, c1, "C1 handed the shelf over before the span began");
    assert.notEqual(verdict.custodyPeriodId, c3, "C3 had not received it yet");
  });

  test("hop 2 — measured from C2→C3's boundary, the answer is C3", async () => {
    const itemId = await newItem();
    await boundary({ handoverId: h1, itemId, verified: true, qty: "12.000" });
    await boundary({ handoverId: h2, itemId, verified: true, qty: "11.800" });

    // The most recent verified observation is B2, so the span starts there
    // and the holder afterwards is C3. This is the case two custodies cannot
    // distinguish from "use the closing custody".
    const verdict = await resolve(itemId, T3, c3);

    assert.equal(verdict.attribution, "VERIFIED_SHIFT");
    assert.equal(verdict.custodyPeriodId, c3);
    assert.notEqual(verdict.custodyPeriodId, c2, "C2 handed it on at T2");
    assert.notEqual(verdict.custodyPeriodId, c1);
  });

  test("the answer tracks the successor, not the position in the chain", async () => {
    // Same two boundaries, same item, two different questions. If the mapping
    // were reading any fixed end of the handover rather than the successor,
    // one of these two would be wrong.
    const itemId = await newItem();
    await boundary({ handoverId: h1, itemId, verified: true, qty: "12.000" });
    await boundary({ handoverId: h2, itemId, verified: true, qty: "11.800" });

    const early = await resolve(itemId, T2, c2);
    const late = await resolve(itemId, T3, c3);

    assert.equal(early.custodyPeriodId, c2);
    assert.equal(late.custodyPeriodId, c3);
    assert.notEqual(early.custodyPeriodId, late.custodyPeriodId);
  });

  test("a successor that is the branch itself is the branch's answer", async () => {
    const itemId = await newItem();
    await boundary({ handoverId: hBranch, itemId, verified: true, qty: "12.000" });

    const verdict = await resolve(itemId, T3, branchCustody);

    assert.equal(verdict.attribution, "BRANCH_CUSTODY", "a BRANCH holder is not a person's fault");
    assert.equal(verdict.custodyPeriodId, branchCustody);
  });
});

describe("VAR-012 the mutation checks — these assertions can fail", () => {
  test("point the opening boundary's successor back at C1 and nobody can be named", async () => {
    // The old mapping, reproduced deliberately on one handover. If this still
    // resolved, the assertions above would be passing for some other reason.
    const itemId = await newItem();
    const local = await handover({ acceptedAt: T1, outgoing: c1, incoming: c1 });
    await boundary({ handoverId: local.id, itemId, verified: true, qty: "12.000" });

    const verdict = await resolve(itemId, T2, c2);

    assert.equal(
      verdict.attribution,
      "PERIOD_UNRESOLVED",
      "a boundary whose successor is not the closing custody cannot name it"
    );
    assert.equal(verdict.custodyPeriodId, null);
  });

  test("a completed handover with no successor at all falls through conservatively", async () => {
    // No database constraint requires `incomingStockCustodyId` on a COMPLETED
    // row, so an imported or legacy handover can carry NULL. The verdict must
    // be the safe one rather than a crash or a guess.
    const itemId = await newItem();
    const orphan = await handover({ acceptedAt: T1, outgoing: c1, incoming: null });
    await boundary({ handoverId: orphan.id, itemId, verified: true, qty: "12.000" });

    const verdict = await resolve(itemId, T2, c2);

    assert.equal(verdict.attribution, "PERIOD_UNRESOLVED");
    assert.equal(verdict.custodyPeriodId, null);
    assert.ok(verdict.span, "an unresolved verdict always carries its span");
  });
});

describe("VAR-012 the span records who held it, not who had already left", () => {
  test("an unresolved span lists the holders and excludes the predecessor", async () => {
    const itemId = await newItem();
    await boundary({ handoverId: h1, itemId, verified: true, qty: "12.000" });
    // Somewhere in between, a boundary nobody stood in front of — which is
    // what makes the span unresolved while still crossing real custodies.
    await boundary({ handoverId: h2, itemId, verified: false, qty: "11.800" });

    const verdict = await resolve(itemId, T3, c3);
    assert.equal(verdict.attribution, "PERIOD_UNRESOLVED");
    assert.ok(verdict.span);

    const crossed = verdict.span!.custodyPeriodIds;
    assert.ok(crossed.includes(c2), "C2 held the shelf from T1");
    assert.ok(crossed.includes(c3), "C3 held it from T2");
    assert.equal(
      crossed.includes(c1),
      false,
      "C1 had handed over before the span began and must not be implicated in it"
    );
  });

  test("the unresolved span persists, with its closing boundary", async () => {
    // The writer refuses a boundary-closed span with no boundary id. A verdict
    // that newly becomes unresolved must still be storable.
    const itemId = await newItem();
    await boundary({ handoverId: h1, itemId, verified: true, qty: "12.000" });
    await boundary({ handoverId: h2, itemId, verified: false, qty: "11.800" });
    const closing = await boundary({ handoverId: hClosing, itemId, verified: true, qty: "11.500" });

    const verdict = await resolve(itemId, T3, c3);
    assert.equal(verdict.attribution, "PERIOD_UNRESOLVED");

    const lineId = await countedLine(itemId);
    const { caseId } = await db.$transaction((tx) =>
      openVarianceCase(tx, {
        cafeId,
        branchId,
        type: "STOCK",
        shiftId: null,
        custodyPeriodId: verdict.custodyPeriodId,
        source: { kind: "STOCK_LINE", stockCountLineId: lineId },
        quantityVariance: -0.5,
        amountVariance: null,
        financialImpact: { available: false, reason: "MISSING_COST" },
        confidence: "VERIFIED",
        attribution: verdict.attribution,
        openedById: managerId,
      })
    );

    const { spanId } = await db.$transaction((tx) =>
      persistVarianceSpan(tx, {
        varianceCaseId: caseId,
        inventoryItemId: itemId,
        closingEvidence: { kind: "BOUNDARY", boundaryId: closing.id },
        toVerifiedAt: T3,
        verdict,
      })
    );

    const links = await db.stockVarianceSpanCustody.findMany({
      where: { spanId },
      select: { custodyPeriodId: true },
    });
    const ids = links.map((l) => l.custodyPeriodId);
    assert.ok(ids.includes(c2));
    assert.equal(ids.includes(c1), false, "the predecessor is not written to the span either");
  });
});
