import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { randomUUID } from "node:crypto";
import type { ResaleLive } from "./helpers/resale-live";

describe("Resale real mixed carry, deferred thaw and intake races", { skip: process.env.RUN_RESALE_CLONE_TESTS !== "1" }, () => {
  let h: typeof import("./helpers/resale-live");
  let db: typeof import("./helpers/db")["db"];
  let handover: typeof import("@/lib/handover");
  const fixtures: ResaleLive[] = [];
  before(async () => {
    const guard = await import("../scripts/resale-acceptance-guard.mjs"); await guard.readResaleTarget();
    assert.ok(guard.resalePreflightVerified());
    h = await import("./helpers/resale-live"); db = (await import("./helpers/db")).db; handover = await import("@/lib/handover");
  });
  after(async () => { if (h) for (const f of fixtures) await h.retain(f); if (db) await db.$disconnect(); });

  async function setup(target: "SHIFT_TO_SHIFT" | "BRANCH_CUSTODY", mixed: boolean, shortage: boolean, preparedQuantity = 1) {
    const f = await h.newResaleCafe("THAW-" + target); fixtures.push(f);
    const outgoing = await h.openShift(f.fx);
    const older = await h.acceptedOrder(f); await h.serve(f, older.id);
    const carried = mixed ? await h.acceptedOrder(f, "READY", { finished: 3, prepared: preparedQuantity }) : null;
    const { closeShiftWithSettlement } = await import("@/lib/cash-close");
    const closed = await closeShiftWithSettlement({ shiftId: outgoing.id, actualCash: 100, actorId: f.fx.cashier.id, closedByManager: false, handoverTarget: target, grants: { handoverSubmit: true, handoverException: true } });
    assert.ok(closed.handoverId && closed.freezeId); const id = closed.handoverId;
    let recipeProcessedAt: Date | null = null;
    if (carried) {
      const before = await db.order.findUniqueOrThrow({ where: { id: carried.id } });
      assert.ok(before.stockDeductedAt); recipeProcessedAt = before.stockDeductedAt;
      const summary = closed.carriedOrders.find(row => row.orderId === carried.id); assert.ok(summary);
      assert.equal(summary.stockDeductedAtHandover, preparedQuantity > 0); assert.equal(summary.recipesAlreadyProcessed, true); assert.equal(summary.finishedStockPending, true);
      assert.equal(await h.balance(f.stock.id), 27); assert.equal(await h.balance(f.preparedStock.id), 10 - .2 * preparedQuantity);
      if (preparedQuantity) { const recipeUsage = await db.inventoryTransaction.findFirstOrThrow({ where: { orderId: carried.id, inventoryItemId: f.preparedStock.id } }); assert.equal(recipeUsage.shiftId, outgoing.id); }
      await assert.rejects(db.orderItem.update({ where: { id: carried.items[0].id }, data: { quantity: 2 } }));
      const served = await h.serve(f, carried.id); assert.equal(served.body.stockDeferred, true);
      assert.equal((await db.order.findUniqueOrThrow({ where: { id: carried.id } })).stockDeductedAt?.getTime() ?? null, before.stockDeductedAt?.getTime() ?? null);
      assert.equal((await db.orderItem.findUniqueOrThrow({ where: { id: carried.items[0].id } })).finishedStockDeductedAt, null);
      assert.equal((await h.post(f.fx.owner.email, `/api/orders/${carried.id}`, { items: [{ id: carried.items[0].id, quantity: 2 }] }, randomUUID(), "PATCH")).status, 400);
    }
    if (mixed) {
      const oldReceipt = await h.physicalReturn(f, older.items[0].id, 1); h.ok(oldReceipt); assert.equal((oldReceipt.body.receipt as { status: string }).status, "PENDING");
      const currentReceipt = await h.physicalReturn(f, carried!.items[0].id, 1); h.ok(currentReceipt); assert.equal((currentReceipt.body.receipt as { valuation: string }).valuation, "PENDING");
      assert.ok((await h.physicalReturn(f, carried!.items[0].id, 3)).status >= 400, "Queued allowance already reserves one of three served units");
      assert.equal(await h.balance(f.stock.id), 27);
    }
    const start = await handover.startHandoverCount({ handoverId: id, actorId: f.fx.cashier.id, cafeId: f.fx.cafeId, viewerBranchId: f.fx.branchId });
    const sessionId = start.countSessionId;
    const reason = await db.reasonCode.create({ data: { cafeId: f.fx.cafeId, domain: "STOCK", code: "RESALE_COUNT", label: "Resale test physical count" } });
    const lines = await db.stockCountLine.findMany({ where: { sessionId } });
    for (const line of lines) {
      const quantity = line.inventoryItemId === f.stock.id && shortage ? 1 : await h.balance(line.inventoryItemId);
      h.ok(await h.post(f.fx.manager.email, `/api/stock-counts/${sessionId}/lines/${line.id}`, { countedQuantity: quantity }, randomUUID(), "PATCH"));
    }
    h.ok(await h.post(f.fx.manager.email, `/api/stock-counts/${sessionId}/submit`, {}));
    for (const line of await db.stockCountLine.findMany({ where: { sessionId, disposition: { in: ["OUTSIDE_TOLERANCE", "RECOUNT_REQUIRED"] } } })) {
      h.ok(await h.post(f.fx.manager.email, `/api/stock-counts/${sessionId}/lines/${line.id}/accept-variance`, { reasonCodeId: reason.id, note: "Test-owned physical shelf count, excluding segregated returns" }));
    }
    h.ok(await h.post(f.fx.manager.email, `/api/stock-counts/${sessionId}/confirm`, { idempotencyKey: randomUUID() }));
    await handover.submitHandover({ handoverId: id, outgoingUserId: f.fx.cashier.id, cafeId: f.fx.cafeId, viewerBranchId: f.fx.branchId });
    let incomingId: string | null = null, incomingShiftId: string | null = null;
    if (target === "SHIFT_TO_SHIFT") {
      const outgoingActor = await db.user.findUniqueOrThrow({ where: { id: f.fx.cashier.id } });
      const incoming = await db.user.create({ data: { cafeId: f.fx.cafeId, branchId: f.fx.branchId, role: "CASHIER", name: f.fx.marker + " incoming", email: f.fx.marker.toLowerCase() + "-incoming@example.invalid", passwordHash: outgoingActor.passwordHash } });
      incomingId = incoming.id; incomingShiftId = (await h.openShift(f.fx, incoming.id)).id;
      for (const line of lines) await handover.acknowledgeStockLine({ handoverId: id, stockCountLineId: line.id, acknowledgedById: incoming.id, cafeId: f.fx.cafeId, viewerBranchId: f.fx.branchId });
    }
    const key = randomUUID();
    const accept = (seam?: import("@/lib/handover").AcceptanceCheckpoint) => target === "SHIFT_TO_SHIFT"
      ? handover.acceptHandover({ handoverId: id, incomingUserId: incomingId!, incomingShiftId, idempotencyKey: key, cafeId: f.fx.cafeId, viewerBranchId: f.fx.branchId, __afterStep: seam })
      : handover.acceptToBranchCustody({ handoverId: id, managerId: f.fx.manager.id, idempotencyKey: key, cafeId: f.fx.cafeId, viewerBranchId: f.fx.branchId, __afterStep: seam });
    return { f, older, carried, id, sessionId, accept, recipeProcessedAt };
  }

  for (const target of ["SHIFT_TO_SHIFT", "BRANCH_CUSTODY"] as const) {
    test(`AC09 ${target}: pure finished carry evaluates empty recipes but consumes pieces only after thaw`, async () => {
      const s = await setup(target, true, false, 0); await s.accept();
      assert.equal((await db.order.findUniqueOrThrow({ where: { id: s.carried!.id } })).stockDeductedAt?.getTime(), s.recipeProcessedAt?.getTime());
      assert.equal(await h.balance(s.f.preparedStock.id), 10); assert.equal(await h.balance(s.f.stock.id), 26);
      assert.equal(await db.inventoryTransaction.count({ where: { orderId: s.carried!.id, type: "USAGE" } }), 1);
    });
    test(`AC10 ${target}: concurrent frozen intake reserves the cumulative sold allowance`, async () => {
      const s = await setup(target, false, false);
      const responses = await Promise.all([h.physicalReturn(s.f, s.older.items[0].id, 2), h.physicalReturn(s.f, s.older.items[0].id, 2)]);
      assert.equal(responses.filter(r => r.status < 300).length, 1); assert.equal(responses.filter(r => r.status >= 400).length, 1);
      assert.equal(await h.balance(s.f.stock.id), 27); assert.equal(await db.finishedGoodsReturn.count({ where: { orderItemId: s.older.items[0].id, appliedAt: null } }), 1);
      await s.accept(); assert.equal(await h.balance(s.f.stock.id), 29);
    });
    test(`AC11 ${target}: intake waits on actual release gate then posts directly after commit`, async () => {
      const s = await setup(target, false, false);
      let release!: () => void, entered!: (pid: number) => void;
      const gate = new Promise<void>(resolve => { release = resolve; }); const ready = new Promise<number>(resolve => { entered = resolve; });
      const acceptance = s.accept(async (step, tx) => { if (step === (target === "SHIFT_TO_SHIFT" ? 15 : 17)) { const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`; entered(row.pid); await gate; } });
      void acceptance.catch(() => {}); const pid = await Promise.race([ready, acceptance.then(() => { throw new Error("Acceptance ended before the release checkpoint"); })]);
      const intake = h.physicalReturn(s.f, s.older.items[0].id, 1); void intake.catch(() => {});
      try {
        let blocked = false;
        for (let n = 0; n < 60 && !blocked; n++) { const [row] = await db.$queryRaw<{ blocked: boolean }[]>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE ${pid}=ANY(pg_blocking_pids(pid))) AS blocked`; blocked = row.blocked; if (!blocked) await new Promise(resolve => setTimeout(resolve, 10)); }
        assert.equal(blocked, true, "Real PostgreSQL release gate blocks intake");
      } finally { release(); try { await acceptance; } finally { await intake; } }
      h.ok(await intake); const receipt = await db.finishedGoodsReturn.findFirstOrThrow({ where: { orderItemId: s.older.items[0].id } });
      assert.ok(receipt.appliedAt && receipt.inventoryTransactionId); assert.equal(receipt.deferredFreezeId, null); assert.equal(await h.balance(s.f.stock.id), 28);
    });
    test(`AC09/11/12 ${target}: recipe carry, full deferred shortage, segregated original-cost returns, rollback and retry`, async () => {
      const s = await setup(target, true, true);
      const before = await h.balance(s.f.stock.id);
      await db.inventoryItem.update({ where: { id: s.f.stock.id }, data: { costPerUnit: 9 } });
      await db.cafeSettings.update({ where: { cafeId: s.f.fx.cafeId }, data: { finishedGoodsSalesEnabled: false } });
      await assert.rejects(() => s.accept(async step => { if (step === (target === "SHIFT_TO_SHIFT" ? 15 : 17)) throw new Error("Resale injected failure after gross usage and return drain"); }));
      assert.equal(await h.balance(s.f.stock.id), before);
      assert.equal(await db.finishedGoodsReturn.count({ where: { deferredHandoverId: s.id, appliedAt: { not: null } } }), 0);
      assert.equal(await db.inventoryTransaction.count({ where: { orderId: s.carried!.id, inventoryItemId: s.f.stock.id } }), 0);
      assert.equal((await db.inventoryFreeze.findFirstOrThrow({ where: { handoverId: s.id } })).releasedAt, null);
      const accepted = await s.accept(); assert.equal(accepted.status, "COMPLETED");
      const usage = await db.inventoryTransaction.findFirstOrThrow({ where: { orderId: s.carried!.id, inventoryItemId: s.f.stock.id, type: "USAGE" } });
      assert.equal(Number(usage.quantity), -3); assert.equal(Number(usage.unitCost), 9); assert.equal(usage.custodyPeriodId, accepted.incomingStockCustodyId);
      const returns = await db.inventoryTransaction.findMany({ where: { cafeId: s.f.fx.cafeId, type: "RETURN" } });
      assert.equal(returns.length, 2); assert.equal(Number(returns.find(r => r.orderId === s.older.id)!.unitCost), 2.5); assert.equal(Number(returns.find(r => r.orderId === s.carried!.id)!.unitCost), 9);
      assert.equal(await h.balance(s.f.stock.id), 0, "Count excludes held pieces; full -3 then +1/+1, never net-only");
      const shortage = await db.auditLog.findFirstOrThrow({ where: { entityId: s.carried!.id, action: "DEFERRED_FINISHED_STOCK_SHORTAGE" } });
      assert.equal((shortage.details as { deferredSettlementException: boolean }).deferredSettlementException, true);
      const movements = await db.inventoryTransaction.count({ where: { cafeId: s.f.fx.cafeId } });
      await s.accept(); assert.equal(await db.inventoryTransaction.count({ where: { cafeId: s.f.fx.cafeId } }), movements);
      assert.equal(await db.finishedGoodsReturn.count({ where: { deferredHandoverId: s.id, appliedAt: null } }), 0);
    });
    test(`AC11 ${target}: old served return-only order arriving after discovery forces a safe union retry`, async () => {
      const s = await setup(target, false, false);
      let release!: () => void, signal!: (pid: number) => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const entered = new Promise<number>(resolve => { signal = resolve; });
      const blocker = db.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "HandoverSession" WHERE "id"=${s.id} FOR UPDATE`;
        const [pid] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`; signal(pid.pid); await gate;
      }, { timeout: 10_000 });
      const pid = await entered;
      const acceptance = s.accept();
      void acceptance.catch(() => {}); // Observe early rejection while the barrier is being inspected.
      try {
        let waiting = false;
        for (let n = 0; n < 60 && !waiting; n++) {
          const rows = await db.$queryRaw<{ waiting: boolean }[]>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE ${pid}=ANY(pg_blocking_pids(pid))) AS waiting`;
          waiting = rows[0].waiting; if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(waiting, true, "Actual PostgreSQL lock barrier, never mocked timing");
        h.ok(await h.physicalReturn(s.f, s.older.items[0].id, 1));
      } finally { release(); await blocker; await acceptance; }
      await acceptance;
      assert.equal(await db.deferredStockDeduction.count({ where: { orderId: s.older.id } }), 0);
      assert.equal(await db.finishedGoodsReturn.count({ where: { orderItemId: s.older.items[0].id, appliedAt: { not: null } } }), 1);
      assert.equal(await h.balance(s.f.stock.id), 28);
      assert.equal(await db.inventoryTransaction.count({ where: { orderId: s.older.id, type: "RETURN" } }), 1);
    });
  }
});
