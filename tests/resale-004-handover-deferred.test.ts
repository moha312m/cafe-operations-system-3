import assert from "node:assert/strict";
import test from "node:test";
import { loadResaleModule } from "./helpers/resale-offline";
class ApiError extends Error {}
test("offline thaw: carried recipes do not suppress outstanding finished usage", async () => {
  const calls: unknown[] = [];
  let recipeTimestampWrites = 0;
  const app = loadResaleModule<typeof import("@/lib/deferred-deduction")>("src/lib/deferred-deduction.ts", {
    "@/lib/api": { ApiError }, "@/lib/audit": { auditInTransaction: async () => {} },
    "@/lib/ledger": { resolveStockAttribution: async () => ({ custodyPeriodId: "incoming", shiftId: "shift" }) },
    "@/lib/sale-consumption": { hasPendingConsumption: async () => true },
    "@/lib/stock-deduction": { deductStockForOrder: async (...args: unknown[]) => { calls.push(args); return { deducted: [{ name: "piece", quantity: 3 }] }; } },
  });
  const tx = { deferredStockDeduction: { findMany: async () => [{ id: "d", orderId: "o", branchId: "b", order: { stockDeductedAt: new Date() } }], update: async () => {} }, order: { update: async () => { recipeTimestampWrites++; } } };
  await (app.applyDeferredDeductions)(tx, { handoverId: "h", actorId: "u" });
  assert.equal(calls.length, 1);
  assert.equal(((calls[0] as unknown[])[4] as { boundary: string }).boundary, "DEFERRED");
  assert.equal(recipeTimestampWrites, 0);
});
