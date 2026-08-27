// CASH-001 — cash keeps one home, and the other channels get their own.
//
// Revision 1 of this plan gave CASH a TenderReconciliation row alongside
// `Shift.actualCashAmount`. That put the same money in two places free to
// disagree, and it demoted the existing, tested close path to a second
// opinion — a close that already worked would have become one of two answers
// with nothing in the schema saying which an owner should believe.
//
// So the split is drawn along how the money actually arrives. CASH is counted
// in a drawer at the end of a shift, and `Shift` is where that count lives;
// it gains what it lacked — the tolerance applied, a reason code, a note —
// and keeps `actualCashAmount` and `cashDifference` exactly as they were.
// CARD and WALLET settle through a processor on the processor's schedule, and
// that is a different record with a different lifecycle: expected against
// settled, submitted by somebody, approved by somebody else.
//
// MIXED is excluded for a third reason again. It is not a channel at all — it
// marks an order paid across more than one method, and every part is already
// a Payment row under its own real method. A MIXED reconciliation would count
// the same money a second time under a label no processor ever settles.
//
// The exclusion is a CHECK constraint, not a convention, because a convention
// is a comment that a later migration, a seed script or a data fix can walk
// straight past.
//
// `Shift.cashVarianceCaseId` is deliberately absent and asserted absent: it
// ships with the VarianceCase table it points at, so the foreign key can be
// created in the same migration as its target rather than left dangling.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { db, tag, teardownTaggedCafe } from "./helpers/db";
import { assertReconcilableTender } from "@/lib/tender";
import { resolveCashTolerance } from "@/lib/tolerance";

const MARKER = tag("CASH001");
let cafeId: string;
let branchId: string;
let cashierId: string;
let managerId: string;
let shiftId: string;
let otherShiftId: string;
let tenderReasonId: string;
let cashReasonId: string;

/** Shifts that existed before this migration, with the figures they held. */
let preExisting: {
  id: string;
  actualCashAmount: unknown;
  cashDifference: unknown;
}[] = [];

before(async () => {
  preExisting = await db.shift.findMany({
    select: { id: true, actualCashAmount: true, cashDifference: true },
  });

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
  cashierId = await mk("cashier", "CASHIER");
  managerId = await mk("manager", "BRANCH_MANAGER");

  const shift = async (n: number) =>
    (await db.shift.create({
      data: {
        cafeId, branchId, cashierId, shiftNumber: n,
        openingCashAmount: 0, expectedCashAmount: 0,
      },
    })).id;
  shiftId = await shift(1);
  otherShiftId = await shift(2);

  tenderReasonId = (await db.reasonCode.create({
    data: { cafeId, domain: "TENDER", code: `${MARKER}-FEE`, label: "عمولة الشبكة" },
  })).id;
  cashReasonId = (await db.reasonCode.create({
    data: { cafeId, domain: "CASH", code: `${MARKER}-SHORT`, label: "عجز في الدرج" },
  })).id;
});

after(() => teardownTaggedCafe(cafeId, [], { disconnect: true }));

const clearRecons = () => db.tenderReconciliation.deleteMany({ where: { shiftId } });

describe("CASH-001 tender reconciliation and shift cash columns", () => {
  test("a CARD reconciliation persists with its whole lifecycle", async () => {
    await clearRecons();
    const r = await db.tenderReconciliation.create({
      data: {
        cafeId, branchId, shiftId, method: "CARD",
        expectedAmount: "1250.00",
      },
    });

    assert.equal(r.status, "DRAFT", "a reconciliation starts unsubmitted");
    assert.equal(Number(r.expectedAmount), 1250);
    assert.equal(r.actualAmount, null, "what settled is not known at creation");
    assert.equal(r.varianceAmount, null, "and neither is the difference");
    assert.equal(r.submittedById, null);
    assert.equal(r.approvedById, null);

    const submitted = await db.tenderReconciliation.update({
      where: { id: r.id },
      data: {
        actualAmount: "1237.50", varianceAmount: "-12.50", toleranceAmount: "5.00",
        reasonCodeId: tenderReasonId, reasonNote: "خصم عمولة",
        status: "SUBMITTED", submittedById: cashierId, submittedAt: new Date(),
      },
    });
    assert.equal(Number(submitted.varianceAmount), -12.5);
    assert.equal(submitted.submittedById, cashierId);

    const approved = await db.tenderReconciliation.update({
      where: { id: r.id },
      data: { status: "APPROVED", approvedById: managerId, approvedAt: new Date() },
    });
    assert.equal(approved.status, "APPROVED");
    assert.equal(
      approved.approvedById, managerId,
      "submitting and approving are different signatures"
    );
  });

  test("a WALLET reconciliation persists alongside the CARD one", async () => {
    await clearRecons();
    await db.tenderReconciliation.create({
      data: { cafeId, branchId, shiftId, method: "CARD", expectedAmount: "100.00" },
    });
    const wallet = await db.tenderReconciliation.create({
      data: { cafeId, branchId, shiftId, method: "WALLET", expectedAmount: "60.00" },
    });

    assert.equal(wallet.method, "WALLET");
    assert.equal(
      await db.tenderReconciliation.count({ where: { shiftId } }), 2,
      "one shift settles through both electronic channels"
    );
  });

  test("CASH is refused by the database, not merely by convention", async () => {
    // The invariant the whole task exists for. Cash is counted in the drawer
    // and recorded on Shift; a row here would be a competing answer.
    await clearRecons();
    await assert.rejects(
      () => db.tenderReconciliation.create({
        data: { cafeId, branchId, shiftId, method: "CASH", expectedAmount: "500.00" },
      }),
      /TenderReconciliation_no_cash_check|constraint/i,
      "a CASH channel must be impossible, not just discouraged"
    );
    assert.equal(await db.tenderReconciliation.count({ where: { shiftId } }), 0);
  });

  test("MIXED is refused too, for a different reason", async () => {
    // Not "cash has a better home" but "this is not a channel". Every part of
    // a mixed payment is already a Payment row under its real method.
    await clearRecons();
    await assert.rejects(
      () => db.tenderReconciliation.create({
        data: { cafeId, branchId, shiftId, method: "MIXED", expectedAmount: "500.00" },
      }),
      /TenderReconciliation_no_cash_check|constraint/i
    );
    assert.equal(await db.tenderReconciliation.count({ where: { shiftId } }), 0);
  });

  test("the service guard and the constraint refuse the same two methods", async () => {
    // Two enforcement points that disagreed would be worse than one. The
    // guard is what an owner sees; the constraint is what stops a script.
    assert.equal(assertReconcilableTender("CARD"), "CARD");
    assert.equal(assertReconcilableTender("WALLET"), "WALLET");
    assert.throws(() => assertReconcilableTender("CASH"), /Shift cash close/);
    assert.throws(() => assertReconcilableTender("MIXED"), /split-payment marker/);
  });

  test("(shiftId, method) rejects a second row for the same channel", async () => {
    await clearRecons();
    const base = { cafeId, branchId, shiftId, method: "CARD" as const, expectedAmount: "10.00" };
    await db.tenderReconciliation.create({ data: base });
    await assert.rejects(
      () => db.tenderReconciliation.create({ data: base }),
      (e: { code?: string }) => e.code === "P2002",
      "one shift settles a channel once, or the totals mean nothing"
    );

    const elsewhere = await db.tenderReconciliation.create({
      data: { ...base, shiftId: otherShiftId },
    });
    assert.equal(
      elsewhere.shiftId, otherShiftId,
      "the same channel on a different shift is a different settlement"
    );
    await db.tenderReconciliation.deleteMany({ where: { shiftId: otherShiftId } });
  });

  test("every shift that existed before this migration reads NULL, unchanged", async () => {
    // The four columns are nullable because NULL is true: those shifts were
    // closed before tolerance, reasons and notes existed here. Backfilling a
    // default would have invented a reconciliation nobody performed.
    assert.ok(preExisting.length > 0, "there must be prior shifts for this to mean anything");

    const now = await db.shift.findMany({
      where: { id: { in: preExisting.map((s) => s.id) } },
      select: {
        id: true, actualCashAmount: true, cashDifference: true,
        cashWithinTolerance: true, cashToleranceAmount: true,
        cashReasonCodeId: true, cashReasonNote: true,
      },
    });
    assert.equal(now.length, preExisting.length, "no prior shift went missing");

    for (const shift of now) {
      const before = preExisting.find((s) => s.id === shift.id);
      assert.ok(before);
      assert.equal(shift.cashWithinTolerance, null, `${shift.id} gained no verdict`);
      assert.equal(shift.cashToleranceAmount, null);
      assert.equal(shift.cashReasonCodeId, null);
      assert.equal(shift.cashReasonNote, null);
      assert.equal(
        String(shift.actualCashAmount), String(before.actualCashAmount),
        "the counted drawer is exactly what it was"
      );
      assert.equal(String(shift.cashDifference), String(before.cashDifference));
    }
  });

  test("cash reconciliation stays on Shift and extends the existing columns", async () => {
    // Requirement 5, asserted rather than asserted-to. The new columns sit
    // beside `actualCashAmount`/`cashDifference` on the same row the close
    // path already writes — they are not a second record it must also update.
    const closed = await db.shift.update({
      where: { id: shiftId },
      data: {
        actualCashAmount: "497.00", cashDifference: "-3.00",
        cashWithinTolerance: false, cashToleranceAmount: "2.00",
        cashReasonCodeId: cashReasonId, cashReasonNote: "فكة ناقصة",
        status: "CLOSED", closedAt: new Date(),
      },
      include: { cashReasonCode: true },
    });

    assert.equal(Number(closed.actualCashAmount), 497, "the pre-existing figure still governs");
    assert.equal(Number(closed.cashDifference), -3);
    assert.equal(closed.cashWithinTolerance, false);
    assert.equal(Number(closed.cashToleranceAmount), 2, "the bound applied, kept for replay");
    assert.equal(
      closed.cashReasonCode?.code, `${MARKER}-SHORT`,
      "the reason resolves through a real relation, not a loose id"
    );
    assert.equal(closed.cashReasonCode?.domain, "CASH");

    await db.shift.update({
      where: { id: shiftId },
      data: { status: "OPEN", closedAt: null },
    });
  });

  test("no second home for cash exists anywhere in the new table", async () => {
    // The failure mode Revision 1 had: the same money in two places, free to
    // disagree. Stated as a property of the schema rather than of one row.
    const rows = await db.tenderReconciliation.findMany({
      where: { shiftId }, select: { method: true },
    });
    assert.deepEqual(
      rows.map((r) => r.method).filter((m) => m === "CASH"), [],
      "no CASH row can be here to disagree with the drawer count"
    );

    const cashColumns = await db.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'TenderReconciliation'
         AND column_name ILIKE '%cash%'
    `;
    assert.deepEqual(
      cashColumns, [],
      "the table carries no cash-named column either — one home, not one and a half"
    );
  });

  test("cash tolerance still resolves, because a policy is not a channel", async () => {
    // The distinction the pre-T16 gate settled: cash HAS a tolerance, stored
    // as a TENDER-scoped rule whose method is CASH, and does NOT have a
    // reconciliation channel. Both halves asserted together so neither can be
    // "fixed" by breaking the other.
    await db.toleranceRule.deleteMany({ where: { cafeId } });
    await db.toleranceRule.create({
      data: { cafeId, scope: "TENDER", tenderMethod: "CASH", amountTolerance: "2.00" },
    });

    const cash = await resolveCashTolerance({ cafeId, branchId });
    assert.equal(cash.scope, "TENDER");
    assert.equal(cash.amountTolerance, 2, "the drawer's bound is configurable and resolves");

    await assert.rejects(
      () => db.tenderReconciliation.create({
        data: { cafeId, branchId, shiftId, method: "CASH", expectedAmount: "1.00" },
      }),
      /constraint|no_cash_check/i,
      "…and still buys no channel"
    );
  });

  test("Shift.cashVarianceCaseId does not exist yet", async () => {
    // R3.3's ordering, visible in a test. The column ships in the migration
    // that creates VarianceCase, so its foreign key can be created with its
    // target rather than pointing at nothing in the meantime.
    const cols = await db.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'Shift' AND column_name = 'cashVarianceCaseId'
    `;
    assert.deepEqual(cols, [], "when this fails, T18 has landed and owns the column");
  });

  test("every accountability id is a real foreign key", async () => {
    // Requirement 7. A String column named `…Id` that no constraint enforces
    // is a promise, not a relation: it survives the row it names being
    // deleted and reads as evidence of somebody who may not exist.
    const fks = await db.$queryRaw<{ table_name: string; column_name: string; foreign_table: string }[]>`
      SELECT tc.table_name,
             kcu.column_name,
             ccu.table_name AS foreign_table
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_name = tc.constraint_name
         AND ccu.table_schema = tc.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY'
         AND tc.table_schema = current_schema()
         AND (
           (tc.table_name = 'TenderReconciliation')
           OR (tc.table_name = 'Shift' AND kcu.column_name = 'cashReasonCodeId')
         )
    `;
    const found = new Set(fks.map((f) => `${f.table_name}.${f.column_name}->${f.foreign_table}`));

    for (const expected of [
      "TenderReconciliation.cafeId->Cafe",
      "TenderReconciliation.branchId->Branch",
      "TenderReconciliation.shiftId->Shift",
      "TenderReconciliation.reasonCodeId->ReasonCode",
      "TenderReconciliation.submittedById->User",
      "TenderReconciliation.approvedById->User",
      "Shift.cashReasonCodeId->ReasonCode",
    ]) {
      assert.ok(found.has(expected), `missing foreign key ${expected}`);
    }
  });

  test("a reason code reaches back to what cited it", async () => {
    await clearRecons();
    const recon = await db.tenderReconciliation.create({
      data: {
        cafeId, branchId, shiftId, method: "CARD",
        expectedAmount: "80.00", actualAmount: "75.00", varianceAmount: "-5.00",
        reasonCodeId: tenderReasonId, submittedById: cashierId, submittedAt: new Date(),
        status: "SUBMITTED",
      },
    });

    const loaded = await db.tenderReconciliation.findUniqueOrThrow({
      where: { id: recon.id },
      include: { cafe: true, branch: true, shift: true, reasonCode: true, submittedBy: true },
    });
    assert.equal(loaded.reasonCode?.code, `${MARKER}-FEE`);
    assert.equal(loaded.reasonCode?.domain, "TENDER");
    assert.equal(loaded.shift.id, shiftId);
    assert.equal(loaded.submittedBy?.id, cashierId);

    const reason = await db.reasonCode.findUniqueOrThrow({
      where: { id: tenderReasonId },
      include: { tenderReconciliations: true },
    });
    assert.equal(
      reason.tenderReconciliations.length, 1,
      "the back-relation exists, so a reason code can be audited by what used it"
    );

    const shift = await db.shift.findUniqueOrThrow({
      where: { id: shiftId }, include: { tenderReconciliations: true },
    });
    assert.equal(shift.tenderReconciliations.length, 1, "and the shift reaches its channels");
  });

  test("deleting a reason code blanks the citation rather than the record", async () => {
    // SetNull, not Cascade. A settlement that happened is evidence; retiring
    // the vocabulary an owner once used must not delete the money it explained.
    await clearRecons();
    const doomed = await db.reasonCode.create({
      data: { cafeId, domain: "TENDER", code: `${MARKER}-TEMP`, label: "مؤقت" },
    });
    const recon = await db.tenderReconciliation.create({
      data: {
        cafeId, branchId, shiftId, method: "WALLET",
        expectedAmount: "40.00", reasonCodeId: doomed.id,
      },
    });

    await db.reasonCode.delete({ where: { id: doomed.id } });

    const after = await db.tenderReconciliation.findUniqueOrThrow({ where: { id: recon.id } });
    assert.equal(after.reasonCodeId, null, "the citation is blanked");
    assert.equal(Number(after.expectedAmount), 40, "the settlement survives intact");
  });
});
