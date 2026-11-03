// Database-free boundary tests of the REAL authoritative recomputation.
// This checks arithmetic/query integration, not PostgreSQL locks or isolation.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Prisma } from "@prisma/client";
import { recomputeShiftTotals, redactBlindCount } from "../src/lib/shifts";

function source(status = "OPEN", received = "0") {
  const shift = { id: "s", status, openingCashAmount: "1000", expectedCashAmount: "777", totalExpensePayouts: "120", totalExpenseReturns: received };
  let writes = 0;
  const tx = {
    shift: { findUnique: async () => shift, update: async ({ data }: { data: object }) => { writes++; return { ...shift, ...data }; } },
    payment: { findMany: async () => [
      { orderId: "o", amount: "500", method: "CASH", type: "COLLECTION", status: "PAID", amendmentId: null },
      { orderId: "o", amount: "50", method: "CASH", type: "REFUND", status: "PAID", amendmentId: null },
      { orderId: "p", amount: "900", method: "CARD", type: "COLLECTION", status: "PAID", amendmentId: null },
    ] },
    order: { findMany: async () => [{ discountAmount: "0", revisions: [] }] },
    orderRevision: { findMany: async () => [] },
    purchasePayment: { aggregate: async ({ where }: { where: { shiftId: string; fundingSource: string } }) => { assert.deepEqual(where, { shiftId: "s", fundingSource: "DRAWER" }); return { _sum: { amount: "0" } }; } },
    operatingExpense: { aggregate: async ({ where }: { where: object }) => { assert.deepEqual(where, { shiftId: "s" }); return { _sum: { amount: "120" } }; } },
    operatingExpenseReturn: { aggregate: async ({ where }: { where: object }) => { assert.deepEqual(where, { shiftId: "s" }); return { _sum: { amount: received } }; } },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, shift, writes: () => writes };
}
test("the real recomputation retains expense and return effects while card collections and sales stay separate", async () => {
  const fixture = source();
  const first = await recomputeShiftTotals("s", fixture.tx);
  const again = await recomputeShiftTotals("s", fixture.tx);
  assert.equal(String(first!.expectedCashAmount), "1330");
  assert.equal(String(again!.expectedCashAmount), "1330");
  assert.equal(String(first!.totalSales), "1350");
  assert.equal(String(first!.totalRefunds), "50");
  assert.equal(String(first!.totalExpensePayouts), "120");
  const returned = source("OPEN", "20");
  assert.equal(String((await recomputeShiftTotals("s", returned.tx))!.expectedCashAmount), "1350");
});
test("closed and awaiting-handover snapshots are not recomputed or written", async () => {
  for (const status of ["CLOSED", "AWAITING_HANDOVER"]) {
    const fixture = source(status);
    assert.equal(await recomputeShiftTotals("s", fixture.tx), fixture.shift);
    assert.equal(fixture.writes(), 0);
    assert.equal(fixture.shift.expectedCashAmount, "777");
  }
});
test("blind-count responses exclude both expense aggregates and expected cash", () => {
  const visible = redactBlindCount({ totalCardSales: "900", totalWalletSales: "0", expectedCashAmount: "1330", totalExpensePayouts: "120", totalExpenseReturns: "20" }, false);
  assert.equal("expectedCashAmount" in visible, false);
  assert.equal("totalExpensePayouts" in visible, false);
  assert.equal("totalExpenseReturns" in visible, false);
  assert.equal("cardSettlementRequired" in visible && visible.cardSettlementRequired, true);
});
