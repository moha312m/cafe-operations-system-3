// T34 / TENDER-002 — no committed financial close without ALL its evidence.
//
// The invariant, stated once and extended from T33:
//
//   A SHIFT IS CLOSED ONLY IF THE CASH SNAPSHOT, EVERY REQUIRED TENDER
//   SETTLEMENT, EVERY VARIANCE CASE THOSE RAISED, AND EVERY AUDIT ROW
//   RECORDING THEM COMMITTED TOGETHER.
//
// T33 made that true of cash. The failure T34 must not reintroduce is a shift
// that goes CLOSED with its drawer reconciled and its card settlement missing
// — which would be strictly worse than not reconciling card at all, because
// the close would assert that the whole shift was settled. Partial
// reconciliation is the one outcome that must be unreachable.
//
// So the tender writes join the transaction the cash close already runs in.
// The tests below prove it by failing each write in turn and asserting that
// the SHIFT is still OPEN afterwards — including the writes that have nothing
// to do with cash. A card audit that cannot be written must leave the drawer
// unclosed.
//
// The failure tests do not stub. They install Postgres triggers that raise on
// the specific INSERT under test, so the failure happens where the question is
// interesting: after validation, after the snapshot, and before commit. A stub
// throwing before the transaction opened would prove only that an exception
// propagates.
//
// CONCURRENCY. Two people pressing Close at the same instant must produce ONE
// committed close — and therefore one card settlement, one wallet settlement
// and one case each. The row lock and the status-guarded UPDATE that T33 built
// are what makes the loser's write affect zero rows; the tender rows are
// written after that guard, inside the same transaction, so the loser never
// reaches them. `@@unique([shiftId, method])` is the database's own backstop.

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
  fx = await countCafe("TS002");
  await useLegacyNoHandoverPolicy(fx.cafeId);
});

after(() =>
  teardownTaggedCafe(fx?.cafeId ? [fx.cafeId] : [], [() => unblockAll()], {
    disconnect: true,
  })
);

let seq = 0;

/** 5,000 expected in the drawer, 3,200 on card, 1,500 on wallet. */
async function till(): Promise<{ shiftId: string; orderId: string }> {
  seq += 1;
  // One drawer per cashier: close the one the previous test left open
  // rather than deleting it, so its payments and evidence survive.
  await closeOpenShifts(fx.branchId, fx.cashier.id);
  const shift = await db.shift.create({
    data: {
      cafeId: fx.cafeId,
      branchId: fx.branchId,
      cashierId: fx.cashier.id,
      shiftNumber: 36000 + seq,
      openingCashAmount: 4000,
      expectedCashAmount: 4000,
    },
  });
  const order = await db.order.create({
    data: {
      cafeId: fx.cafeId,
      branchId: fx.branchId,
      orderNumber: 36000 + seq,
      type: "TAKEAWAY",
      status: "CONFIRMED",
      source: "CASHIER_POS",
      customerName: `${fx.marker}-atomic-${seq}`,
      subtotal: 5700,
      taxAmount: 0,
      discountAmount: 0,
      serviceChargeAmount: 0,
      total: 5700,
      remainingAmount: 0,
      paymentStatus: "PAID",
      createdById: fx.cashier.id,
    },
  });
  for (const [amount, method] of [
    [1000, "CASH"],
    [3200, "CARD"],
    [1500, "WALLET"],
  ] as const) {
    await db.payment.create({
      data: {
        cafeId: fx.cafeId,
        branchId: fx.branchId,
        orderId: order.id,
        shiftId: shift.id,
        cashierId: fx.cashier.id,
        receivedById: fx.cashier.id,
        amount,
        method,
        type: "COLLECTION",
        status: "PAID",
      },
    });
  }
  const { recomputeShiftTotals } = await import("@/lib/shifts");
  const fresh = await recomputeShiftTotals(shift.id);
  assert.equal(Number(fresh!.expectedCashAmount), 5000);
  assert.equal(Number(fresh!.totalCardSales), 3200);
  assert.equal(Number(fresh!.totalWalletSales), 1500);
  return { shiftId: shift.id, orderId: order.id };
}

const close = (email: string, shiftId: string, body: Record<string, unknown>) =>
  as<{ shift?: Record<string, unknown>; error?: string }>(
    email,
    `/api/shifts/${shiftId}/close`,
    { method: "POST", body: JSON.stringify(body) }
  );

/** Exact on cash and wallet; card is what the tests vary. */
const settle = (over: Record<string, unknown> = {}) => ({
  actualCashAmount: 5000,
  actualCardAmount: 3200,
  actualWalletAmount: 1500,
  ...over,
});

const cardShort = settle({ actualCardAmount: 3180, cardReason: "عملية مرفوضة" });
const walletOver = settle({ actualWalletAmount: 1530, walletReason: "استرداد" });

const shiftRow = (id: string) => db.shift.findUniqueOrThrow({ where: { id } });

const recons = (shiftId: string) =>
  db.tenderReconciliation.findMany({ where: { shiftId }, orderBy: { method: "asc" } });

const allCases = (shiftId: string) => db.varianceCase.findMany({ where: { shiftId } });

/** Every audit row this close could have produced, on any entity. */
async function auditCount(shiftId: string): Promise<number> {
  const ids = (await recons(shiftId)).map((r) => r.id);
  const onShift = await db.auditLog.count({ where: { entity: "Shift", entityId: shiftId } });
  const onTender = ids.length
    ? await db.auditLog.count({
        where: { entity: "TenderReconciliation", entityId: { in: ids } },
      })
    : 0;
  return onShift + onTender;
}

/** Everything a rolled-back close must have left exactly as it found it. */
async function openState(shiftId: string) {
  const s = await shiftRow(shiftId);
  return {
    status: s.status,
    actualCash: s.actualCashAmount,
    cashDifference: s.cashDifference,
    cashReason: s.cashReasonNote,
    closedAt: s.closedAt,
    closedById: s.closedById,
    cashCaseId: s.cashVarianceCaseId,
    settlements: (await recons(shiftId)).length,
    cases: (await allCases(shiftId)).length,
    audits: await auditCount(shiftId),
  };
}

// ──────────────────────── fault injection ────────────────────────
//
// One trigger per table, each keyed on the specific row the test cares about,
// so an unrelated write in the same run is never collateral.

async function blockTenderAuditFor(shiftId: string) {
  // Keyed by the shift the settlement belongs to rather than by the audit's
  // own entityId, which is the settlement id and is not known until the
  // transaction that this trigger is about to abort has created it.
  await db.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION ph1_block_tender_audit() RETURNS trigger AS $fn$
    BEGIN
      IF NEW."entity" = 'TenderReconciliation'
         AND NEW."details"::jsonb ->> 'shiftId' = '${shiftId}' THEN
        RAISE EXCEPTION 'tender difference audit blocked by TENDER-002';
      END IF;
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;
  `);
  await db.$executeRawUnsafe(
    `DROP TRIGGER IF EXISTS ph1_block_tender_audit_trg ON "AuditLog"`
  );
  await db.$executeRawUnsafe(`
    CREATE TRIGGER ph1_block_tender_audit_trg
      BEFORE INSERT ON "AuditLog"
      FOR EACH ROW EXECUTE FUNCTION ph1_block_tender_audit()
  `);
}

async function blockTenderCaseFor(shiftId: string) {
  await db.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION ph1_block_tender_case() RETURNS trigger AS $fn$
    BEGIN
      IF NEW."shiftId" = '${shiftId}' AND NEW."type" = 'TENDER' THEN
        RAISE EXCEPTION 'tender variance case insert blocked by TENDER-002';
      END IF;
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;
  `);
  await db.$executeRawUnsafe(
    `DROP TRIGGER IF EXISTS ph1_block_tender_case_trg ON "VarianceCase"`
  );
  await db.$executeRawUnsafe(`
    CREATE TRIGGER ph1_block_tender_case_trg
      BEFORE INSERT ON "VarianceCase"
      FOR EACH ROW EXECUTE FUNCTION ph1_block_tender_case()
  `);
}

/** Refuse the settlement row itself, for one method. */
async function blockSettlementFor(shiftId: string, method: "CARD" | "WALLET") {
  await db.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION ph1_block_settlement() RETURNS trigger AS $fn$
    BEGIN
      IF NEW."shiftId" = '${shiftId}' AND NEW."method" = '${method}' THEN
        RAISE EXCEPTION 'tender settlement insert blocked by TENDER-002';
      END IF;
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;
  `);
  await db.$executeRawUnsafe(
    `DROP TRIGGER IF EXISTS ph1_block_settlement_trg ON "TenderReconciliation"`
  );
  await db.$executeRawUnsafe(`
    CREATE TRIGGER ph1_block_settlement_trg
      BEFORE INSERT ON "TenderReconciliation"
      FOR EACH ROW EXECUTE FUNCTION ph1_block_settlement()
  `);
}

async function unblockAll() {
  for (const [trg, table, fn] of [
    ["ph1_block_tender_audit_trg", "AuditLog", "ph1_block_tender_audit"],
    ["ph1_block_tender_case_trg", "VarianceCase", "ph1_block_tender_case"],
    ["ph1_block_settlement_trg", "TenderReconciliation", "ph1_block_settlement"],
  ] as const) {
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${trg} ON "${table}"`);
    await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${fn}()`);
  }
}

describe("TENDER-002 — the close and every tender's evidence commit together", () => {
  test("the happy path writes the snapshot, both settlements, the cases and the audits", async () => {
    const t = await till();
    const r = await close(fx.cashier.email, t.shiftId, {
      ...cardShort,
      actualWalletAmount: 1530,
      walletReason: "استرداد",
    });

    assert.equal(r.status, 200, r.text);
    const row = await shiftRow(t.shiftId);
    assert.equal(row.status, "CLOSED");

    const rows = await recons(t.shiftId);
    assert.equal(rows.length, 2, "one settlement per active channel");
    assert.equal((await allCases(t.shiftId)).length, 2, "and one case per difference");
    assert.equal(
      await auditCount(t.shiftId),
      3,
      "SHIFT_CLOSED plus one difference event per non-zero tender"
    );
  });

  // ─────────────────────── rollback on every write ──────────────────────

  test("a failing card settlement insert rolls the whole close back", async () => {
    const t = await till();
    const before = await openState(t.shiftId);
    assert.equal(before.status, "OPEN");

    await blockSettlementFor(t.shiftId, "CARD");
    try {
      const r = await close(fx.cashier.email, t.shiftId, settle());
      assert.notEqual(r.status, 200, "a rolled-back close must never answer 200");
    } finally {
      await unblockAll();
    }

    assert.deepEqual(await openState(t.shiftId), before);
  });

  test("a failing wallet settlement insert rolls the whole close back", async () => {
    const t = await till();
    const before = await openState(t.shiftId);

    await blockSettlementFor(t.shiftId, "WALLET");
    try {
      const r = await close(fx.cashier.email, t.shiftId, settle());
      assert.notEqual(r.status, 200);
    } finally {
      await unblockAll();
    }

    const after = await openState(t.shiftId);
    assert.deepEqual(after, before);
    assert.equal(
      after.settlements,
      0,
      "the card settlement that HAD been written went back with it — no partial reconciliation"
    );
  });

  test("a failing card variance-case insert leaves the shift OPEN", async () => {
    const t = await till();
    const before = await openState(t.shiftId);

    await blockTenderCaseFor(t.shiftId);
    try {
      const r = await close(fx.cashier.email, t.shiftId, cardShort);
      assert.notEqual(r.status, 200);
    } finally {
      await unblockAll();
    }

    const after = await openState(t.shiftId);
    assert.deepEqual(after, before);
    assert.equal(
      after.status,
      "OPEN",
      "a close that could not record its card variance is not a close that happened"
    );
  });

  test("a failing wallet variance-case insert leaves the shift OPEN", async () => {
    const t = await till();
    const before = await openState(t.shiftId);

    await blockTenderCaseFor(t.shiftId);
    try {
      const r = await close(fx.cashier.email, t.shiftId, walletOver);
      assert.notEqual(r.status, 200);
    } finally {
      await unblockAll();
    }

    assert.deepEqual(await openState(t.shiftId), before);
  });

  test("a failing tender audit rolls back the CASH close too", async () => {
    // The assertion T34 exists for. The drawer was counted, balanced and
    // written; the card difference could not be announced; and the shift must
    // NOT be left closed claiming the shift was settled.
    const t = await till();
    const before = await openState(t.shiftId);

    await blockTenderAuditFor(t.shiftId);
    try {
      const r = await close(fx.cashier.email, t.shiftId, cardShort);
      assert.notEqual(r.status, 200);
    } finally {
      await unblockAll();
    }

    const after = await openState(t.shiftId);
    assert.deepEqual(after, before);
    assert.equal(after.status, "OPEN");
    assert.equal(after.actualCash, null, "the counted drawer went back with it");
    assert.equal(after.audits, 0, "and left no audit claiming otherwise");
  });

  test("a wallet audit failure rolls back a card settlement that had succeeded", async () => {
    const t = await till();
    const before = await openState(t.shiftId);

    await blockTenderAuditFor(t.shiftId);
    try {
      const r = await close(fx.cashier.email, t.shiftId, {
        ...cardShort,
        actualWalletAmount: 1530,
        walletReason: "استرداد",
      });
      assert.notEqual(r.status, 200);
    } finally {
      await unblockAll();
    }

    const after = await openState(t.shiftId);
    assert.deepEqual(after, before);
    assert.equal(after.settlements, 0, "tenders are never partially reconciled");
    assert.equal(after.cases, 0);
  });

  test("an exact settlement is unaffected by the case and audit triggers", async () => {
    // The control. Without it, the tests above would pass just as well
    // against a close that opened a case for every tender unconditionally.
    const t = await till();
    await blockTenderCaseFor(t.shiftId);
    await blockTenderAuditFor(t.shiftId);
    try {
      const r = await close(fx.cashier.email, t.shiftId, settle());
      assert.equal(r.status, 200, r.text);
    } finally {
      await unblockAll();
    }

    assert.equal((await shiftRow(t.shiftId)).status, "CLOSED");
    assert.equal((await recons(t.shiftId)).length, 2);
    assert.deepEqual(await allCases(t.shiftId), []);
  });

  test("the shift is still closable once the fault clears, exactly once", async () => {
    const t = await till();

    await blockTenderCaseFor(t.shiftId);
    try {
      await close(fx.cashier.email, t.shiftId, cardShort);
    } finally {
      await unblockAll();
    }
    assert.equal((await shiftRow(t.shiftId)).status, "OPEN");

    const retry = await close(fx.cashier.email, t.shiftId, cardShort);
    assert.equal(retry.status, 200, retry.text);

    const rows = await recons(t.shiftId);
    assert.equal(rows.length, 2, "the rolled-back attempt left nothing to collide with");
    assert.equal(Number(rows.find((r) => r.method === "CARD")!.varianceAmount), -20);
    assert.equal((await allCases(t.shiftId)).length, 1);
    assert.equal(await auditCount(t.shiftId), 2);
  });

  test("a refused close writes no settlement and no audit at all", async () => {
    // A missing reason is caught before the transaction opens, so there is
    // nothing to roll back — asserted so the guard cannot later be moved
    // inside and start leaving half-written evidence behind.
    const t = await till();
    const r = await close(fx.cashier.email, t.shiftId, settle({ actualCardAmount: 3180 }));

    assert.equal(r.status, 400, r.text);
    assert.deepEqual(await recons(t.shiftId), []);
    assert.deepEqual(await allCases(t.shiftId), []);
    assert.equal(await auditCount(t.shiftId), 0);
  });

  // ──────────────────────────── concurrency ─────────────────────────────

  test("a repeated close duplicates neither a settlement nor a case", async () => {
    const t = await till();
    assert.equal((await close(fx.cashier.email, t.shiftId, cardShort)).status, 200);

    for (const attempt of [
      cardShort,
      settle({ actualCardAmount: 100, cardReason: "محاولة تانية" }),
      settle(),
    ]) {
      const again = await close(fx.cashier.email, t.shiftId, attempt);
      assert.equal(again.status, 400, again.text);
    }

    const rows = await recons(t.shiftId);
    assert.equal(rows.length, 2, "still one settlement per channel");
    assert.equal(
      Number(rows.find((r) => r.method === "CARD")!.actualAmount),
      3180,
      "the first settlement still governs"
    );
    assert.equal((await allCases(t.shiftId)).length, 1);
    assert.equal(await auditCount(t.shiftId), 2);
  });

  test("two simultaneous closes produce exactly one settled shift", async () => {
    const t = await till();

    // Different settlements on purpose: if both landed, the surviving figures
    // would be whichever write happened to be last.
    const [a, b] = await Promise.all([
      close(fx.cashier.email, t.shiftId, cardShort),
      close(
        fx.manager.email,
        t.shiftId,
        settle({ actualCardAmount: 3230, cardReason: "زيادة" })
      ),
    ]);

    const winners = [a, b].filter((r) => r.status === 200);
    assert.equal(winners.length, 1, `exactly one close may commit: ${a.status}/${b.status}`);
    const loser = [a, b].find((r) => r.status !== 200)!;
    assert.notEqual(loser.status, 500, `the loser must fail cleanly: ${loser.text}`);

    const rows = await recons(t.shiftId);
    assert.equal(rows.length, 2, "one card settlement and one wallet settlement — never two");

    const card = rows.find((r) => r.method === "CARD")!;
    const actual = Number(card.actualAmount);
    assert.ok(actual === 3180 || actual === 3230, "the stored settlement is one of the two, whole");
    assert.equal(
      Number(card.varianceAmount),
      actual === 3180 ? -20 : 30,
      "and the stored variance agrees with the stored settlement"
    );

    const cases = await allCases(t.shiftId);
    assert.equal(cases.length, 1, "one difference, one case");
    assert.equal(cases[0].tenderReconciliationId, card.id);
    assert.equal(await auditCount(t.shiftId), 2);
  });

  test("many simultaneous closes still produce exactly one of everything", async () => {
    const t = await till();
    const results = await Promise.all(
      [3180, 3190, 3210, 3220, 3230].map((amount) =>
        close(
          fx.cashier.email,
          t.shiftId,
          settle({ actualCardAmount: amount, cardReason: `تسوية ${amount}` })
        )
      )
    );

    assert.equal(results.filter((r) => r.status === 200).length, 1, "one winner");
    assert.equal((await recons(t.shiftId)).length, 2);
    assert.equal((await allCases(t.shiftId)).length, 1);
    assert.equal(await auditCount(t.shiftId), 2);
    assert.equal((await shiftRow(t.shiftId)).status, "CLOSED");
  });

  test("simultaneous closes with differences on both channels stay consistent", async () => {
    const t = await till();
    const results = await Promise.all([
      close(fx.cashier.email, t.shiftId, {
        ...cardShort,
        actualWalletAmount: 1530,
        walletReason: "استرداد",
      }),
      close(fx.manager.email, t.shiftId, {
        ...settle({ actualCardAmount: 3230, cardReason: "زيادة" }),
        actualWalletAmount: 1470,
        walletReason: "معلقة",
      }),
    ]);

    assert.equal(results.filter((r) => r.status === 200).length, 1);

    const rows = await recons(t.shiftId);
    assert.equal(rows.length, 2);
    const cases = await allCases(t.shiftId);
    assert.equal(cases.length, 2, "two channels differed, two cases — from ONE close");

    // Both settlements must come from the SAME winning attempt: a card figure
    // from one request beside a wallet figure from the other would be a close
    // nobody performed.
    const card = Number(rows.find((r) => r.method === "CARD")!.actualAmount);
    const wallet = Number(rows.find((r) => r.method === "WALLET")!.actualAmount);
    assert.ok(
      (card === 3180 && wallet === 1530) || (card === 3230 && wallet === 1470),
      `the two settlements must come from one close, got card=${card} wallet=${wallet}`
    );
  });
});
