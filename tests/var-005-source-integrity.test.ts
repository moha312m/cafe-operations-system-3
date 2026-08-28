// VAR-005 — the type must agree with the evidence, and the evidence must be ours.
//
// T18's `VarianceCase_single_source_check` counts sources: exactly one of the
// three source columns is set, or the type is CASH. That is necessary and it
// is not sufficient, and the gap is easy to miss because the constraint looks
// complete. Counting cannot tell a STOCK case holding a TENDER source from a
// STOCK case holding a stock line — both have exactly one non-null column, so
// both pass. A case could therefore claim to be about a counted shelf while
// pointing at a card settlement, and every reader downstream — the API, the
// export, the investigation screen — would believe the label.
//
// So the type and the source have to be checked against each other, not
// merely tallied. The matrix below is the whole of it, and it is enforced in
// the database rather than in a service, because the label and the pointer
// living in one row is exactly the kind of agreement a data fix or a later
// migration walks past.
//
// CASH is the arm that needs the extra clause. It has no source column, so
// "exactly one source" is satisfied by the type alone — which means a CASH
// case with a NULL `shiftId` currently passes while pointing at nothing at
// all. Cash evidence is the shift close (T16), so a CASH case without a shift
// is a case with no evidence.
//
// The second half of this suite is about ownership rather than shape. A
// foreign key proves a row exists; it does not prove the row is ours. A
// counted line from another café satisfies every constraint above while
// belonging to somebody else's business, and attaching it would put another
// café's figures inside this one's investigation. Revision 3 assigns that
// check to no task, so it is enforced in `openVarianceCase` — the one door
// every case goes through — rather than by a trigger.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { db, tag, teardownTaggedCafe } from "./helpers/db";
import { openVarianceCase } from "@/lib/variance-case";

const MARKER = tag("VAR005");

/** One café's worth of every source a variance case can name. */
type World = {
  cafeId: string;
  branchId: string;
  userId: string;
  shiftId: string;
  lineId: string;
  reconId: string;
  exceptionId: string;
};

let home: World;
let otherBranch: World;   // same café, different branch
let otherCafe: World;     // a different business entirely

async function buildWorld(suffix: string, existing?: { cafeId: string }): Promise<World> {
  const label = `${MARKER}-${suffix}`;
  let cafeId: string;
  if (existing) {
    cafeId = existing.cafeId;
  } else {
    cafeId = (await db.cafe.create({
      data: { name: `${label} cafe`, slug: label.toLowerCase(), settings: { create: {} } },
    })).id;
  }
  const branchId = (await db.branch.create({
    data: { cafeId, name: `${label} branch` },
  })).id;

  const userId = (await db.user.create({
    data: {
      email: `${label}@example.invalid`, name: label,
      passwordHash: "no-login-path", role: "BRANCH_MANAGER", cafeId, branchId,
    },
  })).id;

  const last = await db.shift.aggregate({ where: { branchId }, _max: { shiftNumber: true } });
  const shiftId = (await db.shift.create({
    data: {
      cafeId, branchId, cashierId: userId, shiftNumber: (last._max.shiftNumber ?? 0) + 1,
      openingCashAmount: 0, expectedCashAmount: 0,
      actualCashAmount: "487.00", cashDifference: "-13.00",
    },
  })).id;

  const itemId = (await db.inventoryItem.create({
    data: {
      cafeId, branchId, name: `${label} beans`, unit: "KG",
      costPerUnit: 450, currentStock: "12.000",
    },
  })).id;
  const sessionId = (await db.stockCountSession.create({
    data: {
      cafeId, branchId, type: "FULL", scopeDerivation: "ALL_ELIGIBLE", initiatedById: userId,
    },
  })).id;
  const lineId = (await db.stockCountLine.create({
    data: {
      sessionId, inventoryItemId: itemId, unit: "KG",
      expectedQuantity: "12.000", countedQuantity: "11.500", varianceQuantity: "-0.500",
    },
  })).id;

  const reconId = (await db.tenderReconciliation.create({
    data: {
      cafeId, branchId, shiftId, method: "CARD",
      expectedAmount: "1250.00", actualAmount: "1237.50", varianceAmount: "-12.50",
    },
  })).id;

  const reasonCodeId = (await db.reasonCode.create({
    data: { cafeId, domain: "HANDOVER", code: `${label}-OPEN`, label: "فرق عند الفتح" },
  })).id;
  const exceptionId = (await db.openingException.create({
    data: {
      cafeId, branchId, kind: "CASH_MISMATCH", shiftId,
      reasonCodeId, authorizedById: userId,
    },
  })).id;

  return { cafeId, branchId, userId, shiftId, lineId, reconId, exceptionId };
}

before(async () => {
  home = await buildWorld("home");
  otherBranch = await buildWorld("otherbranch", { cafeId: home.cafeId });
  otherCafe = await buildWorld("othercafe");
});

after(() =>
  teardownTaggedCafe([home?.cafeId, otherCafe?.cafeId], [], { disconnect: true })
);

const clearCases = async () => {
  await db.shift.updateMany({
    where: { cafeId: { in: [home.cafeId, otherCafe.cafeId] } },
    data: { cashVarianceCaseId: null },
  });
  await db.varianceCase.deleteMany({
    where: { cafeId: { in: [home.cafeId, otherCafe.cafeId] } },
  });
};

/** A direct INSERT, deliberately bypassing the service, to test the database. */
const rawCase = (data: Record<string, unknown>) =>
  db.varianceCase.create({
    data: {
      cafeId: home.cafeId, branchId: home.branchId, openedById: home.userId,
      ...data,
    } as never,
  });

const REJECTED = /VarianceCase_single_source_check|VarianceCase_type_matches_source|constraint/i;

describe("VAR-005 the type must agree with the evidence", () => {
  test("the live constraint names the type, not only the source count", async () => {
    // Read from the database rather than from the migration file: the file is
    // what we believe was applied, and the catalogue is what actually runs.
    const checks = await db.$queryRaw<{ conname: string; definition: string }[]>`
      SELECT conname, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE conrelid = '"VarianceCase"'::regclass AND contype = 'c'
    `;
    const all = checks.map((c) => c.definition).join("\n");
    for (const t of ["STOCK", "TENDER", "OPENING_EXCEPTION", "CASH"]) {
      assert.ok(
        all.includes(t),
        `no CHECK mentions ${t} — the type is not being matched against its source`
      );
    }
    assert.ok(
      all.includes("shiftId"),
      "no CHECK mentions shiftId — a CASH case could point at nothing"
    );
  });

  // ── the four valid rows ────────────────────────────────────────────
  test("CASH with a shift and no source column is accepted", async () => {
    await clearCases();
    const c = await rawCase({ type: "CASH", shiftId: home.shiftId, amountVariance: "-13.00" });
    assert.equal(c.type, "CASH");
    assert.equal(c.shiftId, home.shiftId, "its evidence is the shift close");
    assert.equal(c.stockCountLineId, null);
    assert.equal(c.tenderReconciliationId, null);
    assert.equal(c.openingExceptionId, null);
  });

  test("STOCK with a counted line is accepted", async () => {
    await clearCases();
    const c = await rawCase({ type: "STOCK", stockCountLineId: home.lineId });
    assert.equal(c.stockCountLineId, home.lineId);
  });

  test("TENDER with a settlement is accepted", async () => {
    await clearCases();
    const c = await rawCase({ type: "TENDER", tenderReconciliationId: home.reconId });
    assert.equal(c.tenderReconciliationId, home.reconId);
  });

  test("OPENING_EXCEPTION with an exception is accepted", async () => {
    await clearCases();
    const c = await rawCase({ type: "OPENING_EXCEPTION", openingExceptionId: home.exceptionId });
    assert.equal(c.openingExceptionId, home.exceptionId);
  });

  // ── every mismatch ─────────────────────────────────────────────────
  test("a STOCK case cannot hold a tender or opening source", async () => {
    // The gap counting alone cannot see: exactly one column is set, so the
    // tally is satisfied while the label is a lie.
    await clearCases();
    await assert.rejects(
      () => rawCase({ type: "STOCK", tenderReconciliationId: home.reconId }), REJECTED
    );
    await assert.rejects(
      () => rawCase({ type: "STOCK", openingExceptionId: home.exceptionId }), REJECTED
    );
  });

  test("a TENDER case cannot hold a stock or opening source", async () => {
    await clearCases();
    await assert.rejects(
      () => rawCase({ type: "TENDER", stockCountLineId: home.lineId }), REJECTED
    );
    await assert.rejects(
      () => rawCase({ type: "TENDER", openingExceptionId: home.exceptionId }), REJECTED
    );
  });

  test("an OPENING_EXCEPTION case cannot hold a stock or tender source", async () => {
    await clearCases();
    await assert.rejects(
      () => rawCase({ type: "OPENING_EXCEPTION", stockCountLineId: home.lineId }), REJECTED
    );
    await assert.rejects(
      () => rawCase({ type: "OPENING_EXCEPTION", tenderReconciliationId: home.reconId }), REJECTED
    );
  });

  test("a CASH case cannot hold any of the three source columns", async () => {
    await clearCases();
    for (const [column, value] of [
      ["stockCountLineId", home.lineId],
      ["tenderReconciliationId", home.reconId],
      ["openingExceptionId", home.exceptionId],
    ] as const) {
      await assert.rejects(
        () => rawCase({ type: "CASH", shiftId: home.shiftId, [column]: value }),
        REJECTED,
        `CASH must not also carry ${column}`
      );
    }
  });

  test("a non-CASH case cannot be left with no source at all", async () => {
    await clearCases();
    for (const type of ["STOCK", "TENDER", "OPENING_EXCEPTION"] as const) {
      await assert.rejects(
        () => rawCase({ type, shiftId: home.shiftId }), REJECTED,
        `a ${type} case with nothing behind it is an assertion, not evidence`
      );
    }
  });

  test("a CASH case with no shift is refused — cash evidence is the close", async () => {
    // `shiftId` is nullable, because the other three types reach their
    // evidence through their own columns and may legitimately leave it null.
    // For CASH it is the entire source, so the constraint has to say so.
    await clearCases();
    await assert.rejects(
      () => rawCase({ type: "CASH", amountVariance: "-13.00" }), REJECTED,
      "a CASH case pointing at no shift points at nothing"
    );
    assert.equal(await db.varianceCase.count({ where: { cafeId: home.cafeId } }), 0);
  });

  test("a CASH case's shift is a real row, and still the authoritative one", async () => {
    await clearCases();
    await assert.rejects(
      () => rawCase({ type: "CASH", shiftId: `no-such-shift-${MARKER}` }),
      /Foreign key|constraint|P2003/i,
      "the shift is a real key, not a label"
    );

    const c = await rawCase({ type: "CASH", shiftId: home.shiftId, amountVariance: "-13.00" });
    const loaded = await db.varianceCase.findUniqueOrThrow({
      where: { id: c.id }, include: { shift: true },
    });
    assert.equal(
      Number(loaded.shift?.actualCashAmount), 487,
      "and the close still holds the counted drawer the case is about"
    );
    assert.equal(Number(loaded.shift?.cashDifference), -13);

    // No second cash source came into being to serve the case.
    const cashRecons = await db.tenderReconciliation.count({
      where: { shiftId: home.shiftId, method: "CASH" },
    });
    assert.equal(cashRecons, 0, "no TenderReconciliation CASH row, now or ever");
    assert.equal(
      await db.varianceCase.count({ where: { type: "CASH", shiftId: home.shiftId } }), 1,
      "and one shift close raises one cash case"
    );
  });

  // ── ownership: a key proves existence, not belonging ───────────────
  test("a stock line from another café cannot be attached", async () => {
    await clearCases();
    await assert.rejects(
      () => db.$transaction((tx) =>
        openVarianceCase(tx, {
          cafeId: home.cafeId, branchId: home.branchId, type: "STOCK",
          openedById: home.userId,
          source: { kind: "STOCK_LINE", stockCountLineId: otherCafe.lineId },
          financialImpact: { available: false, reason: "MISSING_COST" },
        })
      ),
      /café|branch|does not belong/i,
      "another café's counted shelf is not evidence about this one"
    );
    assert.equal(await db.varianceCase.count({ where: { cafeId: home.cafeId } }), 0);
  });

  test("a settlement from another café cannot be attached", async () => {
    await clearCases();
    await assert.rejects(
      () => db.$transaction((tx) =>
        openVarianceCase(tx, {
          cafeId: home.cafeId, branchId: home.branchId, type: "TENDER",
          openedById: home.userId,
          source: { kind: "TENDER", tenderReconciliationId: otherCafe.reconId },
          financialImpact: { available: false, reason: "MISSING_COST" },
        })
      ),
      /café|branch|does not belong/i
    );
  });

  test("an opening exception from another café cannot be attached", async () => {
    await clearCases();
    await assert.rejects(
      () => db.$transaction((tx) =>
        openVarianceCase(tx, {
          cafeId: home.cafeId, branchId: home.branchId, type: "OPENING_EXCEPTION",
          openedById: home.userId,
          source: { kind: "OPENING", openingExceptionId: otherCafe.exceptionId },
          financialImpact: { available: false, reason: "MISSING_COST" },
        })
      ),
      /café|branch|does not belong/i
    );
  });

  test("a shift from another café cannot be the cash source", async () => {
    await clearCases();
    await assert.rejects(
      () => db.$transaction((tx) =>
        openVarianceCase(tx, {
          cafeId: home.cafeId, branchId: home.branchId, type: "CASH",
          shiftId: otherCafe.shiftId, openedById: home.userId,
          source: { kind: "CASH_SHIFT" },
          financialImpact: { available: false, reason: "MISSING_COST" },
        })
      ),
      /café|branch|does not belong/i
    );
  });

  test("the same café's other branch is refused too", async () => {
    // Tenancy is not the only boundary that matters. A case names a branch,
    // and a shortage found in one store room is not evidence about another.
    await clearCases();
    for (const source of [
      { kind: "STOCK_LINE" as const, stockCountLineId: otherBranch.lineId },
      { kind: "TENDER" as const, tenderReconciliationId: otherBranch.reconId },
      { kind: "OPENING" as const, openingExceptionId: otherBranch.exceptionId },
    ]) {
      await assert.rejects(
        () => db.$transaction((tx) =>
          openVarianceCase(tx, {
            cafeId: home.cafeId, branchId: home.branchId,
            type: source.kind === "STOCK_LINE" ? "STOCK"
              : source.kind === "TENDER" ? "TENDER" : "OPENING_EXCEPTION",
            openedById: home.userId, source,
            financialImpact: { available: false, reason: "MISSING_COST" },
          })
        ),
        /branch|café|does not belong/i,
        `${source.kind} from another branch must be refused`
      );
    }

    await assert.rejects(
      () => db.$transaction((tx) =>
        openVarianceCase(tx, {
          cafeId: home.cafeId, branchId: home.branchId, type: "CASH",
          shiftId: otherBranch.shiftId, openedById: home.userId,
          source: { kind: "CASH_SHIFT" },
          financialImpact: { available: false, reason: "MISSING_COST" },
        })
      ),
      /branch|café|does not belong/i
    );

    assert.equal(await db.varianceCase.count({ where: { cafeId: home.cafeId } }), 0);
  });

  test("the café's own sources still open normally", async () => {
    // The permissive half. A guard that refused everything would be an
    // outage with a principled comment above it.
    await clearCases();
    const stock = await db.$transaction((tx) =>
      openVarianceCase(tx, {
        cafeId: home.cafeId, branchId: home.branchId, type: "STOCK",
        openedById: home.userId,
        source: { kind: "STOCK_LINE", stockCountLineId: home.lineId },
        quantityVariance: -0.5,
        financialImpact: { available: false, reason: "MISSING_COST" },
      })
    );
    assert.equal(stock.created, true);

    const cash = await db.$transaction((tx) =>
      openVarianceCase(tx, {
        cafeId: home.cafeId, branchId: home.branchId, type: "CASH",
        shiftId: home.shiftId, openedById: home.userId,
        source: { kind: "CASH_SHIFT" }, amountVariance: -13,
        financialImpact: { available: true, value: 13 },
      })
    );
    assert.equal(cash.created, true);

    // And the other café's own line still opens against its own café — the
    // guard is about mismatch, not about that café being special.
    const theirs = await db.$transaction((tx) =>
      openVarianceCase(tx, {
        cafeId: otherCafe.cafeId, branchId: otherCafe.branchId, type: "STOCK",
        openedById: otherCafe.userId,
        source: { kind: "STOCK_LINE", stockCountLineId: otherCafe.lineId },
        financialImpact: { available: false, reason: "MISSING_COST" },
      })
    );
    assert.equal(theirs.created, true);
  });

  test("the refusal happens before anything is written", async () => {
    await clearCases();
    const before = await db.varianceCase.count();
    await assert.rejects(
      () => db.$transaction((tx) =>
        openVarianceCase(tx, {
          cafeId: home.cafeId, branchId: home.branchId, type: "STOCK",
          openedById: home.userId,
          source: { kind: "STOCK_LINE", stockCountLineId: otherCafe.lineId },
          financialImpact: { available: false, reason: "MISSING_COST" },
        })
      )
    );
    assert.equal(await db.varianceCase.count(), before, "no half-written case survived");
  });
});
