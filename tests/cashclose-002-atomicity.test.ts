// T33 / CASHCLOSE-002 — no committed cash close without its evidence.
//
// The invariant, stated once:
//
//   NO COMMITTED CASH CLOSE WITH A NON-ZERO VARIANCE EXISTS WITHOUT ITS
//   VARIANCE CASE AND ITS AUDIT ROWS.
//
// The close path used to be three independent writes in a hopeful order: the
// shift was updated through `db` — committing the moment it returned — and
// only then were the audit rows written through `audit`, which swallows. A
// café whose AuditLog insert failed got a shift that had quietly gone CLOSED
// 300 EGP short with nothing recording who accepted the count or what the
// figures were.
//
// That is not a missing log line. The shift close is the moment a named
// custodian is discharged of the money they were holding, and the audit row
// plus the variance case ARE the record of that discharge. A close nobody can
// reconstruct is a shortage with its evidence deleted — and, once
// responsibility is assigned on the case, an accusation with its evidence
// deleted.
//
// So all of it becomes one act: the same transaction client freshens the
// aggregates, writes the close snapshot, opens the CASH variance case, links
// it, and writes both audit rows through `auditInTransaction`, which throws
// where `audit` swallows. Either everything lands or nothing does.
//
// The failure tests do not stub. They install Postgres triggers that raise on
// the specific INSERT under test, so the failure happens exactly where the
// question is interesting: after the close was validated, after the snapshot
// was written, and before commit. A stub throwing before the transaction
// opened would prove only that an exception propagates.
//
// VAR-008 asks this question of a variance case's status transition. This
// suite asks it of the act that CREATES the case.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { db, closeOpenShifts, teardownTaggedCafe } from "./helpers/db";
import { requireServer, as } from "./helpers/http";
import { countCafe, type CountCafe } from "./helpers/count";

let fx: CountCafe;

/**
 * A money suite, not a handover one: state the legacy policy explicitly
 * rather than inheriting the HYBRID default, which SH-16 makes a
 * handover-enabled configuration. See CASHCLOSE-001 for the full reasoning.
 */
async function useLegacyNoHandoverPolicy(...cafeIds: string[]) {
  for (const cafeId of cafeIds) {
    await db.cafeSettings.update({
      where: { cafeId },
      data: { stockCountPolicy: "NO_SHIFT_COUNT" },
    });
  }
}
before(async () => {
  await requireServer();
  fx = await countCafe("CC002");
  await useLegacyNoHandoverPolicy(fx.cafeId);
});

after(() =>
  teardownTaggedCafe(fx?.cafeId ? [fx.cafeId] : [], [() => unblockAll()], {
    disconnect: true,
  })
);

let seq = 0;

/** A shift expecting exactly 5,000 EGP: 4,000 float plus 1,000 collected. */
async function drawer(): Promise<{ shiftId: string; orderId: string }> {
  seq += 1;
  // One drawer per cashier: close the one the previous test left open
  // rather than deleting it, so its payments and evidence survive.
  await closeOpenShifts(fx.branchId, fx.cashier.id);
  const shift = await db.shift.create({
    data: {
      cafeId: fx.cafeId,
      branchId: fx.branchId,
      cashierId: fx.cashier.id,
      shiftNumber: 34000 + seq,
      openingCashAmount: 4000,
      expectedCashAmount: 4000,
    },
  });
  const order = await db.order.create({
    data: {
      cafeId: fx.cafeId,
      branchId: fx.branchId,
      orderNumber: 34000 + seq,
      type: "TAKEAWAY",
      status: "CONFIRMED",
      source: "CASHIER_POS",
      customerName: `${fx.marker}-atomic-${seq}`,
      subtotal: 1000,
      taxAmount: 0,
      discountAmount: 0,
      serviceChargeAmount: 0,
      total: 1000,
      remainingAmount: 0,
      paymentStatus: "PAID",
      createdById: fx.cashier.id,
    },
  });
  await db.payment.create({
    data: {
      cafeId: fx.cafeId,
      branchId: fx.branchId,
      orderId: order.id,
      shiftId: shift.id,
      cashierId: fx.cashier.id,
      receivedById: fx.cashier.id,
      amount: 1000,
      method: "CASH",
      type: "COLLECTION",
      status: "PAID",
    },
  });
  const { recomputeShiftTotals } = await import("@/lib/shifts");
  const fresh = await recomputeShiftTotals(shift.id);
  assert.equal(Number(fresh!.expectedCashAmount), 5000);
  return { shiftId: shift.id, orderId: order.id };
}

const close = (email: string, shiftId: string, body: Record<string, unknown>) =>
  as<{ shift?: Record<string, unknown>; error?: string }>(
    email,
    `/api/shifts/${shiftId}/close`,
    { method: "POST", body: JSON.stringify(body) }
  );

const shiftRow = (id: string) => db.shift.findUniqueOrThrow({ where: { id } });

const cashCases = (shiftId: string) =>
  db.varianceCase.findMany({ where: { shiftId, type: "CASH" } });

const shiftAudits = (shiftId: string) =>
  db.auditLog.findMany({ where: { entity: "Shift", entityId: shiftId } });

/** Everything a rolled-back close must have left exactly as it found it. */
async function openState(shiftId: string) {
  const s = await shiftRow(shiftId);
  return {
    status: s.status,
    actual: s.actualCashAmount,
    difference: s.cashDifference,
    reason: s.cashReasonNote,
    closedAt: s.closedAt,
    closedById: s.closedById,
    caseId: s.cashVarianceCaseId,
    cases: (await cashCases(shiftId)).length,
    audits: (await shiftAudits(shiftId)).length,
  };
}

// ──────────────────────── fault injection ────────────────────────
//
// One trigger per table, each keyed on the specific row the test cares
// about, so an unrelated write in the same run is never collateral.

async function blockShiftAuditFor(shiftId: string) {
  await db.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION ph1_block_cash_close_audit() RETURNS trigger AS $fn$
    BEGIN
      IF NEW."entity" = 'Shift' AND NEW."entityId" = '${shiftId}' THEN
        RAISE EXCEPTION 'shift close audit insert blocked by CASHCLOSE-002';
      END IF;
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;
  `);
  // One command per call: Postgres refuses multiple statements in a prepared
  // statement, which is what `$executeRawUnsafe` sends.
  await db.$executeRawUnsafe(
    `DROP TRIGGER IF EXISTS ph1_block_cash_close_audit_trg ON "AuditLog"`
  );
  await db.$executeRawUnsafe(`
    CREATE TRIGGER ph1_block_cash_close_audit_trg
      BEFORE INSERT ON "AuditLog"
      FOR EACH ROW EXECUTE FUNCTION ph1_block_cash_close_audit()
  `);
}

async function blockVarianceCaseFor(shiftId: string) {
  await db.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION ph1_block_cash_variance_case() RETURNS trigger AS $fn$
    BEGIN
      IF NEW."shiftId" = '${shiftId}' AND NEW."type" = 'CASH' THEN
        RAISE EXCEPTION 'cash variance case insert blocked by CASHCLOSE-002';
      END IF;
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;
  `);
  await db.$executeRawUnsafe(
    `DROP TRIGGER IF EXISTS ph1_block_cash_variance_case_trg ON "VarianceCase"`
  );
  await db.$executeRawUnsafe(`
    CREATE TRIGGER ph1_block_cash_variance_case_trg
      BEFORE INSERT ON "VarianceCase"
      FOR EACH ROW EXECUTE FUNCTION ph1_block_cash_variance_case()
  `);
}

async function unblockAll() {
  await db.$executeRawUnsafe(
    `DROP TRIGGER IF EXISTS ph1_block_cash_close_audit_trg ON "AuditLog"`
  );
  await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ph1_block_cash_close_audit()`);
  await db.$executeRawUnsafe(
    `DROP TRIGGER IF EXISTS ph1_block_cash_variance_case_trg ON "VarianceCase"`
  );
  await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ph1_block_cash_variance_case()`);
}

describe("CASHCLOSE-002 — the close and its evidence commit together", () => {
  test("the happy path writes the snapshot, the case and both audit rows", async () => {
    const d = await drawer();
    const r = await close(fx.cashier.email, d.shiftId, {
      actualCashAmount: 4970,
      reason: "عجز",
    });

    assert.equal(r.status, 200, r.text);
    const row = await shiftRow(d.shiftId);
    assert.equal(row.status, "CLOSED");
    assert.equal((await cashCases(d.shiftId)).length, 1);
    assert.equal(
      (await shiftAudits(d.shiftId)).length,
      2,
      "SHIFT_CLOSED and CASH_DIFFERENCE_DETECTED, exactly once each"
    );
  });

  test("a failing audit insert rolls the whole close back", async () => {
    const d = await drawer();
    const before = await openState(d.shiftId);
    assert.equal(before.status, "OPEN");

    await blockShiftAuditFor(d.shiftId);
    try {
      const r = await close(fx.cashier.email, d.shiftId, {
        actualCashAmount: 4970,
        reason: "عجز",
      });
      assert.notEqual(r.status, 200, "a rolled-back close must never answer 200");
    } finally {
      await unblockAll();
    }

    assert.deepEqual(
      await openState(d.shiftId),
      before,
      "the shift is exactly as it was: still open, uncounted, with no case and no audit"
    );
  });

  test("a failing variance-case insert rolls the whole close back", async () => {
    const d = await drawer();
    const before = await openState(d.shiftId);

    await blockVarianceCaseFor(d.shiftId);
    try {
      const r = await close(fx.cashier.email, d.shiftId, {
        actualCashAmount: 4970,
        reason: "عجز",
      });
      assert.notEqual(r.status, 200, "a rolled-back close must never answer 200");
    } finally {
      await unblockAll();
    }

    const after = await openState(d.shiftId);
    assert.deepEqual(after, before);
    assert.equal(
      after.status,
      "OPEN",
      "a close that could not record its variance is not a close that happened"
    );
    assert.equal(after.audits, 0, "and it left no audit claiming otherwise");
  });

  test("a zero-variance close is unaffected by the variance-case trigger", async () => {
    // The control: the case insert only happens when there is a difference,
    // so blocking it must not make an exact close fail. Without this, the
    // test above would pass just as well against a close that opened a case
    // unconditionally.
    const d = await drawer();
    await blockVarianceCaseFor(d.shiftId);
    try {
      const r = await close(fx.cashier.email, d.shiftId, { actualCashAmount: 5000 });
      assert.equal(r.status, 200, r.text);
    } finally {
      await unblockAll();
    }
    assert.equal((await shiftRow(d.shiftId)).status, "CLOSED");
    assert.deepEqual(await cashCases(d.shiftId), []);
  });

  test("the shift is still closable once the fault clears", async () => {
    const d = await drawer();

    await blockShiftAuditFor(d.shiftId);
    try {
      await close(fx.cashier.email, d.shiftId, { actualCashAmount: 4970, reason: "عجز" });
    } finally {
      await unblockAll();
    }
    assert.equal((await shiftRow(d.shiftId)).status, "OPEN");

    const retry = await close(fx.cashier.email, d.shiftId, {
      actualCashAmount: 4970,
      reason: "عجز",
    });
    assert.equal(retry.status, 200, retry.text);

    const row = await shiftRow(d.shiftId);
    assert.equal(row.status, "CLOSED");
    assert.equal(Number(row.cashDifference), -30);
    assert.equal(
      (await cashCases(d.shiftId)).length,
      1,
      "the rolled-back attempt left nothing for the retry to duplicate"
    );
    assert.equal((await shiftAudits(d.shiftId)).length, 2);
  });

  test("a repeated close duplicates neither the case nor the audit", async () => {
    const d = await drawer();
    assert.equal(
      (await close(fx.cashier.email, d.shiftId, { actualCashAmount: 4970, reason: "عجز" }))
        .status,
      200
    );

    for (const attempt of [
      { actualCashAmount: 4970, reason: "عجز" },
      { actualCashAmount: 100, reason: "محاولة تانية" },
      { actualCashAmount: 5000 },
    ]) {
      const again = await close(fx.cashier.email, d.shiftId, attempt);
      assert.equal(again.status, 400, again.text);
    }

    const row = await shiftRow(d.shiftId);
    assert.equal(Number(row.actualCashAmount), 4970, "the first close still governs");
    assert.equal(Number(row.cashDifference), -30);
    assert.equal(row.cashReasonNote, "عجز");
    assert.equal((await cashCases(d.shiftId)).length, 1);
    assert.equal((await shiftAudits(d.shiftId)).length, 2);
  });

  test("two simultaneous closes produce exactly one committed close", async () => {
    const d = await drawer();

    // Different counts on purpose: if both landed, the surviving snapshot
    // would be whichever write happened to be last, and the shift would carry
    // a figure nobody can attribute to a decision.
    const [a, b] = await Promise.all([
      close(fx.cashier.email, d.shiftId, { actualCashAmount: 4970, reason: "عجز" }),
      close(fx.manager.email, d.shiftId, { actualCashAmount: 5030, reason: "زيادة" }),
    ]);

    const winners = [a, b].filter((r) => r.status === 200);
    assert.equal(winners.length, 1, `exactly one close may commit: ${a.status}/${b.status}`);
    const loser = [a, b].find((r) => r.status !== 200)!;
    assert.notEqual(loser.status, 500, `the loser must fail cleanly, not crash: ${loser.text}`);

    const row = await shiftRow(d.shiftId);
    assert.equal(row.status, "CLOSED");
    const actual = Number(row.actualCashAmount);
    assert.ok(actual === 4970 || actual === 5030, "the stored count is one of the two, whole");
    assert.equal(
      Number(row.cashDifference),
      actual === 4970 ? -30 : 30,
      "and the stored variance agrees with the stored count"
    );

    const cases = await cashCases(d.shiftId);
    assert.equal(cases.length, 1, "one close, one case — never two");
    assert.equal(Number(cases[0].amountVariance), Number(row.cashDifference));
    assert.equal(row.cashVarianceCaseId, cases[0].id);

    const audits = await shiftAudits(d.shiftId);
    assert.equal(audits.length, 2, "and one pair of audit rows, not two");
  });

  test("many simultaneous closes still produce exactly one", async () => {
    const d = await drawer();
    const results = await Promise.all(
      [4970, 4980, 4990, 5010, 5020].map((amount) =>
        close(fx.cashier.email, d.shiftId, { actualCashAmount: amount, reason: `عد ${amount}` })
      )
    );

    assert.equal(results.filter((r) => r.status === 200).length, 1, "one winner");
    assert.equal((await cashCases(d.shiftId)).length, 1);
    assert.equal((await shiftAudits(d.shiftId)).length, 2);
    assert.equal((await shiftRow(d.shiftId)).status, "CLOSED");
  });

  test("a refused close writes no audit at all", async () => {
    // A reason that is missing is caught before the transaction opens, so
    // there is nothing to roll back — asserted so the guard cannot later be
    // moved inside and start leaving half-written evidence behind.
    const d = await drawer();
    const r = await close(fx.cashier.email, d.shiftId, { actualCashAmount: 4970 });

    assert.equal(r.status, 400, r.text);
    assert.deepEqual(await shiftAudits(d.shiftId), []);
    assert.deepEqual(await cashCases(d.shiftId), []);
  });
});
