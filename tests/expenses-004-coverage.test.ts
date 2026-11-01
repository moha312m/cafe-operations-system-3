// Real source scanner/coverage with query-boundary fixtures only. No DB or posting.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Prisma } from "@prisma/client";
import { shadowCoverage } from "../src/lib/accounting/shadow-projection";

const first = new Date("2026-10-01T10:00:00Z"), second = new Date("2026-10-02T10:00:00Z");
function sources() {
  const empty = { findMany: async () => [] };
  const query = (rows: { id: string; cafeId: string; branchId: string; occurredAt: Date }[]) => ({ findMany: async ({ where }: { where: { cafeId: string; occurredAt: { gte: Date; lt: Date } } }) => rows.filter(r => r.cafeId === where.cafeId && r.occurredAt >= where.occurredAt.gte && r.occurredAt < where.occurredAt.lt) });
  return { moneyMovement: empty, order: empty, orderRevision: empty, payment: empty, cashStorage: empty, cashStorageMovement: empty, shift: empty, purchaseInvoice: empty, purchasePayment: empty, inventoryTransaction: empty,
    operatingExpense: query([{ id: "payout", cafeId: "c", branchId: "a", occurredAt: first }, { id: "foreign", cafeId: "other", branchId: "x", occurredAt: first }]),
    operatingExpenseReturn: query([{ id: "return", cafeId: "c", branchId: "a", occurredAt: second }]),
    accountingEntity: { findUnique: async () => ({ id: "entity" }) }, journalEntry: empty, accountingProjectionIssue: empty,
  } as unknown as Prisma.TransactionClient;
}
test("unsupported expense evidence makes accounting coverage incomplete without posting or leaking another tenant", async () => {
  const result = await shadowCoverage({ cafeId: "c", from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-10-03T00:00:00Z") }, sources());
  assert.equal(result.complete, false);
  assert.deepEqual(result.unpostable.map(e => [e.sourceType, e.sourceKey]), [["OPERATING_EXPENSE", "operating-expense:payout:paid:v1"], ["OPERATING_EXPENSE_RETURN", "operating-expense-return:return:received:v1"]]);
  assert.equal(result.posted, 0);
  assert.equal(result.missing.length, 0);
});
test("a later cash return blocks its own accounting date even when the original payout is outside the window", async () => {
  const result = await shadowCoverage({ cafeId: "c", from: new Date("2026-10-02T00:00:00Z"), to: new Date("2026-10-03T00:00:00Z") }, sources());
  assert.equal(result.complete, false);
  assert.deepEqual(result.unpostable.map(e => e.sourceId), ["return"]);
});
