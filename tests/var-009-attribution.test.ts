// VAR-009 (SH-17) — a difference nobody can pin on one custody stops being
// pinned on anybody.
//
// Until now a stock variance case carried a `custodyPeriodId` because the
// count that raised it carried one, and that is not the same statement as
// "this custody is answerable for the gap". Between two counts a shelf can
// cross a handover nobody verified, or change hands entirely; the figure at
// the end is real, and the person it would name is an accident of who
// happened to be counting.
//
// So the verdict becomes an explicit column rather than an inference.
// `VarianceAttribution` says which of the three things is true — one verified
// custody answered for the whole span, the branch itself held the stock, or
// the span cannot be resolved to anybody — and `PERIOD_UNRESOLVED` carries a
// NULL custody, so there is no name to read by mistake.
//
// The rule is a pure function. It takes no database, because the thing being
// tested is a judgement about evidence, and a judgement you can only exercise
// by building six handovers is a judgement nobody will exercise.
//
// The second half is the gate. `mayAssignResponsibility` already refuses
// evidence nobody could verify; attribution is the second, independent
// refusal — and it refuses only when it positively says the difference cannot
// be pinned. `NOT_APPLICABLE` is not such a statement: it is what a CASH,
// TENDER or OPENING case has always carried, and what a generic stock case
// outside handover accountability still carries, so those keep exactly the
// behaviour they had before M22.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { db, tag, teardownTaggedCafe } from "./helpers/db";
import { openVarianceCase, advanceVarianceCase } from "@/lib/variance-case";
import {
  classifyStockVariance,
  type AttributionInput,
} from "@/lib/stock-variance-attribution";

const MARKER = tag("VAR009");

let cafeId: string;
let branchId: string;
let openerId: string;
let staffId: string;
let shiftId: string;
let sessionId: string;
let handoverId: string;

let lineSeq = 0;

/**
 * A fresh count line — `VarianceCase.stockCountLineId` is unique, so each case
 * needs its own, and a session holds at most one line per item.
 */
async function newLine(): Promise<string> {
  lineSeq += 1;
  const item = await db.inventoryItem.create({
    data: {
      cafeId,
      branchId,
      name: `${MARKER} beans ${lineSeq}`,
      unit: "KG",
      costPerUnit: 450,
      currentStock: "12.000",
    },
  });
  const line = await db.stockCountLine.create({
    data: {
      sessionId,
      inventoryItemId: item.id,
      unit: "KG",
      expectedQuantity: "12.000",
      countedQuantity: "11.500",
      varianceQuantity: "-0.500",
      effectiveCountedQuantity: "11.500",
    },
  });
  return line.id;
}

before(async () => {
  cafeId = (
    await db.cafe.create({
      data: { name: `${MARKER} cafe`, slug: MARKER.toLowerCase(), settings: { create: {} } },
    })
  ).id;
  branchId = (await db.branch.create({ data: { cafeId, name: `${MARKER} branch` } })).id;

  const user = (email: string, role: "BRANCH_MANAGER" | "CASHIER") =>
    db.user.create({
      data: {
        email: `${MARKER}-${email}@example.invalid`,
        name: `${MARKER} ${email}`,
        passwordHash: "no-login-path",
        role,
        cafeId,
        branchId,
      },
    });
  openerId = (await user("opener", "BRANCH_MANAGER")).id;
  staffId = (await user("staff", "CASHIER")).id;

  shiftId = (
    await db.shift.create({
      data: {
        cafeId,
        branchId,
        cashierId: openerId,
        shiftNumber: 1,
        openingCashAmount: 0,
        expectedCashAmount: 0,
      },
    })
  ).id;

  sessionId = (
    await db.stockCountSession.create({
      data: {
        cafeId,
        branchId,
        type: "FULL",
        scopeDerivation: "ALL_ELIGIBLE",
        initiatedById: openerId,
      },
    })
  ).id;

  handoverId = (
    await db.handoverSession.create({
      data: {
        cafeId,
        branchId,
        outgoingShiftId: shiftId,
        outgoingUserId: openerId,
        status: "COMPLETED",
        acceptedAt: new Date("2026-08-01T10:00:00Z"),
        completedAt: new Date("2026-08-01T10:00:00Z"),
      },
    })
  ).id;
});

after(() => teardownTaggedCafe(cafeId, [], { disconnect: true }));

// ── the pure rule ──────────────────────────────────────────────────────

const OPENED_AT = new Date("2026-08-01T06:00:00Z");

/** A span that resolves cleanly: verified at both ends, one USER custody. */
const clean = (over: Partial<AttributionInput> = {}): AttributionInput => ({
  branchId: "branch-1",
  inventoryItemId: "item-1",
  closingBoundaryVerified: true,
  closingCustodyPeriodId: "custody-1",
  closingCustodyHolderType: "USER",
  openingBoundary: {
    boundaryId: "boundary-0",
    verified: true,
    acceptedAt: OPENED_AT,
    custodyPeriodId: "custody-1",
  },
  interveningUnverifiedBoundaryCount: 0,
  ...over,
});

describe("VAR-009 the attribution rule", () => {
  test("an item never counted before cannot be pinned on the custody that found it", () => {
    const v = classifyStockVariance(clean({ openingBoundary: null }));
    assert.equal(v.attribution, "PERIOD_UNRESOLVED");
    assert.equal(v.custodyPeriodId, null, "a shortage with no opening figure names nobody");
    assert.ok(v.span, "and the boundaries it does know are recorded instead");
    assert.equal(v.span?.fromBoundaryId, null);
    assert.equal(v.span?.fromVerifiedAt, null);
  });

  test("a carried opening figure is not an observation, so the span is unresolved", () => {
    const v = classifyStockVariance(
      clean({
        openingBoundary: {
          boundaryId: "boundary-0",
          verified: false,
          acceptedAt: OPENED_AT,
          custodyPeriodId: "custody-1",
        },
      })
    );
    assert.equal(v.attribution, "PERIOD_UNRESOLVED");
    assert.equal(v.custodyPeriodId, null);
    assert.equal(
      v.span?.fromBoundaryId,
      null,
      "the span starts at the last VERIFIED point, and there is not one"
    );
  });

  test("one unverified boundary in between is enough to unresolve the span", () => {
    const v = classifyStockVariance(clean({ interveningUnverifiedBoundaryCount: 1 }));
    assert.equal(v.attribution, "PERIOD_UNRESOLVED");
    assert.equal(v.span?.unverifiedBoundaryCount, 1);
    assert.equal(
      v.span?.fromBoundaryId,
      "boundary-0",
      "the last verified observation is still the start of the span"
    );
    assert.deepEqual(v.span?.fromVerifiedAt, OPENED_AT);
  });

  test("stock that changed hands mid-span is not one custody's answer", () => {
    const v = classifyStockVariance(
      clean({
        openingBoundary: {
          boundaryId: "boundary-0",
          verified: true,
          acceptedAt: OPENED_AT,
          custodyPeriodId: "custody-0",
        },
      })
    );
    assert.equal(v.attribution, "PERIOD_UNRESOLVED");
    assert.equal(v.custodyPeriodId, null);
    assert.deepEqual(
      [...(v.span?.custodyPeriodIds ?? [])].sort(),
      ["custody-0", "custody-1"],
      "both custodies the span crossed are named, and neither is blamed"
    );
  });

  test("a closing custody nobody holds cannot become somebody's answer", () => {
    const v = classifyStockVariance(
      clean({
        closingCustodyPeriodId: null,
        closingCustodyHolderType: null,
        openingBoundary: {
          boundaryId: "boundary-0",
          verified: true,
          acceptedAt: OPENED_AT,
          custodyPeriodId: null,
        },
      })
    );
    assert.equal(v.attribution, "PERIOD_UNRESOLVED");
    assert.equal(v.custodyPeriodId, null);
  });

  test("a difference that arose while the branch held the stock is the branch's", () => {
    const v = classifyStockVariance(clean({ closingCustodyHolderType: "BRANCH" }));
    assert.equal(v.attribution, "BRANCH_CUSTODY");
    assert.equal(v.custodyPeriodId, "custody-1");
    assert.equal(v.span, null, "a resolved attribution has no span to record");
  });

  test("verified at both ends, one user custody throughout, is that shift's answer", () => {
    const v = classifyStockVariance(clean());
    assert.equal(v.attribution, "VERIFIED_SHIFT");
    assert.equal(v.custodyPeriodId, "custody-1");
    assert.equal(v.span, null);
  });
});

// ── the column, and what it defaults to ────────────────────────────────

describe("VAR-009 attribution on the case", () => {
  test("a CASH case is opened NOT_APPLICABLE, exactly as before M22", async () => {
    const { caseId } = await db.$transaction((tx) =>
      openVarianceCase(tx, {
        cafeId,
        branchId,
        type: "CASH",
        shiftId,
        openedById: openerId,
        source: { kind: "CASH_SHIFT" },
        amountVariance: -13,
        financialImpact: { available: true, value: 13 },
      })
    );
    const c = await db.varianceCase.findUniqueOrThrow({ where: { id: caseId } });
    assert.equal(c.attribution, "NOT_APPLICABLE", "attribution does not apply to cash");
    assert.equal(c.acceptedHandoverId, null, "and no handover accepted it");
  });

  test("an accepted handover can be named, and losing it does not delete the case", async () => {
    const lineId = await newLine();
    const { caseId } = await db.$transaction((tx) =>
      openVarianceCase(tx, {
        cafeId,
        branchId,
        type: "STOCK",
        openedById: openerId,
        source: { kind: "STOCK_LINE", stockCountLineId: lineId },
        quantityVariance: -0.5,
        confidence: "VERIFIED",
        financialImpact: { available: true, value: 225 },
        attribution: "VERIFIED_SHIFT",
        acceptedHandoverId: handoverId,
      })
    );
    const opened = await db.varianceCase.findUniqueOrThrow({ where: { id: caseId } });
    assert.equal(opened.acceptedHandoverId, handoverId);
    assert.equal(opened.attribution, "VERIFIED_SHIFT");

    // SET NULL, not cascade: the investigation is a record of something that
    // happened, and it must outlive the transfer that surfaced it.
    await db.handoverSession.delete({ where: { id: handoverId } });
    const survivor = await db.varianceCase.findUniqueOrThrow({ where: { id: caseId } });
    assert.equal(survivor.acceptedHandoverId, null);
    assert.equal(survivor.attribution, "VERIFIED_SHIFT", "the verdict itself is not erased");
  });
});

// ── the second gate ────────────────────────────────────────────────────

/** A STOCK case at the given attribution and confidence, moved as far as investigation. */
async function investigating(args: {
  attribution: "VERIFIED_SHIFT" | "PERIOD_UNRESOLVED" | "BRANCH_CUSTODY" | "NOT_APPLICABLE";
  confidence?: "VERIFIED" | "PARTIAL";
}): Promise<string> {
  const lineId = await newLine();
  const { caseId } = await db.$transaction((tx) =>
    openVarianceCase(tx, {
      cafeId,
      branchId,
      type: "STOCK",
      openedById: openerId,
      source: { kind: "STOCK_LINE", stockCountLineId: lineId },
      quantityVariance: -0.5,
      confidence: args.confidence ?? "VERIFIED",
      financialImpact: { available: true, value: 225 },
      attribution: args.attribution,
    })
  );
  await advanceVarianceCase({ caseId, to: "UNDER_INVESTIGATION", actorId: openerId });
  return caseId;
}

const assign = (caseId: string) =>
  advanceVarianceCase({
    caseId,
    to: "RESPONSIBILITY_ASSIGNED",
    actorId: openerId,
    assignedResponsibilityUserId: staffId,
  });

describe("VAR-009 responsibility needs an attribution as well as confidence", () => {
  test("an unresolved period never becomes somebody's fault", async () => {
    const caseId = await investigating({ attribution: "PERIOD_UNRESOLVED" });
    await assert.rejects(
      () => assign(caseId),
      (e: { status?: number; message?: string }) => {
        assert.equal(e.status, 400);
        assert.match(
          e.message ?? "",
          /PERIOD_UNRESOLVED/,
          "the refusal names the reason, so the reader knows what would have to change"
        );
        return true;
      }
    );
    const still = await db.varianceCase.findUniqueOrThrow({ where: { id: caseId } });
    assert.equal(still.assignedResponsibilityUserId, null, "and nobody was named on the way out");
    assert.equal(still.status, "UNDER_INVESTIGATION");
  });

  test("a branch-held difference is not a person's fault either", async () => {
    const caseId = await investigating({ attribution: "BRANCH_CUSTODY" });
    await assert.rejects(
      () => assign(caseId),
      (e: { status?: number; message?: string }) => {
        assert.equal(e.status, 400);
        assert.match(e.message ?? "", /BRANCH_CUSTODY/);
        return true;
      }
    );
    const still = await db.varianceCase.findUniqueOrThrow({ where: { id: caseId } });
    assert.equal(still.assignedResponsibilityUserId, null);
  });

  test("a verified shift with verified evidence may be named", async () => {
    const caseId = await investigating({ attribution: "VERIFIED_SHIFT" });
    const assigned = await assign(caseId);
    assert.equal(assigned.status, "RESPONSIBILITY_ASSIGNED");
    const c = await db.varianceCase.findUniqueOrThrow({ where: { id: caseId } });
    assert.equal(c.assignedResponsibilityUserId, staffId);
  });

  test("attribution does not weaken the confidence gate", async () => {
    const caseId = await investigating({ attribution: "VERIFIED_SHIFT", confidence: "PARTIAL" });
    await assert.rejects(
      () => assign(caseId),
      (e: { status?: number; message?: string }) => {
        assert.equal(e.status, 400);
        assert.match(e.message ?? "", /VERIFIED/);
        return true;
      }
    );
    const still = await db.varianceCase.findUniqueOrThrow({ where: { id: caseId } });
    assert.equal(still.assignedResponsibilityUserId, null);
  });

  test("a case attribution never applied to keeps the behaviour it had before M22", async () => {
    // CASH, TENDER, OPENING — and any stock case outside handover
    // accountability — carry NOT_APPLICABLE. That is not a statement that the
    // difference cannot be pinned, so it must not refuse anything.
    const caseId = await investigating({ attribution: "NOT_APPLICABLE" });
    const assigned = await assign(caseId);
    assert.equal(assigned.status, "RESPONSIBILITY_ASSIGNED");
  });
});
