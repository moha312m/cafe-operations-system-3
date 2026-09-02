// T33 / CASHCLOSE-001 — the drawer count becomes a fact, with a reason.
//
// The close path already computed `actual - expected` and stored it. What it
// did not do is treat a non-zero result as something that has to be
// EXPLAINED, or as something the variance architecture should know about.
// A shift could close 300 EGP short with `notes` left blank, and the only
// trace was an audit line nobody was required to write a sentence into.
//
// So this suite states the accounting rule the owner asked for, and nothing
// beyond it:
//
//   cashVariance = ACTUAL CASH COUNTED − EXPECTED CASH
//
//   negative = shortage, positive = overage, zero = exact.
//
// A reason is REQUIRED when the variance is non-zero, and MUST NOT be
// required when it is zero — there is no "No variance" placeholder to invent.
// The amount never blocks the close: a 5,000 EGP shortage closes just as a
// 30 EGP one does, because the ERP's job here is to record what happened, not
// to decide whether it was acceptable.
//
// THERE IS NO TOLERANCE ON THIS PATH, and the assertions say so directly.
// `Shift.cashWithinTolerance` and `Shift.cashToleranceAmount` exist from T16
// and stay NULL: a close that wrote a verdict into them would be the ERP
// classifying a difference as acceptable, which is the café owner's decision
// to make in their own books, not this system's. `resolveCashTolerance`
// remains a resolver that nothing on the close path calls.
//
// EXPECTED CASH IS NOT RECOMPUTED HERE. It comes from
// `recomputeShiftTotals` — opening cash plus net cash movements — which is
// the repository's one authoritative answer. A second formula written into
// the close route would be a second opinion with nothing saying which to
// believe. Card and wallet are collected in the same fixture precisely so
// their absence from the cash figure is asserted rather than assumed.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { requireServer, as } from "./helpers/http";
import { countCafe, type CountCafe } from "./helpers/count";

let fx: CountCafe;
let other: CountCafe;

/**
 * This suite is about MONEY, not about handovers.
 *
 * `countCafe` creates a café with the schema default policy, which is
 * HYBRID — a handover-ENABLED configuration. Under SH-16 that is a real
 * setting with real consequences: such a close must state where the stock
 * is going and the closer must hold the handover capability, so every close
 * below would be refused for reasons this suite is not about.
 *
 * Before SH-16 the distinction did not exist and these tests inherited
 * whatever the default happened to be. Declaring `NO_SHIFT_COUNT` states
 * the configuration they always meant: a café that settles its drawer and
 * closes, with no stock handover in the picture. Nothing about the cash,
 * card or wallet assertions changes — they are simply no longer resting on
 * an accident.
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
  fx = await countCafe("CC001");
  other = await countCafe("CC001X");
  await useLegacyNoHandoverPolicy(fx.cafeId, other.cafeId);
});

after(() =>
  teardownTaggedCafe([fx?.cafeId, other?.cafeId].filter(Boolean) as string[], [], {
    disconnect: true,
  })
);

let seq = 0;

type Drawer = {
  shiftId: string;
  expected: number;
  orderId: string;
};

/**
 * A shift whose expected cash is 5,000 EGP, built the way the ledger builds
 * it: a 4,000 opening float plus 1,000 collected in cash.
 *
 * 700 on card and 300 on wallet are collected onto the SAME shift and must
 * not move the cash figure by a piastre. That is the point of putting them
 * here — the drawer only ever holds cash, and a close that reached for
 * `totalSales` would fail loudly rather than silently report a 1,000 EGP
 * overage.
 */
async function drawer(
  opts: { cafe?: CountCafe; branchId?: string; cashierId?: string } = {}
): Promise<Drawer> {
  const owner = opts.cafe ?? fx;
  const branchId = opts.branchId ?? owner.branchId;
  const cashierId = opts.cashierId ?? owner.cashier.id;
  seq += 1;

  const shift = await db.shift.create({
    data: {
      cafeId: owner.cafeId,
      branchId,
      cashierId,
      shiftNumber: 33000 + seq,
      openingCashAmount: 4000,
      expectedCashAmount: 4000,
    },
  });

  const order = await db.order.create({
    data: {
      cafeId: owner.cafeId,
      branchId,
      orderNumber: 33000 + seq,
      type: "TAKEAWAY",
      status: "CONFIRMED",
      source: "CASHIER_POS",
      customerName: `${owner.marker}-drawer-${seq}`,
      subtotal: 2000,
      taxAmount: 0,
      discountAmount: 0,
      serviceChargeAmount: 0,
      total: 2000,
      remainingAmount: 0,
      paymentStatus: "PAID",
      createdById: cashierId,
    },
  });

  const pay = (amount: number, method: "CASH" | "CARD" | "WALLET") =>
    db.payment.create({
      data: {
        cafeId: owner.cafeId,
        branchId,
        orderId: order.id,
        shiftId: shift.id,
        cashierId,
        receivedById: cashierId,
        amount,
        method,
        type: "COLLECTION",
        status: "PAID",
      },
      select: { id: true },
    });

  await pay(1000, "CASH");
  await pay(700, "CARD");
  await pay(300, "WALLET");

  // Through the authoritative aggregate, never by writing the figure by hand.
  const { recomputeShiftTotals } = await import("@/lib/shifts");
  const fresh = await recomputeShiftTotals(shift.id);
  assert.equal(
    Number(fresh!.expectedCashAmount),
    5000,
    "the fixture must reach 5,000 through the repository's own cash formula"
  );

  return { shiftId: shift.id, expected: 5000, orderId: order.id };
}

type CloseBody = {
  shift?: Record<string, unknown>;
  error?: string;
};

/**
 * T34 adaptation, and the ONLY change this suite needed for it.
 *
 * The drawer above deliberately collects 700 on card and 300 on wallet, so
 * both processor channels are ACTIVE — and T34 will not mark a shift CLOSED
 * while a channel it took money on is unreconciled. Those two figures are
 * defaulted to their exact expected amounts so every assertion below is about
 * CASH and nothing else, exactly as it was before T34 existed.
 *
 * Nothing about the cash rules moved: not the arithmetic, not the reason
 * requirement, not the case, not the audit, not the absence of a tolerance.
 * The request simply now also states what the acquirer and the wallet
 * provider settled, which is the point of T34. A caller that wants a tender
 * difference overrides these; no test in this file does, because a tender
 * difference is TENDER-001's subject, not this suite's.
 */
const close = (email: string, shiftId: string, body: Record<string, unknown>) =>
  as<CloseBody>(email, `/api/shifts/${shiftId}/close`, {
    method: "POST",
    body: JSON.stringify({ actualCardAmount: 700, actualWalletAmount: 300, ...body }),
  });

const shiftRow = (id: string) => db.shift.findUniqueOrThrow({ where: { id } });

const cashCases = (shiftId: string) =>
  db.varianceCase.findMany({ where: { shiftId, type: "CASH" } });

const auditRows = (shiftId: string, action: string) =>
  db.auditLog.findMany({ where: { entity: "Shift", entityId: shiftId, action } });

describe("CASHCLOSE-001 — cash variance is recorded as a fact", () => {
  // ─────────────────────────── arithmetic ────────────────────────────

  test("exact cash: variance is zero and no reason is demanded", async () => {
    const d = await drawer();
    const r = await close(fx.cashier.email, d.shiftId, { actualCashAmount: 5000 });

    assert.equal(r.status, 200, r.text);
    const row = await shiftRow(d.shiftId);
    assert.equal(row.status, "CLOSED");
    assert.equal(Number(row.expectedCashAmount), 5000);
    assert.equal(Number(row.actualCashAmount), 5000);
    assert.equal(Number(row.cashDifference), 0);
    assert.equal(
      row.cashReasonNote,
      null,
      "an exact close invents no reason — there is no 'No variance' to store"
    );
  });

  test("shortage: 4,970 counted against 5,000 expected is −30", async () => {
    const d = await drawer();
    const r = await close(fx.cashier.email, d.shiftId, {
      actualCashAmount: 4970,
      reason: "عجز في الدرج",
    });

    assert.equal(r.status, 200, r.text);
    const row = await shiftRow(d.shiftId);
    assert.equal(Number(row.cashDifference), -30, "a shortage is negative");
    assert.equal(Number(row.expectedCashAmount), 5000);
    assert.equal(Number(row.actualCashAmount), 4970);
  });

  test("overage: 5,030 counted against 5,000 expected is +30", async () => {
    const d = await drawer();
    const r = await close(fx.cashier.email, d.shiftId, {
      actualCashAmount: 5030,
      reason: "زيادة في الدرج",
    });

    assert.equal(r.status, 200, r.text);
    const row = await shiftRow(d.shiftId);
    assert.equal(Number(row.cashDifference), 30, "an overage is positive");
  });

  test("a large variance still closes — size is not a verdict", async () => {
    // The rule the owner asked for: the ERP records the fact. Whether a
    // 5,000 EGP shortage is acceptable is decided outside this system.
    const d = await drawer();
    const r = await close(fx.cashier.email, d.shiftId, {
      actualCashAmount: 0,
      reason: "الدرج فاضي — بلاغ مقدم",
    });

    assert.equal(r.status, 200, r.text);
    const row = await shiftRow(d.shiftId);
    assert.equal(Number(row.cashDifference), -5000);
    assert.equal(row.status, "CLOSED", "amount alone never blocks a close");
  });

  // ───────────────────────────── the reason ──────────────────────────

  test("a shortage without a reason is refused, and the shift stays open", async () => {
    const d = await drawer();
    const r = await close(fx.cashier.email, d.shiftId, { actualCashAmount: 4970 });

    assert.equal(r.status, 400, r.text);
    const row = await shiftRow(d.shiftId);
    assert.equal(row.status, "OPEN", "a refused close commits nothing");
    assert.equal(row.actualCashAmount, null);
    assert.equal(row.cashDifference, null);
    assert.equal(row.closedAt, null);
    assert.deepEqual(await cashCases(d.shiftId), []);
  });

  test("an overage without a reason is refused too", async () => {
    const d = await drawer();
    const r = await close(fx.cashier.email, d.shiftId, { actualCashAmount: 5030 });

    assert.equal(r.status, 400, r.text);
    assert.equal((await shiftRow(d.shiftId)).status, "OPEN");
  });

  test("a whitespace-only reason is not a reason", async () => {
    const d = await drawer();
    const r = await close(fx.cashier.email, d.shiftId, {
      actualCashAmount: 4970,
      reason: "   \t\n  ",
    });

    assert.equal(r.status, 400, r.text);
    const row = await shiftRow(d.shiftId);
    assert.equal(row.status, "OPEN");
    assert.equal(row.cashReasonNote, null);
  });

  test("a non-zero variance with a real reason closes and stores the reason", async () => {
    const d = await drawer();
    const r = await close(fx.cashier.email, d.shiftId, {
      actualCashAmount: 4970,
      reason: "  فكة ناقصة من أول الشيفت  ",
    });

    assert.equal(r.status, 200, r.text);
    const row = await shiftRow(d.shiftId);
    assert.equal(
      row.cashReasonNote,
      "فكة ناقصة من أول الشيفت",
      "stored trimmed, the way every other required reason in this repo is"
    );
  });

  // ───────────────────────── the variance case ───────────────────────

  test("a zero variance opens no cash case — nothing happened to investigate", async () => {
    const d = await drawer();
    await close(fx.cashier.email, d.shiftId, { actualCashAmount: 5000 });

    assert.deepEqual(await cashCases(d.shiftId), []);
    assert.equal((await shiftRow(d.shiftId)).cashVarianceCaseId, null);
  });

  test("a non-zero variance opens exactly one CASH case, linked to the shift", async () => {
    const d = await drawer();
    const r = await close(fx.cashier.email, d.shiftId, {
      actualCashAmount: 4970,
      reason: "عجز",
    });
    assert.equal(r.status, 200, r.text);

    const cases = await cashCases(d.shiftId);
    assert.equal(cases.length, 1, "one close, one case");

    const row = await shiftRow(d.shiftId);
    assert.equal(
      row.cashVarianceCaseId,
      cases[0].id,
      "the shift points at the case it opened"
    );
  });

  test("the case carries the exact evidence, and no acceptability verdict", async () => {
    const d = await drawer();
    await close(fx.cashier.email, d.shiftId, {
      actualCashAmount: 4970,
      reason: "عجز في الوردية",
    });

    const [c] = await cashCases(d.shiftId);
    assert.ok(c, "a case was opened");
    assert.equal(c.type, "CASH");
    assert.equal(c.status, "OPEN");
    assert.equal(c.cafeId, fx.cafeId);
    assert.equal(c.branchId, fx.branchId);
    assert.equal(c.shiftId, d.shiftId);
    assert.equal(Number(c.amountVariance), -30, "the signed variance, not its magnitude");
    assert.equal(c.openedById, fx.cashier.id, "the actor who performed the close");
    assert.equal(
      c.financialImpactAvailable,
      true,
      "cash is money already — its impact is never unpriceable"
    );
    assert.equal(Number(c.financialImpact), 30);
    assert.ok(c.openedAt instanceof Date);

    // No source column: cash is sourced by its shift, which is the fourth arm
    // of the single-source CHECK.
    assert.equal(c.stockCountLineId, null);
    assert.equal(c.tenderReconciliationId, null);
    assert.equal(c.openingExceptionId, null);
  });

  test("an overage opens a case with a positive amount", async () => {
    const d = await drawer();
    await close(fx.cashier.email, d.shiftId, {
      actualCashAmount: 5030,
      reason: "زيادة",
    });

    const [c] = await cashCases(d.shiftId);
    assert.ok(c);
    assert.equal(
      Number(c.amountVariance),
      30,
      "an overage is as much a discrepancy as a shortage, and keeps its sign"
    );
  });

  // ───────────────────────── the close snapshot ──────────────────────

  test("the stored close does not move when money arrives afterwards", async () => {
    const d = await drawer();
    await close(fx.cashier.email, d.shiftId, {
      actualCashAmount: 4970,
      reason: "عجز",
    });

    const before = await shiftRow(d.shiftId);

    // Money posted to a settled period. SHIFT-002 already refuses to rewrite
    // a CLOSED shift; this asserts the T33 figures inherit that protection.
    await db.payment.create({
      data: {
        cafeId: fx.cafeId,
        branchId: fx.branchId,
        orderId: d.orderId,
        shiftId: d.shiftId,
        cashierId: fx.cashier.id,
        receivedById: fx.cashier.id,
        amount: 250,
        method: "CASH",
        type: "COLLECTION",
        status: "PAID",
      },
    });
    const { recomputeShiftTotals } = await import("@/lib/shifts");
    await recomputeShiftTotals(d.shiftId);

    const after = await shiftRow(d.shiftId);
    assert.equal(Number(after.expectedCashAmount), Number(before.expectedCashAmount));
    assert.equal(Number(after.actualCashAmount), 4970);
    assert.equal(Number(after.cashDifference), -30);
    assert.equal(after.cashReasonNote, before.cashReasonNote);
  });

  test("closing never edits sales or payments to make the variance disappear", async () => {
    const d = await drawer();
    const snap = async () =>
      (
        await db.payment.findMany({
          where: { shiftId: d.shiftId },
          orderBy: { createdAt: "asc" },
          select: { id: true, amount: true, method: true, type: true, status: true },
        })
      ).map((p) => ({ ...p, amount: String(p.amount) }));
    const before = await snap();

    await close(fx.cashier.email, d.shiftId, {
      actualCashAmount: 4970,
      reason: "عجز",
    });

    assert.deepEqual(
      await snap(),
      before,
      "the variance is reported, never reconciled away by rewriting the takings"
    );
    const order = await db.order.findUniqueOrThrow({ where: { id: d.orderId } });
    assert.equal(Number(order.total), 2000, "the sale is untouched");
  });

  // ──────────────────────────── the audit ────────────────────────────

  test("the audit row carries expected, actual, variance, reason, actor and scope", async () => {
    const d = await drawer();
    await close(fx.manager.email, d.shiftId, {
      actualCashAmount: 4970,
      reason: "عجز مسجل",
    });

    const rows = await auditRows(d.shiftId, "SHIFT_CLOSED");
    assert.equal(rows.length, 1, "one close, one SHIFT_CLOSED row");
    const row = rows[0];
    assert.equal(row.userId, fx.manager.id, "who performed the close");
    assert.equal(row.cafeId, fx.cafeId);

    const details = row.details as Record<string, unknown>;
    assert.equal(details.expectedCash, 5000);
    assert.equal(details.actualCash, 4970);
    assert.equal(details.cashDifference, -30);
    assert.equal(details.reason, "عجز مسجل");
    assert.equal(details.branchId, fx.branchId);
    assert.equal(details.shiftId, d.shiftId);

    const diff = await auditRows(d.shiftId, "CASH_DIFFERENCE_DETECTED");
    assert.equal(diff.length, 1);
    const dd = diff[0].details as Record<string, unknown>;
    assert.equal(dd.cashDifference, -30);
    assert.equal(dd.kind, "SHORTAGE");
    assert.equal(dd.expectedCash, 5000);
    assert.equal(dd.actualCash, 4970);
    assert.equal(dd.reason, "عجز مسجل");
    assert.equal(
      dd.varianceCaseId,
      (await shiftRow(d.shiftId)).cashVarianceCaseId,
      "the audit names the case, so the evidence chain is followable"
    );
  });

  test("an exact close writes SHIFT_CLOSED and no difference event", async () => {
    const d = await drawer();
    await close(fx.cashier.email, d.shiftId, { actualCashAmount: 5000 });

    assert.equal((await auditRows(d.shiftId, "SHIFT_CLOSED")).length, 1);
    assert.deepEqual(
      await auditRows(d.shiftId, "CASH_DIFFERENCE_DETECTED"),
      [],
      "no difference, no difference event"
    );
  });

  test("the close records who performed it, durably on the shift", async () => {
    const d = await drawer();
    await close(fx.manager.email, d.shiftId, {
      actualCashAmount: 5030,
      reason: "زيادة",
    });

    const row = await shiftRow(d.shiftId);
    assert.equal(
      row.closedById,
      fx.manager.id,
      "the closer is stored beside the figures, not only in a log line"
    );
    assert.equal(
      row.cashierId,
      fx.cashier.id,
      "and stays distinct from the custodian who held the drawer"
    );
    assert.ok(row.closedAt instanceof Date);
  });

  // ─────────────────────── reading history back ──────────────────────

  test("a historical close reads back the stored expected, actual and variance", async () => {
    const d = await drawer();
    await close(fx.cashier.email, d.shiftId, {
      actualCashAmount: 4970,
      reason: "عجز",
    });

    const r = await as<{ shifts: Array<Record<string, unknown>> }>(
      fx.manager.email,
      `/api/shifts?status=CLOSED`
    );
    assert.equal(r.status, 200, r.text);
    const found = r.body.shifts.find((s) => s.id === d.shiftId);
    assert.ok(found, "the closed shift is readable");
    assert.equal(Number(found.expectedCashAmount), 5000);
    assert.equal(Number(found.actualCashAmount), 4970);
    assert.equal(Number(found.cashDifference), -30);
    assert.equal(found.cashReasonNote, "عجز");
  });

  // ─────────────────── no tolerance, no classification ───────────────

  test("no tolerance verdict is written by a close, at any variance", async () => {
    for (const [actual, reason] of [
      [5000, null],
      [4999.99, "قرش"],
      [4970, "عجز"],
      [0, "الدرج فاضي"],
    ] as const) {
      const d = await drawer();
      const r = await close(fx.cashier.email, d.shiftId, {
        actualCashAmount: actual,
        ...(reason ? { reason } : {}),
      });
      assert.equal(r.status, 200, r.text);

      const row = await shiftRow(d.shiftId);
      assert.equal(
        row.cashWithinTolerance,
        null,
        `close of ${actual} must not decide whether the difference was acceptable`
      );
      assert.equal(
        row.cashToleranceAmount,
        null,
        `close of ${actual} must not apply a bound`
      );
    }
  });

  test("a configured cash tolerance rule changes nothing about the close", async () => {
    // The T16 resolver still exists and still resolves — it is simply not on
    // this path. An owner who configured a bound in an earlier milestone must
    // not find it silently deciding how their shift closes.
    await db.toleranceRule.deleteMany({ where: { cafeId: fx.cafeId } });
    await db.toleranceRule.create({
      data: {
        cafeId: fx.cafeId,
        scope: "TENDER",
        tenderMethod: "CASH",
        amountTolerance: "100.00",
      },
    });
    try {
      const d = await drawer();
      const refused = await close(fx.cashier.email, d.shiftId, { actualCashAmount: 4970 });
      assert.equal(
        refused.status,
        400,
        "a 30 EGP shortage inside a 100 EGP bound STILL needs a reason — there is no tolerance here"
      );

      const ok = await close(fx.cashier.email, d.shiftId, {
        actualCashAmount: 4970,
        reason: "عجز",
      });
      assert.equal(ok.status, 200, ok.text);

      const row = await shiftRow(d.shiftId);
      assert.equal(row.cashWithinTolerance, null);
      assert.equal(row.cashToleranceAmount, null);
      assert.equal(
        (await cashCases(d.shiftId)).length,
        1,
        "and the case is opened regardless of the configured bound"
      );
    } finally {
      await db.toleranceRule.deleteMany({ where: { cafeId: fx.cafeId } });
    }
  });

  test("the close response speaks of facts, not of acceptability", async () => {
    const d = await drawer();
    const r = await close(fx.cashier.email, d.shiftId, {
      actualCashAmount: 4970,
      reason: "عجز",
    });
    assert.equal(r.status, 200, r.text);

    // `cashWithinTolerance` and `cashToleranceAmount` are T16 columns and are
    // serialised with the rest of the row, so their NAMES appear. What must
    // not appear is a VALUE in any of them: the assertion is that every
    // acceptability-shaped field came back empty, which is the difference
    // between a column that exists and a verdict this close reached.
    const shift = r.body.shift!;
    const verdictKeys = Object.keys(shift).filter((k) =>
      /tolerance|acceptable|threshold|approved/i.test(k)
    );
    assert.deepEqual(
      verdictKeys.sort(),
      ["cashToleranceAmount", "cashWithinTolerance"],
      "no NEW acceptability field was introduced by T33"
    );
    for (const key of verdictKeys) {
      assert.equal(shift[key], null, `${key} must carry no verdict`);
    }

    // And the figures that ARE disclosed are the factual ones.
    assert.equal(Number(shift.expectedCashAmount), 5000);
    assert.equal(Number(shift.actualCashAmount), 4970);
    assert.equal(Number(shift.cashDifference), -30);
    assert.equal(shift.cashReasonNote, "عجز");
  });

  test("a tolerance field is not accepted from the request either", async () => {
    const d = await drawer();
    const r = await close(fx.cashier.email, d.shiftId, {
      actualCashAmount: 4970,
      reason: "عجز",
      cashWithinTolerance: true,
      cashToleranceAmount: 500,
    });
    assert.equal(r.status, 200, r.text);

    const row = await shiftRow(d.shiftId);
    assert.equal(row.cashWithinTolerance, null, "a client cannot smuggle a verdict in");
    assert.equal(row.cashToleranceAmount, null);
  });

  // ──────────────────── card / wallet stay out of it ─────────────────

  test("card and wallet are untouched by a cash close", async () => {
    const d = await drawer();
    await close(fx.cashier.email, d.shiftId, {
      actualCashAmount: 4970,
      reason: "عجز",
    });

    const row = await shiftRow(d.shiftId);
    assert.equal(Number(row.totalCardSales), 700, "card takings are reported, not reconciled");
    assert.equal(Number(row.totalWalletSales), 300);
    assert.equal(Number(row.totalCashSales), 1000);
    assert.equal(
      Number(row.expectedCashAmount),
      5000,
      "expected cash is opening + net CASH only — card and wallet never entered the drawer"
    );

    // This assertion used to read "T33 opens no settlement channel — that is
    // T34", and T34 is now here: the channels ARE settled by the close, with
    // the exact figures this suite's `close` helper supplies. What the
    // assertion was really protecting is unchanged and is stated directly
    // below — a cash close does not invent a tender DIFFERENCE, and the
    // drawer's own numbers above are computed without reference to either
    // channel.
    const settlements = await db.tenderReconciliation.findMany({
      where: { shiftId: d.shiftId },
      orderBy: { method: "asc" },
    });
    assert.equal(settlements.length, 2, "card and wallet settle alongside the drawer");
    for (const s of settlements) {
      assert.equal(
        Number(s.varianceAmount),
        0,
        "an exactly-settled channel differs by nothing, whatever the drawer did"
      );
      assert.equal(s.reasonNote, null, "and is asked to explain nothing");
    }

    const nonCash = await db.varianceCase.findMany({
      where: { shiftId: d.shiftId, type: { not: "CASH" } },
    });
    assert.deepEqual(
      nonCash,
      [],
      "a 30 EGP cash shortage raises no TENDER case — the tenders are accounted separately"
    );
  });

  // ─────────────────────── permissions and tenancy ───────────────────

  test("a manager of the same branch may close a cashier's shift", async () => {
    const d = await drawer();
    const r = await close(fx.manager.email, d.shiftId, { actualCashAmount: 5000 });

    assert.equal(r.status, 200, r.text);
    const row = await shiftRow(d.shiftId);
    assert.equal(row.status, "CLOSED");
    assert.equal(row.closedById, fx.manager.id);
  });

  test("another café cannot close this café's shift", async () => {
    const d = await drawer();
    const r = await close(other.manager.email, d.shiftId, {
      actualCashAmount: 4970,
      reason: "محاولة",
    });

    assert.ok(r.status === 403 || r.status === 404, `expected refusal, got ${r.status}`);
    const row = await shiftRow(d.shiftId);
    assert.equal(row.status, "OPEN", "and nothing was written");
    assert.equal(row.actualCashAmount, null);
    assert.deepEqual(await cashCases(d.shiftId), []);
  });

  test("a branch-pinned user cannot close another branch's shift", async () => {
    const d = await drawer({ branchId: fx.otherBranchId });
    const r = await close(fx.manager.email, d.shiftId, {
      actualCashAmount: 4970,
      reason: "محاولة",
    });

    assert.equal(r.status, 403, r.text);
    const row = await shiftRow(d.shiftId);
    assert.equal(row.status, "OPEN");
    assert.deepEqual(await cashCases(d.shiftId), []);
  });

  test("a role with no shift power cannot close, whatever it counts", async () => {
    const d = await drawer();
    const r = await close(fx.waiter.email, d.shiftId, { actualCashAmount: 5000 });

    assert.equal(r.status, 403, r.text);
    assert.equal((await shiftRow(d.shiftId)).status, "OPEN");
  });

  test("an unauthenticated close is refused", async () => {
    const d = await drawer();
    const r = await as<CloseBody>("nobody@example.invalid", `/api/shifts/${d.shiftId}/close`, {
      method: "POST",
      body: JSON.stringify({ actualCashAmount: 5000 }),
    });

    assert.equal(r.status, 401, r.text);
    assert.equal((await shiftRow(d.shiftId)).status, "OPEN");
  });

  // ───────────────────────── input validation ────────────────────────

  test("a negative or absent count is refused before anything is written", async () => {
    for (const body of [{ actualCashAmount: -1 }, { actualCashAmount: "4970" }, {}]) {
      const d = await drawer();
      const r = await close(fx.cashier.email, d.shiftId, body);
      assert.equal(r.status, 400, `${JSON.stringify(body)} → ${r.text}`);
      assert.equal((await shiftRow(d.shiftId)).status, "OPEN");
    }
  });

  test("an already-closed shift refuses a second close", async () => {
    const d = await drawer();
    assert.equal(
      (await close(fx.cashier.email, d.shiftId, { actualCashAmount: 5000 })).status,
      200
    );
    const again = await close(fx.cashier.email, d.shiftId, {
      actualCashAmount: 4000,
      reason: "تاني",
    });

    assert.equal(again.status, 400, again.text);
    const row = await shiftRow(d.shiftId);
    assert.equal(
      Number(row.actualCashAmount),
      5000,
      "the first accepted close is never overwritten"
    );
    assert.equal(Number(row.cashDifference), 0);
  });

  test("a shift that does not exist is a 404, not a 500", async () => {
    const r = await close(fx.manager.email, "cc001-no-such-shift", {
      actualCashAmount: 5000,
    });
    assert.equal(r.status, 404, r.text);
  });

  // ────────────────────────── decimal precision ──────────────────────

  test("piastre-level differences survive the round trip", async () => {
    const d = await drawer();
    const r = await close(fx.cashier.email, d.shiftId, {
      actualCashAmount: 4999.99,
      reason: "قرش ناقص",
    });
    assert.equal(r.status, 200, r.text);

    const row = await shiftRow(d.shiftId);
    assert.equal(Number(row.cashDifference), -0.01);
    assert.equal(Number(row.actualCashAmount), 4999.99);
    const [c] = await cashCases(d.shiftId);
    assert.equal(Number(c.amountVariance), -0.01);
    assert.equal(Number(c.financialImpact), 0.01);
  });

  test("a sub-piastre count cannot manufacture a phantom variance", async () => {
    // Decimal(10,2) is the column, and the service rounds to it before
    // comparing. 5000.001 counted against 5000 expected is zero, not a
    // 0.001 shortage demanding a reason nobody could write.
    const d = await drawer();
    const r = await close(fx.cashier.email, d.shiftId, { actualCashAmount: 5000.001 });

    assert.equal(r.status, 200, r.text);
    assert.equal(Number((await shiftRow(d.shiftId)).cashDifference), 0);
    assert.deepEqual(await cashCases(d.shiftId), []);
  });
});
