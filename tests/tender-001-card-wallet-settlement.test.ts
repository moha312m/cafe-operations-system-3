// T34 / TENDER-001 — card and wallet settle with the shift, independently.
//
// T33 made the counted drawer a fact that has to be explained. It left the
// two channels that do NOT arrive in a drawer unreconciled: a shift could go
// CLOSED with 3,200 EGP of card takings and 1,500 of wallet, and nothing in
// the system had ever asked what the acquirer and the wallet provider
// actually settled. The money was recorded as collected and never checked
// against the party that holds it.
//
// So the close becomes the financial close of the whole shift, and the
// accounting rule is stated once per tender:
//
//   variance = ACTUAL SETTLEMENT − EXPECTED SETTLEMENT
//
//   negative = under-settlement, positive = over-settlement, zero = exact.
//
// THE THREE TENDERS ARE NEVER NETTED. A 20 EGP card shortage and a 30 EGP
// wallet overage are two findings, with two reasons and two cases — not a
// +10 EGP "settlement difference". They have different counterparties and
// different causes, and summing them would destroy the only information that
// makes either investigable. Half this suite exists to say that.
//
// EXPECTED IS NEVER TYPED IN. It comes from `recomputeShiftTotals`, the
// repository's one authoritative aggregate — the same function T33 reconciles
// cash against. `totalCardSales` and `totalWalletSales` are computed there by
// exactly the arithmetic that produces `expectedCashAmount`: PAID collections
// add, REFUND rows subtract, per method. A second formula written into the
// close would be a second opinion with nothing saying which to believe, and a
// client-supplied expected figure would let the settlement target be moved to
// meet the settlement.
//
// THERE IS NO TOLERANCE, on either channel, for the same reason there is none
// on cash: the ERP records the difference, and the owner decides in their own
// books whether it was acceptable. `TenderReconciliation.toleranceAmount`
// exists from T16 and stays NULL on every row this close writes.
//
// CASH IS UNTOUCHED. Every cash assertion here is a copy of the T33 rule,
// asserted again in the presence of card and wallet variances, because the
// failure this suite must catch is a tender difference leaking into the
// drawer figure.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { db, closeOpenShifts, teardownTaggedCafe } from "./helpers/db";
import { requireServer, as } from "./helpers/http";
import { countCafe, type CountCafe } from "./helpers/count";

let fx: CountCafe;
let other: CountCafe;

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
  fx = await countCafe("TS001");
  other = await countCafe("TS001X");
  await useLegacyNoHandoverPolicy(fx.cafeId, other.cafeId);
});

after(() =>
  teardownTaggedCafe([fx?.cafeId, other?.cafeId].filter(Boolean) as string[], [], {
    disconnect: true,
  })
);

let seq = 0;

type Till = {
  shiftId: string;
  orderId: string;
  expectedCash: number;
  expectedCard: number;
  expectedWallet: number;
};

type Leg = { amount: number; method: "CASH" | "CARD" | "WALLET"; type?: "COLLECTION" | "REFUND"; status?: "PAID" | "UNPAID" | "CANCELLED" | "PENDING_COLLECTION" };

/**
 * A shift built to the owner's UAT figures: 5,000 expected in the drawer,
 * 3,200 expected from the acquirer, 1,500 expected from the wallet provider.
 *
 * The three are deliberately different amounts. A close that reached for
 * `totalSales`, or that netted the tenders together, cannot accidentally
 * agree with three distinct targets.
 */
async function till(
  opts: {
    cafe?: CountCafe;
    branchId?: string;
    cashierId?: string;
    legs?: Leg[];
  } = {}
): Promise<Till> {
  const owner = opts.cafe ?? fx;
  const branchId = opts.branchId ?? owner.branchId;
  const cashierId = opts.cashierId ?? owner.cashier.id;
  seq += 1;

  // One drawer per cashier: close the one the previous test left open
  // rather than deleting it, so its payments and evidence survive.
  await closeOpenShifts(branchId, cashierId);
  const shift = await db.shift.create({
    data: {
      cafeId: owner.cafeId,
      branchId,
      cashierId,
      shiftNumber: 35000 + seq,
      openingCashAmount: 4000,
      expectedCashAmount: 4000,
    },
  });

  const order = await db.order.create({
    data: {
      cafeId: owner.cafeId,
      branchId,
      orderNumber: 35000 + seq,
      type: "TAKEAWAY",
      status: "CONFIRMED",
      source: "CASHIER_POS",
      customerName: `${owner.marker}-till-${seq}`,
      subtotal: 5700,
      taxAmount: 0,
      discountAmount: 0,
      serviceChargeAmount: 0,
      total: 5700,
      remainingAmount: 0,
      paymentStatus: "PAID",
      createdById: cashierId,
    },
  });

  const legs: Leg[] = opts.legs ?? [
    { amount: 1000, method: "CASH" },
    { amount: 3200, method: "CARD" },
    { amount: 1500, method: "WALLET" },
  ];

  for (const leg of legs) {
    await db.payment.create({
      data: {
        cafeId: owner.cafeId,
        branchId,
        orderId: order.id,
        shiftId: shift.id,
        cashierId,
        receivedById: cashierId,
        amount: leg.amount,
        method: leg.method,
        type: leg.type ?? "COLLECTION",
        status: leg.status ?? "PAID",
      },
    });
  }

  // Through the authoritative aggregate, never by writing the figures by
  // hand — the fixture must reach its targets by the repository's own
  // arithmetic or it is not testing that arithmetic.
  const { recomputeShiftTotals } = await import("@/lib/shifts");
  const fresh = await recomputeShiftTotals(shift.id);

  return {
    shiftId: shift.id,
    orderId: order.id,
    expectedCash: Number(fresh!.expectedCashAmount),
    expectedCard: Number(fresh!.totalCardSales),
    expectedWallet: Number(fresh!.totalWalletSales),
  };
}

type CloseBody = { shift?: Record<string, unknown>; error?: string };

const close = (email: string, shiftId: string, body: Record<string, unknown>) =>
  as<CloseBody>(email, `/api/shifts/${shiftId}/close`, {
    method: "POST",
    body: JSON.stringify(body),
  });

/** An exact settlement on all three tenders — the baseline the tests vary. */
const exact = { actualCashAmount: 5000, actualCardAmount: 3200, actualWalletAmount: 1500 };

const shiftRow = (id: string) => db.shift.findUniqueOrThrow({ where: { id } });

const recon = (shiftId: string, method: "CARD" | "WALLET") =>
  db.tenderReconciliation.findFirst({ where: { shiftId, method } });

const recons = (shiftId: string) =>
  db.tenderReconciliation.findMany({ where: { shiftId }, orderBy: { method: "asc" } });

const tenderCases = (shiftId: string) =>
  db.varianceCase.findMany({ where: { shiftId, type: "TENDER" } });

const caseFor = async (shiftId: string, method: "CARD" | "WALLET") => {
  const r = await recon(shiftId, method);
  if (!r) return null;
  return db.varianceCase.findFirst({ where: { tenderReconciliationId: r.id } });
};

const cashCases = (shiftId: string) =>
  db.varianceCase.findMany({ where: { shiftId, type: "CASH" } });

const auditRows = (entity: string, entityId: string, action?: string) =>
  db.auditLog.findMany({ where: { entity, entityId, ...(action ? { action } : {}) } });

describe("TENDER-001 — card and wallet settlement is part of the shift close", () => {
  // ───────────────────── expected comes from the ledger ─────────────────

  test("expected card and wallet are the authoritative payment totals", async () => {
    const t = await till();

    assert.equal(t.expectedCard, 3200, "expected card is net valid CARD payments");
    assert.equal(t.expectedWallet, 1500, "expected wallet is net valid WALLET payments");
    assert.equal(t.expectedCash, 5000, "and cash is unchanged: float plus net cash");

    const r = await close(fx.cashier.email, t.shiftId, exact);
    assert.equal(r.status, 200, r.text);

    const card = await recon(t.shiftId, "CARD");
    const wallet = await recon(t.shiftId, "WALLET");
    assert.equal(Number(card!.expectedAmount), 3200);
    assert.equal(Number(wallet!.expectedAmount), 1500);
  });

  test("a client cannot supply the expected figure it is measured against", async () => {
    const t = await till();
    const r = await close(fx.cashier.email, t.shiftId, {
      ...exact,
      // If any of these were honoured, the settlement target could be moved
      // to meet the settlement and no variance would ever be found.
      expectedCardAmount: 10,
      expectedWalletAmount: 10,
      cardVariance: 999,
      walletVariance: 999,
    });
    assert.equal(r.status, 200, r.text);

    const card = await recon(t.shiftId, "CARD");
    const wallet = await recon(t.shiftId, "WALLET");
    assert.equal(Number(card!.expectedAmount), 3200, "the server's figure, not the client's");
    assert.equal(Number(wallet!.expectedAmount), 1500);
    assert.equal(Number(card!.varianceAmount), 0, "and the server's variance, not the client's");
    assert.equal(Number(wallet!.varianceAmount), 0);
  });

  // ──────────────────────────── card arithmetic ─────────────────────────

  test("exact card settlement is a zero variance needing no reason", async () => {
    const t = await till();
    const r = await close(fx.cashier.email, t.shiftId, exact);

    assert.equal(r.status, 200, r.text);
    const card = await recon(t.shiftId, "CARD");
    assert.equal(Number(card!.actualAmount), 3200);
    assert.equal(Number(card!.varianceAmount), 0);
    assert.equal(card!.reasonNote, null, "an exact settlement invents no reason");
  });

  test("card shortage: 3,180 settled against 3,200 expected is −20", async () => {
    const t = await till();
    const r = await close(fx.cashier.email, t.shiftId, {
      ...exact,
      actualCardAmount: 3180,
      cardReason: "عملية مرفوضة من الشبكة",
    });

    assert.equal(r.status, 200, r.text);
    const card = await recon(t.shiftId, "CARD");
    assert.equal(Number(card!.varianceAmount), -20, "an under-settlement is negative");
    assert.equal(Number(card!.expectedAmount), 3200);
    assert.equal(Number(card!.actualAmount), 3180);
  });

  test("card overage: 3,230 settled against 3,200 expected is +30", async () => {
    const t = await till();
    const r = await close(fx.cashier.email, t.shiftId, {
      ...exact,
      actualCardAmount: 3230,
      cardReason: "تسوية عملية من وردية سابقة",
    });

    assert.equal(r.status, 200, r.text);
    assert.equal(Number((await recon(t.shiftId, "CARD"))!.varianceAmount), 30);
  });

  test("a large card variance still closes — size is not a verdict", async () => {
    const t = await till();
    const r = await close(fx.cashier.email, t.shiftId, {
      ...exact,
      actualCardAmount: 0,
      cardReason: "الشبكة لم تسوِّ أي عملية — بلاغ مفتوح",
    });

    assert.equal(r.status, 200, r.text);
    assert.equal(Number((await recon(t.shiftId, "CARD"))!.varianceAmount), -3200);
    assert.equal((await shiftRow(t.shiftId)).status, "CLOSED", "amount alone never blocks");
  });

  // ─────────────────────────── wallet arithmetic ────────────────────────

  test("exact wallet settlement is a zero variance needing no reason", async () => {
    const t = await till();
    const r = await close(fx.cashier.email, t.shiftId, exact);

    assert.equal(r.status, 200, r.text);
    const w = await recon(t.shiftId, "WALLET");
    assert.equal(Number(w!.actualAmount), 1500);
    assert.equal(Number(w!.varianceAmount), 0);
    assert.equal(w!.reasonNote, null);
  });

  test("wallet shortage: 1,470 settled against 1,500 expected is −30", async () => {
    const t = await till();
    const r = await close(fx.cashier.email, t.shiftId, {
      ...exact,
      actualWalletAmount: 1470,
      walletReason: "عملية محفظة معلقة",
    });

    assert.equal(r.status, 200, r.text);
    assert.equal(Number((await recon(t.shiftId, "WALLET"))!.varianceAmount), -30);
  });

  test("wallet overage: 1,530 settled against 1,500 expected is +30", async () => {
    const t = await till();
    const r = await close(fx.cashier.email, t.shiftId, {
      ...exact,
      actualWalletAmount: 1530,
      walletReason: "استرداد من المزود",
    });

    assert.equal(r.status, 200, r.text);
    assert.equal(Number((await recon(t.shiftId, "WALLET"))!.varianceAmount), 30);
  });

  // ───────────────────────────── the reasons ────────────────────────────

  test("a card variance without a reason is refused, and nothing commits", async () => {
    const t = await till();
    const r = await close(fx.cashier.email, t.shiftId, { ...exact, actualCardAmount: 3180 });

    assert.equal(r.status, 400, r.text);
    const row = await shiftRow(t.shiftId);
    assert.equal(row.status, "OPEN", "a refused close commits nothing");
    assert.equal(row.actualCashAmount, null, "not even the cash it could have accepted");
    assert.deepEqual(await recons(t.shiftId), []);
    assert.deepEqual(await tenderCases(t.shiftId), []);
  });

  test("a wallet variance without a reason is refused too", async () => {
    const t = await till();
    const r = await close(fx.cashier.email, t.shiftId, { ...exact, actualWalletAmount: 1530 });

    assert.equal(r.status, 400, r.text);
    assert.equal((await shiftRow(t.shiftId)).status, "OPEN");
    assert.deepEqual(await recons(t.shiftId), []);
  });

  test("a whitespace-only card reason is not a reason", async () => {
    const t = await till();
    const r = await close(fx.cashier.email, t.shiftId, {
      ...exact,
      actualCardAmount: 3180,
      cardReason: "   \t\n  ",
    });

    assert.equal(r.status, 400, r.text);
    assert.equal((await shiftRow(t.shiftId)).status, "OPEN");
  });

  test("a whitespace-only wallet reason is not a reason", async () => {
    const t = await till();
    const r = await close(fx.cashier.email, t.shiftId, {
      ...exact,
      actualWalletAmount: 1530,
      walletReason: "\n\t   ",
    });

    assert.equal(r.status, 400, r.text);
    assert.equal((await shiftRow(t.shiftId)).status, "OPEN");
  });

  test("real reasons are stored trimmed, one per tender", async () => {
    const t = await till();
    const r = await close(fx.cashier.email, t.shiftId, {
      ...exact,
      actualCardAmount: 3180,
      cardReason: "  عملية مرفوضة  ",
      actualWalletAmount: 1530,
      walletReason: "  استرداد من المزود  ",
    });

    assert.equal(r.status, 200, r.text);
    assert.equal((await recon(t.shiftId, "CARD"))!.reasonNote, "عملية مرفوضة");
    assert.equal((await recon(t.shiftId, "WALLET"))!.reasonNote, "استرداد من المزود");
  });

  test("a card reason does not satisfy a wallet variance", async () => {
    // The failure this catches is one generic "settlement reason" field
    // covering both channels. The causes are different — a rejected card
    // authorisation is not a pending wallet transfer — so the explanations
    // must be too.
    const t = await till();
    const r = await close(fx.cashier.email, t.shiftId, {
      ...exact,
      actualCardAmount: 3180,
      cardReason: "عملية مرفوضة",
      actualWalletAmount: 1530,
    });

    assert.equal(r.status, 400, r.text);
    assert.equal((await shiftRow(t.shiftId)).status, "OPEN");
  });

  test("a cash reason does not satisfy a card variance", async () => {
    const t = await till();
    const r = await close(fx.cashier.email, t.shiftId, {
      ...exact,
      actualCashAmount: 4970,
      reason: "عجز في الدرج",
      actualCardAmount: 3180,
    });

    assert.equal(r.status, 400, r.text);
    assert.equal((await shiftRow(t.shiftId)).status, "OPEN");
  });

  test("an exact settlement is never asked for a reason", async () => {
    const t = await till();
    const r = await close(fx.cashier.email, t.shiftId, exact);
    assert.equal(r.status, 200, r.text);
    assert.equal((await recon(t.shiftId, "CARD"))!.reasonNote, null);
    assert.equal((await recon(t.shiftId, "WALLET"))!.reasonNote, null);
  });

  // ───────────────────── the settlement must be entered ─────────────────

  test("a shift with card takings cannot close without a card settlement", async () => {
    // The T34 invariant: no committed financial close without the tender
    // evidence. 3,200 EGP is sitting with an acquirer and the close is the
    // moment somebody states what came back.
    const t = await till();
    const r = await close(fx.cashier.email, t.shiftId, {
      actualCashAmount: 5000,
      actualWalletAmount: 1500,
    });

    assert.equal(r.status, 400, r.text);
    assert.equal((await shiftRow(t.shiftId)).status, "OPEN");
    assert.deepEqual(await recons(t.shiftId), []);
  });

  test("a shift with wallet takings cannot close without a wallet settlement", async () => {
    const t = await till();
    const r = await close(fx.cashier.email, t.shiftId, {
      actualCashAmount: 5000,
      actualCardAmount: 3200,
    });

    assert.equal(r.status, 400, r.text);
    assert.equal((await shiftRow(t.shiftId)).status, "OPEN");
  });

  // ───────────────────────── zero-activity tenders ──────────────────────

  test("a channel with no activity needs no settlement entry and invents no difference", async () => {
    // Cash-only shift. Demanding a card figure here would make the closer
    // type a number for a terminal that took nothing, and recording a 0
    // settlement would assert a provider report nobody read.
    const t = await till({ legs: [{ amount: 1000, method: "CASH" }] });
    assert.equal(t.expectedCard, 0);
    assert.equal(t.expectedWallet, 0);

    const r = await close(fx.cashier.email, t.shiftId, { actualCashAmount: 5000 });

    assert.equal(r.status, 200, r.text);
    assert.equal((await shiftRow(t.shiftId)).status, "CLOSED");
    assert.deepEqual(
      await recons(t.shiftId),
      [],
      "no activity, no settlement record — a zero row would be an unread report"
    );
    assert.deepEqual(await tenderCases(t.shiftId), []);
  });

  test("a channel with no activity may still be settled at zero, on purpose", async () => {
    const t = await till({ legs: [{ amount: 1000, method: "CASH" }] });
    const r = await close(fx.cashier.email, t.shiftId, {
      actualCashAmount: 5000,
      actualCardAmount: 0,
      actualWalletAmount: 0,
    });

    assert.equal(r.status, 200, r.text);
    const rows = await recons(t.shiftId);
    assert.equal(rows.length, 2, "an affirmative zero IS a settlement statement");
    for (const row of rows) {
      assert.equal(Number(row.expectedAmount), 0);
      assert.equal(Number(row.actualAmount), 0);
      assert.equal(Number(row.varianceAmount), 0);
    }
    assert.deepEqual(await tenderCases(t.shiftId), []);
  });

  test("a settlement on a channel that took nothing is a real overage", async () => {
    const t = await till({ legs: [{ amount: 1000, method: "CASH" }] });
    const r = await close(fx.cashier.email, t.shiftId, {
      actualCashAmount: 5000,
      actualCardAmount: 50,
    });
    assert.equal(r.status, 400, "50 EGP the till never saw still needs explaining");

    const ok = await close(fx.cashier.email, t.shiftId, {
      actualCashAmount: 5000,
      actualCardAmount: 50,
      cardReason: "تسوية متأخرة من وردية أمس",
    });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(Number((await recon(t.shiftId, "CARD"))!.varianceAmount), 50);
    assert.equal((await tenderCases(t.shiftId)).length, 1);
  });

  // ────────────────────────── the variance cases ────────────────────────

  test("a zero card variance opens no case", async () => {
    const t = await till();
    await close(fx.cashier.email, t.shiftId, exact);
    assert.deepEqual(await tenderCases(t.shiftId), []);
    assert.equal(await caseFor(t.shiftId, "CARD"), null);
  });

  test("a zero wallet variance opens no case", async () => {
    const t = await till();
    await close(fx.cashier.email, t.shiftId, exact);
    assert.equal(await caseFor(t.shiftId, "WALLET"), null);
  });

  test("a non-zero card variance opens exactly one case, sourced by its settlement", async () => {
    const t = await till();
    const r = await close(fx.cashier.email, t.shiftId, {
      ...exact,
      actualCardAmount: 3180,
      cardReason: "عملية مرفوضة",
    });
    assert.equal(r.status, 200, r.text);

    const all = await tenderCases(t.shiftId);
    assert.equal(all.length, 1, "one settlement, one case");

    const card = await recon(t.shiftId, "CARD");
    const c = all[0];
    assert.equal(c.type, "TENDER");
    assert.equal(c.status, "OPEN");
    assert.equal(c.tenderReconciliationId, card!.id, "the case points at its evidence");
    assert.equal(c.shiftId, t.shiftId);
    assert.equal(c.cafeId, fx.cafeId);
    assert.equal(c.branchId, fx.branchId);
    assert.equal(Number(c.amountVariance), -20, "the signed variance, not its magnitude");
    assert.equal(Number(c.financialImpact), 20);
    assert.equal(c.financialImpactAvailable, true, "a settlement is money already");
    assert.equal(c.openedById, fx.cashier.id);

    // The single-source CHECK: a tender case is sourced by its settlement
    // and by nothing else.
    assert.equal(c.stockCountLineId, null);
    assert.equal(c.openingExceptionId, null);
  });

  test("a non-zero wallet variance opens exactly one case", async () => {
    const t = await till();
    await close(fx.cashier.email, t.shiftId, {
      ...exact,
      actualWalletAmount: 1530,
      walletReason: "استرداد",
    });

    const all = await tenderCases(t.shiftId);
    assert.equal(all.length, 1);
    const w = await recon(t.shiftId, "WALLET");
    assert.equal(all[0].tenderReconciliationId, w!.id);
    assert.equal(Number(all[0].amountVariance), 30);
  });

  test("the case is never given an acceptability verdict", async () => {
    const t = await till();
    await close(fx.cashier.email, t.shiftId, {
      ...exact,
      actualCardAmount: 3180,
      cardReason: "عملية مرفوضة",
    });
    const [c] = await tenderCases(t.shiftId);
    assert.ok(c);
    assert.equal(
      c.assignedResponsibilityUserId,
      null,
      "responsibility is an investigation outcome, never a side effect of a difference"
    );
    assert.equal(c.resolvedAt, null);
  });

  // ─────────────────────────── independence ─────────────────────────────

  test("card shortage with an exact wallet touches only the card record", async () => {
    const t = await till();
    const r = await close(fx.cashier.email, t.shiftId, {
      ...exact,
      actualCardAmount: 3180,
      cardReason: "عملية مرفوضة",
    });
    assert.equal(r.status, 200, r.text);

    assert.equal(Number((await recon(t.shiftId, "CARD"))!.varianceAmount), -20);
    const w = await recon(t.shiftId, "WALLET");
    assert.equal(Number(w!.varianceAmount), 0);
    assert.equal(w!.reasonNote, null);
    assert.equal(await caseFor(t.shiftId, "WALLET"), null);
    assert.equal((await tenderCases(t.shiftId)).length, 1);
  });

  test("wallet shortage with an exact card touches only the wallet record", async () => {
    const t = await till();
    const r = await close(fx.cashier.email, t.shiftId, {
      ...exact,
      actualWalletAmount: 1470,
      walletReason: "عملية معلقة",
    });
    assert.equal(r.status, 200, r.text);

    assert.equal(Number((await recon(t.shiftId, "WALLET"))!.varianceAmount), -30);
    assert.equal(Number((await recon(t.shiftId, "CARD"))!.varianceAmount), 0);
    assert.equal(await caseFor(t.shiftId, "CARD"), null);
    assert.equal((await tenderCases(t.shiftId)).length, 1);
  });

  test("a card shortage and a wallet overage are TWO findings, never one net figure", async () => {
    // The owner's Scenario D, and the single most important assertion in this
    // suite. −20 on card and +30 on wallet must not become +10 of anything.
    const t = await till();
    const r = await close(fx.cashier.email, t.shiftId, {
      ...exact,
      actualCardAmount: 3180,
      cardReason: "عملية مرفوضة من الشبكة",
      actualWalletAmount: 1530,
      walletReason: "استرداد من المزود",
    });
    assert.equal(r.status, 200, r.text);

    const card = await recon(t.shiftId, "CARD");
    const wallet = await recon(t.shiftId, "WALLET");
    assert.equal(Number(card!.varianceAmount), -20);
    assert.equal(Number(wallet!.varianceAmount), 30);
    assert.equal(card!.reasonNote, "عملية مرفوضة من الشبكة");
    assert.equal(wallet!.reasonNote, "استرداد من المزود");

    const cases = await tenderCases(t.shiftId);
    assert.equal(cases.length, 2, "two counterparties, two findings");
    const amounts = cases.map((c) => Number(c.amountVariance)).sort((a, b) => a - b);
    assert.deepEqual(amounts, [-20, 30], "each keeps its own sign and size");

    const sources = cases.map((c) => c.tenderReconciliationId).sort();
    assert.deepEqual(
      sources,
      [card!.id, wallet!.id].sort(),
      "and each points at its own settlement"
    );

    // The netting failure, stated as an assertion rather than trusted.
    assert.ok(
      !cases.some((c) => Number(c.amountVariance) === 10),
      "a +10 net difference would have destroyed both findings"
    );
  });

  test("equal and opposite tender variances do not cancel out", async () => {
    const t = await till();
    const r = await close(fx.cashier.email, t.shiftId, {
      ...exact,
      actualCardAmount: 3180,
      cardReason: "ناقص",
      actualWalletAmount: 1520,
      walletReason: "زيادة",
    });
    assert.equal(r.status, 200, r.text);

    assert.equal(Number((await recon(t.shiftId, "CARD"))!.varianceAmount), -20);
    assert.equal(Number((await recon(t.shiftId, "WALLET"))!.varianceAmount), 20);
    assert.equal(
      (await tenderCases(t.shiftId)).length,
      2,
      "a −20 and a +20 are two problems, not zero problems"
    );
  });

  // ─────────────────── cash is untouched by any of this ─────────────────

  test("a tender variance never moves the cash figure", async () => {
    const t = await till();
    const r = await close(fx.cashier.email, t.shiftId, {
      actualCashAmount: 5000,
      actualCardAmount: 3180,
      cardReason: "عملية مرفوضة",
      actualWalletAmount: 1530,
      walletReason: "استرداد",
    });
    assert.equal(r.status, 200, r.text);

    const row = await shiftRow(t.shiftId);
    assert.equal(Number(row.expectedCashAmount), 5000);
    assert.equal(Number(row.actualCashAmount), 5000);
    assert.equal(Number(row.cashDifference), 0, "the drawer balanced, and still does");
    assert.equal(row.cashReasonNote, null, "and needs no reason for somebody else's shortfall");
    assert.deepEqual(await cashCases(t.shiftId), [], "no cash case for a card problem");
    assert.equal(row.cashVarianceCaseId, null);
  });

  test("a cash variance never moves the tender figures", async () => {
    const t = await till();
    const r = await close(fx.cashier.email, t.shiftId, {
      ...exact,
      actualCashAmount: 4970,
      reason: "عجز في الدرج",
    });
    assert.equal(r.status, 200, r.text);

    const row = await shiftRow(t.shiftId);
    assert.equal(Number(row.cashDifference), -30);
    assert.equal(Number((await recon(t.shiftId, "CARD"))!.varianceAmount), 0);
    assert.equal(Number((await recon(t.shiftId, "WALLET"))!.varianceAmount), 0);
    assert.equal((await cashCases(t.shiftId)).length, 1);
    assert.deepEqual(await tenderCases(t.shiftId), []);
  });

  test("all three tenders can differ at once, and each keeps its own evidence", async () => {
    const t = await till();
    const r = await close(fx.cashier.email, t.shiftId, {
      actualCashAmount: 4970,
      reason: "عجز في الدرج",
      actualCardAmount: 3180,
      cardReason: "عملية مرفوضة",
      actualWalletAmount: 1530,
      walletReason: "استرداد",
    });
    assert.equal(r.status, 200, r.text);

    const row = await shiftRow(t.shiftId);
    assert.equal(Number(row.cashDifference), -30);
    assert.equal(row.cashReasonNote, "عجز في الدرج");
    assert.equal(Number((await recon(t.shiftId, "CARD"))!.varianceAmount), -20);
    assert.equal(Number((await recon(t.shiftId, "WALLET"))!.varianceAmount), 30);

    assert.equal((await cashCases(t.shiftId)).length, 1, "one CASH case");
    assert.equal((await tenderCases(t.shiftId)).length, 2, "and two TENDER cases");
  });

  // ───────────────────────── payment accounting ─────────────────────────

  test("cash payments are excluded from the card expectation", async () => {
    const t = await till({
      legs: [
        { amount: 1000, method: "CASH" },
        { amount: 3200, method: "CARD" },
      ],
    });
    assert.equal(t.expectedCard, 3200, "the 1,000 in cash is not the acquirer's problem");
    assert.equal(t.expectedWallet, 0);
    assert.equal(t.expectedCash, 5000);
  });

  test("wallet payments are excluded from the card expectation, and the reverse", async () => {
    const t = await till();
    assert.equal(t.expectedCard, 3200, "wallet money is not card money");
    assert.equal(t.expectedWallet, 1500, "and card money is not wallet money");

    await close(fx.cashier.email, t.shiftId, exact);
    assert.equal(Number((await recon(t.shiftId, "CARD"))!.expectedAmount), 3200);
    assert.equal(Number((await recon(t.shiftId, "WALLET"))!.expectedAmount), 1500);
  });

  test("a card refund reduces the card expectation and nothing else", async () => {
    const t = await till({
      legs: [
        { amount: 1000, method: "CASH" },
        { amount: 3200, method: "CARD" },
        { amount: 1500, method: "WALLET" },
        { amount: 200, method: "CARD", type: "REFUND" },
      ],
    });

    assert.equal(t.expectedCard, 3000, "3,200 taken less 200 returned");
    assert.equal(t.expectedWallet, 1500, "the wallet is untouched by a card refund");
    assert.equal(t.expectedCash, 5000, "and so is the drawer");

    const r = await close(fx.cashier.email, t.shiftId, {
      actualCashAmount: 5000,
      actualCardAmount: 3000,
      actualWalletAmount: 1500,
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(Number((await recon(t.shiftId, "CARD"))!.varianceAmount), 0);
  });

  test("a wallet refund reduces the wallet expectation and nothing else", async () => {
    const t = await till({
      legs: [
        { amount: 1000, method: "CASH" },
        { amount: 3200, method: "CARD" },
        { amount: 1500, method: "WALLET" },
        { amount: 300, method: "WALLET", type: "REFUND" },
      ],
    });

    assert.equal(t.expectedWallet, 1200);
    assert.equal(t.expectedCard, 3200);
    assert.equal(t.expectedCash, 5000);
  });

  test("a cash refund never reduces a tender expectation", async () => {
    const t = await till({
      legs: [
        { amount: 1000, method: "CASH" },
        { amount: 3200, method: "CARD" },
        { amount: 1500, method: "WALLET" },
        { amount: 100, method: "CASH", type: "REFUND" },
      ],
    });

    assert.equal(t.expectedCash, 4900, "the drawer paid it out");
    assert.equal(t.expectedCard, 3200);
    assert.equal(t.expectedWallet, 1500);
  });

  test("unpaid and cancelled rows do not inflate a settlement expectation", async () => {
    const t = await till({
      legs: [
        { amount: 1000, method: "CASH" },
        { amount: 3200, method: "CARD" },
        { amount: 900, method: "CARD", status: "UNPAID" },
        { amount: 700, method: "CARD", status: "CANCELLED" },
        { amount: 400, method: "CARD", status: "PENDING_COLLECTION" },
        { amount: 1500, method: "WALLET" },
        { amount: 250, method: "WALLET", status: "CANCELLED" },
      ],
    });

    assert.equal(
      t.expectedCard,
      3200,
      "money that was never collected is not money an acquirer owes"
    );
    assert.equal(t.expectedWallet, 1500);
  });

  // ────────────────────────── the snapshot holds ────────────────────────

  test("the settlement persists exactly as committed", async () => {
    const t = await till();
    await close(fx.manager.email, t.shiftId, {
      ...exact,
      actualCardAmount: 3180,
      cardReason: "عملية مرفوضة",
    });

    const card = await recon(t.shiftId, "CARD");
    assert.equal(Number(card!.expectedAmount), 3200);
    assert.equal(Number(card!.actualAmount), 3180);
    assert.equal(Number(card!.varianceAmount), -20);
    assert.equal(card!.reasonNote, "عملية مرفوضة");
    assert.equal(card!.submittedById, fx.manager.id, "who stated the settlement");
    assert.ok(card!.submittedAt instanceof Date);
    assert.equal(card!.cafeId, fx.cafeId);
    assert.equal(card!.branchId, fx.branchId);
    assert.equal(card!.shiftId, t.shiftId);
  });

  test("payments arriving after the close never rewrite the settled figures", async () => {
    const t = await till();
    await close(fx.cashier.email, t.shiftId, {
      ...exact,
      actualCardAmount: 3180,
      cardReason: "عملية مرفوضة",
    });
    const before = await recon(t.shiftId, "CARD");

    await db.payment.create({
      data: {
        cafeId: fx.cafeId,
        branchId: fx.branchId,
        orderId: t.orderId,
        shiftId: t.shiftId,
        cashierId: fx.cashier.id,
        receivedById: fx.cashier.id,
        amount: 500,
        method: "CARD",
        type: "COLLECTION",
        status: "PAID",
      },
    });
    const { recomputeShiftTotals } = await import("@/lib/shifts");
    await recomputeShiftTotals(t.shiftId);

    const after = await recon(t.shiftId, "CARD");
    assert.equal(Number(after!.expectedAmount), Number(before!.expectedAmount));
    assert.equal(Number(after!.actualAmount), 3180);
    assert.equal(Number(after!.varianceAmount), -20);
    assert.equal(after!.reasonNote, before!.reasonNote);
  });

  test("closing never edits payments to make a tender variance disappear", async () => {
    const t = await till();
    const snap = async () =>
      (
        await db.payment.findMany({
          where: { shiftId: t.shiftId },
          orderBy: { createdAt: "asc" },
          select: { id: true, amount: true, method: true, type: true, status: true },
        })
      ).map((p) => ({ ...p, amount: String(p.amount) }));
    const before = await snap();

    await close(fx.cashier.email, t.shiftId, {
      ...exact,
      actualCardAmount: 3180,
      cardReason: "عملية مرفوضة",
    });

    assert.deepEqual(
      await snap(),
      before,
      "the variance is the finding — reconciling it away by rewriting the takings is the failure"
    );
  });

  // ──────────────────────────── the audit ───────────────────────────────

  test("the close audit carries every tender's expected, actual, variance and reason", async () => {
    const t = await till();
    await close(fx.manager.email, t.shiftId, {
      actualCashAmount: 4970,
      reason: "عجز في الدرج",
      actualCardAmount: 3180,
      cardReason: "عملية مرفوضة",
      actualWalletAmount: 1530,
      walletReason: "استرداد",
    });

    const rows = await auditRows("Shift", t.shiftId, "SHIFT_CLOSED");
    assert.equal(rows.length, 1, "one close, one SHIFT_CLOSED row");
    const details = rows[0].details as Record<string, unknown>;

    // Cash, exactly as T33 wrote it.
    assert.equal(details.expectedCash, 5000);
    assert.equal(details.actualCash, 4970);
    assert.equal(details.cashDifference, -30);
    assert.equal(details.reason, "عجز في الدرج");

    // And the two channels, so the whole close is reconstructible from here.
    const tenders = details.tenders as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(tenders), "the audit names the tenders it settled");
    const card = tenders.find((x) => x.method === "CARD")!;
    const wallet = tenders.find((x) => x.method === "WALLET")!;
    assert.equal(card.expected, 3200);
    assert.equal(card.actual, 3180);
    assert.equal(card.variance, -20);
    assert.equal(card.reason, "عملية مرفوضة");
    assert.equal(wallet.expected, 1500);
    assert.equal(wallet.actual, 1530);
    assert.equal(wallet.variance, 30);
    assert.equal(wallet.reason, "استرداد");

    assert.equal(rows[0].userId, fx.manager.id, "who performed the close");
    assert.equal(rows[0].cafeId, fx.cafeId);
    assert.equal(details.branchId, fx.branchId);
  });

  test("each non-zero tender writes its own difference event, and a zero one writes none", async () => {
    const t = await till();
    await close(fx.cashier.email, t.shiftId, {
      ...exact,
      actualCardAmount: 3180,
      cardReason: "عملية مرفوضة",
    });

    const card = await recon(t.shiftId, "CARD");
    const wallet = await recon(t.shiftId, "WALLET");

    const cardEvents = await auditRows("TenderReconciliation", card!.id);
    assert.equal(cardEvents.length, 1, "the shortfall is announced exactly once");
    assert.equal(cardEvents[0].action, "TENDER_DIFFERENCE_DETECTED");
    const d = cardEvents[0].details as Record<string, unknown>;
    assert.equal(d.method, "CARD");
    assert.equal(d.expected, 3200);
    assert.equal(d.actual, 3180);
    assert.equal(d.variance, -20);
    assert.equal(d.kind, "SHORTAGE", "the direction, which is not a verdict");
    assert.equal(d.reason, "عملية مرفوضة");
    assert.equal(d.shiftId, t.shiftId);
    assert.equal(d.branchId, fx.branchId);
    assert.equal(
      d.varianceCaseId,
      (await caseFor(t.shiftId, "CARD"))!.id,
      "and names the case, so the evidence chain is followable"
    );

    assert.deepEqual(
      await auditRows("TenderReconciliation", wallet!.id),
      [],
      "no difference, no difference event"
    );
  });

  test("an overage is announced as an OVERAGE", async () => {
    const t = await till();
    await close(fx.cashier.email, t.shiftId, {
      ...exact,
      actualWalletAmount: 1530,
      walletReason: "استرداد",
    });
    const w = await recon(t.shiftId, "WALLET");
    const events = await auditRows("TenderReconciliation", w!.id);
    assert.equal(events.length, 1);
    assert.equal((events[0].details as Record<string, unknown>).kind, "OVERAGE");
  });

  test("reading a closed shift back writes no audit noise", async () => {
    const t = await till();
    await close(fx.cashier.email, t.shiftId, exact);
    const before = await db.auditLog.count({ where: { cafeId: fx.cafeId } });

    const r = await as<{ shifts: unknown[] }>(fx.manager.email, "/api/shifts?status=CLOSED");
    assert.equal(r.status, 200, r.text);

    assert.equal(
      await db.auditLog.count({ where: { cafeId: fx.cafeId } }),
      before,
      "looking at a settlement is not an event"
    );
  });

  // ───────────────────── no tolerance, no classification ────────────────

  test("no tolerance is applied or recorded, at any tender variance", async () => {
    for (const [actual, reason] of [
      [3200, null],
      [3199.99, "قرش"],
      [3180, "عملية مرفوضة"],
      [0, "لا شيء تمت تسويته"],
    ] as const) {
      const t = await till();
      const r = await close(fx.cashier.email, t.shiftId, {
        ...exact,
        actualCardAmount: actual,
        ...(reason ? { cardReason: reason } : {}),
      });
      assert.equal(r.status, 200, r.text);

      const card = await recon(t.shiftId, "CARD");
      assert.equal(
        card!.toleranceAmount,
        null,
        `a settlement of ${actual} must not apply a bound`
      );
      assert.equal(
        card!.approvedById,
        null,
        `and the close must not approve its own settlement`
      );
      assert.equal(card!.approvedAt, null);
    }
  });

  test("a configured tender tolerance changes nothing about the close", async () => {
    // The T16 vocabulary still exists and still resolves. It is simply not on
    // this path: an owner who configured a bound in an earlier milestone must
    // not find it silently deciding how their shift closes.
    await db.toleranceRule.deleteMany({ where: { cafeId: fx.cafeId } });
    await db.toleranceRule.create({
      data: {
        cafeId: fx.cafeId,
        scope: "TENDER",
        tenderMethod: "CARD",
        amountTolerance: "100.00",
      },
    });
    try {
      const t = await till();
      const refused = await close(fx.cashier.email, t.shiftId, {
        ...exact,
        actualCardAmount: 3180,
      });
      assert.equal(
        refused.status,
        400,
        "a 20 EGP shortfall inside a 100 EGP bound STILL needs a reason"
      );

      const ok = await close(fx.cashier.email, t.shiftId, {
        ...exact,
        actualCardAmount: 3180,
        cardReason: "عملية مرفوضة",
      });
      assert.equal(ok.status, 200, ok.text);
      assert.equal((await recon(t.shiftId, "CARD"))!.toleranceAmount, null);
      assert.equal(
        (await tenderCases(t.shiftId)).length,
        1,
        "and the case is opened regardless of the configured bound"
      );
    } finally {
      await db.toleranceRule.deleteMany({ where: { cafeId: fx.cafeId } });
    }
  });

  test("no acceptability field is produced anywhere on the settlement", async () => {
    const t = await till();
    await close(fx.cashier.email, t.shiftId, {
      ...exact,
      actualCardAmount: 3180,
      cardReason: "عملية مرفوضة",
    });

    const card = await recon(t.shiftId, "CARD");
    const verdicts = Object.entries(card as Record<string, unknown>).filter(
      ([k, v]) => /tolerance|acceptable|threshold|approved/i.test(k) && v !== null
    );
    assert.deepEqual(
      verdicts,
      [],
      "the close records the difference; whether it was acceptable is the owner's judgement"
    );
  });

  // ────────────────────────── permissions / tenancy ─────────────────────

  test("a cashier from another café cannot settle this shift", async () => {
    const t = await till();
    const r = await close(other.cashier.email, t.shiftId, exact);

    assert.equal(r.status, 403, r.text);
    assert.equal((await shiftRow(t.shiftId)).status, "OPEN");
    assert.deepEqual(await recons(t.shiftId), []);
  });

  test("a manager pinned to another branch cannot settle this shift", async () => {
    const t = await till({ branchId: fx.otherBranchId, cashierId: fx.manager.id });
    // `fx.manager` is pinned to the main branch; the shift is on the annex.
    const r = await close(fx.manager.email, t.shiftId, exact);

    assert.equal(r.status, 403, r.text);
    assert.equal((await shiftRow(t.shiftId)).status, "OPEN");
    assert.deepEqual(await recons(t.shiftId), []);
  });

  test("a waiter cannot settle somebody else's shift", async () => {
    const t = await till();
    const r = await close(fx.waiter.email, t.shiftId, exact);

    assert.equal(r.status, 403, r.text);
    assert.deepEqual(await recons(t.shiftId), []);
  });

  test("the custodian settles their own shift, and a manager may settle any", async () => {
    const mine = await till();
    assert.equal((await close(fx.cashier.email, mine.shiftId, exact)).status, 200);

    const theirs = await till();
    const r = await close(fx.manager.email, theirs.shiftId, exact);
    assert.equal(r.status, 200, r.text);
    assert.equal((await recon(theirs.shiftId, "CARD"))!.submittedById, fx.manager.id);
    assert.equal(
      (await shiftRow(theirs.shiftId)).closedById,
      fx.manager.id,
      "and the settlement is signed by the closer, not the custodian"
    );
  });

  test("a settlement never crosses into another café's records", async () => {
    const mine = await till();
    const theirs = await till({ cafe: other });

    await close(fx.cashier.email, mine.shiftId, exact);
    await close(other.cashier.email, theirs.shiftId, exact);

    for (const row of await recons(mine.shiftId)) {
      assert.equal(row.cafeId, fx.cafeId);
      assert.equal(row.branchId, fx.branchId);
    }
    for (const row of await recons(theirs.shiftId)) {
      assert.equal(row.cafeId, other.cafeId);
    }
  });

  // ───────────────────────── T33 cash regression ────────────────────────

  test("T33 exact / shortage / overage cash behaviour is unchanged", async () => {
    for (const [actual, difference, reason] of [
      [5000, 0, null],
      [4970, -30, "عجز"],
      [5030, 30, "زيادة"],
    ] as const) {
      const t = await till();
      const r = await close(fx.cashier.email, t.shiftId, {
        ...exact,
        actualCashAmount: actual,
        ...(reason ? { reason } : {}),
      });
      assert.equal(r.status, 200, r.text);

      const row = await shiftRow(t.shiftId);
      assert.equal(Number(row.cashDifference), difference);
      assert.equal(row.cashReasonNote, reason);
      assert.equal(row.cashWithinTolerance, null, "still no cash verdict");
      assert.equal(row.cashToleranceAmount, null);
      assert.equal((await cashCases(t.shiftId)).length, difference === 0 ? 0 : 1);
    }
  });

  test("a cash shortage without a reason is still refused, tenders or not", async () => {
    const t = await till();
    const r = await close(fx.cashier.email, t.shiftId, { ...exact, actualCashAmount: 4970 });
    assert.equal(r.status, 400, r.text);
    assert.equal((await shiftRow(t.shiftId)).status, "OPEN");
  });
});
