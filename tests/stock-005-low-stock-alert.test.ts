// STOCK-005 — warn before an ingredient runs out, not after.
//
// `minimumStock` defaults to 0, so without a typed minimum the only warning a
// café ever got was "it is gone". The café-wide percent makes "low" a share of
// the item's own most recent delivery. Deliveries here go through the real
// movement route, so the threshold is read from genuine ledger rows.
import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { requireServer, as } from "./helpers/http";
import { countCafe, countItem, type CountCafe } from "./helpers/count";

let fx: CountCafe;

before(async () => {
  await requireServer();
  fx = await countCafe("STOCK005");
});
after(() => teardownTaggedCafe(fx ? [fx.cafeId] : [], [], { disconnect: true }));

type Policy = { mode?: string; lowStockAlertPercent?: number; error?: string };
type InvRow = { id: string; status: string; alertThreshold: number };
type Alerts = {
  percent: number; lowCount: number; outCount: number;
  items: Array<{ id: string; status: string; threshold: number; stock: number; branchName: string }>;
};

const POLICY = "/api/cafe/inventory-policy";
const setPolicy = (body: object, email = fx.owner.email) =>
  as<Policy>(email, POLICY, { method: "PATCH", body: JSON.stringify(body) });
const move = async (id: string, type: "PURCHASE" | "USAGE", quantity: number) => {
  const r = await as(fx.owner.email, `/api/inventory/${id}/movement`, {
    method: "POST", body: JSON.stringify({ type, quantity }),
  });
  assert.equal(r.status, 200, `${type} ${quantity}: ${r.text}`);
};
const rowOf = async (id: string, email = fx.owner.email) => {
  const r = await as<{ items: InvRow[] }>(email, `/api/inventory?branchId=${fx.branchId}`);
  assert.equal(r.status, 200, r.text);
  const row = r.body.items.find((i) => i.id === id);
  assert.ok(row, "item must be listed");
  return row;
};
const alerts = async (email = fx.owner.email) => {
  const r = await as<Alerts>(email, "/api/inventory/alerts");
  assert.equal(r.status, 200, r.text);
  return r.body;
};

describe("STOCK-005 early low-stock warning", () => {
  test("a new café warns at 20% of the last delivery by default", async () => {
    const r = await as<Policy>(fx.owner.email, POLICY);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.lowStockAlertPercent, 20);
  });

  test("an item turns low at the percent of its last delivery, before it runs out", async () => {
    const milk = await countItem(fx, "milk");
    await move(milk.id, "PURCHASE", 10);
    await move(milk.id, "USAGE", 7.5);
    let row = await rowOf(milk.id);
    assert.equal(row.alertThreshold, 2);
    assert.equal(row.status, "ok", "2.5 left is still above 20% of 10");

    await move(milk.id, "USAGE", 0.6);
    row = await rowOf(milk.id);
    assert.equal(row.status, "low", "1.9 left must warn while stock remains");

    const banner = await alerts();
    const listed = banner.items.find((i) => i.id === milk.id);
    assert.ok(listed, "the banner must list the low item");
    assert.equal(listed.status, "low");
    assert.equal(listed.threshold, 2);
    assert.equal(listed.stock, 1.9);

    const dash = await as<{ lowStockItems: Array<{ id: string; min: number }> }>(fx.owner.email, "/api/dashboard");
    assert.equal(dash.status, 200, dash.text);
    assert.equal(dash.body.lowStockItems.find((i) => i.id === milk.id)?.min, 2, "dashboard uses the same threshold");

    await move(milk.id, "PURCHASE", 5);
    row = await rowOf(milk.id);
    assert.equal(row.alertThreshold, 1, "only the MOST RECENT delivery sets the threshold");
    assert.equal(row.status, "ok");
  });

  test("a higher per-item minimum still wins over the percent", async () => {
    const beans = await countItem(fx, "beans");
    await db.inventoryItem.update({ where: { id: beans.id }, data: { minimumStock: "4" } });
    await move(beans.id, "PURCHASE", 10);
    await move(beans.id, "USAGE", 6.5);
    const row = await rowOf(beans.id);
    assert.equal(row.alertThreshold, 4);
    assert.equal(row.status, "low");
  });

  test("an item with no recorded delivery gets no invented threshold", async () => {
    const sugar = await countItem(fx, "sugar", { stock: 0.5 });
    const row = await rowOf(sugar.id);
    assert.equal(row.alertThreshold, 0);
    assert.equal(row.status, "ok");
    const empty = await countItem(fx, "cups", { stock: 0 });
    assert.equal((await rowOf(empty.id)).status, "out");
  });

  test("percent 0 turns the percent rule off and keeps the typed minimum", async () => {
    const syrup = await countItem(fx, "syrup");
    await move(syrup.id, "PURCHASE", 10);
    await move(syrup.id, "USAGE", 9);
    assert.equal((await rowOf(syrup.id)).status, "low");
    try {
      assert.equal((await setPolicy({ lowStockAlertPercent: 0 })).status, 200);
      const row = await rowOf(syrup.id);
      assert.equal(row.alertThreshold, 0);
      assert.equal(row.status, "ok");
    } finally {
      await setPolicy({ lowStockAlertPercent: 20 });
    }
  });

  test("the owner's change is audited in the same write with old and new values", async () => {
    const before = await db.auditLog.count({ where: { cafeId: fx.cafeId, action: "LOW_STOCK_ALERT_PERCENT_CHANGED" } });
    const r = await setPolicy({ lowStockAlertPercent: 35 });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.lowStockAlertPercent, 35);
    assert.equal(r.body.mode, "STRICT", "changing the percent leaves the enforcement mode alone");
    const rows = await db.auditLog.findMany({
      where: { cafeId: fx.cafeId, action: "LOW_STOCK_ALERT_PERCENT_CHANGED" }, orderBy: { createdAt: "desc" },
    });
    assert.equal(rows.length, before + 1);
    const d = rows[0].details as Record<string, unknown>;
    assert.equal(d.oldValue, 20);
    assert.equal(d.newValue, 35);
    assert.equal(rows[0].userId, fx.owner.id);
    assert.equal((await alerts()).percent, 35);

    const modeOnly = await setPolicy({ mode: "STRICT" });
    assert.equal(modeOnly.status, 200, modeOnly.text);
    assert.equal(modeOnly.body.lowStockAlertPercent, 35, "a mode-only change keeps the percent");
    await setPolicy({ lowStockAlertPercent: 20 });
  });

  test("invalid percents and empty changes are refused without writing", async () => {
    for (const bad of [91, -1, 2.5, "20"]) {
      const r = await setPolicy({ lowStockAlertPercent: bad });
      assert.equal(r.status, 400, `${JSON.stringify(bad)}: ${r.text}`);
    }
    assert.equal((await setPolicy({})).status, 400);
    assert.equal((await as<Policy>(fx.owner.email, POLICY)).body.lowStockAlertPercent, 20);
    await assert.rejects(
      db.cafeSettings.update({ where: { cafeId: fx.cafeId }, data: { lowStockAlertPercent: 95 } }),
      "the database enforces the range as well"
    );
  });

  test("only settings.edit may change the percent", async () => {
    for (const email of [fx.manager.email, fx.cashier.email, fx.waiter.email]) {
      const r = await setPolicy({ lowStockAlertPercent: 50 }, email);
      assert.equal(r.status, 403, `${email}: ${r.text}`);
    }
    assert.equal((await as<Policy>(fx.owner.email, POLICY)).body.lowStockAlertPercent, 20);
  });

  test("a branch manager's banner covers only their branch; a cashier has none", async () => {
    const annex = await countItem(fx, "annex-milk", { branchId: fx.otherBranchId, stock: 0 });
    const owner = await alerts();
    assert.ok(owner.items.some((i) => i.id === annex.id), "the unassigned owner sees every branch");
    const manager = await alerts(fx.manager.email);
    assert.ok(!manager.items.some((i) => i.id === annex.id), "another branch's shortage must not leak");
    const cashier = await as(fx.cashier.email, "/api/inventory/alerts");
    assert.equal(cashier.status, 403, cashier.text);
  });

  test("reading alerts writes nothing", async () => {
    const snapshot = () => db.inventoryItem.findMany({
      where: { cafeId: fx.cafeId }, orderBy: { id: "asc" },
      select: { id: true, currentStock: true, ledgerVersion: true, updatedAt: true },
    });
    const beforeItems = await snapshot();
    const beforeTxns = await db.inventoryTransaction.count({ where: { cafeId: fx.cafeId } });
    const beforeAudit = await db.auditLog.count({ where: { cafeId: fx.cafeId } });
    await alerts();
    await alerts(fx.manager.email);
    assert.deepEqual(await snapshot(), beforeItems);
    assert.equal(await db.inventoryTransaction.count({ where: { cafeId: fx.cafeId } }), beforeTxns);
    assert.equal(await db.auditLog.count({ where: { cafeId: fx.cafeId } }), beforeAudit);
  });
});
