import assert from "node:assert/strict";
import test from "node:test";
import { loadResaleModule } from "./helpers/resale-offline";
import { api } from "@/lib/client";
const boundaries = {
  "@/lib/api": { ApiError: class extends Error {}, resolveReadScope: () => ({ cafeId: "c", branchId: "b" }) },
  "@/lib/db": { db: {} }, "@/lib/audit": { auditInTransaction: async () => {} },
  "@/lib/ledger": {}, "@/lib/transaction-locks": {}, "@/lib/inventory-freeze": {},
};
test("offline return valuation uses original cost, preserves zero and discloses missing valuation", () => {
  const app = loadResaleModule<typeof import("@/lib/finished-goods-returns")>("src/lib/finished-goods-returns.ts", boundaries);
  const value = app.returnValuation;
  assert.equal(value(2, 2.5).totalCost, 5);
  assert.equal(value(2, 0).totalCost, 0);
  assert.equal(value(2, null).unitCost, null);
  assert.equal(value(2, null).totalCost, null);
  assert.equal(value(2, null).valuation, "UNVALUED");
});

function returnFixture(frozen = false) {
  type ReceiptRow = Record<string, unknown> & { id: string; quantity: number; idempotencyKey: string; appliedAt: Date | null; inventoryTransactionId: string | null };
  const receipts: ReceiptRow[] = [];
  const movements: (Record<string, unknown> & { id: string })[] = [];
  const audits: { details: Record<string, unknown> }[] = [];
  const line = { id: "l", orderId: "o", stockModeSnapshot: "FINISHED_GOOD", stockAcceptedAt: new Date(), finishedStockItemId: "i", finishedStockUnit: "PIECE", finishedStockQuantity: 3, finishedStockCafeId: "c", finishedStockBranchId: "b", finishedStockTransactionId: frozen ? null : "usage", voidedAt: null, kitchenStatus: "SERVED", order: { status: "SERVED", cafeId: "c", branchId: "b" } };
  const tx = {
    $queryRaw: async () => [], orderItem: { findFirst: async () => line, findUniqueOrThrow: async () => line },
    deferredStockDeduction: { findFirst: async () => ({ id: "deferred" }) },
    inventoryTransaction: { findUniqueOrThrow: async ({ where }: { where: { id: string } }) => where.id === "usage" ? { id: "usage", type: "USAGE", quantity: -3, orderId: "o", inventoryItemId: "i", unitCost: 2.5 } : movements.find(m => m.id === where.id) },
    finishedGoodsReturn: {
      findUnique: async ({ where }: { where: { idempotencyScope_idempotencyKey: { idempotencyKey: string } } }) => receipts.find(r => r.idempotencyKey === where.idempotencyScope_idempotencyKey.idempotencyKey) ?? null,
      aggregate: async ({ where }: { where: { id?: { not: string } } }) => ({ _sum: { quantity: receipts.filter(r => r.id !== where.id?.not).reduce((sum, r) => sum + r.quantity, 0) } }),
      findMany: async () => receipts.filter(r => !r.appliedAt),
      update: async ({ where, data }: { where: { id: string }; data: object }) => Object.assign(receipts.find(r => r.id === where.id)!, data),
      create: async ({ data }: { data: object }) => { const row = { appliedAt: null, inventoryTransactionId: null, ...data } as ReceiptRow; receipts.push(row); return row; },
    },
  };
  const app = loadResaleModule<typeof import("@/lib/finished-goods-returns")>("src/lib/finished-goods-returns.ts", { ...boundaries, "@/lib/audit": { auditInTransaction: async (_tx: unknown, audit: { details: Record<string, unknown> }) => { audits.push(audit); } }, "@/lib/transaction-locks": { lockOrders: async () => {} }, "@/lib/inventory-freeze": { acquireInventorySharedLocks: async () => {}, activeFreezeFor: async () => frozen ? { freezeId: "f", handoverId: "h" } : null }, "@/lib/ledger": { lockItemForUpdate: async () => {}, applyStockMutation: async (_tx: unknown, data: object) => { const id = "return" + movements.length; movements.push({ id, ...data }); return { transactionId: id, stockBefore: 1, stockAfter: 3, custodyPeriodId: "incoming", shiftId: "shift" }; } } });
  const request = (quantity: number, key: string, hash = "a".repeat(64)) => (app.recordFinishedGoodsReturn)(tx, { actorSessionUser: { id: "u" }, orderItemId: "l", inventoryItemId: "i", quantity, reason: "Physical goods received", idempotencyScope: "scope", idempotencyKey: key, requestHash: hash });
  return { request, receipts, movements, audits, postQueued: async () => { line.finishedStockTransactionId = "usage"; return app.applyPendingFinishedGoodsReturns(tx, { handoverId: "h", actorId: "receiver" }); } };
}
test("offline receipt replay survives generic response removal; cap counts cumulative receipts", async () => {
  const f = returnFixture();
  const first = await f.request(2, "first-key");
  assert.equal((await f.request(2, "first-key")).receiptId, first.receiptId);
  assert.equal((await f.request(2, "first-key")).replayed, true);
  await f.request(1, "second-key");
  await assert.rejects(() => f.request(1, "third-key"));
  await assert.rejects(() => f.request(2, "first-key", "b".repeat(64)));
  assert.equal(f.receipts.length, 2);
  assert.equal(f.movements.length, 2);
  assert.equal(f.movements[0].totalCost, 5);
  assert.equal(f.movements[0].newCostPerUnit, undefined);
  assert.equal(f.audits.length, 2); // Durable replay adds no new posting evidence.
  assert.equal(f.audits[0].details.receiptId, first.receiptId);
  assert.match(String(f.movements[0].note), new RegExp(first.receiptId));
  assert.equal(f.audits[0].details.originalServedQuantity, 3);
  assert.equal(f.audits[0].details.previousReceivedTotal, 0);
  assert.equal(f.audits[1].details.previousReceivedTotal, 2);
  assert.equal(f.audits[0].details.stockBefore, 1);
  assert.equal(f.audits[0].details.stockAfter, 3);
  assert.equal(f.audits[0].details.postingCustodyPeriodId, "incoming");
  assert.equal(f.audits[0].details.requestHash, "a".repeat(64));
});
test("offline frozen physical receipts reserve quantity and move no saleable stock", async () => {
  const f = returnFixture(true);
  assert.equal((await f.request(2, "frozen-one")).status, "PENDING");
  assert.equal(f.movements.length, 0);
  assert.equal(f.receipts[0].deferredFreezeId, "f");
  assert.equal(f.audits[0].details.receiptId, f.receipts[0].id);
  assert.equal(f.audits[0].details.valuation, "PENDING");
  await assert.rejects(() => f.request(2, "frozen-two"));
});

test("offline queued receipts post original valuation once after gross usage is linked", async () => {
  const f = returnFixture(true);
  const queued = await f.request(2, "frozen-key");
  assert.equal((await f.postQueued()).applied, 1);
  assert.equal((await f.postQueued()).applied, 0);
  assert.equal(f.movements.length, 1);
  assert.equal(f.movements[0].quantity, 2);
  assert.equal(f.movements[0].totalCost, 5);
  assert.equal(f.audits[1].details.previousReceivedTotal, 0);
  assert.equal(f.audits[1].details.deferredHandoverId, "h");
  const replay = await f.request(2, "frozen-key");
  assert.equal(replay.receiptId, queued.receiptId);
  assert.equal(replay.status, "APPLIED");
});

for (const [name, history, revoked] of [["history only", true, false], ["no branch history", false, false], ["revoked grants", true, true]] as const) {
  test("offline historical return permission: " + name, async () => {
    const app = loadResaleModule<typeof import("@/lib/perms/effective")>("src/lib/perms/effective.ts", {
      "@/lib/db": { db: { user: { findUnique: async () => ({ role: "INVENTORY_MANAGER", cafeRoleId: null, cafeRole: null, permissionOverrides: revoked ? [{ permissionKey: "inventory.transactions", allowed: false }, { permissionKey: "inventory.view", allowed: false }] : [] }) }, orderItem: { count: async ({ where }: { where: { order: { cafeId: string; branchId: string } } }) => { assert.equal(where.order.cafeId, "c"); assert.equal(where.order.branchId, "b"); return history ? 1 : 0; } } } },
      "@/lib/cafe-settings": { getCafeSettings: async () => ({ inventoryEnabled: false }) },
    });
    const result = await (app.resolvePermissions)({ id: "u", cafeId: "c", branchId: "b", role: "INVENTORY_MANAGER" });
    assert.equal(result.keys.has("inventory.finished_returns"), history && !revoked);
    assert.equal(result.keys.has("inventory.view"), history && !revoked);
    assert.equal(result.keys.has("inventory.transactions"), false);
    assert.equal(result.keys.has("inventory.edit"), false);
  });
}

test("offline physical-return client retains its request identity after a lost response", async () => {
  const originalFetch = globalThis.fetch;
  const keys: string[] = [];
  globalThis.fetch = async (_url, init) => {
    keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
    if (keys.length === 1) throw new Error("Response lost after receipt commit");
    return Response.json({ receipt: { receiptId: "same", replayed: true } });
  };
  try {
    const request = { method: "POST", body: { type: "RETURN", orderItemId: "resale-line", quantity: 1, note: "Physical piece received" } };
    const endpoint = "/api/inventory/resale-retry/movement";
    await assert.rejects(() => api(endpoint, request));
    await api(endpoint, request);
    assert.ok(keys[0]);
    assert.equal(keys[1], keys[0]);
    await api(endpoint, request);
    assert.notEqual(keys[2], keys[0]);
  } finally { globalThis.fetch = originalFetch; }
});
