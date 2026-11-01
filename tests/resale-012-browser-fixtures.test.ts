import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import { randomUUID } from "node:crypto";

// A staged fixture operation invoked by the clone-only runner, never npm test.
// Browser actions themselves use the existing CUA harness.
const phase = process.env.RESALE_BROWSER_PHASE;
let db: typeof import("./helpers/db")["db"];
after(async () => { if (db) await db.$disconnect(); });
test("guarded test-owned browser fixture stage", { skip: !phase }, async () => {
  assert.ok(phase);
  const guard = await import("../scripts/resale-acceptance-guard.mjs"); const proof = guard.readResaleHandoff();
  assert.equal(process.env.RESALE_ACCEPTANCE_PREFLIGHT_VERIFIED, "1");
  const file = process.env.RESALE_BROWSER_FIXTURES;
  assert.ok(file); const h = await import("./helpers/resale-live"); db = (await import("./helpers/db")).db;
  const handover = await import("@/lib/handover");
  if (phase === "prepare") {
    assert.equal(fs.existsSync(file), false, "Do not replace an active browser scope");
    const config = await h.newResaleCafe("UI01"); const sales = await h.newResaleCafe("UI02");
    const returns = await h.newResaleCafe("UI03"); const receiving = await h.newResaleCafe("UI04");
    await db.product.update({ where: { id: config.finished.id }, data: { stockMode: "RECIPE" } });
    const variant = await db.productVariant.create({ data: { productId: config.finished.id, name: "original configuration", price: 10 } });
    await h.openShift(sales.fx);
    for (const permissionKey of ["qr_orders.view", "qr_orders.approve", "qr_orders.edit_before_approval", "orders.update_status"]) await db.userPermissionOverride.upsert({ where: { userId_permissionKey: { userId: sales.fx.cashier.id, permissionKey } }, create: { userId: sales.fx.cashier.id, permissionKey, allowed: true }, update: { allowed: true } });
    await db.branch.update({ where: { id: sales.fx.branchId }, data: { publicMenuEnabled: true, menuSlug: "resale-ui" } });
    const shift = await h.openShift(returns.fx);
    const older = await h.acceptedOrder(returns); await h.serve(returns, older.id);
    const unvalued = await h.acceptedOrder(returns, "READY", { finished: 1, prepared: 0 });
    const { protectedTransaction } = await import("@/lib/protected-transaction"); const { lockOrders } = await import("@/lib/transaction-locks"); const { applyStockMutation } = await import("@/lib/ledger");
    await protectedTransaction(async tx => {
      await lockOrders(tx, [unvalued.id]);
      const usage = await applyStockMutation(tx, { cafeId: returns.fx.cafeId, branchId: returns.fx.branchId, inventoryItemId: returns.stock.id, orderId: unvalued.id, type: "USAGE", quantity: -1, unitCost: null, totalCost: null, createdById: returns.fx.owner.id, note: returns.fx.marker + " historical unvalued browser fixture" });
      await tx.orderItem.update({ where: { id: unvalued.items[0].id }, data: { finishedStockDeductedAt: new Date(), finishedStockTransactionId: usage.transactionId } });
    }, { cafeId: returns.fx.cafeId, branchId: returns.fx.branchId });
    await h.serve(returns, unvalued.id);
    const carried = await h.acceptedOrder(returns, "READY", { finished: 3, prepared: 1 });
    const { closeShiftWithSettlement } = await import("@/lib/cash-close");
    const close = await closeShiftWithSettlement({ shiftId: shift.id, actualCash: 100, actorId: returns.fx.cashier.id, closedByManager: false, handoverTarget: "BRANCH_CUSTODY", grants: { handoverSubmit: true, handoverException: true } });
    assert.ok(close.handoverId && close.freezeId); await h.serve(returns, carried.id);
    const piece = await db.inventoryItem.create({ data: { cafeId: receiving.fx.cafeId, branchId: receiving.fx.branchId, name: receiving.fx.marker + " receiving pieces", unit: "PIECE" } });
    await db.productStockBinding.updateMany({ where: { productId: receiving.finished.id }, data: { inventoryItemId: piece.id } });
    const annex = await db.inventoryItem.create({ data: { cafeId: receiving.fx.cafeId, branchId: receiving.fx.otherBranchId, name: receiving.fx.marker + " excluded annex pieces", unit: "PIECE" } });
    const invoices = [];
    for (const unitCost of [2, 4]) {
      const invoiceNumber = receiving.fx.marker + "-" + unitCost;
      const result = await h.post(receiving.fx.owner.email, "/api/purchases", { branchId: receiving.fx.branchId, invoiceNumber, items: [{ inventoryItemId: piece.id, quantity: 10, unitCost }] }); h.ok(result);
      invoices.push({ id: (result.body as { id: string }).id, invoiceNumber });
    }
    async function describe(f: import("./helpers/resale-live").ResaleLive) {
      const cafe = await db.cafe.findUniqueOrThrow({ where: { id: f.fx.cafeId }, select: { slug: true } });
      const branch = await db.branch.findUniqueOrThrow({ where: { id: f.fx.branchId }, select: { name: true, menuSlug: true } });
      await h.journal(f, "BROWSER_SCOPE_PREPARED");
      return { ...f.fx, productId: f.finished.id, productName: f.finished.name, stockId: f.stock.id, stockName: f.stock.name, preparedStockId: f.preparedStock.id, branchName: branch.name, publicPath: `/menu/${cafe.slug}/${branch.menuSlug}` };
    }
    fs.writeFileSync(file, JSON.stringify({ issue: proof.issue, buildId: proof.build.id, at: new Date().toISOString(), status: "PREPARED_NOT_RUN", config: { ...await describe(config), variantId: variant.id }, sales: await describe(sales), returns: { ...await describe(returns), handoverId: close.handoverId, olderLineId: older.items[0].id, deferredLineId: carried.items[0].id, unvaluedLineId: unvalued.items[0].id, initialStock: 26 }, receiving: { ...await describe(receiving), receivedStockId: piece.id, receivedStockName: piece.name, otherBranchStockName: annex.name, invoices } }, null, 2));
    return;
  }
  assert.ok(["finish-returns", "finish"].includes(phase));
  const metadata = JSON.parse(fs.readFileSync(file, "utf8")); assert.equal(metadata.buildId, proof.build.id);
  for (const f of [metadata.config, metadata.sales, metadata.returns, metadata.receiving]) {
    assert.equal((await db.cafe.findUniqueOrThrow({ where: { id: f.cafeId } })).name, f.marker + " cafe");
  }
  const f = metadata.returns;
  if (phase === "finish-returns") {
    const { countSessionId } = await handover.startHandoverCount({ handoverId: f.handoverId, actorId: f.cashier.id, cafeId: f.cafeId, viewerBranchId: f.branchId });
    for (const line of await db.stockCountLine.findMany({ where: { sessionId: countSessionId } })) h.ok(await h.post(f.manager.email, `/api/stock-counts/${countSessionId}/lines/${line.id}`, { countedQuantity: await h.balance(line.inventoryItemId) }, randomUUID(), "PATCH"));
    h.ok(await h.post(f.manager.email, `/api/stock-counts/${countSessionId}/submit`, {}));
    h.ok(await h.post(f.manager.email, `/api/stock-counts/${countSessionId}/confirm`, { idempotencyKey: randomUUID() }));
    await handover.submitHandover({ handoverId: f.handoverId, outgoingUserId: f.cashier.id, cafeId: f.cafeId, viewerBranchId: f.branchId });
    await db.cafeSettings.update({ where: { cafeId: f.cafeId }, data: { finishedGoodsSalesEnabled: false } });
    await handover.acceptToBranchCustody({ handoverId: f.handoverId, managerId: f.manager.id, idempotencyKey: randomUUID(), cafeId: f.cafeId, viewerBranchId: f.branchId });
    assert.equal(await db.finishedGoodsReturn.count({ where: { cafeId: f.cafeId, appliedAt: null } }), 0);
    h.ok(await h.post(f.owner.email, `/api/inventory/${f.stockId}`, { archived: true }, randomUUID(), "PATCH"));
    await db.cafeSettings.update({ where: { cafeId: f.cafeId }, data: { inventoryEnabled: false } });
    metadata.returnSettlement = "POSTED_GATE_OFF";
  } else {
    for (const owned of [metadata.config, metadata.sales, metadata.returns, metadata.receiving]) {
      await db.cafeSettings.update({ where: { cafeId: owned.cafeId }, data: { finishedGoodsSalesEnabled: false } });
      await h.journalOwnedCafe(owned, "BROWSER_RETAINED_GATE_OFF");
    }
    metadata.pendingReturns = await db.finishedGoodsReturn.count({ where: { cafeId: f.cafeId, appliedAt: null } });
    metadata.cleanup = "All owned new-sales flags OFF; immutable histories retained. Any pending receipts require feature-aware settlement, never deletion.";
  }
  fs.writeFileSync(file, JSON.stringify(metadata, null, 2));
});
