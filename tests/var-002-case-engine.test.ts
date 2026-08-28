// VAR-002 — a confirmed difference becomes a case, once.
//
// Two properties this module exists for, neither of which the schema alone
// can give:
//
// ONCE. Confirmation runs in a transaction that may be retried, and the same
// counted line may be reached twice by a caller that does not know it already
// succeeded. `openVarianceCase` returns `created: false` on the second call
// rather than throwing or duplicating. The `@unique` on each source column is
// what makes that true rather than merely likely, so the engine can lean on
// it instead of racing a `findFirst`.
//
// INSIDE THE CALLER'S TRANSACTION. `openVarianceCase` takes a
// `Prisma.TransactionClient` and never opens its own. T28 confirms a count,
// writes dispositions and opens cases as ONE act; a function that opened its
// own transaction could not take part in that, and a rolled-back
// confirmation would leave cases behind for a count that never happened.
// The last test rolls a transaction back and checks the case went with it.
//
// `financialImpact` is a discriminated union rather than a nullable number,
// and that is spec §12 made into a compile-time property: a caller cannot
// pass a value without asserting it trustworthy, nor assert unavailability
// without giving a reason. There is no way to spell "cost zero because we
// could not price it" in the type, which is the mistake it exists to
// prevent. The runtime half is asserted here too, since types vanish at run
// time and the database is what an owner reads.
//
// `source` is a union that maps one-to-one onto T18's CHECK, so an illegal
// shape is unrepresentable in TypeScript *and* rejected by the database.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { db, tag, teardownTaggedCafe } from "./helpers/db";
import { openVarianceCase, advanceVarianceCase } from "@/lib/variance-case";

const MARKER = tag("VAR002");
let cafeId: string;
let branchId: string;
let openerId: string;
let actorId: string;
let staffId: string;
let shiftId: string;
let custodyPeriodId: string;
let lineId: string;
let otherLineId: string;
let reconId: string;
let exceptionId: string;

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
  actorId = await mk("actor", "BRANCH_MANAGER");
  staffId = await mk("staff", "CASHIER");

  shiftId = (await db.shift.create({
    data: {
      cafeId, branchId, cashierId: staffId, shiftNumber: 1,
      openingCashAmount: 0, expectedCashAmount: 0,
      actualCashAmount: "487.00", cashDifference: "-13.00",
    },
  })).id;

  custodyPeriodId = (await db.custodyPeriod.create({
    data: {
      cafeId, branchId, scope: "STOCK",
      participants: { create: [{ userId: staffId, role: "PRIMARY" }] },
    },
  })).id;

  const item = async (name: string) =>
    (await db.inventoryItem.create({
      data: {
        cafeId, branchId, name: `${MARKER} ${name}`, unit: "KG",
        costPerUnit: 450, currentStock: "12.000",
      },
    })).id;

  const sessionId = (await db.stockCountSession.create({
    data: {
      cafeId, branchId, type: "FULL", scopeDerivation: "ALL_ELIGIBLE",
      initiatedById: openerId,
    },
  })).id;
  const line = async (inventoryItemId: string) =>
    (await db.stockCountLine.create({
      data: {
        sessionId, inventoryItemId, unit: "KG",
        expectedQuantity: "12.000", countedQuantity: "11.500",
        effectiveCountedQuantity: "11.500", varianceQuantity: "-0.500",
      },
    })).id;
  lineId = await line(await item("beans"));
  otherLineId = await line(await item("milk"));

  reconId = (await db.tenderReconciliation.create({
    data: {
      cafeId, branchId, shiftId, method: "CARD",
      expectedAmount: "1250.00", actualAmount: "1237.50", varianceAmount: "-12.50",
    },
  })).id;

  const reasonCodeId = (await db.reasonCode.create({
    data: { cafeId, domain: "HANDOVER", code: `${MARKER}-OPEN`, label: "فرق عند الفتح" },
  })).id;
  exceptionId = (await db.openingException.create({
    data: {
      cafeId, branchId, kind: "CASH_MISMATCH", shiftId,
      reasonCodeId, authorizedById: openerId,
    },
  })).id;
});

after(() => teardownTaggedCafe(cafeId, [], { disconnect: true }));

const clearCases = async () => {
  await db.shift.updateMany({ where: { cafeId }, data: { cashVarianceCaseId: null } });
  await db.varianceCase.deleteMany({ where: { cafeId } });
};

const base = () => ({
  cafeId, branchId, openedById: openerId,
  confidence: "UNVERIFIABLE" as const,
});

describe("VAR-002 variance case engine", () => {
  test("a stock line opens an OPEN, non-blocking case linked through the relation", async () => {
    await clearCases();
    const { caseId, created } = await db.$transaction((tx) =>
      openVarianceCase(tx, {
        ...base(), type: "STOCK", custodyPeriodId, shiftId,
        source: { kind: "STOCK_LINE", stockCountLineId: lineId },
        quantityVariance: -0.5,
        financialImpact: { available: false, reason: "MISSING_COST" },
      })
    );

    assert.equal(created, true);
    const c = await db.varianceCase.findUniqueOrThrow({
      where: { id: caseId }, include: { stockCountLine: true, custodyPeriod: true },
    });
    assert.equal(c.status, "OPEN");
    assert.equal(c.blocking, false, "a case does not stop the shop by default");
    assert.equal(c.stockCountLine?.id, lineId, "through the relation, not by loose id");
    assert.equal(c.custodyPeriod?.id, custodyPeriodId);
    assert.equal(Number(c.quantityVariance), -0.5);
    assert.equal(c.assignedResponsibilityUserId, null, "and blames nobody");
  });

  test("calling twice for one line returns created:false and leaves one case", async () => {
    // Idempotence is the point. Confirmation may be retried, and a retry must
    // not open a twin or explode on the unique index.
    await clearCases();
    const args = {
      ...base(), type: "STOCK" as const,
      source: { kind: "STOCK_LINE" as const, stockCountLineId: lineId },
      quantityVariance: -0.5,
      financialImpact: { available: false as const, reason: "MISSING_COST" as const },
    };
    const first = await db.$transaction((tx) => openVarianceCase(tx, args));
    const second = await db.$transaction((tx) => openVarianceCase(tx, args));

    assert.equal(first.created, true);
    assert.equal(second.created, false, "the second call found the first one's work");
    assert.equal(second.caseId, first.caseId, "and reports the same case");
    assert.equal(
      await db.varianceCase.count({ where: { stockCountLineId: lineId } }), 1,
      "one line, one case"
    );
  });

  test("a cash source opens with only shiftId and satisfies the CHECK", async () => {
    // The fourth arm. No source column is set, and the database accepts it
    // precisely because `type` is CASH.
    await clearCases();
    const { caseId } = await db.$transaction((tx) =>
      openVarianceCase(tx, {
        ...base(), type: "CASH", shiftId,
        source: { kind: "CASH_SHIFT" },
        amountVariance: -13,
        financialImpact: { available: true, value: 13 },
      })
    );
    const c = await db.varianceCase.findUniqueOrThrow({
      where: { id: caseId }, include: { shift: true },
    });
    assert.equal(c.stockCountLineId, null);
    assert.equal(c.tenderReconciliationId, null);
    assert.equal(c.openingExceptionId, null);
    assert.equal(c.shift?.id, shiftId, "the shift close is the evidence");
    assert.equal(Number(c.financialImpact), 13);
    assert.equal(c.financialImpactAvailable, true);
  });

  test("a cash case is idempotent per shift too", async () => {
    await clearCases();
    const args = {
      ...base(), type: "CASH" as const, shiftId,
      source: { kind: "CASH_SHIFT" as const },
      amountVariance: -13,
      financialImpact: { available: true as const, value: 13 },
    };
    const first = await db.$transaction((tx) => openVarianceCase(tx, args));
    const second = await db.$transaction((tx) => openVarianceCase(tx, args));
    assert.equal(second.created, false, "one shift close, one cash case");
    assert.equal(second.caseId, first.caseId);
    assert.equal(await db.varianceCase.count({ where: { cafeId, type: "CASH" } }), 1);
  });

  test("tender and opening sources open their own cases", async () => {
    await clearCases();
    const tender = await db.$transaction((tx) =>
      openVarianceCase(tx, {
        ...base(), type: "TENDER", shiftId,
        source: { kind: "TENDER", tenderReconciliationId: reconId },
        amountVariance: -12.5,
        financialImpact: { available: true, value: 12.5 },
      })
    );
    const opening = await db.$transaction((tx) =>
      openVarianceCase(tx, {
        ...base(), type: "OPENING_EXCEPTION", shiftId,
        source: { kind: "OPENING", openingExceptionId: exceptionId },
        financialImpact: { available: false, reason: "MISSING_COST" },
      })
    );

    const t = await db.varianceCase.findUniqueOrThrow({
      where: { id: tender.caseId }, include: { tenderReconciliation: true },
    });
    assert.equal(t.tenderReconciliation?.method, "CARD");

    const o = await db.varianceCase.findUniqueOrThrow({
      where: { id: opening.caseId }, include: { openingException: true },
    });
    assert.equal(o.openingException?.id, exceptionId);
  });

  test("an unavailable impact stores NULL and never a zero", async () => {
    // Spec §12, at runtime as well as in the type. Asserted on the returned
    // object AND on the stored row, because the row is what an owner reads.
    await clearCases();
    const reasons = ["MISSING_COST", "UNTRUSTED_COST", "CONFIDENCE_NOT_VERIFIED"] as const;
    const lines = [lineId, otherLineId];

    for (const [i, reason] of reasons.entries()) {
      await clearCases();
      const { caseId } = await db.$transaction((tx) =>
        openVarianceCase(tx, {
          ...base(), type: "STOCK",
          source: { kind: "STOCK_LINE", stockCountLineId: lines[i % lines.length] },
          quantityVariance: -0.5,
          financialImpact: { available: false, reason },
        })
      );
      const c = await db.varianceCase.findUniqueOrThrow({ where: { id: caseId } });
      assert.equal(c.financialImpact, null, `${reason} stores NULL`);
      assert.notEqual(Number(c.financialImpact ?? NaN), 0, "and never reads as zero");
      assert.equal(c.financialImpactAvailable, false);
      assert.equal(c.financialImpactUnavailableReason, reason, "with the reason kept");
    }

    // A genuine, trustworthy zero remains expressible and distinguishable.
    await clearCases();
    const { caseId } = await db.$transaction((tx) =>
      openVarianceCase(tx, {
        ...base(), type: "STOCK",
        source: { kind: "STOCK_LINE", stockCountLineId: lineId },
        financialImpact: { available: true, value: 0 },
      })
    );
    const priced = await db.varianceCase.findUniqueOrThrow({ where: { id: caseId } });
    assert.equal(Number(priced.financialImpact), 0);
    assert.equal(
      priced.financialImpactAvailable, true,
      "a priced zero says so; an unpriced unknown never borrows its number"
    );
  });

  test("the legal chain runs end to end", async () => {
    await clearCases();
    const { caseId } = await db.$transaction((tx) =>
      openVarianceCase(tx, {
        ...base(), type: "STOCK", custodyPeriodId,
        source: { kind: "STOCK_LINE", stockCountLineId: lineId },
        confidence: "VERIFIED",
        financialImpact: { available: true, value: 225 },
      })
    );

    for (const to of ["UNDER_INVESTIGATION", "RESPONSIBILITY_ASSIGNED", "APPROVED", "RESOLVED"] as const) {
      const r = await advanceVarianceCase({
        caseId, to, actorId,
        ...(to === "RESPONSIBILITY_ASSIGNED" ? { assignedResponsibilityUserId: staffId } : {}),
        ...(to === "RESOLVED" ? { note: "أعيد العد وطابق" } : {}),
      });
      assert.equal(r.status, to);
    }

    const final = await db.varianceCase.findUniqueOrThrow({
      where: { id: caseId }, include: { resolvedBy: true, assignedResponsibility: true },
    });
    assert.equal(final.status, "RESOLVED");
    assert.equal(final.resolvedBy?.id, actorId, "who closed it is recorded");
    assert.ok(final.resolvedAt);
    assert.equal(final.resolutionNote, "أعيد العد وطابق");
    assert.equal(
      final.assignedResponsibility?.id, staffId,
      "and responsibility was assigned by an act, not by attendance"
    );
  });

  test("RESOLVED does not go back to OPEN", async () => {
    await clearCases();
    const { caseId } = await db.$transaction((tx) =>
      openVarianceCase(tx, {
        ...base(), type: "STOCK",
        source: { kind: "STOCK_LINE", stockCountLineId: lineId },
        confidence: "VERIFIED",
        financialImpact: { available: true, value: 225 },
      })
    );
    for (const to of ["UNDER_INVESTIGATION", "RESPONSIBILITY_ASSIGNED", "APPROVED", "RESOLVED"] as const) {
      await advanceVarianceCase({
        caseId, to, actorId,
        ...(to === "RESPONSIBILITY_ASSIGNED" ? { assignedResponsibilityUserId: staffId } : {}),
      });
    }

    await assert.rejects(
      () => advanceVarianceCase({ caseId, to: "OPEN", actorId }),
      (e: { status?: number }) => e.status === 400,
      "a resolved case is closed history, not a draft"
    );
    const still = await db.varianceCase.findUniqueOrThrow({ where: { id: caseId } });
    assert.equal(still.status, "RESOLVED", "and the refused transition changed nothing");
  });

  test("a skipped step is refused", async () => {
    await clearCases();
    const { caseId } = await db.$transaction((tx) =>
      openVarianceCase(tx, {
        ...base(), type: "STOCK",
        source: { kind: "STOCK_LINE", stockCountLineId: lineId },
        financialImpact: { available: false, reason: "MISSING_COST" },
      })
    );
    await assert.rejects(
      () => advanceVarianceCase({ caseId, to: "RESOLVED", actorId }),
      (e: { status?: number }) => e.status === 400,
      "OPEN does not jump straight to RESOLVED"
    );
  });

  test("WAIVED is reachable from any non-terminal state", async () => {
    await clearCases();
    const { caseId } = await db.$transaction((tx) =>
      openVarianceCase(tx, {
        ...base(), type: "STOCK",
        source: { kind: "STOCK_LINE", stockCountLineId: lineId },
        financialImpact: { available: false, reason: "MISSING_COST" },
      })
    );
    await advanceVarianceCase({ caseId, to: "UNDER_INVESTIGATION", actorId });
    const waived = await advanceVarianceCase({
      caseId, to: "WAIVED", actorId, note: "فرق مقبول",
    });
    assert.equal(waived.status, "WAIVED");

    await assert.rejects(
      () => advanceVarianceCase({ caseId, to: "UNDER_INVESTIGATION", actorId }),
      (e: { status?: number }) => e.status === 400,
      "WAIVED is terminal too"
    );
  });

  test("a case created inside a rolled-back transaction does not persist", async () => {
    // The reason this takes a TransactionClient at all. A confirmation that
    // fails after opening cases must leave none behind: the count did not
    // happen, so neither did the investigations it would have raised.
    await clearCases();
    const beforeCount = await db.varianceCase.count({ where: { cafeId } });

    await assert.rejects(
      () => db.$transaction(async (tx) => {
        await openVarianceCase(tx, {
          ...base(), type: "STOCK",
          source: { kind: "STOCK_LINE", stockCountLineId: lineId },
          financialImpact: { available: false, reason: "MISSING_COST" },
        });
        throw new Error("the confirmation failed after opening the case");
      }),
      /the confirmation failed/
    );

    assert.equal(
      await db.varianceCase.count({ where: { cafeId } }), beforeCount,
      "the case rolled back with the transaction that made it"
    );
    assert.equal(await db.varianceCase.count({ where: { stockCountLineId: lineId } }), 0);
  });

  test("opening a case through the engine still moves no stock", async () => {
    // The schema test proves a bare INSERT does not. This proves the engine
    // does not either — no convenience crept in between the two.
    await clearCases();
    const item = await db.inventoryItem.findFirstOrThrow({ where: { cafeId } });
    const txnsBefore = await db.inventoryTransaction.count({ where: { cafeId } });

    await db.$transaction((tx) =>
      openVarianceCase(tx, {
        ...base(), type: "STOCK", custodyPeriodId,
        source: { kind: "STOCK_LINE", stockCountLineId: lineId },
        quantityVariance: -0.5,
        financialImpact: { available: false, reason: "MISSING_COST" },
      })
    );

    const after = await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    assert.equal(String(after.currentStock), String(item.currentStock));
    assert.equal(after.ledgerVersion, item.ledgerVersion);
    assert.equal(await db.inventoryTransaction.count({ where: { cafeId } }), txnsBefore);
  });
});
