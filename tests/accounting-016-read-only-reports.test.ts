import { after, test } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { as, requireServer } from "./helpers/http";
import { countCafe, countItem, stockReasonCode, type CountCafe } from "./helpers/count";
import { addDays, dateStrInTz, zonedDayStart } from "@/lib/date-range";
import { closePeriod, trialBalance } from "@/lib/accounting/ledger";
import { applyStockMutation } from "@/lib/ledger";

after(() => db.$disconnect());

const today = () => dateStrInTz(new Date());
const post = (body: Record<string, unknown> = {}): RequestInit => ({
  method: "POST", body: JSON.stringify(body),
});

async function sale(fx: CountCafe, orderNumber: number, day: string, total: number, branchId = fx.branchId) {
  const servedAt = new Date(zonedDayStart(day).getTime() + 9 * 3600_000);
  return db.order.create({ data: {
    cafeId: fx.cafeId, branchId, orderNumber, type: "TAKEAWAY", status: "SERVED",
    source: "CASHIER_POS", createdById: fx.cashier.id, createdAt: servedAt, servedAt,
    subtotal: total, total, remainingAmount: total,
  } });
}

async function financialState(cafeId: string) {
  const where = { cafeId };
  const [entities, accounts, periods, journals, runs, lines, movements, balances, inventory] = await Promise.all([
    db.accountingEntity.count({ where }), db.accountingAccount.count({ where }), db.accountingPeriod.count({ where }),
    db.journalEntry.count({ where }), db.accountingProjectionRun.count({ where }), db.journalLine.count({ where }),
    db.inventoryTransaction.count({ where }), trialBalance({ cafeId }),
    db.inventoryItem.findMany({ where, select: { currentStock: true, ledgerVersion: true }, orderBy: { id: "asc" } }),
  ]);
  return { entities, accounts, periods, journals, runs, lines, movements, balances, inventory };
}

test("repeated P&L GETs leave unconfigured books and operational inventory untouched", { timeout: 90000 }, async () => {
  await requireServer();
  const fx = await countCafe("ACC016READ");
  try {
    const day = today();
    await countItem(fx, "stock", { stock: 10 });
    await sale(fx, 501, day, 15);
    const before = await financialState(fx.cafeId);
    for (const flag of ["", "&autoSync=true", "&autoSync=false"]) {
      const res = await as<{ configured: boolean }>(fx.owner.email, `/api/accounting/pnl?from=${day}&to=${day}${flag}`);
      assert.equal(res.status, 200, res.text);
      assert.equal(res.body.configured, false);
    }
    assert.deepEqual(await financialState(fx.cafeId), before);
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});

test("only a café-wide projector can post; reruns preserve journals and closed periods", { timeout: 90000 }, async () => {
  await requireServer();
  const fx = await countCafe("ACC016POST");
  try {
    const day = addDays(today(), -1);
    const request = post({ from: day, to: day });
    const project = "/api/accounting/projection";
    await db.userPermissionOverride.create({ data: { userId: fx.manager.id, permissionKey: "accounting.view", allowed: true } });
    assert.equal((await as(fx.manager.email, project, request)).status, 403);
    assert.equal((await as(fx.manager.email, "/api/accounting/pnl", post())).status, 403);
    for (const permissionKey of ["accounting.project", "accounting.setup"]) {
      await db.userPermissionOverride.create({ data: { userId: fx.manager.id, permissionKey, allowed: true } });
    }
    assert.equal((await as(fx.manager.email, project, request)).status, 403);
    assert.equal((await as(fx.manager.email, "/api/accounting/pnl", post())).status, 403);
    assert.equal((await as(fx.owner.email, project, request)).status, 409, "initialize the chart explicitly first");
    assert.equal((await as(fx.owner.email, "/api/accounting/pnl", post())).status, 200);
    assert.equal((await as(fx.owner.email, project, post({ from: "2026-02-30", to: day }))).status, 400);
    assert.equal((await as(fx.owner.email, `${project}?branchId=${fx.branchId}`, request)).status, 403);

    await sale(fx, 501, day, 15);
    await sale(fx, 501, day, 25, fx.otherBranchId);
    await countItem(fx, "stock", { stock: 10 });
    const before = await financialState(fx.cafeId);
    const reportPath = `/api/accounting/pnl?from=${day}&to=${day}&autoSync=true`;
    for (const email of [fx.owner.email, fx.manager.email, fx.manager.email]) {
      assert.equal((await as(email, reportPath)).status, 200);
    }
    assert.deepEqual(await financialState(fx.cafeId), before);

    const [first, second] = await Promise.all([
      as<{ posted: number; replayed: number; exceptions: unknown[] }>(fx.owner.email, project, request),
      as<{ posted: number; replayed: number; exceptions: unknown[] }>(fx.owner.email, project, request),
    ]);
    assert.equal(first.status, 200, first.text);
    assert.equal(second.status, 200, second.text);
    assert.equal(first.body.posted + second.body.posted, 2);
    assert.equal(first.body.replayed + second.body.replayed, 2);
    assert.deepEqual([...first.body.exceptions, ...second.body.exceptions], []);
    const entries = await db.journalEntry.findMany({ where: { cafeId: fx.cafeId }, include: { lines: true } });
    assert.equal(entries.length, 2);
    assert.ok(entries.every((e) => e.createdById === fx.owner.id));
    assert.deepEqual(new Set(entries.flatMap((e) => e.lines.map((l) => l.branchId))), new Set([fx.branchId, fx.otherBranchId]));
    const afterPost = await financialState(fx.cafeId);
    assert.equal(afterPost.periods, 1);
    assert.equal(afterPost.balances.balanced, true);
    assert.equal(afterPost.balances.totalDebit, 40);
    const scoped = await as<{ branchId: string; kpis: { grossSales: number } }>(fx.manager.email, `${reportPath}&branchId=${fx.otherBranchId}`);
    assert.equal(scoped.status, 200, scoped.text);
    assert.equal(scoped.body.branchId, fx.branchId);
    assert.equal(scoped.body.kpis.grossSales, 15);
    assert.deepEqual(await financialState(fx.cafeId), afterPost);

    await db.$transaction((tx) => closePeriod(tx, { cafeId: fx.cafeId, periodId: entries[0].periodId, actorId: fx.owner.id }));
    await sale(fx, 502, day, 10);
    const closed = await as<{ posted: number; replayed: number; exceptions: { reason: string }[] }>(fx.owner.email, project, request);
    assert.equal(closed.status, 200, closed.text);
    assert.equal(closed.body.posted, 0);
    assert.equal(closed.body.replayed, 2);
    assert.equal(closed.body.exceptions.length, 1);
    assert.match(closed.body.exceptions[0].reason, /فترة اتقفلت/);
    assert.deepEqual((await financialState(fx.cafeId)).balances, afterPost.balances);
    assert.equal(await db.journalEntry.count({ where: { cafeId: fx.cafeId } }), 2);
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});

test("approved count corrections reach stock only through the explicit, replay-safe action", { timeout: 90000 }, async () => {
  await requireServer();
  const fx = await countCafe("ACC016COUNT");
  try {
    const item = await countItem(fx, "milk", { stock: 10, costPerUnit: 2 });
    const count = await db.stockCountSession.create({
      data: {
        cafeId: fx.cafeId, branchId: fx.branchId, type: "FULL", scopeDerivation: "ALL_ELIGIBLE",
        status: "IN_PROGRESS", initiatedById: fx.manager.id,
        lines: { create: [{ inventoryItemId: item.id, unit: "KG" }] },
      },
      include: { lines: true },
    });
    const line = count.lines[0];
    const path = `/api/stock-counts/${count.id}/lines/${line.id}`;
    const captured = await as(fx.cashier.email, path, { method: "PATCH", body: JSON.stringify({ countedQuantity: 10 }) });
    assert.equal(captured.status, 200, captured.text);
    const reason = await stockReasonCode(fx.cafeId, "MISCOUNT", "خطأ في العد");
    const proposed = await as<{ correctionId: string }>(fx.manager.email, `${path}/correction`, post({ newCountedQuantity: 8, reasonCodeId: reason.id, note: "إعادة عد العبوة" }));
    assert.equal(proposed.status, 201, proposed.text);
    const approved = await as(fx.owner.email, `/api/corrections/${proposed.body.correctionId}/approve`, post());
    assert.equal(approved.status, 200, approved.text);

    const before = await financialState(fx.cafeId);
    for (const email of [fx.storekeeper.email, fx.owner.email, fx.storekeeper.email]) {
      const res = await as<{ items: { id: string; currentStock: string }[] }>(email, `/api/inventory?branchId=${fx.branchId}`);
      assert.equal(res.status, 200, res.text);
      assert.equal(Number(res.body.items.find((i) => i.id === item.id)?.currentStock), 10);
    }
    assert.deepEqual(await financialState(fx.cafeId), before);

    // A sale consumed one unit after the original evidence cursor.
    await db.$transaction((tx) => applyStockMutation(tx, {
      cafeId: fx.cafeId, branchId: fx.branchId, inventoryItemId: item.id,
      type: "USAGE", quantity: -1, createdById: fx.cashier.id,
    }));
    await db.stockCountSession.update({ where: { id: count.id }, data: { status: "CONFIRMED", confirmedAt: new Date(), confirmedById: fx.manager.id } });
    await db.stockCountLine.update({ where: { id: line.id }, data: { disposition: "VARIANCE_CONFIRMED" } });

    const apply = `/api/stock-counts/${count.id}/apply-to-stock`;
    assert.equal((await as(fx.storekeeper.email, apply, post())).status, 403);
    const results = await Promise.all([as(fx.manager.email, apply, post()), as(fx.manager.email, apply, post())]);
    for (const res of results) assert.equal(res.status, 200, res.text);
    assert.deepEqual(results.map((r) => r.body.itemsApplied).sort(), [0, 1]);
    assert.equal(Number((await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).currentStock), 7);
    const move = await db.inventoryTransaction.findMany({ where: { cafeId: fx.cafeId, type: "COUNT_REBASE" } });
    assert.deepEqual(move.map((m) => [Number(m.quantity), m.createdById]), [[-2, fx.manager.id]]);
    assert.equal(await db.stockCountRebase.count({ where: { sessionId: count.id } }), 1);
    assert.equal(await db.auditLog.count({ where: { cafeId: fx.cafeId, action: "STOCK_REBASED", userId: fx.manager.id, entityId: item.id } }), 1);
    const evidence = await db.stockCountCorrection.findUniqueOrThrow({ where: { id: proposed.body.correctionId } });
    assert.equal(evidence.reasonCodeId, reason.id);
    assert.equal(evidence.approvedById, fx.owner.id);
    assert.equal(await db.journalEntry.count({ where: { cafeId: fx.cafeId } }), 0);
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});

test("a legacy read-side adjustment is held for reconciliation before applying the same count", { timeout: 90000 }, async () => {
  await requireServer();
  const fx = await countCafe("ACC016LEGACY");
  try {
    const item = await countItem(fx, "milk", { stock: 10, costPerUnit: 2 });
    const now = new Date();
    const count = await db.stockCountSession.create({ data: {
      cafeId: fx.cafeId, branchId: fx.branchId, type: "FULL", scopeDerivation: "ALL_ELIGIBLE",
      status: "CONFIRMED", initiatedById: fx.manager.id, confirmedById: fx.manager.id, confirmedAt: now,
      lines: { create: [{
        inventoryItemId: item.id, unit: "KG", countedAt: now, itemVersion: item.ledgerVersion,
        countedQuantity: 10, effectiveCountedQuantity: 8, expectedQuantity: 10,
        varianceQuantity: -2, disposition: "VARIANCE_CONFIRMED",
      }] },
    } });
    await db.$transaction((tx) => applyStockMutation(tx, {
      inventoryItemId: item.id, cafeId: fx.cafeId, branchId: fx.branchId,
      type: "ADJUSTMENT", quantity: -2, createdById: fx.owner.id,
      note: "مزامنة رصيد المخزن مع تصحيح الجرد المعتمد من المالك",
    }));
    const before = await financialState(fx.cafeId);
    const result = await as<{ error: string }>(fx.manager.email, `/api/stock-counts/${count.id}/apply-to-stock`, post());
    assert.equal(result.status, 409, result.text);
    assert.match(result.body.error, /تسوية سابقة/);
    assert.deepEqual(await financialState(fx.cafeId), before);
    assert.equal(await db.stockCountRebase.count({ where: { sessionId: count.id } }), 0);
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});

test("P&L and inventory GETs preserve missing settings and use the feature defaults", { timeout: 30_000 }, async (t) => {
  await requireServer();
  const fx = await countCafe("ACC016SETTINGS");
  try {
    for (const path of ["/api/accounting/pnl", "/api/inventory"]) {
      await t.test(path, async () => {
        await db.cafeSettings.deleteMany({ where: { cafeId: fx.cafeId } });
        const result = await as(fx.owner.email, path);
        assert.equal(result.status, 200, result.text);
        assert.equal(await db.cafeSettings.count({ where: { cafeId: fx.cafeId } }), 0);
      });
    }
    await db.cafeSettings.upsert({
      where: { cafeId: fx.cafeId },
      create: { cafeId: fx.cafeId, inventoryEnabled: false },
      update: { inventoryEnabled: false },
    });
    assert.equal((await as(fx.owner.email, "/api/inventory")).status, 403);
    assert.equal((await as(fx.owner.email, "/api/accounting/pnl")).status, 200);
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});

test("P&L and inventory GETs enforce projected branch scope without changing assignments", { timeout: 30_000 }, async (t) => {
  await requireServer();
  const fx = await countCafe("ACC016ASSIGN");
  try {
    await db.userPermissionOverride.createMany({
      data: ["accounting.view", "inventory.view"].map((permissionKey) => ({ userId: fx.manager.id, permissionKey, allowed: true })),
    });
    const main = await countItem(fx, "home branch");
    const annex = await countItem(fx, "temporary branch", { branchId: fx.otherBranchId });
    const where = { id: fx.manager.id };
    const select = {
      temporaryBranchId: true, temporaryBranchUntil: true,
      temporaryBranchStartedAt: true, temporaryBranchCancelledAt: true, updatedAt: true,
    } as const;

    for (const expired of [false, true]) {
      const expectedBranch = expired ? fx.branchId : fx.otherBranchId;
      const expectedItem = expired ? main : annex;
      const otherBranch = expired ? fx.otherBranchId : fx.branchId;
      for (const path of ["/api/accounting/pnl", "/api/inventory"]) {
        await t.test(`${path} with ${expired ? "expired" : "pending"} assignment`, async () => {
          const before = await db.user.update({
            where,
            data: {
              temporaryBranchId: fx.otherBranchId,
              temporaryBranchUntil: new Date(Date.now() + (expired ? -60_000 : 3_600_000)),
              temporaryBranchStartedAt: expired ? new Date(Date.now() - 3_600_000) : null,
              temporaryBranchCancelledAt: null,
            },
            select,
          });
          const result = await as<{ branchId?: string; items?: { id: string }[] }>(
            fx.manager.email, `${path}?branchId=${otherBranch}`,
          );
          assert.equal(result.status, 200, result.text);
          if (path.endsWith("/pnl")) assert.equal(result.body.branchId, expectedBranch);
          else assert.deepEqual(result.body.items?.map((item) => item.id), [expectedItem.id]);
          assert.deepEqual(await db.user.findUniqueOrThrow({ where, select }), before);
        });
      }
    }

    await db.user.update({ where, data: { isActive: false } });
    for (const path of ["/api/accounting/pnl", "/api/inventory"]) {
      assert.equal((await as(fx.manager.email, path)).status, 403);
      assert.equal((await as("missing-session", path)).status, 401);
    }
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});


test("periods and reconciliation GETs preserve missing café settings", { timeout: 30_000 }, async (t) => {
  await requireServer();
  const fx = await countCafe("ACC016LIFECYCLEREAD");
  try {
    for (const path of ["/api/accounting/periods", "/api/accounting/reconciliation"]) {
      await t.test(path, async () => {
        await db.cafeSettings.deleteMany({ where: { cafeId: fx.cafeId } });
        const result = await as(fx.owner.email, path);
        assert.equal(result.status, 200, result.text);
        assert.equal(await db.cafeSettings.count({ where: { cafeId: fx.cafeId } }), 0);
      });
    }
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});
