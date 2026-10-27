import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { randomUUID } from "node:crypto";
import type { Order } from "@prisma/client";
import type { ResaleLive } from "./helpers/resale-live";

// Real HTTP/PostgreSQL tests only. No import of a DB client until explicitly
// opted in behind provider evidence and the clone-only preflight runner.
describe("Resale remaining SQL/HTTP acceptance", { skip: process.env.RUN_RESALE_CLONE_TESTS !== "1" }, () => {
  let h: typeof import("./helpers/resale-live");
  let db: typeof import("./helpers/db")["db"];
  const fixtures: ResaleLive[] = [];
  before(async () => {
    const { readResaleTarget, resalePreflightVerified } = await import("../scripts/resale-acceptance-guard.mjs"); await readResaleTarget();
    assert.ok(resalePreflightVerified());
    h = await import("./helpers/resale-live"); db = (await import("./helpers/db")).db;
  });
  after(async () => { if (h) for (const f of fixtures) await h.retain(f); if (db) await db.$disconnect(); });
  async function fixture(label: string) { const f = await h.newResaleCafe(label); fixtures.push(f); return f; }
  async function ready(f: ResaleLive, orderId: string) {
    for (const status of ["PREPARING", "READY"]) h.ok(await h.post(f.fx.owner.email, `/api/orders/${orderId}/status`, { status }, randomUUID(), "PATCH"));
  }
  async function qr(f: ResaleLive, quantity = 2) {
    const { BASE } = await import("./helpers/http");
    const response = await fetch(`${BASE}/api/qr/${f.fx.branchId}/orders`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() }, body: JSON.stringify({ customerName: f.fx.marker, tableNumber: "R1", items: [{ productId: f.finished.id, quantity }] }) });
    assert.equal(response.status, 201, await response.text());
    return db.order.findFirstOrThrow({ where: { cafeId: f.fx.cafeId, source: "QR_MENU" }, orderBy: { createdAt: "desc" }, include: { items: true } });
  }
  test("AC02 exact variant/branch binding positive controls and PostgreSQL rejection", async () => {
    const f = await fixture("BINDINGS");
    const variant = await db.productVariant.create({ data: { productId: f.finished.id, name: "specific", price: 12 } });
    const foreignVariant = await db.productVariant.create({ data: { productId: f.prepared.id, name: "foreign", price: 22 } });
    const variantData = { cafeId: f.fx.cafeId, branchId: f.fx.branchId, productId: f.finished.id, variantId: variant.id, inventoryItemId: f.stock.id, unit: "PIECE" as const };
    await db.productStockBinding.create({ data: variantData });
    await assert.rejects(db.productStockBinding.create({ data: variantData }));
    await assert.rejects(db.productStockBinding.create({ data: { ...variantData, variantId: foreignVariant.id } }));
    await assert.rejects(db.productStockBinding.create({ data: { ...variantData, inventoryItemId: f.preparedStock.id, unit: "KG" } }));
    const annex = await db.inventoryItem.create({ data: { cafeId: f.fx.cafeId, branchId: f.fx.otherBranchId, name: "annex", unit: "PIECE" } });
    await db.productStockBinding.create({ data: { ...variantData, branchId: f.fx.otherBranchId, inventoryItemId: annex.id } });
    await assert.rejects(db.inventoryItem.update({ where: { id: f.stock.id }, data: { branchId: f.fx.otherBranchId } }));
  });
  test("AC03 legacy NULL pending approval remains prepared after catalog mode/activity changes", async () => {
    const f = await fixture("LEGACY"); await h.openShift(f.fx);
    const legacy = await db.order.create({ data: { cafeId: f.fx.cafeId, branchId: f.fx.branchId, orderNumber: 1, type: "DINE_IN", source: "QR_MENU", status: "PENDING_WAITER_APPROVAL", approvalStatus: "PENDING_APPROVAL", subtotal: 20, total: 20, remainingAmount: 20, items: { create: { productId: f.prepared.id, productName: f.prepared.name, quantity: 1, unitPrice: 20, lineTotal: 20 } } }, include: { items: true } });
    await db.product.update({ where: { id: f.prepared.id }, data: { stockMode: "FINISHED_GOOD", isActive: false, basePrice: 900 } });
    h.ok(await h.post(f.fx.owner.email, `/api/orders/${legacy.id}/approve`, {})); await ready(f, legacy.id); await h.serve(f, legacy.id);
    const line = await db.orderItem.findUniqueOrThrow({ where: { id: legacy.items[0].id } });
    assert.equal(line.stockModeSnapshot, null); assert.equal(line.stockAcceptedAt, null); assert.equal(line.finishedStockTransactionId, null);
    assert.equal(Number(line.unitPrice), 20); assert.equal(await h.balance(f.stock.id), 30); assert.equal(await h.balance(f.preparedStock.id), 9.8);
  });
  test("AC03 deleted legacy prepared QR retains its existing approval and price behavior", async () => {
    const f = await fixture("LEGACY-DELETED");
    const o = await db.order.create({ data: { cafeId: f.fx.cafeId, branchId: f.fx.branchId, orderNumber: 1, type: "DINE_IN", source: "QR_MENU", status: "PENDING_WAITER_APPROVAL", approvalStatus: "PENDING_APPROVAL", subtotal: 20, total: 20, items: { create: { productId: f.prepared.id, productName: f.prepared.name, quantity: 1, unitPrice: 20, lineTotal: 20 } } }, include: { items: true } });
    await db.product.delete({ where: { id: f.prepared.id } }); h.ok(await h.post(f.fx.owner.email, `/api/orders/${o.id}/approve`, {}));
    const row = await db.orderItem.findUniqueOrThrow({ where: { id: o.items[0].id } }); assert.equal(row.productId, null); assert.equal(row.stockModeSnapshot, null); assert.equal(Number(row.unitPrice), 20); assert.equal(row.finishedStockItemId, null);
    assert.equal(await db.inventoryTransaction.count({ where: { orderId: o.id } }), 0); assert.equal(await h.balance(f.stock.id), 30);
  });
  test("AC04/05 pending QR 2→5→1, removal/new lines and immutable accepted history", async () => {
    const f = await fixture("QR"); await h.openShift(f.fx);
    const o = await qr(f); assert.equal(o.status, "PENDING_WAITER_APPROVAL");
    assert.equal(o.items[0].stockAcceptedAt, null); assert.equal(o.items[0].finishedStockItemId, null);
    for (const quantity of [5, 1]) h.ok(await h.post(f.fx.owner.email, `/api/orders/${o.id}`, { items: [{ id: o.items[0].id, quantity }] }, randomUUID(), "PATCH"));
    h.ok(await h.post(f.fx.owner.email, `/api/orders/${o.id}`, { newItems: [{ productId: f.prepared.id, quantity: 1 }] }, randomUUID(), "PATCH"));
    const added = await db.orderItem.findFirstOrThrow({ where: { orderId: o.id, productId: f.prepared.id } });
    h.ok(await h.post(f.fx.owner.email, `/api/orders/${o.id}`, { items: [{ id: added.id, quantity: 0 }] }, randomUUID(), "PATCH"));
    h.ok(await h.post(f.fx.owner.email, `/api/orders/${o.id}/approve`, {}));
    const accepted = await db.orderItem.findUniqueOrThrow({ where: { id: o.items[0].id } });
    assert.equal(accepted.finishedStockQuantity, 1); assert.equal(accepted.finishedStockItemId, f.stock.id);
    for (const payload of [{ items: [{ id: accepted.id, quantity: 2 }] }, { items: [{ id: accepted.id, quantity: 0 }] }, { newItems: [{ productId: f.finished.id, quantity: 1 }] }]) {
      assert.equal((await h.post(f.fx.owner.email, `/api/orders/${o.id}`, payload, randomUUID(), "PATCH")).status, 400);
    }
    await db.productStockBinding.updateMany({ where: { productId: f.finished.id }, data: { inventoryItemId: f.replacement.id } });
    await db.product.delete({ where: { id: f.finished.id } });
    await ready(f, o.id);
    assert.equal((await h.post(f.fx.owner.email, `/api/orders/${o.id}/status`, { status: "SERVED", itemIds: [accepted.id], quantity: 1 }, randomUUID(), "PATCH")).status, 400);
    await h.serve(f, o.id); assert.equal(await h.balance(f.stock.id), 29); assert.equal(await h.balance(f.replacement.id), 30);
    h.ok(await h.physicalReturn(f, accepted.id, 1)); assert.equal(await h.balance(f.stock.id), 30);
  });
  test("AC04/06/07 POS mixed lines/add-on aggregate and first service survives HTTP retries", async () => {
    const f = await fixture("MIXED"); await h.openShift(f.fx);
    const extra = await db.addOn.create({ data: { cafeId: f.fx.cafeId, name: f.fx.marker + " extra", price: 1 } });
    await db.productAddOn.create({ data: { productId: f.finished.id, addOnId: extra.id } });
    await db.recipe.create({ data: { cafeId: f.fx.cafeId, addOnId: extra.id, items: { create: { inventoryItemId: f.stock.id, quantity: 1, unit: "PIECE" } } } });
    const response = await h.post(f.fx.owner.email, "/api/orders", { branchId: f.fx.branchId, type: "DINE_IN", tableNumber: "M1", collectionMode: "PENDING", items: [{ productId: f.finished.id, quantity: 2 }, { productId: f.finished.id, quantity: 1, addOnIds: [extra.id] }, { productId: f.prepared.id, quantity: 2 }] }); h.ok(response);
    const order = (response.body as { order: Order }).order;
    assert.equal(await db.inventoryTransaction.count({ where: { orderId: order.id } }), 0);
    await ready(f, order.id); await Promise.all([h.serve(f, order.id), h.serve(f, order.id)]);
    const first = await db.order.findUniqueOrThrow({ where: { id: order.id } }); await h.serve(f, order.id);
    const replay = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    assert.equal(replay.servedAt?.getTime(), first.servedAt?.getTime()); assert.equal(replay.servedById, first.servedById);
    assert.ok(replay.servedStockCustodyPeriodId); assert.equal(await h.balance(f.stock.id), 26); assert.equal(await h.balance(f.preparedStock.id), 9.6);
    const usages = await db.inventoryTransaction.findMany({ where: { orderId: order.id, type: "USAGE" } }); assert.equal(usages.length, 2);
    const direct = usages.find(u => u.inventoryItemId === f.stock.id)!; assert.equal(Number(direct.quantity), -4); assert.equal(Number(direct.totalCost), 10);
    const lines = await db.orderItem.findMany({ where: { orderId: order.id, stockModeSnapshot: "FINISHED_GOOD" } }); assert.ok(lines.every(l => l.finishedStockTransactionId === direct.id));
  });
  test("AC04 direct public QR finalizes exact finished identity without an approval round trip", async () => {
    const f = await fixture("QR-DIRECT"); await h.openShift(f.fx);
    await db.qrOrderApprovalSettings.update({ where: { branchId: f.fx.branchId }, data: { approvalMode: "AUTO_CONFIRM" } });
    const o = await qr(f, 2); assert.equal(o.status, "CONFIRMED");
    assert.ok(o.items[0].stockAcceptedAt); assert.equal(o.items[0].finishedStockItemId, f.stock.id); assert.equal(o.items[0].finishedStockQuantity, 2);
    assert.equal(await db.inventoryTransaction.count({ where: { orderId: o.id } }), 0);
    await ready(f, o.id); await h.serve(f, o.id); assert.equal(await h.balance(f.stock.id), 28);
  });
  test("AC14 revoked create, approve and menu grants deny initial requests and cached replay", async () => {
    const f = await fixture("REVOKED"); await h.openShift(f.fx);
    const actor = f.fx.cashier; const saleKey = randomUUID();
    for (const permissionKey of ["qr_orders.approve", "menu.edit", "menu.view"]) await db.userPermissionOverride.upsert({ where: { userId_permissionKey: { userId: actor.id, permissionKey } }, create: { userId: actor.id, permissionKey, allowed: true }, update: { allowed: true } });
    const payload = { branchId: f.fx.branchId, type: "DINE_IN", collectionMode: "PENDING", items: [{ productId: f.finished.id, quantity: 1 }] };
    h.ok(await h.post(actor.email, "/api/orders", payload, saleKey));
    const pending = await qr(f); const approveKey = randomUUID();
    h.ok(await h.post(actor.email, `/api/orders/${pending.id}/approve`, {}, approveKey));
    const otherPending = await qr(f); const menuKey = randomUUID();
    h.ok(await h.post(actor.email, `/api/products/${f.finished.id}`, { name: f.finished.name }, menuKey, "PATCH"));
    for (const permissionKey of ["pos.create_order", "qr_orders.approve", "menu.edit", "menu.view"]) {
      await db.userPermissionOverride.upsert({ where: { userId_permissionKey: { userId: actor.id, permissionKey } }, create: { userId: actor.id, permissionKey, allowed: false }, update: { allowed: false } });
    }
    for (const key of [saleKey, randomUUID()]) assert.equal((await h.post(actor.email, "/api/orders", payload, key)).status, 403);
    // Approval has no response cache: the completed target refuses its state
    // before permission evaluation. A still-pending target tests revocation.
    assert.equal((await h.post(actor.email, `/api/orders/${pending.id}/approve`, {}, approveKey)).status, 400);
    assert.equal((await h.post(actor.email, `/api/orders/${otherPending.id}/approve`, {})).status, 403);
    for (const key of [menuKey, randomUUID()]) assert.equal((await h.post(actor.email, `/api/products/${f.finished.id}`, { name: f.finished.name }, key, "PATCH")).status, 403);
    assert.equal(await h.balance(f.stock.id), 30);
  });
  test("AC10/14 durable HTTP replay after generic retention expiry, revocation and branch denial", async () => {
    const f = await fixture("REPLAY"); await h.openShift(f.fx); const o = await h.acceptedOrder(f); await h.serve(f, o.id);
    const line = o.items[0], key = randomUUID(); const first = await h.physicalReturn(f, line.id, 1, key, f.fx.manager.email); h.ok(first);
    await db.idempotencyKey.deleteMany({ where: { key } }); // Only this test's generic response retention, never receipt history.
    const replay = await h.physicalReturn(f, line.id, 1, key, f.fx.manager.email); h.ok(replay);
    assert.deepEqual(replay.body.receipt, { ...(first.body.receipt as object), replayed: true });
    await db.userPermissionOverride.upsert({ where: { userId_permissionKey: { userId: f.fx.manager.id, permissionKey: "inventory.transactions" } }, create: { userId: f.fx.manager.id, permissionKey: "inventory.transactions", allowed: false }, update: { allowed: false } });
    assert.equal((await h.physicalReturn(f, line.id, 1, key, f.fx.manager.email)).status, 403);
    await db.userPermissionOverride.update({ where: { userId_permissionKey: { userId: f.fx.manager.id, permissionKey: "inventory.transactions" } }, data: { allowed: true } });
    await db.user.update({ where: { id: f.fx.manager.id }, data: { branchId: f.fx.otherBranchId } });
    assert.ok((await h.physicalReturn(f, line.id, 1, key, f.fx.manager.email)).status >= 400);
    assert.equal(await db.finishedGoodsReturn.count({ where: { orderItemId: line.id } }), 1);
    assert.equal((await h.post(f.fx.owner.email, `/api/inventory/${f.stock.id}/movement`, { type: "RETURN", quantity: 1, note: "Unlinked bypass attempt" })).status, 409);
  });
  test("AC12/13 real weighted receiving, duplicate confirmation, locked usage and original return/report values", async () => {
    const f = await fixture("RECEIVING"); await h.openShift(f.fx);
    const piece = await db.inventoryItem.create({ data: { cafeId: f.fx.cafeId, branchId: f.fx.branchId, name: f.fx.marker + " received", unit: "PIECE" } });
    await db.productStockBinding.updateMany({ where: { productId: f.finished.id }, data: { inventoryItemId: piece.id } });
    for (const unitCost of [2, 4]) {
      const draft = await h.post(f.fx.owner.email, "/api/purchases", { branchId: f.fx.branchId, items: [{ inventoryItemId: piece.id, quantity: 10, unitCost }] }); h.ok(draft);
      const id = String(draft.body.id); const outcomes = await Promise.all([h.post(f.fx.owner.email, `/api/purchases/${id}/confirm`, {}), h.post(f.fx.owner.email, `/api/purchases/${id}/confirm`, {})]);
      assert.equal(outcomes.filter(r => r.status === 200).length, 1);
      assert.equal(await db.purchasePayment.count({ where: { purchaseInvoiceId: id } }), 0);
    }
    assert.equal(await h.balance(piece.id), 20); assert.equal(Number((await db.inventoryItem.findUniqueOrThrow({ where: { id: piece.id } })).costPerUnit), 3);
    const o = await h.acceptedOrder(f); await h.serve(f, o.id);
    const line = await db.orderItem.findUniqueOrThrow({ where: { id: o.items[0].id } }); const usage = await db.inventoryTransaction.findUniqueOrThrow({ where: { id: line.finishedStockTransactionId! } }); assert.equal(Number(usage.unitCost), 3);
    await db.inventoryItem.update({ where: { id: piece.id }, data: { costPerUnit: 9 } });
    h.ok(await h.post(f.fx.owner.email, `/api/inventory/${piece.id}/movement`, { type: "RETURN", orderItemId: line.id, quantity: 2, note: f.fx.marker + " original cost return" }));
    const returned = await db.inventoryTransaction.findFirstOrThrow({ where: { orderId: o.id, type: "RETURN" } }); assert.equal(Number(returned.totalCost), 6); assert.equal(await h.balance(piece.id), 19);
    assert.equal(Number((await db.inventoryItem.findUniqueOrThrow({ where: { id: piece.id } })).costPerUnit), 9);
    const { as } = await import("./helpers/http"); const report = await as(f.fx.owner.email, `/api/reports/product-cost?branchId=${f.fx.branchId}`); h.ok(report);
    assert.equal(report.body.valuationBasis, "CURRENT_BRANCH_REFERENCE_ESTIMATE"); assert.match(String(report.body.limitation), /not realized order profit/);
  });
  test("AC12 financial refund moves money only and does not imply physical receipt", async () => {
    const f = await fixture("REFUND"); await h.openShift(f.fx); const o = await h.acceptedOrder(f); await h.serve(f, o.id);
    const payment = await h.post(f.fx.cashier.email, "/api/payments", { orderId: o.id, amount: 30, method: "CASH" }); h.ok(payment);
    const collection = await db.payment.findFirstOrThrow({ where: { orderId: o.id, type: "COLLECTION" } });
    const before = await db.orderItem.findUniqueOrThrow({ where: { id: o.items[0].id } });
    const { refundPayment } = await import("@/lib/refunds");
    await refundPayment(collection.id, { ...f.fx.owner, role: "CAFE_OWNER", cafeId: f.fx.cafeId, branchId: null }, f.fx.marker + " refund without returned goods");
    assert.equal(await db.finishedGoodsReturn.count({ where: { orderId: o.id } }), 0); assert.equal(await db.inventoryTransaction.count({ where: { orderId: o.id, type: "RETURN" } }), 0);
    assert.equal(await h.balance(f.stock.id), 27); assert.equal((await db.orderItem.findUniqueOrThrow({ where: { id: o.items[0].id } })).finishedStockTransactionId, before.finishedStockTransactionId);
    h.ok(await h.physicalReturn(f, o.items[0].id, 2)); assert.equal(await h.balance(f.stock.id), 29);
    const { periodFinancials } = await import("@/lib/reporting");
    const financials = await periodFinancials({ cafeId: f.fx.cafeId, branchId: f.fx.branchId, period: { gte: new Date(0) } });
    assert.equal(financials.grossSales, 30); assert.equal(financials.refunds, 30); assert.equal(financials.netSales, 0); assert.equal(financials.netMoneyMovement, 0);
    const movements = await db.inventoryTransaction.findMany({ where: { orderId: o.id } });
    assert.equal(movements.reduce((sum, row) => sum + (row.type === "USAGE" ? Number(row.totalCost) : -Number(row.totalCost)), 0), 2.5, "Three sold and two physically returned: retained ledger consumption cost is one original piece");
  });
  test("AC05 approved whole-item void and order cancellation retain snapshots without restoring pieces", async () => {
    const f = await fixture("VOID-CANCEL"); await h.openShift(f.fx);
    await db.ownerActionSettings.create({ data: { cafeId: f.fx.cafeId, ownerId: f.fx.owner.id } });
    async function approved(action: "VOID_ORDER_ITEM" | "CANCEL_ORDER", orderId: string, orderItemId?: string) {
      const request = await h.post(f.fx.manager.email, "/api/owner-action-requests", { action, orderId, orderItemId, reason: f.fx.marker + " owned cancellation", idempotencyKey: randomUUID() }); h.ok(request);
      const id = (request.body.request as { id: string }).id;
      h.ok(await h.post(f.fx.owner.email, `/api/owner-action-requests/${id}/decision`, { decision: "ACCEPT" }));
      h.ok(await h.post(f.fx.manager.email, `/api/owner-action-requests/${id}/execute`, { idempotencyKey: randomUUID() }));
    }
    const o = await h.acceptedOrder(f, "CONFIRMED", { finished: 3, prepared: 1 });
    await approved("VOID_ORDER_ITEM", o.id, o.items[0].id);
    const voided = await db.orderItem.findUniqueOrThrow({ where: { id: o.items[0].id } });
    assert.ok(voided.voidedAt); assert.equal(voided.quantity, 3); assert.equal(voided.finishedStockQuantity, 3); assert.equal(voided.finishedStockItemId, f.stock.id);
    await ready(f, o.id); await h.serve(f, o.id);
    assert.equal(await h.balance(f.stock.id), 30); assert.equal(await h.balance(f.preparedStock.id), 9.8);
    assert.ok((await h.physicalReturn(f, voided.id, 1)).status >= 400);
    const cancelled = await h.acceptedOrder(f, "CONFIRMED"); await approved("CANCEL_ORDER", cancelled.id);
    assert.equal((await db.order.findUniqueOrThrow({ where: { id: cancelled.id } })).status, "CANCELLED");
    assert.equal((await db.orderItem.findUniqueOrThrow({ where: { id: cancelled.items[0].id } })).finishedStockQuantity, 3);
    assert.equal(await db.inventoryTransaction.count({ where: { orderId: cancelled.id } }), 0); assert.equal(await h.balance(f.stock.id), 30);
  });
  test("AC13 purchases reject foreign branch stock and BOX bindings never convert to PIECE", async () => {
    const f = await fixture("RECEIVING-SCOPE");
    const annex = await db.inventoryItem.create({ data: { cafeId: f.fx.cafeId, branchId: f.fx.otherBranchId, name: f.fx.marker + " annex piece", unit: "PIECE" } });
    assert.ok((await h.post(f.fx.manager.email, "/api/purchases", { branchId: f.fx.branchId, items: [{ inventoryItemId: annex.id, quantity: 10, unitCost: 2 }] })).status >= 400);
    assert.equal(await h.balance(annex.id), 0); assert.equal(await db.inventoryTransaction.count({ where: { inventoryItemId: annex.id } }), 0);
    const box = await db.inventoryItem.create({ data: { cafeId: f.fx.cafeId, branchId: f.fx.branchId, name: f.fx.marker + " box", unit: "BOX" } });
    assert.ok((await h.post(f.fx.owner.email, `/api/products/${f.finished.id}`, { stockBindings: [{ branchId: f.fx.branchId, variantId: null, inventoryItemId: box.id }] }, randomUUID(), "PATCH")).status >= 400);
    await assert.rejects(db.productStockBinding.updateMany({ where: { productId: f.finished.id }, data: { inventoryItemId: box.id, unit: "BOX" } }));
    assert.equal(await h.balance(box.id), 0); assert.equal(await h.balance(f.stock.id), 30);
  });
  test("AC15 pending archive refusal, settled archived returns and gate-off permission narrowing", async () => {
    const f = await fixture("HISTORY"); await h.openShift(f.fx); const o = await h.acceptedOrder(f);
    assert.equal((await h.post(f.fx.owner.email, `/api/inventory/${f.stock.id}`, { archived: true }, randomUUID(), "PATCH")).status, 409);
    await h.serve(f, o.id); h.ok(await h.post(f.fx.owner.email, `/api/inventory/${f.stock.id}`, { archived: true }, randomUUID(), "PATCH"));
    await db.cafeSettings.update({ where: { cafeId: f.fx.cafeId }, data: { finishedGoodsSalesEnabled: false, inventoryEnabled: false } });
    const { as } = await import("./helpers/http"); h.ok(await as(f.fx.manager.email, "/api/inventory?includeArchived=1"));
    h.ok(await h.physicalReturn(f, o.items[0].id, 1, randomUUID(), f.fx.manager.email));
    assert.equal((await h.post(f.fx.manager.email, `/api/inventory/${f.stock.id}/movement`, { type: "WASTE", quantity: 1 })).status, 403);
    assert.equal((await h.post(f.fx.manager.email, `/api/inventory/${f.stock.id}`, { costPerUnit: 1 }, randomUUID(), "PATCH")).status, 403);
    const receipt = await db.finishedGoodsReturn.findFirstOrThrow({ where: { orderItemId: o.items[0].id } });
    await assert.rejects(db.finishedGoodsReturn.delete({ where: { id: receipt.id } }));
    await assert.rejects(db.finishedGoodsReturn.update({ where: { id: receipt.id }, data: { quantity: 2 } }));
    await assert.rejects(db.inventoryTransaction.delete({ where: { id: receipt.inventoryTransactionId! } }));
  });
});
