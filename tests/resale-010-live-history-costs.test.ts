import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { randomUUID } from "node:crypto";
import type { ResaleLive } from "./helpers/resale-live";

describe("Resale real historical valuation and SQL linkage limits", { skip: process.env.RUN_RESALE_CLONE_TESTS !== "1" }, () => {
  let h: typeof import("./helpers/resale-live");
  let db: typeof import("./helpers/db")["db"];
  const fixtures: ResaleLive[] = [];
  before(async () => {
    const guard = await import("../scripts/resale-acceptance-guard.mjs"); await guard.readResaleTarget(); assert.ok(guard.resalePreflightVerified());
    h = await import("./helpers/resale-live"); db = (await import("./helpers/db")).db;
  });
  after(async () => { if (h) for (const f of fixtures) await h.retain(f); if (db) await db.$disconnect(); });
  async function fixture(label: string) { const f = await h.newResaleCafe(label); fixtures.push(f); await h.openShift(f.fx); return f; }

  for (const cost of [0, null] as const) test(`AC12 original ${cost === null ? "NULL" : "zero"} usage valuation remains exact on real RETURN`, async () => {
    const f = await fixture("VALUATION-" + String(cost)); const o = await h.acceptedOrder(f);
    const { protectedTransaction } = await import("@/lib/protected-transaction"); const { lockOrders } = await import("@/lib/transaction-locks"); const { applyStockMutation } = await import("@/lib/ledger");
    // Historical valuation fixture, written through the actual single writer.
    // A normal newly served order records its locked numeric reference cost.
    await protectedTransaction(async tx => {
      await lockOrders(tx, [o.id]);
      const usage = await applyStockMutation(tx, { cafeId: f.fx.cafeId, branchId: f.fx.branchId, inventoryItemId: f.stock.id, orderId: o.id, type: "USAGE", quantity: -3, unitCost: cost, totalCost: cost, createdById: f.fx.owner.id, note: f.fx.marker + " historical valuation fixture" });
      await tx.orderItem.update({ where: { id: o.items[0].id }, data: { finishedStockDeductedAt: new Date(), finishedStockTransactionId: usage.transactionId } });
    }, { cafeId: f.fx.cafeId, branchId: f.fx.branchId });
    await h.serve(f, o.id);
    const response = await h.physicalReturn(f, o.items[0].id, 2); h.ok(response);
    const receipt = response.body.receipt as { valuation: string; inventoryTransactionId: string };
    assert.equal(receipt.valuation, cost === null ? "UNVALUED" : "VALUED");
    const returned = await db.inventoryTransaction.findUniqueOrThrow({ where: { id: receipt.inventoryTransactionId } });
    assert.equal(returned.unitCost === null ? null : Number(returned.unitCost), cost); assert.equal(returned.totalCost === null ? null : Number(returned.totalCost), cost);
    assert.equal(Number((await db.inventoryItem.findUniqueOrThrow({ where: { id: f.stock.id } })).costPerUnit), 2.5);
    const audit = await db.auditLog.findFirstOrThrow({ where: { entityId: o.id, action: "FINISHED_GOODS_RETURN_POSTED" } });
    assert.equal((audit.details as { valuation: string }).valuation, receipt.valuation);
  });
  test("AC08 cumulative shared USAGE link allocation is serialized by PostgreSQL", async () => {
    const f = await fixture("ALLOCATION"); const first = await h.acceptedOrder(f, "READY", { finished: 10, prepared: 0, finishedLineQuantities: [5, 5] });
    const second = first.items[1];
    const { protectedTransaction } = await import("@/lib/protected-transaction"); const { applyStockMutation } = await import("@/lib/ledger");
    const usage = await protectedTransaction(tx => applyStockMutation(tx, { cafeId: f.fx.cafeId, branchId: f.fx.branchId, inventoryItemId: f.stock.id, orderId: first.id, type: "USAGE", quantity: -5, unitCost: 2.5, totalCost: 12.5, createdById: f.fx.owner.id, note: f.fx.marker + " SQL link-cap fixture" }), { cafeId: f.fx.cafeId, branchId: f.fx.branchId });
    const outcomes = await Promise.allSettled([first.items[0].id, second.id].map(id => db.orderItem.update({ where: { id }, data: { finishedStockDeductedAt: new Date(), finishedStockTransactionId: usage.transactionId } })));
    assert.equal(outcomes.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(await db.orderItem.count({ where: { finishedStockTransactionId: usage.transactionId } }), 1);
    // Settle the remaining component through the actual whole-order service;
    // retained history ends consistent: ten pieces, two usages of five.
    await h.serve(f, first.id); assert.equal(await h.balance(f.stock.id), 20);
    const usages = await db.inventoryTransaction.findMany({ where: { orderId: first.id, type: "USAGE" } }); assert.equal(usages.length, 2); assert.equal(usages.reduce((sum, u) => sum + Number(u.quantity), 0), -10);
  });
  test("AC15 ledger cost mutation racing first linkage yields one coherent original valuation", async () => {
    const f = await fixture("LINK-RACE"); const o = await h.acceptedOrder(f);
    const { protectedTransaction } = await import("@/lib/protected-transaction"); const { applyStockMutation } = await import("@/lib/ledger");
    const usage = await protectedTransaction(tx => applyStockMutation(tx, { cafeId: f.fx.cafeId, branchId: f.fx.branchId, inventoryItemId: f.stock.id, orderId: o.id, type: "USAGE", quantity: -3, unitCost: 2.5, totalCost: 7.5, createdById: f.fx.owner.id, note: f.fx.marker + " pre-link race fixture" }), { cafeId: f.fx.cafeId, branchId: f.fx.branchId });
    const outcomes = await Promise.allSettled([
      db.orderItem.update({ where: { id: o.items[0].id }, data: { finishedStockDeductedAt: new Date(), finishedStockTransactionId: usage.transactionId } }),
      db.inventoryTransaction.update({ where: { id: usage.transactionId }, data: { unitCost: 9, totalCost: 27 } }),
    ]);
    assert.equal(outcomes[0].status, "fulfilled");
    const original = await db.inventoryTransaction.findUniqueOrThrow({ where: { id: usage.transactionId } });
    assert.ok(Number(original.unitCost) === 2.5 || Number(original.unitCost) === 9);
    assert.equal(Number(original.totalCost), Number(original.unitCost) * 3);
    await assert.rejects(db.inventoryTransaction.update({ where: { id: usage.transactionId }, data: { totalCost: 1 } }));
    await h.serve(f, o.id); h.ok(await h.physicalReturn(f, o.items[0].id, 1));
    const returned = await db.inventoryTransaction.findFirstOrThrow({ where: { orderId: o.id, type: "RETURN" } }); assert.equal(Number(returned.unitCost), Number(original.unitCost));
  });
  test("AC15 first linkage racing gross-quantity reduction cannot retain an under-allocated movement", async () => {
    const f = await fixture("LINK-QUANTITY-RACE"); const o = await h.acceptedOrder(f);
    const { protectedTransaction } = await import("@/lib/protected-transaction"); const { applyStockMutation } = await import("@/lib/ledger"); const { lockOrders } = await import("@/lib/transaction-locks");
    const usage = await protectedTransaction(tx => applyStockMutation(tx, { cafeId: f.fx.cafeId, branchId: f.fx.branchId, inventoryItemId: f.stock.id, orderId: o.id, type: "USAGE", quantity: -3, unitCost: 2.5, totalCost: 7.5, createdById: f.fx.owner.id, note: f.fx.marker + " newly-created unlinked constraint fixture" }), { cafeId: f.fx.cafeId, branchId: f.fx.branchId });
    const outcomes = await Promise.allSettled([
      db.orderItem.update({ where: { id: o.items[0].id }, data: { finishedStockDeductedAt: new Date(), finishedStockTransactionId: usage.transactionId } }),
      db.inventoryTransaction.update({ where: { id: usage.transactionId }, data: { quantity: -2, totalCost: 5 } }),
    ]);
    assert.equal(outcomes.filter(r => r.status === "fulfilled").length, 1);
    if (outcomes[0].status === "rejected") {
      assert.equal(outcomes[1].status, "fulfilled");
      // Restore only this seconds-old, still-unlinked SQL constraint fixture
      // before acceptance of any linkage. No referenced history is editable.
      await protectedTransaction(async tx => {
        await lockOrders(tx, [o.id]); assert.equal((await tx.orderItem.findUniqueOrThrow({ where: { id: o.items[0].id } })).finishedStockTransactionId, null);
        await tx.inventoryTransaction.update({ where: { id: usage.transactionId }, data: { quantity: -3, totalCost: 7.5 } });
        await tx.orderItem.update({ where: { id: o.items[0].id }, data: { finishedStockDeductedAt: new Date(), finishedStockTransactionId: usage.transactionId } });
      }, { cafeId: f.fx.cafeId, branchId: f.fx.branchId });
    }
    await assert.rejects(db.inventoryTransaction.update({ where: { id: usage.transactionId }, data: { quantity: -2 } }));
    await h.serve(f, o.id); assert.equal(await h.balance(f.stock.id), 27);
    assert.equal(Number((await db.inventoryTransaction.findUniqueOrThrow({ where: { id: usage.transactionId } })).quantity), -3);
  });
  test("AC04/14 prospective FG refuses missing original variant, foreign tenant catalog and stock", async () => {
    const f = await fixture("IDENTITY"); const foreign = await fixture("FOREIGN");
    const variant = await db.productVariant.create({ data: { productId: f.prepared.id, name: "original", price: 20 } });
    const pending = await db.order.create({ data: { cafeId: f.fx.cafeId, branchId: f.fx.branchId, orderNumber: 1, type: "DINE_IN", status: "PENDING_WAITER_APPROVAL", approvalStatus: "PENDING_APPROVAL", source: "QR_MENU", subtotal: 20, total: 20, items: { create: { productId: f.prepared.id, variantId: variant.id, productName: f.prepared.name, quantity: 1, unitPrice: 20, lineTotal: 20, stockModeSnapshot: "RECIPE", stockProductIdSnapshot: f.prepared.id, stockVariantIdSnapshot: variant.id } } }, include: { items: true } });
    await db.productVariant.delete({ where: { id: variant.id } }); await db.product.update({ where: { id: f.prepared.id }, data: { stockMode: "FINISHED_GOOD" } });
    await db.productStockBinding.create({ data: { cafeId: f.fx.cafeId, branchId: f.fx.branchId, productId: f.prepared.id, inventoryItemId: f.stock.id, unit: "PIECE" } });
    assert.equal((await h.post(f.fx.owner.email, `/api/orders/${pending.id}/approve`, {})).status, 409);
    assert.equal((await db.orderItem.findUniqueOrThrow({ where: { id: pending.items[0].id } })).stockAcceptedAt, null);
    const foreignSale = await h.post(f.fx.owner.email, "/api/orders", { branchId: f.fx.branchId, type: "DINE_IN", collectionMode: "PENDING", items: [{ productId: foreign.finished.id, quantity: 1 }] }); assert.ok(foreignSale.status >= 400);
    const foreignBinding = await h.post(f.fx.owner.email, `/api/products/${f.finished.id}`, { stockBindings: [{ branchId: f.fx.branchId, variantId: null, inventoryItemId: foreign.stock.id }] }, randomUUID(), "PATCH"); assert.ok(foreignBinding.status >= 400);
    assert.equal(await h.balance(foreign.stock.id), 30);
  });
});
