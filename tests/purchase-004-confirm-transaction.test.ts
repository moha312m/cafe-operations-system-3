import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Prisma } from "@prisma/client";
import { db } from "./helpers/db";
import { countCafe, countItem, type CountCafe } from "./helpers/count";
import { as, requireServer } from "./helpers/http";
import { weightedAverageCost } from "@/lib/purchases";

// Confirming a supplier invoice changes stock, cost and the ledger, and its
// two audit actions are the evidence of who did it and what it cost. Those
// must commit together or not at all, a retry after a failure must apply the
// invoice exactly once, and two confirmations sharing items must not
// deadlock. Valuation, units and the response stay as they were.

let fx: CountCafe;
let other: CountCafe;
let handovers = 0;

// Temporary audit-failure hooks are catalog objects in the disposable
// database. Each one is journalled before and after it exists, so an
// interrupted run leaves a record of exactly what to remove.
const JOURNAL_DIR = process.env.TEST_FIXTURE_JOURNAL_DIR ?? path.join(os.tmpdir(), "nextcup-test-fixture-journal");

before(async () => {
  await requireServer();
  fx = await countCafe("ACC01B-PURCHASE004");
  other = await countCafe("ACC01B-PURCHASE004OTHER");
  // Compile the route with a request every version refuses before any write.
  assert.equal((await confirm(fx.owner.email, "missing-invoice")).status, 404);
});

// ACC-01B keeps these cafés: confirmed invoices, stock rows and their audits
// are financial evidence, so the run journals them instead of purging.
after(async () => {
  const dir = process.env.ACC01B_EVIDENCE_DIR;
  if (dir) for (const c of [fx, other]) if (c) fs.appendFileSync(path.join(dir, "retained-fixtures.jsonl"), JSON.stringify({ at: new Date().toISOString(), suite: "purchase-004", marker: c.marker, cafeId: c.cafeId }) + "\n");
  await db.$disconnect();
});

const confirm = (email: string, id: string) =>
  as<Record<string, unknown>>(email, `/api/purchases/${id}/confirm`, { method: "POST", body: "{}" });

async function draft(owner: CountCafe, lines: { item: { id: string }; quantity: number; unitCost: number }[], branchId = owner.branchId) {
  const r = await as<{ id: string }>(owner.owner.email, "/api/purchases", {
    method: "POST",
    body: JSON.stringify({ branchId, items: lines.map((l) => ({ inventoryItemId: l.item.id, quantity: l.quantity, unitCost: l.unitCost })) }),
  });
  assert.equal(r.status, 201, r.text);
  return r.body.id;
}

// Everything a confirmation may change, so "no effect" is one comparison.
async function state(invoiceId: string, itemIds: string[]) {
  const invoice = await db.purchaseInvoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { status: true, confirmedAt: true } });
  const items = await db.inventoryItem.findMany({
    where: { id: { in: itemIds } }, orderBy: { id: "asc" },
    select: { id: true, currentStock: true, costPerUnit: true, ledgerVersion: true },
  });
  const ledger = await db.inventoryTransaction.findMany({
    where: { inventoryItemId: { in: itemIds } }, orderBy: [{ inventoryItemId: "asc" }, { itemVersion: "asc" }],
    select: { inventoryItemId: true, type: true, quantity: true, unitCost: true, totalCost: true, itemVersion: true },
  });
  const confirmations = await db.auditLog.findMany({ where: { action: "PURCHASE_INVOICE_CONFIRMED", entityId: invoiceId } });
  const stockAdded = (await db.auditLog.findMany({
    where: { action: "PURCHASE_STOCK_ADDED", entityId: { in: itemIds } }, orderBy: { createdAt: "asc" },
  })).filter((a) => (a.details as Record<string, unknown>)?.purchaseInvoiceId === invoiceId);
  return {
    invoice: { status: invoice.status, confirmed: invoice.confirmedAt !== null },
    items: items.map((i) => ({ id: i.id, stock: Number(i.currentStock), cost: Number(i.costPerUnit), version: String(i.ledgerVersion) })),
    ledger: ledger.map((r) => ({ ...r, quantity: Number(r.quantity), unitCost: Number(r.unitCost), totalCost: Number(r.totalCost), itemVersion: String(r.itemVersion) })),
    confirmations: confirmations.length,
    stockAdded: stockAdded.map((a) => a.details as Record<string, unknown>),
  };
}

// Holds rows so requests reach their write boundary before any may proceed.
async function hold(lock: (tx: Prisma.TransactionClient) => Promise<unknown>) {
  let locked!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => { locked = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const blocker = db.$transaction(async (tx) => { await lock(tx); locked(); await gate; }, { timeout: 20_000 });
  await entered;
  return { release, blocker };
}
const holdItems = (ids: string[]) => hold((tx) =>
  tx.$queryRaw`SELECT "id" FROM "InventoryItem" WHERE "id" = ANY(${ids}) ORDER BY "id" FOR UPDATE`);

async function lockWaiters(count: number) {
  for (let n = 0; n < 100; n++) {
    const [s] = await db.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`;
    if (s.count >= count) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

async function failingAudit<T>(action: string, entityId: string, run: () => Promise<T>) {
  const fn = "ph1_purchase004_audit_" + randomUUID().replaceAll("-", ""), trigger = fn + "_trg";
  const journal = path.join(JOURNAL_DIR, `${fx.marker}-${fn}.json`);
  const record = (phase: string, objects: { function: boolean; trigger: boolean }) => {
    fs.mkdirSync(JOURNAL_DIR, { recursive: true });
    fs.writeFileSync(journal, JSON.stringify({
      phase, marker: fx.marker, database: "disposable test database only", table: "AuditLog", action, entityId,
      catalogObjects: { function: fn, trigger, created: objects },
      cleanup: "Drop only the named trigger, then the named function; no CASCADE.",
    }, null, 2));
  };
  record("PLANNED", { function: false, trigger: false });
  await db.$executeRawUnsafe(`CREATE FUNCTION ${fn}() RETURNS trigger AS $f$ BEGIN IF NEW."action" = '${action}' AND NEW."entityId" = '${entityId}' THEN RAISE EXCEPTION 'owned purchase audit failure'; END IF; RETURN NEW; END; $f$ LANGUAGE plpgsql`);
  record("FUNCTION_CREATED", { function: true, trigger: false });
  try {
    await db.$executeRawUnsafe(`CREATE TRIGGER ${trigger} BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    record("TRIGGER_CREATED", { function: true, trigger: true });
    try { return await run(); } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER ${trigger} ON "AuditLog"`);
      record("TRIGGER_REMOVED", { function: true, trigger: false });
    }
  } finally {
    await db.$executeRawUnsafe(`DROP FUNCTION ${fn}()`);
    record("REMOVED", { function: false, trigger: false });
  }
}

async function handover(branchId: string) {
  handovers += 1;
  const shift = await db.shift.create({
    data: {
      cafeId: fx.cafeId, branchId, cashierId: fx.owner.id, shiftNumber: 940000 + handovers,
      status: "CLOSED", closedAt: new Date(), openingCashAmount: 0, expectedCashAmount: 0,
    },
  });
  return (await db.handoverSession.create({
    data: {
      cafeId: fx.cafeId, branchId, outgoingShiftId: shift.id, outgoingUserId: fx.owner.id,
      status: "DRAFT",
    },
  })).id;
}

async function frozen<T>(branchId: string, run: () => Promise<T>) {
  const { acquireInventoryFreeze, releaseInventoryFreeze } = await import("@/lib/inventory-freeze");
  // Only simulate an active legacy freeze. A v2 handover never acquires one.
  const handoverId = await handover(branchId);
  await db.$transaction((tx) => acquireInventoryFreeze(tx, { cafeId: fx.cafeId, branchId, handoverId, startedById: fx.owner.id }));
  try { return await run(); } finally {
    await db.$transaction(async (tx) => {
      await releaseInventoryFreeze(tx, { handoverId, actorId: fx.owner.id });
      await tx.handoverSession.update({ where: { id: handoverId }, data: { status: "COMPLETED", completedAt: new Date() } });
    });
  }
}

// Expected rows after one successful confirmation, computed line by line in
// the order the route reads them, exactly as the route values them.
async function expectedAfter(invoiceId: string, before: Awaited<ReturnType<typeof state>>) {
  const lines = await db.purchaseInvoiceItem.findMany({ where: { purchaseInvoiceId: invoiceId } });
  const running = new Map(before.items.map((i) => [i.id, { stock: i.stock, cost: i.cost }]));
  const audits = lines.map((line) => {
    const cur = running.get(line.inventoryItemId)!;
    const qty = Number(line.quantity);
    const newCost = weightedAverageCost(cur.stock, cur.cost, qty, Number(line.unitCost));
    cur.stock = Math.round((cur.stock + qty) * 1000) / 1000;
    cur.cost = newCost;
    return { inventoryItemId: line.inventoryItemId, quantity: qty, newStock: cur.stock, newCostPerUnit: newCost };
  });
  return { lines, audits, items: running };
}

function assertConfirmedOnce(after: Awaited<ReturnType<typeof state>>, expected: Awaited<ReturnType<typeof expectedAfter>>) {
  assert.deepEqual(after.invoice, { status: "CONFIRMED", confirmed: true });
  assert.equal(after.confirmations, 1, "one confirmation audit");
  assert.equal(after.ledger.length, expected.lines.length, "one PURCHASE row per invoice line");
  assert.ok(after.ledger.every((r) => r.type === "PURCHASE"));
  const key = (d: { inventoryItemId: unknown; newStock: unknown }) => `${d.inventoryItemId}:${String(d.newStock).padStart(20, "0")}`;
  const byKey = <T extends { inventoryItemId: unknown; newStock: unknown }>(rows: T[]) => [...rows].sort((x, y) => key(x).localeCompare(key(y)));
  assert.deepEqual(
    byKey(after.stockAdded.map((d) => ({ inventoryItemId: d.inventoryItemId, quantity: d.quantity, newStock: d.newStock, newCostPerUnit: d.newCostPerUnit }))),
    byKey(expected.audits),
    "one stock-added audit per line, with the existing details",
  );
  for (const item of after.items) {
    const e = expected.items.get(item.id)!;
    assert.equal(item.stock, e.stock);
    assert.equal(item.cost, e.cost);
  }
}

test("a failed confirmation audit rolls back the invoice, stock, cost and ledger; the same confirm then succeeds once", { timeout: 30_000 }, async () => {
  const beans = await countItem(fx, "a-beans", { stock: 10 });
  const milk = await countItem(fx, "a-milk", { stock: 4 });
  const id = await draft(fx, [{ item: beans, quantity: 2, unitCost: 460 }, { item: milk, quantity: 1.5, unitCost: 40 }]);
  const before = await state(id, [beans.id, milk.id]);
  const failed = await failingAudit("PURCHASE_INVOICE_CONFIRMED", id, () => confirm(fx.owner.email, id));
  assert.equal(failed.status, 500, failed.text);
  assert.deepEqual(await state(id, [beans.id, milk.id]), before, "nothing survives a missing confirmation audit");
  const expected = await expectedAfter(id, before);
  const retry = await confirm(fx.owner.email, id);
  assert.equal(retry.status, 200, retry.text);
  assert.deepEqual(retry.body, { ok: true, itemsAdded: 2 });
  assertConfirmedOnce(await state(id, [beans.id, milk.id]), expected);
});

test("a failed later stock-added audit rolls back earlier lines and audits; the retry applies once", { timeout: 30_000 }, async () => {
  const first = await countItem(fx, "b-first", { stock: 10 });
  const second = await countItem(fx, "b-second", { stock: 20 });
  const id = await draft(fx, [{ item: first, quantity: 3, unitCost: 470 }, { item: second, quantity: 0.018, unitCost: 100 }]);
  const before = await state(id, [first.id, second.id]);
  const failed = await failingAudit("PURCHASE_STOCK_ADDED", second.id, () => confirm(fx.owner.email, id));
  assert.equal(failed.status, 500, failed.text);
  assert.deepEqual(await state(id, [first.id, second.id]), before, "the first line and both earlier audits rolled back too");
  const expected = await expectedAfter(id, before);
  const retry = await confirm(fx.owner.email, id);
  assert.equal(retry.status, 200, retry.text);
  assertConfirmedOnce(await state(id, [first.id, second.id]), expected);
  assert.equal((await confirm(fx.owner.email, id)).status, 400, "an already confirmed invoice is refused");
  assertConfirmedOnce(await state(id, [first.id, second.id]), expected);
});

test("concurrent confirmations of one invoice have one business effect", { timeout: 30_000 }, async () => {
  const beans = await countItem(fx, "c-beans", { stock: 10 });
  const id = await draft(fx, [{ item: beans, quantity: 2, unitCost: 450 }]);
  const before = await state(id, [beans.id]);
  const expected = await expectedAfter(id, before);
  const held = await hold((tx) => tx.$queryRaw`SELECT "id" FROM "PurchaseInvoice" WHERE "id" = ${id} FOR UPDATE`);
  const requests = [1, 2].map(() => confirm(fx.owner.email, id));
  try {
    assert.ok(await lockWaiters(2), "both confirmations reached the invoice");
  } finally { held.release(); await held.blocker; }
  const responses = await Promise.all(requests);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 400], responses.map((r) => r.text).join(" | "));
  assertConfirmedOnce(await state(id, [beans.id]), expected);
});

test("two invoices listing shared items in opposite order both settle", { timeout: 30_000 }, async () => {
  const a = await countItem(fx, "d-alpha", { stock: 10 });
  const b = await countItem(fx, "d-beta", { stock: 10 });
  const forward = await draft(fx, [{ item: a, quantity: 1, unitCost: 450 }, { item: b, quantity: 2, unitCost: 450 }]);
  const reverse = await draft(fx, [{ item: b, quantity: 3, unitCost: 450 }, { item: a, quantity: 4, unitCost: 450 }]);
  const held = await holdItems([a.id, b.id]);
  const requests = [confirm(fx.owner.email, forward), confirm(fx.owner.email, reverse)];
  try {
    assert.ok(await lockWaiters(2), "both confirmations reached their first item");
  } finally { held.release(); await held.blocker; }
  const responses = await Promise.all(requests);
  assert.deepEqual(responses.map((r) => r.status), [200, 200], responses.map((r) => r.text).join(" | "));
  const after = await state(forward, [a.id, b.id]);
  assert.deepEqual(after.items.map((i) => i.stock).sort(), [15, 15]);
  assert.equal(after.ledger.length, 4);
  assert.equal((await state(reverse, [a.id, b.id])).invoice.status, "CONFIRMED");
});

test("duplicate item lines are valued one after another, not merged", { timeout: 30_000 }, async () => {
  const a = await countItem(fx, "e-alpha", { stock: 10 });
  const b = await countItem(fx, "e-beta", { stock: 5 });
  const id = await draft(fx, [
    { item: a, quantity: 2, unitCost: 460 },
    { item: b, quantity: 1, unitCost: 100 },
    { item: a, quantity: 3, unitCost: 470 },
  ]);
  const before = await state(id, [a.id, b.id]);
  const expected = await expectedAfter(id, before);
  const r = await confirm(fx.owner.email, id);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body, { ok: true, itemsAdded: 3 });
  const after = await state(id, [a.id, b.id]);
  assertConfirmedOnce(after, expected);
  const alpha = after.ledger.filter((row) => row.inventoryItemId === a.id);
  assert.deepEqual(alpha.map((row) => [row.quantity, row.unitCost, row.totalCost]).sort((x, y) => x[0] - y[0]), [[2, 460, 920], [3, 470, 1410]], "two rows, not one merged row");
  const alphaCost = after.items.find((i) => i.id === a.id)!.cost;
  assert.equal(alphaCost, 455.34, "sequential weighted average");
  assert.equal(weightedAverageCost(10, 450, 5, 466), 455.33, "one merged line (5 at 466) would give 455.33");
  assert.notEqual(alphaCost, 455.33);
});

test("a frozen branch refuses confirmation with no partial effect; it succeeds after release", { timeout: 30_000 }, async () => {
  const beans = await countItem(fx, "f-beans", { stock: 10 });
  const id = await draft(fx, [{ item: beans, quantity: 2, unitCost: 450 }]);
  const before = await state(id, [beans.id]);
  const refused = await frozen(fx.branchId, () => confirm(fx.owner.email, id));
  assert.equal(refused.status, 409, refused.text);
  assert.deepEqual(await state(id, [beans.id]), before);
  const expected = await expectedAfter(id, before);
  const retry = await confirm(fx.owner.email, id);
  assert.equal(retry.status, 200, retry.text);
  assertConfirmedOnce(await state(id, [beans.id]), expected);
});

test("tenant, branch and permission denials have no effect", { timeout: 30_000 }, async () => {
  const annexItem = await countItem(fx, "g-annex", { stock: 10, branchId: fx.otherBranchId });
  const id = await draft(fx, [{ item: annexItem, quantity: 2, unitCost: 450 }], fx.otherBranchId);
  const before = await state(id, [annexItem.id]);
  for (const [who, email] of [["other café owner", other.owner.email], ["manager of another branch", fx.manager.email], ["waiter without purchases.confirm", fx.waiter.email]] as const) {
    const r = await confirm(email, id);
    assert.equal(r.status, 403, `${who}: ${r.text}`);
  }
  assert.deepEqual(await state(id, [annexItem.id]), before);
});

test("a held item lock times out as a retryable 409 with no partial effect; the retry succeeds", { timeout: 30_000 }, async () => {
  const first = await countItem(fx, "h-first", { stock: 10 });
  const second = await countItem(fx, "h-second", { stock: 10 });
  const id = await draft(fx, [{ item: first, quantity: 1, unitCost: 450 }, { item: second, quantity: 1, unitCost: 450 }]);
  const before = await state(id, [first.id, second.id]);
  const held = await holdItems([second.id]);
  let refused: Awaited<ReturnType<typeof confirm>> | "still waiting";
  try {
    refused = await Promise.race([
      confirm(fx.owner.email, id),
      new Promise<"still waiting">((resolve) => setTimeout(() => resolve("still waiting"), 8_000)),
    ]);
  } finally { held.release(); await held.blocker; }
  assert.notEqual(refused, "still waiting", "the confirmation must give up on a held lock rather than wait");
  if (refused === "still waiting") return;
  assert.equal(refused.status, 409, refused.text);
  assert.deepEqual(await state(id, [first.id, second.id]), before, "the claim and the first line rolled back");
  const expected = await expectedAfter(id, before);
  const retry = await confirm(fx.owner.email, id);
  assert.equal(retry.status, 200, retry.text);
  assertConfirmedOnce(await state(id, [first.id, second.id]), expected);
});
