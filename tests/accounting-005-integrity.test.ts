// ACCOUNTING-005 (G1): the defects found in review stay fixed — stable account
// identity, coverage that sees changed and vanished sources, a close that
// re-checks atomically and coordinates with source writes, event-time
// meaning for advances and refunds, and unknowns kept visible.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, countItem, COUNT_PASSWORD, type CountCafe } from "./helpers/count";
import { as, login, requireServer } from "./helpers/http";
import { addDays, dateStrInTz, zonedDayStart } from "@/lib/date-range";
import { ensureAccountingEntity, syncDefaultChart } from "@/lib/accounting/chart";
import { openPeriod, trialBalance } from "@/lib/accounting/ledger";
import { projectShadowLedger, shadowCoverage } from "@/lib/accounting/shadow-projection";
import { closeChecklist, closeCheckedPeriod } from "@/lib/accounting/close-checklist";
import { inventoryReconciliation } from "@/lib/accounting/subledgers";

after(async () => { await db.$disconnect(); });

let sequence = 0;
const at = (date: string, hour: number) => new Date(zonedDayStart(date).getTime() + hour * 3600_000);
const span = (date: string) => ({ from: zonedDayStart(date), to: zonedDayStart(addDays(date, 1)) });
const daysAgo = (n: number) => addDays(dateStrInTz(new Date()), -n);
async function order(fx: CountCafe, created: Date, total: number, servedAt: Date | null, status: "SERVED" | "CANCELLED" | "PREPARING" = "SERVED") {
  sequence += 1;
  return db.order.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, orderNumber: 9000 + sequence, type: "TAKEAWAY", status, source: "CASHIER_POS", createdById: fx.cashier.id, createdAt: created, servedAt, subtotal: total, total, paidAmount: 0, remainingAmount: 0, paymentStatus: "PAID" } });
}
const pay = (fx: CountCafe, orderId: string, when: Date, amount: number, type: "COLLECTION" | "REFUND" = "COLLECTION", extra: Record<string, unknown> = {}) =>
  db.payment.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, orderId, cashierId: fx.cashier.id, receivedById: fx.cashier.id, amount, method: "CASH", type, status: "PAID", createdAt: when, paidAt: when, ...extra } });
async function balances(cafeId: string) {
  const rows = new Map((await trialBalance({ cafeId })).accounts.map(r => [r.systemKey ?? r.code, r.balance]));
  return (key: string) => rows.get(key) ?? 0;
}
async function waitFor(predicate: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 200; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 25)); }
  assert.fail(`timed out waiting for ${what}`);
}
const advisoryWaiters = async () => (await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory'`)[0].n;

test("system accounts keep their identity through renames and renumbering", { timeout: 30000 }, async () => {
  await requireServer();
  const fx = await countCafe("ACC005CHART");
  try {
    await login(fx.owner.email, COUNT_PASSWORD);
    const entity = await db.$transaction(tx => ensureAccountingEntity(tx, fx.cafeId));
    await db.accountingAccount.updateMany({ where: { entityId: entity.id, systemKey: "INVENTORY" }, data: { code: "1250", name: "المخزون الرئيسي" } });
    await db.accountingAccount.updateMany({ where: { entityId: entity.id, systemKey: "HEADER_ASSETS" }, data: { systemKey: null } }); // books made before headers had keys
    await db.accountingAccount.deleteMany({ where: { entityId: entity.id, systemKey: "INVENTORY_IN_TRANSIT" } }); // its code is now someone else's
    await db.accountingAccount.create({ data: { cafeId: fx.cafeId, entityId: entity.id, code: "1210", name: "عهدة موظفين", type: "ASSET", normalBalance: "DEBIT" } });

    const sync = await db.$transaction(tx => syncDefaultChart(tx, entity));
    assert.deepEqual(sync.created, [], "nothing is recreated");
    assert.deepEqual(sync.adopted, ["HEADER_ASSETS"], "a keyless header at its code is adopted");
    assert.deepEqual(sync.conflicts.map(c => [c.systemKey, c.code]), [["INVENTORY_IN_TRANSIT", "1210"]], "a code taken by the accountant's own account is a conflict, not an adoption");
    const inventory = await db.accountingAccount.findMany({ where: { entityId: entity.id, systemKey: "INVENTORY" } });
    assert.deepEqual(inventory.map(a => [a.code, a.name]), [["1250", "المخزون الرئيسي"]]);

    const milk = await countItem(fx, "milk");
    assert.equal((await as(fx.owner.email, `/api/inventory/${milk.id}/movement`, { method: "POST", headers: { "Idempotency-Key": randomUUID() }, body: JSON.stringify({ type: "PURCHASE", quantity: 2, unitCost: 10 }) })).status, 200);
    const today = dateStrInTz(new Date());
    await projectShadowLedger({ cafeId: fx.cafeId, ...span(today), openMissingPeriods: true });
    const stock = await inventoryReconciliation({ cafeId: fx.cafeId, asOf: today });
    assert.deepEqual({ gl: stock.glInventory, ledger: stock.ledgerValue, unposted: stock.unposted }, { gl: 20, ledger: 20, unposted: 0 }, "the renumbered control account is still found");
    assert.ok(!Number.isNaN(Date.parse(stock.currentValuationAt)), "today's valuation carries the instant it describes");
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});

test("coverage sees a changed source and a source that stopped being an event", { timeout: 60000 }, async () => {
  await requireServer();
  const fx = await countCafe("ACC005COVER");
  try {
    const date = daysAgo(2), w = span(date);
    const o = await order(fx, at(date, 10), 80, at(date, 10.5));
    await pay(fx, o.id, at(date, 11), 80);
    await projectShadowLedger({ cafeId: fx.cafeId, ...w, openMissingPeriods: true });
    assert.equal((await shadowCoverage({ cafeId: fx.cafeId, ...w })).complete, true);

    await db.order.update({ where: { id: o.id }, data: { subtotal: 90, total: 90 } });
    const changed = await shadowCoverage({ cafeId: fx.cafeId, ...w });
    assert.deepEqual(changed.changed.map(c => c.sourceKey), [`sale:${o.id}`], "same key, different payload");
    assert.equal(changed.complete, false);

    await db.order.update({ where: { id: o.id }, data: { subtotal: 80, total: 80, status: "CANCELLED" } });
    const gone = await shadowCoverage({ cafeId: fx.cafeId, ...w });
    assert.deepEqual(gone.disappeared.map(c => c.sourceKey), [`sale:${o.id}`]);
    const run = await projectShadowLedger({ cafeId: fx.cafeId, ...w });
    assert.ok(run.exceptions.some(e => e.sourceKey === `sale:${o.id}` && /قيد عكسي/.test(e.reason)));
    const issue = await db.accountingProjectionIssue.findFirstOrThrow({ where: { cafeId: fx.cafeId, kind: "DISAPPEARED" } });
    assert.equal(issue.resolvedAt, null, "kept until resolved");
    const period = await db.accountingPeriod.findFirstOrThrow({ where: { cafeId: fx.cafeId } });
    const list = await closeChecklist({ cafeId: fx.cafeId, periodId: period.id });
    assert.equal(list.items.find(i => i.key === "not-disappeared")!.status, "blocking");
    assert.equal(list.items.find(i => i.key === "recorded-issues")!.status, "blocking");
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});

async function cleanClosablePeriod(name: string) {
  const fx = await countCafe(name);
  const date = daysAgo(3);
  await db.$transaction(tx => ensureAccountingEntity(tx, fx.cafeId));
  const period = await db.$transaction(tx => openPeriod(tx, { cafeId: fx.cafeId, startsOn: date, endsOn: date }));
  const o = await order(fx, at(date, 9), 40, at(date, 9.5));
  await pay(fx, o.id, at(date, 10), 40);
  await projectShadowLedger({ cafeId: fx.cafeId, ...span(date) });
  return { fx, date, period, o };
}

test("a source write in flight makes the close wait, then the close sees it and refuses", { timeout: 60000 }, async () => {
  await requireServer();
  const { fx, date, period, o } = await cleanClosablePeriod("ACC005GATE");
  let release!: () => void, inserted!: () => void;
  const gate = new Promise<void>(r => { release = r; }), done = new Promise<void>(r => { inserted = r; });
  try {
    assert.equal((await closeChecklist({ cafeId: fx.cafeId, periodId: period.id })).canClose, true, "validated clean");
    const writer = db.$transaction(async tx => { await tx.payment.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, orderId: o.id, cashierId: fx.cashier.id, receivedById: fx.cashier.id, amount: 5, method: "CASH", type: "COLLECTION", status: "PAID", createdAt: at(date, 12), paidAt: at(date, 12) } }); inserted(); await gate; }, { timeout: 20000 });
    await done;
    const close = closeCheckedPeriod({ cafeId: fx.cafeId, periodId: period.id, actorId: fx.owner.id });
    await waitFor(async () => (await advisoryWaiters()) >= 1, "the close to wait on the gate");
    release(); await writer;
    await assert.rejects(close, /مينفعش تقفل الفترة/, "the close re-checked after the write committed");
    assert.equal((await db.accountingPeriod.findUniqueOrThrow({ where: { id: period.id } })).status, "OPEN");
  } finally {
    release();
    await teardownTaggedCafe(fx.cafeId);
  }
});

test("a source write that starts during the close waits for it and becomes a visible late event", { timeout: 60000 }, async () => {
  await requireServer();
  const { fx, date, period, o } = await cleanClosablePeriod("ACC005LATE");
  try {
    let writer: Promise<unknown> | undefined;
    await closeCheckedPeriod({ cafeId: fx.cafeId, periodId: period.id, actorId: fx.owner.id, beforeCommit: async () => {
      writer = pay(fx, o.id, at(date, 13), 7).then(r => r); // a backdated row arriving mid-close (then() sends the lazy query)
      await waitFor(async () => (await advisoryWaiters()) >= 1, "the writer to wait on the gate");
    } });
    await writer;
    assert.equal((await db.accountingPeriod.findUniqueOrThrow({ where: { id: period.id } })).status, "CLOSED");
    const run = await projectShadowLedger({ cafeId: fx.cafeId, ...span(date) });
    const late = run.exceptions.filter(e => /اتقفلت/.test(e.reason));
    assert.equal(late.length, 1, "reported, not absorbed");
    assert.equal(await db.accountingProjectionIssue.count({ where: { cafeId: fx.cafeId, kind: "LATE_EVENT", resolvedAt: null } }), 1);
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});

test("advances, receivables and returns follow the time money moved, not today's status", { timeout: 60000 }, async () => {
  await requireServer();
  const fx = await countCafe("ACC005ADVANCE");
  try {
    const date = daysAgo(2), w = span(date);
    // Paid in full before serving: an advance, applied at serving.
    const a = await order(fx, at(date, 9), 50, at(date, 9.5));
    await pay(fx, a.id, at(date, 9.1), 50);
    // Split: 40 before serving, 60 after.
    const b = await order(fx, at(date, 10), 100, at(date, 10.5));
    await pay(fx, b.id, at(date, 10.1), 40);
    await pay(fx, b.id, at(date, 11), 60);
    // Prepaid, refunded before serving, then cancelled: money in and out of advances.
    const c = await order(fx, at(date, 12), 30, null, "CANCELLED");
    await pay(fx, c.id, at(date, 12.1), 30);
    await pay(fx, c.id, at(date, 12.2), 30, "REFUND");
    // Served, then refunded with no amendment: a sales return.
    const d = await order(fx, at(date, 13), 20, at(date, 13.2));
    await pay(fx, d.id, at(date, 13.3), 20);
    await pay(fx, d.id, at(date, 14), 5, "REFUND");
    // Legacy in-place refund: its date is unknown.
    const e = await order(fx, at(date, 15), 10, at(date, 15.1));
    const legacy = await pay(fx, e.id, at(date, 15.2), 10, "COLLECTION", { status: "REFUNDED" });

    const run = await projectShadowLedger({ cafeId: fx.cafeId, ...w, openMissingPeriods: true });
    assert.deepEqual(run.exceptions.map(x => x.sourceKey), [`payment-refund:${legacy.id}`]);
    assert.match(run.exceptions[0].reason, /تاريخ المرتجع/);
    const g = await balances(fx.cafeId);
    assert.equal(g("CUSTOMER_CREDIT"), 0, "every advance was applied or refunded");
    assert.equal(g("CUSTOMER_RECEIVABLE"), 0, "every served bill was settled");
    assert.equal(g("SALES_RETURNS"), 5);
    assert.equal(g("SALES"), 180);

    // The cancelled order's refund keeps its meaning if the order's status changes later.
    await db.order.update({ where: { id: c.id }, data: { status: "PREPARING" } });
    assert.equal((await shadowCoverage({ cafeId: fx.cafeId, ...w })).changed.length, 0);
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});

test("a cross-branch transfer posts both sides once and nets through transit", { timeout: 60000 }, async () => {
  await requireServer();
  const fx = await countCafe("ACC005TRANSFER");
  try {
    await login(fx.owner.email, COUNT_PASSWORD);
    const other = await db.branch.create({ data: { cafeId: fx.cafeId, name: `${fx.marker} فرع 2` } });
    const beans = await countItem(fx, "beans", { stock: 0, costPerUnit: 8 });
    assert.equal((await as(fx.owner.email, `/api/inventory/${beans.id}/movement`, { method: "POST", headers: { "Idempotency-Key": randomUUID() }, body: JSON.stringify({ type: "PURCHASE", quantity: 5, unitCost: 8 }) })).status, 200);
    const t = await as(fx.owner.email, "/api/inventory/transfer", { method: "POST", headers: { "Idempotency-Key": randomUUID() }, body: JSON.stringify({ inventoryItemId: beans.id, toBranchId: other.id, quantity: 2 }) });
    assert.equal(t.status, 200, t.text);
    const today = dateStrInTz(new Date());
    await projectShadowLedger({ cafeId: fx.cafeId, ...span(today), openMissingPeriods: true });
    const again = await projectShadowLedger({ cafeId: fx.cafeId, ...span(today) });
    assert.equal(again.posted, 0);
    const g = await balances(fx.cafeId);
    assert.equal(g("INVENTORY_IN_TRANSIT"), 0, "out and in net to zero");
    assert.equal(g("INVENTORY"), 40, "the café still holds 5 x 8");
    const source = await trialBalance({ cafeId: fx.cafeId, branchId: fx.branchId });
    const dest = await trialBalance({ cafeId: fx.cafeId, branchId: other.id });
    assert.equal(source.accounts.find(a => a.systemKey === "INVENTORY")!.balance, 24);
    assert.equal(dest.accounts.find(a => a.systemKey === "INVENTORY")!.balance, 16);
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});
