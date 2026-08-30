// T34 / TENDER-003 — the owner's four acceptance scenarios, end to end.
//
// TENDER-001 states the rules one property at a time. This suite runs the
// exact figures the owner asked to see, through the real HTTP close, in the
// order a shift is actually closed — so the acceptance criteria are executable
// rather than a paragraph somebody has to re-check by hand.
//
//   Expected:  cash 5,000   card 3,200   wallet 1,500
//
//   A  exact everywhere              → three zero variances, no reasons asked
//   B  card 3,180                    → card −20 only, card reason required
//   C  wallet 1,530                  → wallet +30 only, wallet reason required
//   D  card 3,180, wallet 1,530      → −20 and +30, two independent records
//
// Scenario D is the one that matters most: the two differences must stay two
// findings. If anything in the close ever nets them, D is where it shows.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { requireServer, as } from "./helpers/http";
import { countCafe, type CountCafe } from "./helpers/count";

let fx: CountCafe;

before(async () => {
  await requireServer();
  fx = await countCafe("TS003");
});

after(() => teardownTaggedCafe(fx?.cafeId ? [fx.cafeId] : [], [], { disconnect: true }));

let seq = 0;

/** The owner's till: 5,000 expected in cash, 3,200 on card, 1,500 on wallet. */
async function uatShift(): Promise<string> {
  seq += 1;
  const shift = await db.shift.create({
    data: {
      cafeId: fx.cafeId,
      branchId: fx.branchId,
      cashierId: fx.cashier.id,
      shiftNumber: 37000 + seq,
      openingCashAmount: 4000,
      expectedCashAmount: 4000,
    },
  });
  const order = await db.order.create({
    data: {
      cafeId: fx.cafeId,
      branchId: fx.branchId,
      orderNumber: 37000 + seq,
      type: "TAKEAWAY",
      status: "CONFIRMED",
      source: "CASHIER_POS",
      customerName: `${fx.marker}-uat-${seq}`,
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
  assert.equal(Number(fresh!.expectedCashAmount), 5000, "UAT expects 5,000 cash");
  assert.equal(Number(fresh!.totalCardSales), 3200, "UAT expects 3,200 card");
  assert.equal(Number(fresh!.totalWalletSales), 1500, "UAT expects 1,500 wallet");
  return shift.id;
}

const close = (shiftId: string, body: Record<string, unknown>) =>
  as<{ error?: string }>(fx.cashier.email, `/api/shifts/${shiftId}/close`, {
    method: "POST",
    body: JSON.stringify(body),
  });

/** Everything the owner would check after a close, in one shape. */
async function outcome(shiftId: string) {
  const shift = await db.shift.findUniqueOrThrow({ where: { id: shiftId } });
  const rows = await db.tenderReconciliation.findMany({
    where: { shiftId },
    orderBy: { method: "asc" },
  });
  const cases = await db.varianceCase.findMany({ where: { shiftId } });
  const of = (m: "CARD" | "WALLET") => rows.find((r) => r.method === m);
  return {
    status: shift.status,
    cash: {
      expected: Number(shift.expectedCashAmount),
      actual: Number(shift.actualCashAmount),
      variance: Number(shift.cashDifference),
      reason: shift.cashReasonNote,
    },
    card: of("CARD") && {
      expected: Number(of("CARD")!.expectedAmount),
      actual: Number(of("CARD")!.actualAmount),
      variance: Number(of("CARD")!.varianceAmount),
      reason: of("CARD")!.reasonNote,
    },
    wallet: of("WALLET") && {
      expected: Number(of("WALLET")!.expectedAmount),
      actual: Number(of("WALLET")!.actualAmount),
      variance: Number(of("WALLET")!.varianceAmount),
      reason: of("WALLET")!.reasonNote,
    },
    cashCases: cases.filter((c) => c.type === "CASH").length,
    tenderCases: cases.filter((c) => c.type === "TENDER").length,
  };
}

describe("TENDER-003 — the owner's acceptance scenarios", () => {
  test("Scenario A — everything settles exactly", async () => {
    const id = await uatShift();
    const r = await close(id, {
      actualCashAmount: 5000,
      actualCardAmount: 3200,
      actualWalletAmount: 1500,
    });
    assert.equal(r.status, 200, `an exact close asks for nothing more: ${r.text}`);

    const o = await outcome(id);
    assert.equal(o.status, "CLOSED");
    assert.deepEqual(o.cash, { expected: 5000, actual: 5000, variance: 0, reason: null });
    assert.deepEqual(o.card, { expected: 3200, actual: 3200, variance: 0, reason: null });
    assert.deepEqual(o.wallet, { expected: 1500, actual: 1500, variance: 0, reason: null });
    assert.equal(o.cashCases, 0, "nothing happened, so nothing is investigated");
    assert.equal(o.tenderCases, 0);
  });

  test("Scenario B — card settles 20 short", async () => {
    const id = await uatShift();

    const refused = await close(id, {
      actualCashAmount: 5000,
      actualCardAmount: 3180,
      actualWalletAmount: 1500,
    });
    assert.equal(refused.status, 400, "a −20 card difference must be explained");
    assert.equal((await db.shift.findUniqueOrThrow({ where: { id } })).status, "OPEN");

    const r = await close(id, {
      actualCashAmount: 5000,
      actualCardAmount: 3180,
      cardReason: "عملية مرفوضة من الشبكة",
      actualWalletAmount: 1500,
    });
    assert.equal(r.status, 200, r.text);

    const o = await outcome(id);
    assert.equal(o.card!.variance, -20, "card is 20 short");
    assert.equal(o.card!.reason, "عملية مرفوضة من الشبكة");
    assert.equal(o.cash.variance, 0, "and the drawer balanced");
    assert.equal(o.cash.reason, null, "so it is asked to explain nothing");
    assert.equal(o.wallet!.variance, 0);
    assert.equal(o.wallet!.reason, null);
    assert.equal(o.tenderCases, 1, "one difference, one case");
    assert.equal(o.cashCases, 0);
  });

  test("Scenario C — wallet settles 30 over", async () => {
    const id = await uatShift();

    const refused = await close(id, {
      actualCashAmount: 5000,
      actualCardAmount: 3200,
      actualWalletAmount: 1530,
    });
    assert.equal(refused.status, 400, "a +30 wallet difference must be explained too");

    const r = await close(id, {
      actualCashAmount: 5000,
      actualCardAmount: 3200,
      actualWalletAmount: 1530,
      walletReason: "استرداد من المزود",
    });
    assert.equal(r.status, 200, r.text);

    const o = await outcome(id);
    assert.equal(o.wallet!.variance, 30, "wallet is 30 over");
    assert.equal(o.wallet!.reason, "استرداد من المزود");
    assert.equal(o.card!.variance, 0);
    assert.equal(o.card!.reason, null);
    assert.equal(o.cash.variance, 0);
    assert.equal(o.tenderCases, 1);
  });

  test("Scenario D — card 20 short AND wallet 30 over, as two findings", async () => {
    const id = await uatShift();

    const halfExplained = await close(id, {
      actualCashAmount: 5000,
      actualCardAmount: 3180,
      cardReason: "عملية مرفوضة من الشبكة",
      actualWalletAmount: 1530,
    });
    assert.equal(
      halfExplained.status,
      400,
      "explaining the card does not explain the wallet"
    );

    const r = await close(id, {
      actualCashAmount: 5000,
      actualCardAmount: 3180,
      cardReason: "عملية مرفوضة من الشبكة",
      actualWalletAmount: 1530,
      walletReason: "استرداد من المزود",
    });
    assert.equal(r.status, 200, r.text);

    const o = await outcome(id);
    assert.equal(o.card!.variance, -20);
    assert.equal(o.wallet!.variance, 30);
    assert.equal(o.card!.reason, "عملية مرفوضة من الشبكة");
    assert.equal(o.wallet!.reason, "استرداد من المزود");
    assert.equal(o.cash.variance, 0, "the drawer is untouched by either");

    assert.equal(o.tenderCases, 2, "two independent discrepancy records");
    assert.equal(o.cashCases, 0);

    // The netting check, stated explicitly: −20 and +30 must never have
    // become +10 anywhere in the record.
    const cases = await db.varianceCase.findMany({ where: { shiftId: id, type: "TENDER" } });
    const amounts = cases.map((c) => Number(c.amountVariance)).sort((a, b) => a - b);
    assert.deepEqual(amounts, [-20, 30], "each difference kept its own sign and size");
    assert.equal(
      amounts.reduce((a, b) => a + b, 0),
      10,
      "their arithmetic sum is 10 — and that number appears NOWHERE in the record"
    );
    assert.ok(
      !cases.some((c) => Number(c.amountVariance) === 10),
      "a netted +10 case would have destroyed both findings"
    );
  });
});
