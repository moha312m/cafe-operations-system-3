import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { PrismaClient } from "@prisma/client";
import type { SessionUser } from "@/lib/auth";

// Opt-in only after RUNTIME_HANDOFF native guard, exact clone identity/marker,
// fresh owner-activity baseline and migration preflight. Never launch a host here.
// Retain this suite's uniquely tagged immutable history; do not purge receipts/usage.
describe("RESALE verified-clone constraints, atomicity and concurrency", { skip: process.env.RUN_RESALE_CLONE_TESTS !== "1" }, () => {
  let db: PrismaClient;
  let runtime: typeof import("@/lib/protected-transaction");
  let locks: typeof import("@/lib/transaction-locks");
  let consumption: typeof import("@/lib/sale-consumption");
  let deduction: typeof import("@/lib/stock-deduction");
  let returns: typeof import("@/lib/finished-goods-returns");
  let actor: SessionUser;
  let cafeId: string, branchId: string, otherBranchId: string, productId: string, stockId: string;
  let number = 0;
  let ownedFixture: import("./helpers/count").CountCafe;
  before(async () => {
    const { readResaleHandoff } = await import("../scripts/resale-acceptance-guard.mjs");
    readResaleHandoff();
    assert.equal(process.env.RESALE_ACCEPTANCE_PREFLIGHT_VERIFIED, "1");
    const url = new URL(process.env.DATABASE_URL ?? "");
    assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.port, "5434"); assert.equal(url.pathname, "/cafe_ops_test");
    const harness = await import("./helpers/db");
    await harness.assertTestDatabase(); db = harness.db;
    const { countCafe } = await import("./helpers/count");
    const fx = await countCafe("RESALE001");
    ownedFixture = fx;
    await (await import("./helpers/resale-live")).journalOwnedCafe(fx, "REGISTERED_BEFORE_ACTIVATION");
    cafeId = fx.cafeId; branchId = fx.branchId; otherBranchId = fx.otherBranchId;
    actor = { ...fx.owner, role: "CAFE_OWNER", cafeId, branchId: null };
    [runtime, locks, consumption, deduction, returns] = await Promise.all([import("@/lib/protected-transaction"), import("@/lib/transaction-locks"), import("@/lib/sale-consumption"), import("@/lib/stock-deduction"), import("@/lib/finished-goods-returns")]);
    await db.cafeSettings.update({ where: { cafeId }, data: { finishedGoodsSalesEnabled: true, inventoryEnabled: true } });
    const category = await db.menuCategory.create({ data: { cafeId, name: fx.marker } });
    const stock = await db.inventoryItem.create({ data: { cafeId, branchId, name: fx.marker + " PIECE", unit: "PIECE", costPerUnit: 2.5 } }); stockId = stock.id;
    productId = (await db.product.create({ data: { cafeId, categoryId: category.id, name: fx.marker + " finished", basePrice: 10, stockMode: "FINISHED_GOOD" } })).id;
    await db.productStockBinding.create({ data: { cafeId, branchId, productId, inventoryItemId: stockId, unit: "PIECE" } });
    const { applyStockMutation } = await import("@/lib/ledger");
    await runtime.protectedTransaction(tx => applyStockMutation(tx, { cafeId, branchId, inventoryItemId: stockId, type: "PURCHASE", quantity: 100, unitCost: 2.5, totalCost: 250, createdById: actor.id, note: "RESALE001 test-owned opening receipt" }), { cafeId, branchId });
    console.log(JSON.stringify({ retainedResaleFixture: fx.marker, cafeId, branchId, stockId, cleanup: "Retain immutable test-owned movements. Whole-clone recovery only under separate recovery procedure." }));
  });
  after(async () => {
    if (db && cafeId) {
      await db.cafeSettings.update({ where: { cafeId }, data: { finishedGoodsSalesEnabled: false } });
      await (await import("./helpers/resale-live")).journalOwnedCafe(ownedFixture, "RETAINED_GATE_OFF");
    }
    if (db) await db.$disconnect();
  });
  async function order(quantity = 3) {
    return runtime.protectedTransaction(async tx => {
    const created = await tx.order.create({ data: { cafeId, branchId, orderNumber: ++number, type: "TAKEAWAY", status: "READY", subtotal: 10 * quantity, total: 10 * quantity, inventoryEnforcementMode: "STRICT", items: { create: { ...consumption.provisionalConsumption({ id: productId, stockMode: "FINISHED_GOOD" }, null), productId, productName: "RESALE001 finished", quantity, unitPrice: 10, lineTotal: 10 * quantity, kitchenStatus: "READY" } } }, include: { items: true } });
    await locks.lockOrders(tx, [created.id]); await consumption.finalizeOrderConsumption(tx, created.id, new Date());
    return tx.order.findUniqueOrThrow({ where: { id: created.id }, include: { items: true } });
    }, { cafeId, branchId });
  }
  async function serve(id: string, failAfterUsage = false) {
    return runtime.protectedTransaction(async tx => {
      await locks.lockOrders(tx, [id]);
      const row = await tx.order.findUniqueOrThrow({ where: { id } });
      if (row.status === "SERVED") return;
      await deduction.deductStockForOrder(tx, id, actor.id);
      if (failAfterUsage) throw new Error("RESALE001 injected rollback after writer/link");
      await tx.orderItem.updateMany({ where: { orderId: id }, data: { kitchenStatus: "SERVED" } });
      await tx.order.update({ where: { id }, data: { status: "SERVED", servedAt: new Date() } });
    }, { cafeId, branchId });
  }
  async function receipt(lineId: string, quantity: number, key: string, hash = "a".repeat(64)) {
    return runtime.protectedTransaction(tx => returns.recordFinishedGoodsReturn(tx, { actorSessionUser: actor, orderItemId: lineId, inventoryItemId: stockId, quantity, reason: "RESALE001 physical pieces received", idempotencyScope: `${cafeId}:${branchId}:${actor.id}:resale-test`, idempotencyKey: key, requestHash: hash }), { cafeId, branchId });
  }
  test("AC02/15 real SQL duplicate base binding, foreign identity and unit mutation fail", async () => {
    await assert.rejects(db.productStockBinding.create({ data: { cafeId, branchId, productId, inventoryItemId: stockId, unit: "PIECE" } }));
    await assert.rejects(db.productStockBinding.create({ data: { cafeId, branchId: otherBranchId, productId, inventoryItemId: stockId, unit: "PIECE" } }));
    await assert.rejects(db.inventoryItem.update({ where: { id: stockId }, data: { unit: "BOX" } }));
  });
  test("AC04/05/15 accepted quantity and stock identity cannot be changed/deleted", async () => {
    const o = await order();
    await assert.rejects(db.orderItem.update({ where: { id: o.items[0].id }, data: { quantity: 4 } }));
    await assert.rejects(db.orderItem.update({ where: { id: o.items[0].id }, data: { stockModeSnapshot: null } }));
    await assert.rejects(db.orderItem.delete({ where: { id: o.items[0].id } }));
  });
  test("AC07 real rollback and concurrent same-order retry leave exactly one usage", async () => {
    const o = await order();
    const beforeStock = await db.inventoryItem.findUniqueOrThrow({ where: { id: stockId } });
    await assert.rejects(() => serve(o.id, true));
    assert.equal(await db.inventoryTransaction.count({ where: { orderId: o.id } }), 0);
    assert.equal(Number((await db.inventoryItem.findUniqueOrThrow({ where: { id: stockId } })).currentStock), Number(beforeStock.currentStock));
    await Promise.all([serve(o.id), serve(o.id)]);
    assert.equal(await db.inventoryTransaction.count({ where: { orderId: o.id, type: "USAGE" } }), 1);
    const line = await db.orderItem.findUniqueOrThrow({ where: { id: o.items[0].id } });
    assert.ok(line.finishedStockTransactionId && line.finishedStockDeductedAt);
    await assert.rejects(db.inventoryTransaction.update({ where: { id: line.finishedStockTransactionId }, data: { unitCost: 99 } }));
  });
  test("AC10/12 real durable replay, cumulative cap and original cost", async () => {
    const o = await order(); await serve(o.id);
    await db.inventoryItem.update({ where: { id: stockId }, data: { costPerUnit: 9 } });
    const first = await receipt(o.items[0].id, 2, "first-" + o.id);
    assert.equal((await receipt(o.items[0].id, 2, "first-" + o.id)).receiptId, first.receiptId);
    const r = await db.inventoryTransaction.findUniqueOrThrow({ where: { id: first.inventoryTransactionId! } });
    assert.equal(Number(r.unitCost), 2.5); assert.equal(Number(r.totalCost), 5);
    await receipt(o.items[0].id, 1, "last-" + o.id);
    await assert.rejects(() => receipt(o.items[0].id, 1, "excess-" + o.id));
    await assert.rejects(() => receipt(o.items[0].id, 2, "first-" + o.id, "b".repeat(64)));
  });
  test("AC10/14 concurrent receipts cannot exceed original sold quantity", async () => {
    const o = await order(); await serve(o.id);
    const outcomes = await Promise.allSettled([receipt(o.items[0].id, 2, "race-a-" + o.id), receipt(o.items[0].id, 2, "race-b-" + o.id)]);
    assert.equal(outcomes.filter(r => r.status === "fulfilled").length, 1);
    assert.equal((await db.finishedGoodsReturn.aggregate({ where: { orderItemId: o.items[0].id }, _sum: { quantity: true } }))._sum.quantity, 2);
  });
  test("AC08 actual competing orders cannot overdraw the last finished piece even under OVERRIDE_ALL", async () => {
    const { applyStockMutation } = await import("@/lib/ledger");
    const current = await db.inventoryItem.findUniqueOrThrow({ where: { id: stockId } });
    const delta = 1 - Number(current.currentStock);
    if (delta) await runtime.protectedTransaction(tx => applyStockMutation(tx, { cafeId, branchId, inventoryItemId: stockId, type: "ADJUSTMENT", quantity: delta, createdById: actor.id, note: "RESALE001 owned last-piece test boundary" }), { cafeId, branchId });
    const a = await order(1), b = await order(1);
    await db.order.updateMany({ where: { id: { in: [a.id, b.id] } }, data: { inventoryEnforcementMode: "OVERRIDE_ALL" } });
    const outcomes = await Promise.allSettled([serve(a.id), serve(b.id)]);
    assert.equal(outcomes.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(await db.inventoryTransaction.count({ where: { orderId: { in: [a.id, b.id] }, type: "USAGE" } }), 1);
    assert.equal(Number((await db.inventoryItem.findUniqueOrThrow({ where: { id: stockId } })).currentStock), 0);
    await runtime.protectedTransaction(tx => applyStockMutation(tx, { cafeId, branchId, inventoryItemId: stockId, type: "PURCHASE", quantity: 100, unitCost: 9, totalCost: 900, createdById: actor.id, note: "RESALE001 owned replenishment after shortage case" }), { cafeId, branchId });
  });
  test("AC07/10 receipt, RETURN, audit and balance all roll back on an injected post-receipt failure", async () => {
    const o = await order(); await serve(o.id);
    const stock = await db.inventoryItem.findUniqueOrThrow({ where: { id: stockId } });
    const audits = await db.auditLog.count({ where: { cafeId, entityId: o.id } });
    await assert.rejects(() => runtime.protectedTransaction(async tx => {
      await returns.recordFinishedGoodsReturn(tx, { actorSessionUser: actor, orderItemId: o.items[0].id, inventoryItemId: stockId, quantity: 1, reason: "RESALE001 injected receipt rollback", idempotencyScope: `${cafeId}:${actor.id}:rollback`, idempotencyKey: "rollback-" + o.id, requestHash: "c".repeat(64) });
      throw new Error("RESALE001 injected after receipt/audit/ledger");
    }, { cafeId, branchId }));
    assert.equal(await db.finishedGoodsReturn.count({ where: { orderItemId: o.items[0].id } }), 0);
    assert.equal(await db.inventoryTransaction.count({ where: { orderId: o.id, type: "RETURN" } }), 0);
    assert.equal(await db.auditLog.count({ where: { cafeId, entityId: o.id } }), audits);
    assert.equal(Number((await db.inventoryItem.findUniqueOrThrow({ where: { id: stockId } })).currentStock), Number(stock.currentStock));
  });
  test("AC15 gate off stops new acceptance and preserves accepted settlement/returns", async () => {
    const o = await order();
    await db.cafeSettings.update({ where: { cafeId }, data: { finishedGoodsSalesEnabled: false } });
    await assert.rejects(() => order());
    await serve(o.id); await receipt(o.items[0].id, 1, "gate-off-" + o.id);
    await db.cafeSettings.update({ where: { cafeId }, data: { finishedGoodsSalesEnabled: true } });
  });
});
