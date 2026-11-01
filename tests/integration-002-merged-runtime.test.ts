// Task-specific retained-fixture regression suite. Historical finance helpers
// retain their old database/source guards; this suite does not import them.
// Run only after the continuation's explicit config, 91-migration identity and
// real app/database correspondence have all passed. No financial cleanup runs.
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { PrismaClient, type Prisma, type Role } from "@prisma/client";
import {
  loadIntegrationConfig, databaseUrl, verifyIntegrationRuntime,
  journalIntegrationEvidence,
} from "./helpers/integration-runtime";
import { purchaseLineFromForm, purchaseSubtotal } from "@/lib/purchase-arithmetic";

const config = loadIntegrationConfig();
const explicitUrl = databaseUrl(config, "replay");
// Some retained production services own their Prisma singleton. Its process
// connection must be exactly the same explicit guarded datasource, never .env.
assert.ok(process.env.DATABASE_URL === explicitUrl, "service datasource must equal the guarded runtime datasource");
const db = new PrismaClient({ datasourceUrl: explicitUrl });
assert.ok(config.baseUrl, "explicit owned runtime base URL required");
const base = config.baseUrl;
const password = "integration-retained-synthetic-only-20261101";
type Actor = { id: string; name: string; email: string };
type Fixture = {
  marker: string; cafeId: string; branchId: string; otherBranchId: string;
  owner: Actor; manager: Actor; cashier: Actor; waiter: Actor;
};
const cookies = new Map<string, string>();
let fx: Fixture, foreign: Fixture;
let appDb: PrismaClient | undefined;
const evidence = (kind: string, data: unknown) => journalIntegrationEvidence(config, kind, data);

async function request<T = Record<string, unknown>>(
  actor: Actor | null, route: string, method = "GET", body?: unknown,
  key?: string, cookie = actor ? cookies.get(actor.id) ?? "" : "",
  extraHeaders: Record<string, string> = {},
) {
  const response = await fetch(base + route, {
    method, signal: AbortSignal.timeout(60_000), redirect: "manual",
    headers: { "Content-Type": "application/json", cookie, ...(key ? { "Idempotency-Key": key } : {}), ...extraHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: T;
  try { parsed = JSON.parse(text) as T; } catch { parsed = {} as T; }
  return { status: response.status, body: parsed, text, headers: response.headers };
}
async function login(actor: Actor) {
  const response = await request(null, "/api/auth/login", "POST", { email: actor.email, password });
  assert.equal(response.status, 200, response.text);
  const cookie = response.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
  assert.ok(cookie.includes("cafeops_session="), "real login must issue a session cookie");
  cookies.set(actor.id, cookie);
  return cookie;
}
async function fixture(label: string): Promise<Fixture> {
  const marker = "IMRG-" + label + "-" + randomUUID().replaceAll("-", "").slice(0, 12);
  const cafe = await db.cafe.create({ data: {
    name: marker, slug: marker.toLowerCase(), currency: "EGP",
    settings: { create: { stockCountPolicy: "NO_SHIFT_COUNT", inventoryEnabled: true, purchasesEnabled: true, shiftManagementEnabled: true } },
    branches: { create: [{ name: marker + " main", menuSlug: "main" }, { name: marker + " annex", menuSlug: "annex" }] },
  }, include: { branches: true } });
  const branchId = cafe.branches.find(b => b.name.endsWith(" main"))!.id;
  const otherBranchId = cafe.branches.find(b => b.name.endsWith(" annex"))!.id;
  // Journal ownership immediately, including a partially prepared fixture.
  evidence("retained-cafe-created", { marker, cafeId: cafe.id, branchId, otherBranchId });
  const passwordHash = await bcrypt.hash(password, 10);
  const actor = (suffix: string, role: Role, branch: string | null) => db.user.create({
    data: { cafeId: cafe.id, branchId: branch, name: marker + " " + suffix, email: marker.toLowerCase() + "-" + suffix + "@example.invalid", passwordHash, role },
    select: { id: true, name: true, email: true },
  });
  const owner = await actor("owner", "CAFE_OWNER", null);
  const manager = await actor("manager", "BRANCH_MANAGER", branchId);
  const cashier = await actor("cashier", "CASHIER", branchId);
  const waiter = await actor("waiter", "WAITER", branchId);
  await db.userPermissionOverride.createMany({ data: ["expenses.view", "expenses.manage"].map(permissionKey => ({ userId: manager.id, permissionKey, allowed: true })) });
  const result = { marker, cafeId: cafe.id, branchId, otherBranchId, owner, manager, cashier, waiter };
  evidence("retained-fixture", result);
  for (const a of [owner, manager, cashier, waiter]) await login(a);
  return result;
}
const item = (f: Fixture, name: string, stock = 0, costPerUnit = 450, branchId = f.branchId) => db.inventoryItem.create({ data: {
  cafeId: f.cafeId, branchId, name: f.marker + " " + name + " " + randomUUID().slice(0, 6), unit: "KG", currentStock: stock, costPerUnit,
} });
const line = (inventoryItemId: string, quantity = 1, unitCost = 1) => ({ inventoryItemId, quantity, unitCost });
async function draft(f: Fixture, items: ReturnType<typeof line>[], extra: Record<string, unknown> = {}) {
  const response = await request<{ id: string }>(f.owner, "/api/purchases", "POST", { branchId: f.branchId, items, ...extra });
  assert.equal(response.status, 201, response.text);
  assert.ok(response.body.id);
  return response.body.id;
}
const confirm = (f: Fixture, id: string, actor = f.owner) => request(actor, `/api/purchases/${id}/confirm`, "POST", {});
const invoice = (id: string) => db.purchaseInvoice.findUniqueOrThrow({ where: { id }, include: { items: true, payments: true } });
const payment = (f: Fixture, id: string, amount: number, method = "BANK_TRANSFER", fundingSource = "BANK", actor = f.owner, key = randomUUID()) =>
  request(actor, `/api/purchases/${id}/payments`, "POST", { amount, method, fundingSource }, key);
async function purchaseState(id: string, ids: string[]) {
  return {
    invoice: await invoice(id),
    items: await db.inventoryItem.findMany({ where: { id: { in: ids } }, orderBy: { id: "asc" } }),
    ledger: await db.inventoryTransaction.findMany({ where: { inventoryItemId: { in: ids } }, orderBy: [{ inventoryItemId: "asc" }, { itemVersion: "asc" }] }),
    audits: await db.auditLog.findMany({ where: { entityId: { in: [id, ...ids] } }, orderBy: { id: "asc" } }),
  };
}
async function assertOneConfirmation(id: string, ids: string[], expectedStocks: number[], lineCount: number) {
  const saved = await invoice(id);
  assert.equal(saved.status, "CONFIRMED"); assert.ok(saved.confirmedAt);
  assert.equal(await db.auditLog.count({ where: { action: "PURCHASE_INVOICE_CONFIRMED", entityId: id } }), 1);
  const rows = await db.inventoryTransaction.findMany({ where: { inventoryItemId: { in: ids } } });
  assert.equal(rows.length, lineCount); assert.ok(rows.every(r => r.type === "PURCHASE"));
  const audits = (await db.auditLog.findMany({ where: { action: "PURCHASE_STOCK_ADDED", entityId: { in: ids } } }))
    .filter(a => (a.details as Record<string, unknown>)?.purchaseInvoiceId === id);
  assert.equal(audits.length, lineCount);
  for (let i = 0; i < ids.length; i++) assert.equal(Number((await db.inventoryItem.findUniqueOrThrow({ where: { id: ids[i] } })).currentStock), expectedStocks[i]);
}
async function hold(lock: (tx: Prisma.TransactionClient) => Promise<unknown>) {
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const blocker = db.$transaction(async tx => { await lock(tx); entered(); await gate; }, { timeout: 20_000 });
  await Promise.race([ready, blocker]);
  return { release, blocker };
}
async function lockWaiters(count: number) {
  for (let i = 0; i < 80; i++) {
    const [row] = await db.$queryRaw<{ count: number }[]>`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock'`;
    if (row.count >= count) { evidence("observed-lock-wait", { count: row.count }); return; }
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  assert.fail(`Did not observe ${count} waiting runtime transactions`);
}
async function failingAudit<T>(action: "PURCHASE_INVOICE_CONFIRMED" | "PURCHASE_STOCK_ADDED", entityId: string, run: () => Promise<T>) {
  assert.match(entityId, /^[A-Za-z0-9_-]+$/);
  const fn = "imrg_audit_" + randomUUID().replaceAll("-", ""), trigger = fn + "_trg";
  let functionCreated = false, triggerCreated = false;
  const journal = (phase: string) => evidence("owned-audit-failure-hook", { phase, action, entityId, function: fn, trigger, functionCreated, triggerCreated, cleanup: "Exact named trigger and function only; no CASCADE, no trigger disabling." });
  journal("PLANNED");
  try {
    await db.$executeRawUnsafe(`CREATE FUNCTION public."${fn}"() RETURNS trigger AS $hook$ BEGIN IF NEW."action" = '${action}' AND NEW."entityId" = '${entityId}' THEN RAISE EXCEPTION 'owned integration audit failure'; END IF; RETURN NEW; END; $hook$ LANGUAGE plpgsql`);
    functionCreated = true; journal("FUNCTION_CREATED");
    await db.$executeRawUnsafe(`CREATE TRIGGER "${trigger}" BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION public."${fn}"()`);
    triggerCreated = true; journal("TRIGGER_CREATED");
    return await run();
  } finally {
    if (triggerCreated) { await db.$executeRawUnsafe(`DROP TRIGGER "${trigger}" ON "AuditLog"`); triggerCreated = false; journal("TRIGGER_REMOVED"); }
    if (functionCreated) { await db.$executeRawUnsafe(`DROP FUNCTION public."${fn}"()`); functionCreated = false; journal("REMOVED"); }
    const [remaining] = await db.$queryRaw<{ triggers: number; functions: number }[]>`SELECT (SELECT count(*)::int FROM pg_trigger WHERE tgname=${trigger}) AS triggers,(SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.proname=${fn} AND n.nspname='public') AS functions`;
    assert.deepEqual(remaining, { triggers: 0, functions: 0 });
    journal("VERIFIED_REMOVED");
  }
}
async function openShift(f: Fixture, actor = f.manager, opening = 1000) {
  const response = await request<{ shift: { id: string } }>(actor, "/api/shifts", "POST", { branchId: f.branchId, openingCashAmount: opening });
  assert.equal(response.status, 201, response.text);
  return response.body.shift.id;
}
async function services() {
  // Loaded only after the strict before hook and datasource assertion.
  const modules = await Promise.all([import("@/lib/shifts"), import("@/lib/accounting/shadow-projection"), import("@/lib/accounting/ledger"), import("@/lib/accounting/subledgers"), import("@/lib/date-range"), import("@/lib/db")]);
  appDb = modules[5].db;
  return { ...modules[0], ...modules[1], ...modules[2], ...modules[3], ...modules[4] };
}

before(async () => {
  await verifyIntegrationRuntime(db, config, "replay", base);
  fx = await fixture("MAIN"); foreign = await fixture("FOREIGN");
  // Warm the confirmation route before deliberately holding its short locks.
  assert.equal((await confirm(fx, "missing-owned-invoice")).status, 404);
}, { timeout: 180_000 });
after(async () => {
  evidence("retention-complete", { runId: config.runId, financialCleanup: false, fixturesPurged: false });
  await db.$disconnect(); await appDb?.$disconnect();
});

test("purchase normalized previews, persisted totals and stock ledger agree at two decimals", { timeout: 90_000 }, async () => {
  const stock = await item(fx, "preview", 0, 0);
  const items = [line(stock.id, 0.5, 2.01), line(stock.id, 1.2345, 10), line(stock.id, 0.5, 2.01)];
  const id = await draft(fx, items, { discountAmount: 0.005, taxAmount: 0.004, payment: { amount: 0.005, method: "BANK_TRANSFER", fundingSource: "BANK" } });
  const saved = await invoice(id);
  assert.deepEqual(saved.items.map(i => Number(i.quantity)).sort((a, b) => a - b), [0.5, 0.5, 1.235]);
  assert.deepEqual(saved.items.map(i => Number(i.totalCost)).sort((a, b) => a - b), [1.01, 1.01, 12.35]);
  assert.deepEqual([saved.subtotalAmount, saved.discountAmount, saved.taxAmount, saved.totalAmount, saved.paidAmount, saved.remainingAmount].map(Number), [14.37, 0.01, 0, 14.36, 0.01, 14.35]);
  assert.equal(Number(saved.payments[0].amount), 0.01);
  assert.equal(purchaseSubtotal([purchaseLineFromForm("0.5", "2.01"), purchaseLineFromForm("1.2345", "10"), purchaseLineFromForm("0.5", "2.01")]), Number(saved.subtotalAmount));
  const response = await confirm(fx, id); assert.equal(response.status, 200, response.text);
  assert.deepEqual(response.body, { ok: true, itemsAdded: 3 });
  await assertOneConfirmation(id, [stock.id], [2.235], 3);
  assert.deepEqual((await db.inventoryTransaction.findMany({ where: { inventoryItemId: stock.id } })).map(r => Number(r.totalCost)).sort((a, b) => a - b), [1.01, 1.01, 12.35]);
  const state = await purchaseState(id, [stock.id]);
  assert.equal((await confirm(fx, id)).status, 400);
  assert.deepEqual(await purchaseState(id, [stock.id]), state, "duplicate confirmation changes no evidence");
});

test("purchase invalid input refuses every write and returns Arabic validation", async () => {
  const stock = await item(fx, "invalid");
  const counts = () => Promise.all([db.purchaseInvoice.count({ where: { cafeId: fx.cafeId } }), db.purchaseInvoiceItem.count({ where: { cafeId: fx.cafeId } }), db.purchasePayment.count({ where: { cafeId: fx.cafeId } }), db.auditLog.count({ where: { cafeId: fx.cafeId } })]);
  const prior = await counts();
  for (const invalid of [
    ...[0.004, 2.001, -1, 10000000000, "2.01", null].map(unitCost => ({ items: [{ inventoryItemId: stock.id, quantity: 1, unitCost }] })),
    ...[0.0004, 0, -1, 999999999.9995].map(quantity => ({ items: [line(stock.id, quantity)] })),
    { items: [line(stock.id, 2, 9999999999.99)] },
  ]) {
    const response = await request(fx.owner, "/api/purchases", "POST", { branchId: fx.branchId, ...invalid });
    assert.equal(response.status, 400, response.text); assert.match(String(response.body.error), /[\u0600-\u06ff]/);
    assert.deepEqual(await counts(), prior);
  }
});

test("draft editing keeps payments, invalid replacement is atomic, and keyed payments settle once", async () => {
  const stock = await item(fx, "edit");
  const id = await draft(fx, [line(stock.id, 1, 2)], { payment: { amount: 2, method: "BANK_TRANSFER", fundingSource: "BANK" } });
  const edited = await request(fx.owner, `/api/purchases/${id}`, "PATCH", { items: [line(stock.id, 0.5, 2.01), line(stock.id, 0.5, 2.01)], discountAmount: 0.005, taxAmount: 0.004 });
  assert.equal(edited.status, 200, edited.text);
  const saved = await invoice(id);
  assert.deepEqual([saved.subtotalAmount, saved.totalAmount, saved.paidAmount, saved.remainingAmount].map(Number), [2.02, 2.01, 2, 0.01]); assert.equal(saved.paymentStatus, "PARTIAL");
  const prior = await purchaseState(id, [stock.id]);
  const invalid = await request(fx.owner, `/api/purchases/${id}`, "PATCH", { items: [line(stock.id, 1, 0.004)] });
  assert.equal(invalid.status, 400, invalid.text); assert.deepEqual(await purchaseState(id, [stock.id]), prior);
  const key = randomUUID();
  const paid = await payment(fx, id, 0.01, "BANK_TRANSFER", "BANK", fx.owner, key); assert.equal(paid.status, 200, paid.text);
  const replay = await payment(fx, id, 0.01, "BANK_TRANSFER", "BANK", fx.owner, key);
  assert.equal(replay.status, 200, replay.text); assert.equal(replay.headers.get("Idempotency-Replayed"), "true"); assert.deepEqual(replay.body, paid.body);
  assert.equal((await payment(fx, id, 0.02, "BANK_TRANSFER", "BANK", fx.owner, key)).status, 409);
  const final = await invoice(id); assert.deepEqual([final.paidAmount, final.remainingAmount].map(Number), [2.01, 0]); assert.equal(final.payments.length, 2); assert.equal(final.paymentStatus, "PAID");
  assert.equal((await confirm(fx, id)).status, 200); await assertOneConfirmation(id, [stock.id], [1], 2);
});

for (const late of [false, true]) test(`confirmation ${late ? "later stock" : "invoice"} audit failure rolls back every business effect before retry`, { timeout: 90_000 }, async () => {
  const first = await item(fx, "rollback-first", 10), second = await item(fx, "rollback-second", 4);
  const id = await draft(fx, [line(first.id, 2, 460), line(second.id, 1.5, 40)]);
  const prior = await purchaseState(id, [first.id, second.id]);
  const failed = await failingAudit(late ? "PURCHASE_STOCK_ADDED" : "PURCHASE_INVOICE_CONFIRMED", late ? second.id : id, () => confirm(fx, id));
  assert.equal(failed.status, 500, failed.text);
  assert.deepEqual(await purchaseState(id, [first.id, second.id]), prior, "no claim, stock, cost, ledger or earlier audit survives");
  assert.equal((await confirm(fx, id)).status, 200);
  await assertOneConfirmation(id, [first.id, second.id], [12, 5.5], 2);
});

test("concurrent same-invoice confirmations have one committed effect", { timeout: 30_000 }, async () => {
  const stock = await item(fx, "same-confirm", 10);
  const id = await draft(fx, [line(stock.id, 2, 450)]);
  const held = await hold(tx => tx.$queryRaw`SELECT id FROM "PurchaseInvoice" WHERE id=${id} FOR UPDATE`);
  const requests = [confirm(fx, id), confirm(fx, id)];
  try { await lockWaiters(2); } finally { held.release(); await held.blocker; }
  const responses = await Promise.all(requests);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 400], responses.map(r => r.text).join(" | "));
  await assertOneConfirmation(id, [stock.id], [12], 1);
});

test("opposite item order confirmations share sorted locks and both settle", { timeout: 30_000 }, async () => {
  const a = await item(fx, "lock-alpha", 10), b = await item(fx, "lock-beta", 10);
  const forward = await draft(fx, [line(a.id, 1, 450), line(b.id, 2, 450)]);
  const reverse = await draft(fx, [line(b.id, 3, 450), line(a.id, 4, 450)]);
  const held = await hold(tx => tx.$queryRaw`SELECT id FROM "InventoryItem" WHERE id=ANY(${[a.id, b.id]}) ORDER BY id FOR UPDATE`);
  const requests = [confirm(fx, forward), confirm(fx, reverse)];
  try { await lockWaiters(2); } finally { held.release(); await held.blocker; }
  const responses = await Promise.all(requests);
  assert.deepEqual(responses.map(r => r.status), [200, 200], responses.map(r => r.text).join(" | "));
  assert.equal((await invoice(forward)).status, "CONFIRMED"); assert.equal((await invoice(reverse)).status, "CONFIRMED");
  const stocks = await db.inventoryItem.findMany({ where: { id: { in: [a.id, b.id] } } });
  assert.deepEqual(stocks.map(i => [Number(i.currentStock), Number(i.costPerUnit)]), [[15, 450], [15, 450]]);
  assert.equal(await db.inventoryTransaction.count({ where: { inventoryItemId: { in: [a.id, b.id] } } }), 4);
  assert.equal(await db.auditLog.count({ where: { action: "PURCHASE_INVOICE_CONFIRMED", entityId: { in: [forward, reverse] } } }), 2);
});

test("duplicate purchase lines keep sequential two-decimal valuation", async () => {
  const stock = await item(fx, "sequential", 10, 450);
  const id = await draft(fx, [line(stock.id, 2, 460), line(stock.id, 3, 470)]);
  assert.equal((await confirm(fx, id)).status, 200);
  await assertOneConfirmation(id, [stock.id], [15], 2);
  assert.equal(Number((await db.inventoryItem.findUniqueOrThrow({ where: { id: stock.id } })).costPerUnit), 455.34, "one merged line would incorrectly give 455.33");
  const rows = await db.inventoryTransaction.findMany({ where: { inventoryItemId: stock.id }, orderBy: { itemVersion: "asc" } });
  assert.deepEqual(rows.map(r => [Number(r.quantity), Number(r.unitCost), Number(r.totalCost)]), [[2, 460, 920], [3, 470, 1410]]);
});

test("purchase confirmation permission, tenant and sibling-branch refusals preserve state", async () => {
  const stock = await item(fx, "scope", 10, 450, fx.otherBranchId);
  const id = await draft(fx, [line(stock.id, 2, 450)], { branchId: fx.otherBranchId });
  const prior = await purchaseState(id, [stock.id]);
  for (const actor of [foreign.owner, fx.manager, fx.waiter]) assert.equal((await confirm(fx, id, actor)).status, 403);
  assert.deepEqual(await purchaseState(id, [stock.id]), prior);
});

test("transfer retries and concurrent same-key calls produce one balanced transfer", { timeout: 30_000 }, async () => {
  const stock = await item(fx, "transfer", 10, 12.5);
  const body = { inventoryItemId: stock.id, toBranchId: fx.otherBranchId, quantity: 4 };
  assert.equal((await request(fx.owner, "/api/inventory/transfer", "POST", body)).status, 400, "key is mandatory");
  const key = randomUUID();
  const held = await hold(tx => tx.$queryRaw`SELECT id FROM "InventoryItem" WHERE id=${stock.id} FOR UPDATE`);
  const requests = [1, 2].map(() => request(fx.owner, "/api/inventory/transfer", "POST", body, key));
  try { await lockWaiters(1); } finally { held.release(); await held.blocker; }
  const responses = await Promise.all(requests);
  assert.ok(responses.every(r => r.status === 200 || r.status === 409), responses.map(r => r.text).join(" | "));
  assert.equal(responses.filter(r => r.status === 200 && r.headers.get("Idempotency-Replayed") !== "true").length, 1);
  const replay = await request(fx.owner, "/api/inventory/transfer", "POST", body, key);
  assert.equal(replay.status, 200, replay.text); assert.equal(replay.headers.get("Idempotency-Replayed"), "true"); assert.deepEqual(replay.body, { ok: true });
  assert.equal((await request(fx.owner, "/api/inventory/transfer", "POST", { ...body, quantity: 3 }, key)).status, 409);
  const destinations = await db.inventoryItem.findMany({ where: { cafeId: fx.cafeId, branchId: fx.otherBranchId, name: stock.name, unit: stock.unit } });
  assert.equal(destinations.length, 1); assert.equal(Number(destinations[0].currentStock), 4);
  assert.equal(Number((await db.inventoryItem.findUniqueOrThrow({ where: { id: stock.id } })).currentStock), 6);
  const rows = await db.inventoryTransaction.findMany({ where: { inventoryItemId: { in: [stock.id, destinations[0].id] } } });
  assert.deepEqual(rows.map(r => [r.type, Number(r.quantity), Number(r.unitCost), Number(r.totalCost)]).sort(), [["TRANSFER_IN", 4, 12.5, 50], ["TRANSFER_OUT", -4, 12.5, 50]]);
  assert.equal(await db.auditLog.count({ where: { action: "INVENTORY_TRANSFERRED", entityId: stock.id } }), 1);
  const receipts = await db.idempotencyKey.findMany({ where: { key } }); assert.equal(receipts.length, 1); assert.equal(receipts[0].status, "COMPLETED");
});

test("manual movement retry applies once and current revoked permission protects its stored receipt", async () => {
  const local = await fixture("MOVEMENT");
  const stock = await item(local, "manual", 10, 12.5), key = randomUUID();
  const route = `/api/inventory/${stock.id}/movement`, body = { type: "WASTE", quantity: 3 };
  assert.equal((await request(local.manager, route, "POST", body)).status, 400);
  const first = await request(local.manager, route, "POST", body, key); assert.equal(first.status, 200, first.text);
  const replay = await request(local.manager, route, "POST", body, key); assert.equal(replay.status, 200); assert.equal(replay.headers.get("Idempotency-Replayed"), "true"); assert.deepEqual(replay.body, first.body);
  assert.equal((await request(local.manager, route, "POST", { ...body, quantity: 4 }, key)).status, 409);
  await db.userPermissionOverride.create({ data: { userId: local.manager.id, permissionKey: "inventory.transactions", allowed: false } });
  const denied = await request(local.manager, route, "POST", body, key); assert.equal(denied.status, 403); assert.equal(denied.headers.get("Idempotency-Replayed"), null); assert.deepEqual(Object.keys(denied.body), ["error"]);
  assert.equal(Number((await db.inventoryItem.findUniqueOrThrow({ where: { id: stock.id } })).currentStock), 7);
  const rows = await db.inventoryTransaction.findMany({ where: { inventoryItemId: stock.id } });
  assert.deepEqual(rows.map(r => [r.type, Number(r.quantity), Number(r.unitCost), Number(r.totalCost)]), [["WASTE", -3, 12.5, 37.5]]);
  assert.equal(await db.auditLog.count({ where: { entityId: stock.id, action: "INVENTORY_WASTE_RECORDED" } }), 1);
});

type Expense = { id: string; amount: number; returnedAmount: number; unrecoveredAmount: number; returns: { id: string; amount: number }[] };
async function category(f: Fixture) {
  const response = await request<{ category: { id: string } }>(f.owner, "/api/expenses/categories", "POST", { code: "OPERATING", nameAr: "مصروف تشغيل تجريبي", classification: "OPERATING_EXPENSE" });
  assert.equal(response.status, 201, response.text);
  return response.body.category.id;
}
const expenseBody = (f: Fixture, categoryId: string, amount = 120) => ({ branchId: f.branchId, categoryId, amount, description: "مصروف تشغيل تجريبي" });
async function sale(f: Fixture, shiftId: string, actor: Actor, pays: Partial<Record<"CASH" | "CARD" | "WALLET", number>>) {
  const total = Object.values(pays).reduce((a, b) => a + (b ?? 0), 0);
  const orderNumber = (await db.order.count({ where: { cafeId: f.cafeId } })) + 1;
  const order = await db.order.create({ data: {
    cafeId: f.cafeId, branchId: f.branchId, orderNumber, source: "CASHIER_POS", type: "TAKEAWAY", status: "SERVED", servedAt: new Date(),
    subtotal: total, total, paidAmount: total, remainingAmount: 0, paymentStatus: "PAID", createdById: actor.id,
  } });
  const payments = [];
  for (const [method, amount] of Object.entries(pays)) payments.push(await db.payment.create({ data: {
    cafeId: f.cafeId, branchId: f.branchId, shiftId, orderId: order.id, cashierId: actor.id, receivedById: actor.id,
    amount: amount!, method: method as "CASH" | "CARD" | "WALLET", type: "COLLECTION", status: "PAID", paidAt: new Date(),
  } }));
  evidence("retained-synthetic-sales-evidence", { cafeId: f.cafeId, shiftId, orderId: order.id, paymentIds: payments.map(p => p.id), pays });
  return { order, payments };
}

test("expenses, actual returns and supplier drawer payouts recompute once to 1330, 1350 and 1320", { timeout: 120_000 }, async () => {
  const f = await fixture("EXPENSE"), shiftId = await openShift(f), categoryId = await category(f);
  const sold = await sale(f, shiftId, f.manager, { CASH: 500 });
  await db.payment.create({ data: { cafeId: f.cafeId, branchId: f.branchId, shiftId, orderId: sold.order.id, cashierId: f.manager.id, receivedById: f.manager.id, amount: 50, method: "CASH", type: "REFUND", status: "PAID", reversalOfPaymentId: sold.payments[0].id, paidAt: new Date() } });
  const key = randomUUID(), body = expenseBody(f, categoryId);
  const paid = await request<Expense>(f.manager, "/api/expenses", "POST", body, key);
  assert.equal(paid.status, 201, paid.text);
  const paidAgain = await request<Expense>(f.manager, "/api/expenses", "POST", body, key);
  assert.equal(paidAgain.status, 201); assert.equal(paidAgain.headers.get("Idempotency-Replayed"), "true"); assert.equal(paidAgain.body.id, paid.body.id);
  assert.equal((await request(f.manager, "/api/expenses", "POST", { ...body, amount: 121 }, key)).status, 409);
  const svc = await services();
  for (let i = 0; i < 2; i++) {
    await svc.recomputeShiftTotals(shiftId, db);
    const shift = await db.shift.findUniqueOrThrow({ where: { id: shiftId } });
    assert.deepEqual([shift.expectedCashAmount, shift.totalSales, shift.totalRefunds, shift.totalExpensePayouts].map(Number), [1330, 450, 50, 120]);
  }
  const returnKey = randomUUID(), returnBody = { amount: 20, reason: "استلام نقد فعلي تجريبي" };
  const returned = await request<Expense>(f.manager, `/api/expenses/${paid.body.id}/returns`, "POST", returnBody, returnKey);
  assert.equal(returned.status, 201, returned.text); assert.equal(returned.body.returnedAmount, 20); assert.equal(returned.body.unrecoveredAmount, 100);
  const returnedAgain = await request<Expense>(f.manager, `/api/expenses/${paid.body.id}/returns`, "POST", returnBody, returnKey);
  assert.equal(returnedAgain.status, 201); assert.equal(returnedAgain.headers.get("Idempotency-Replayed"), "true"); assert.deepEqual(returnedAgain.body, returned.body);
  assert.equal(Number((await db.shift.findUniqueOrThrow({ where: { id: shiftId } })).expectedCashAmount), 1350);
  const stock = await item(f, "supplier", 0, 0), purchaseId = await draft(f, [line(stock.id, 1, 30)]);
  const supplierPaid = await payment(f, purchaseId, 30, "CASH", "DRAWER", f.manager); assert.equal(supplierPaid.status, 200, supplierPaid.text);
  await svc.recomputeShiftTotals(shiftId, db); await svc.recomputeShiftTotals(shiftId, db);
  const shift = await db.shift.findUniqueOrThrow({ where: { id: shiftId } });
  assert.deepEqual([shift.expectedCashAmount, shift.totalCashPayouts, shift.totalSales, shift.totalExpenseReturns].map(Number), [1320, 30, 450, 20]);
  assert.equal(await db.operatingExpense.count({ where: { cafeId: f.cafeId } }), 1);
  assert.equal(await db.operatingExpenseReturn.count({ where: { cafeId: f.cafeId } }), 1);
  assert.equal(await db.auditLog.count({ where: { cafeId: f.cafeId, action: "OPERATING_EXPENSE_PAID" } }), 1);
  assert.equal(await db.auditLog.count({ where: { cafeId: f.cafeId, action: "OPERATING_EXPENSE_CASH_RETURNED" } }), 1);
  assert.equal((await request(f.manager, `/api/shifts/${shiftId}/close`, "POST", { actualCashAmount: 1320 })).status, 200);
  assert.equal((await request<Expense>(f.manager, "/api/expenses", "POST", body, key)).body.id, paid.body.id, "a settled drawer does not lose its stored expense receipt");
  assert.equal((await request(f.manager, `/api/expenses/${paid.body.id}/returns`, "POST", returnBody, returnKey)).status, 201);
  evidence("drawer-arithmetic", { cafeId: f.cafeId, shiftId, expenseId: paid.body.id, returned: returned.body.returns, purchaseId, expected: [1330, 1350, 1320] });
});

test("expense input, tenant scope and actual drawer custody cannot be bypassed by role authority", { timeout: 90_000 }, async () => {
  const f = await fixture("EXPENSE_SCOPE"), shiftId = await openShift(f), categoryId = await category(f);
  for (const amount of [0, -1, 1.001, 10000000000, "12", null]) {
    const response = await request(f.manager, "/api/expenses", "POST", { ...expenseBody(f, categoryId), amount }, randomUUID());
    assert.equal(response.status, 400, response.text);
  }
  assert.equal((await request(f.owner, "/api/expenses", "POST", expenseBody(f, categoryId, 1), randomUUID())).status, 400, "owner cannot spend another custodian's drawer");
  assert.equal((await request(f.manager, "/api/expenses/categories", "POST", { code: "NO", nameAr: "مصروف تجريبي", classification: "OPERATING_EXPENSE" })).status, 403);
  assert.equal((await request(foreign.owner, "/api/expenses", "POST", expenseBody(f, categoryId, 1), randomUUID())).status, 404);
  assert.equal((await request(f.manager, "/api/expenses", "POST", { ...expenseBody(f, categoryId, 1), branchId: f.otherBranchId }, randomUUID())).status, 404);
  assert.equal(await db.operatingExpense.count({ where: { cafeId: f.cafeId } }), 0);
  assert.equal(Number((await db.shift.findUniqueOrThrow({ where: { id: shiftId } })).expectedCashAmount), 1000);
});

async function syntheticTreasuryOpening(f: Fixture, accountId: string, amount: number) {
  // Fixture-only approved opening, copied from the retained treasury harness.
  // This sets no policy and creates an immutable opening movement and audit.
  const account = await db.moneyAccount.findUniqueOrThrow({ where: { id: accountId } });
  assert.equal(account.cafeId, f.cafeId); assert.equal(account.openingState, "UNSET");
  const reference = config.runId + ":" + accountId;
  await db.$transaction(async tx => {
    const [stamp] = await tx.$queryRaw<{ at: Date }[]>`SELECT (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS at`;
    await tx.moneyAccount.update({ where: { id: accountId }, data: { openingState: "APPROVED", openingAt: stamp.at, openingReference: reference, openingApprovedAt: stamp.at, openingApprovedById: f.owner.id, version: { increment: 1 } } });
    await tx.moneyMovement.create({ data: { cafeId: f.cafeId, accountId, kind: "OPENING", signedAmount: amount, occurredAt: stamp.at, actorId: f.owner.id, sourceKey: "money-opening:" + accountId, openingReference: reference } });
    await tx.auditLog.create({ data: { cafeId: f.cafeId, userId: f.owner.id, action: "INTEGRATION_SYNTHETIC_TEST_OPENING", entity: "MoneyAccount", entityId: accountId, details: { reference, amount } } });
  });
  evidence("retained-synthetic-treasury-opening", { cafeId: f.cafeId, accountId, reference, amount });
}

test("treasury is owner-only; dispatch and receipt replay preserve balanced immutable movements", { timeout: 120_000 }, async () => {
  const f = await fixture("TREASURY");
  const createAccount = async (code: string) => {
    const response = await request<{ id: string; openingState: string; recordedBalance: string | null; realUseReady: boolean }>(f.owner, "/api/treasury/accounts", "POST", { code, name: "Synthetic " + code, kind: "BANK", instaPayEnabled: true }, randomUUID());
    assert.equal(response.status, 201, response.text); assert.equal(response.body.openingState, "UNSET"); assert.equal(response.body.recordedBalance, null); assert.equal(response.body.realUseReady, false);
    return response.body.id;
  };
  const from = await createAccount("SOURCE"), to = await createAccount("DEST");
  assert.equal((await request(f.manager, "/api/treasury/accounts")).status, 403);
  assert.equal((await request(foreign.owner, "/api/treasury/accounts/" + from)).status, 404);
  const body = { fromAccountId: from, toAccountId: to, amount: 20, channel: "INSTAPAY", reference: f.marker, note: "synthetic internal transfer" };
  const key = randomUUID();
  const created = await request<{ transferId: string }>(f.owner, "/api/treasury/transfers", "POST", body, key); assert.equal(created.status, 201, created.text);
  const createReplay = await request(f.owner, "/api/treasury/transfers", "POST", body, key); assert.equal(createReplay.status, 201); assert.deepEqual(createReplay.body, created.body);
  const id = created.body.transferId, route = "/api/treasury/transfers/" + id;
  const noOpening = await request(f.owner, route + "/dispatch", "POST", { moneyLeft: true, reference: f.marker }, randomUUID());
  assert.equal(noOpening.status, 409, noOpening.text); assert.equal(await db.moneyMovement.count({ where: { transferId: id } }), 0);
  await syntheticTreasuryOpening(f, from, 100); await syntheticTreasuryOpening(f, to, 0);
  for (const action of ["dispatch", "receive"] as const) {
    const actionKey = randomUUID(), actionBody = { [action === "dispatch" ? "moneyLeft" : "moneyReceived"]: true, reference: f.marker };
    const response = await request(f.owner, route + "/" + action, "POST", actionBody, actionKey); assert.equal(response.status, 201, response.text);
    const again = await request(f.owner, route + "/" + action, "POST", actionBody, actionKey); assert.equal(again.status, 201); assert.deepEqual(again.body, response.body);
    assert.equal((await request(f.owner, route + "/" + action, "POST", { ...actionBody, reference: "changed" }, actionKey)).status, 409);
    assert.equal((await request(f.owner, route + "/" + action, "POST", actionBody, randomUUID())).status, 409);
  }
  assert.equal((await db.moneyTransfer.findUniqueOrThrow({ where: { id } })).status, "RECEIVED");
  const movements = await db.moneyMovement.findMany({ where: { transferId: id }, orderBy: { signedAmount: "asc" } });
  assert.deepEqual(movements.map(m => [m.kind, Number(m.signedAmount)]), [["TRANSFER_OUT", -20], ["TRANSFER_IN", 20]]);
  for (const action of ["MONEY_TRANSFER_CREATED", "MONEY_TRANSFER_DISPATCHED", "MONEY_TRANSFER_RECEIVED"]) assert.equal(await db.auditLog.count({ where: { action, entityId: id } }), 1);
  const balances = await Promise.all([from, to].map(async accountId => Number((await db.moneyMovement.aggregate({ where: { accountId }, _sum: { signedAmount: true } }))._sum.signedAmount)));
  assert.deepEqual(balances, [80, 20]);
  const source = await request<{ account: { recordedBalance: string } }>(f.owner, "/api/treasury/accounts/" + from); assert.equal(source.status, 200); assert.equal(source.body.account.recordedBalance, "80.00");
  const svc = await services(), date = svc.dateStrInTz(new Date());
  const projected = await svc.projectShadowLedger({ cafeId: f.cafeId, from: svc.zonedDayStart(date), to: svc.zonedDayStart(svc.addDays(date, 1)), openMissingPeriods: true });
  // ACC-02A deliberately withholds accounting policy for money accounts.
  // Every treasury source remains a named blocking issue, including zero
  // opening evidence, rather than being assigned an invented GL account.
  assert.deepEqual(projected.warnings, []); assert.deepEqual(projected.bySource, {}); assert.equal(projected.posted, 0);
  assert.deepEqual(projected.exceptions.map(e => e.sourceType).sort(), ["TREASURY_OPENING", "TREASURY_OPENING", "TREASURY_TRANSFER_DISPATCH", "TREASURY_TRANSFER_RECEIVE"]);
  assert.ok(projected.exceptions.every(e => /[\u0600-\u06ff]/.test(e.reason)));
  assert.equal(await db.journalEntry.count({ where: { cafeId: f.cafeId } }), 0);
  assert.equal(await db.accountingProjectionIssue.count({ where: { cafeId: f.cafeId, kind: "UNPOSTABLE", severity: "BLOCKING", resolvedAt: null } }), 4);
  const tb = await svc.trialBalance({ cafeId: f.cafeId }, db); assert.equal(tb.balanced, true);
  const repeated = await svc.projectShadowLedger({ cafeId: f.cafeId, from: svc.zonedDayStart(date), to: svc.zonedDayStart(svc.addDays(date, 1)), openMissingPeriods: true });
  assert.equal(repeated.posted, 0); assert.equal(repeated.replayed, 0); assert.equal(repeated.exceptions.length, 4);
  evidence("treasury-and-projection", { cafeId: f.cafeId, from, to, transferId: id, balances, projected, repeated });
});

test("purchase, payment and inventory shadow books reconcile without guessing an uncosted movement", { timeout: 180_000 }, async () => {
  const f = await fixture("ACCOUNTING"), shiftId = await openShift(f, f.manager, 100), svc = await services();
  const startDate = svc.dateStrInTz(new Date());
  const milk = await item(f, "milk", 0, 0), eggs = await item(f, "eggs", 0, 0);
  const a = await draft(f, [line(milk.id, 10, 12)], { discountAmount: 20, taxAmount: 14 });
  assert.equal((await payment(f, a, 30, "CASH", "SAFE")).status, 200);
  assert.equal((await confirm(f, a)).status, 200);
  assert.equal((await payment(f, a, 50)).status, 200);
  const drawer = await payment(f, a, 20, "CASH", "DRAWER", f.manager); assert.equal(drawer.status, 200, drawer.text);
  const b = await draft(f, [line(milk.id, 1, 15)]); assert.equal((await payment(f, b, 15, "CASH", "SAFE")).status, 200);
  const c = await draft(f, [line(eggs.id, 1, 40)]); assert.equal((await confirm(f, c)).status, 200);
  const cancelled = await request(f.owner, `/api/purchases/${c}/cancel`, "POST", {}); assert.equal(cancelled.status, 200, cancelled.text);
  for (const type of ["WASTE", "ADJUSTMENT"]) {
    const moved = await request(f.owner, `/api/inventory/${milk.id}/movement`, "POST", { type, quantity: 1 }, randomUUID()); assert.equal(moved.status, 200, moved.text);
  }
  const endDate = svc.dateStrInTz(new Date()), from = svc.zonedDayStart(startDate), to = svc.zonedDayStart(svc.addDays(endDate, 1));
  const first = await svc.projectShadowLedger({ cafeId: f.cafeId, from, to, openMissingPeriods: true });
  const count = await db.journalEntry.count({ where: { cafeId: f.cafeId } });
  const again = await svc.projectShadowLedger({ cafeId: f.cafeId, from, to, openMissingPeriods: true });
  const tb = await svc.trialBalance({ cafeId: f.cafeId }, db), suppliers = await svc.supplierPosition({ cafeId: f.cafeId, asOf: endDate }, db), stock = await svc.inventoryReconciliation({ cafeId: f.cafeId, asOf: endDate }, db);
  const adjustment = await db.inventoryTransaction.findFirstOrThrow({ where: { inventoryItemId: milk.id, type: "ADJUSTMENT" } });
  evidence("accounting-actuals", { cafeId: f.cafeId, shiftId, invoices: { a, b, c }, first, again, count, tb, suppliers, stock });
  assert.equal(adjustment.totalCost, null);
  assert.deepEqual(first.exceptions.map(e => [e.sourceType, e.sourceId]), [["STOCK_MOVEMENT", adjustment.id]]);
  assert.deepEqual(first.warnings, []);
  assert.deepEqual(first.bySource, { SUPPLIER_PAYMENT: 4, STOCK_MOVEMENT: 3, PURCHASE_INVOICE: 2, PURCHASE_CANCEL: 1 });
  assert.equal(first.posted, 10); assert.equal(again.posted, 0); assert.equal(again.replayed, 10);
  assert.equal(count, 10); assert.equal(await db.journalEntry.count({ where: { cafeId: f.cafeId } }), count);
  assert.deepEqual(again.exceptions.map(e => e.sourceId), [adjustment.id]);
  const issues = await db.accountingProjectionIssue.findMany({ where: { cafeId: f.cafeId } });
  assert.deepEqual(issues.map(i => [i.sourceId, i.kind, i.severity, i.resolvedAt]), [[adjustment.id, "UNPOSTABLE", "BLOCKING", null]]);
  assert.equal(tb.balanced, true);
  const g = (code: string) => tb.accounts.find(r => r.code === code)?.balance ?? 0;
  assert.equal(g("1170"), 14); assert.equal(g("5110"), 20);
  assert.deepEqual({ safe: g("1120"), bank: g("1130"), drawer: g("1110") }, { safe: -45, bank: -50, drawer: -20 });
  assert.equal(g("2100"), suppliers.payable); assert.equal(suppliers.payable, 14);
  assert.deepEqual(suppliers.items.map(i => [i.invoiceId, i.open]), [[a, 14]]);
  assert.equal(g("1300"), suppliers.advanceTotal); assert.equal(suppliers.advanceTotal, 15); assert.deepEqual(suppliers.advances.map(i => [i.invoiceId, i.amount]), [[b, 15]]);
  assert.equal(g("2110"), 40, "cancelled invoice retains its receipt in goods received not invoiced");
  assert.deepEqual({ gl: stock.glInventory, ledger: stock.ledgerValue, unposted: stock.unposted, uncosted: stock.uncostedRows }, { gl: 148, ledger: 148, unposted: 0, uncosted: 1 });
  const stored = await invoice(a); assert.deepEqual([stored.paidAmount, stored.remainingAmount].map(Number), [100, 14]); assert.equal(stored.paymentStatus, "PARTIAL");
  const open = await db.shift.findUniqueOrThrow({ where: { id: shiftId } }); assert.deepEqual([open.expectedCashAmount, open.totalCashPayouts].map(Number), [80, 20]);
  const overview = await request<{ configured: boolean; mode: string; notice: string }>(f.owner, "/api/accounting/overview");
  assert.equal(overview.status, 200, overview.text); assert.equal(overview.body.configured, true); assert.equal(overview.body.mode, "SHADOW"); assert.match(overview.body.notice, /[\u0600-\u06ff]/);
  const balance = await request<{ totals: { balanced: boolean; debit: number; credit: number } }>(f.owner, `/api/accounting/trial-balance?from=${startDate}&to=${endDate}`);
  assert.equal(balance.status, 200, balance.text); assert.equal(balance.body.totals.balanced, true); assert.equal(balance.body.totals.debit, balance.body.totals.credit);
  for (const route of ["/api/accounting/overview", "/api/accounting/journal", "/api/accounting/accounts"]) assert.equal((await request(f.cashier, route)).status, 403);
});

test("logout revokes one real cookie, suspended accounts lose API and printable access, and another session survives", { timeout: 90_000 }, async () => {
  const f = await fixture("SESSIONS"), shiftId = await openShift(f, f.manager, 75);
  assert.equal((await request(f.manager, `/api/shifts/${shiftId}/close`, "POST", { actualCashAmount: 75 })).status, 200);
  const first = await login(f.manager), second = await login(f.manager);
  assert.notEqual(first, second);
  const page = await request(f.manager, "/reports/shift/" + shiftId, "GET", undefined, undefined, second);
  assert.equal(page.status, 200); assert.ok(page.text.includes(f.marker), "authorized real printable report renders the owned cafe");
  const loggedOut = await request(f.manager, "/api/auth/logout", "POST", undefined, undefined, first);
  assert.equal(loggedOut.status, 200, loggedOut.text);
  const revoked = await request(f.manager, "/api/auth/me", "GET", undefined, undefined, first);
  assert.equal(revoked.status, 401, revoked.text);
  const beforeBranch = await db.branch.findUniqueOrThrow({ where: { id: f.branchId } });
  const mutation = await request(f.manager, "/api/branches/" + f.branchId, "PATCH", { phone: "integration-revoked-denied" }, undefined, first);
  assert.equal(mutation.status, 401); assert.deepEqual(await db.branch.findUniqueOrThrow({ where: { id: f.branchId } }), beforeBranch);
  for (const route of ["/reports/shift/" + shiftId, "/receipts/payment/integration-missing"]) {
    const printable = await request(f.manager, route, "GET", undefined, undefined, first);
    assert.ok(printable.text.includes(String(revoked.body.error)), "printable page must enforce the exact live revocation refusal");
  }
  assert.equal((await request(f.manager, "/api/auth/me", "GET", undefined, undefined, second)).status, 200);
  await db.user.update({ where: { id: f.manager.id }, data: { isActive: false } });
  const suspended = await request(f.manager, "/api/branches", "GET", undefined, undefined, second);
  assert.equal(suspended.status, 403, suspended.text);
  assert.equal((await request(f.manager, "/api/shifts", "GET", undefined, undefined, second)).status, 403);
  const blocked = await request(f.manager, "/reports/shift/" + shiftId, "GET", undefined, undefined, second);
  assert.ok(blocked.text.includes(String(suspended.body.error)), "printable report reads current account activity");
  assert.equal((await request(null, "/api/auth/login", "POST", { email: f.manager.email, password })).status, 403);
  assert.equal((await request(f.cashier, `/api/shifts/${shiftId}/report`)).status, 403, "cashier cannot read oversight figures");
  const cashierPrintable = await request(f.cashier, "/reports/shift/" + shiftId);
  assert.ok(cashierPrintable.text.includes("ليس لديك صلاحية لعرض التقرير المالي"));
});

test("public QR submissions throttle the unique branch/origin pair and reject oversized notes before lookup", { timeout: 90_000 }, async () => {
  const branchId = "imrg-missing-" + randomUUID(), route = `/api/qr/${branchId}/orders`;
  const post = (origin: string, body: unknown) => request(null, route, "POST", body, randomUUID(), "", { "x-forwarded-for": origin });
  for (let i = 0; i < 60; i++) {
    const response = await post("203.0.113.71", {});
    assert.equal(response.status, 400, `submission ${i + 1}: ${response.text}`);
  }
  const limited = await post("203.0.113.71", {});
  assert.equal(limited.status, 429, limited.text); assert.ok(Number(limited.headers.get("retry-after")) > 0);
  assert.equal((await post("198.51.100.72", {})).status, 400, "another origin has its own allowance");
  const order = (notes: string) => ({ customerName: "Synthetic QR guest", notes, items: [{ productId: "imrg-missing", quantity: 1 }] });
  const tooLong = await post("192.0.2.73", order("x".repeat(501)));
  assert.equal(tooLong.status, 400, tooLong.text); assert.ok(tooLong.text.includes("النص طويل جدًا"));
  const fits = await post("192.0.2.74", order("x".repeat(500)));
  // publicQrRequestScope deliberately denies an unavailable/missing menu
  // before the route's business callback, including for a valid-sized body.
  assert.equal(fits.status, 403, "a valid-sized request reaches the public menu scope guard: " + fits.text);
  assert.deepEqual(fits.body, { error: "المنيو غير متاح حاليًا" });
  assert.equal(await db.order.count({ where: { branchId } }), 0);
});

test("two-screen close keeps blind counts, independent tender differences and materials evidence through receipt", { timeout: 180_000 }, async () => {
  const f = await fixture("MATERIALS"), svc = await services();
  const alpha = await item(f, "Alpha", 10), beta = await item(f, "Beta", 5);
  const configured = await request(f.owner, `/api/branches/${f.branchId}/handover-config`, "PATCH", {
    enabled: true, mode: "SELECTED", selectedItemIds: [alpha.id, beta.id], schedule: "MANUAL_ONLY",
    materials: { cadence: "EVERY_SHIFT", weekday: null, cutoff: null },
  });
  assert.equal(configured.status, 200, configured.text);
  const shiftId = await openShift(f, f.cashier, 600);
  await sale(f, shiftId, f.cashier, { CASH: 1000, CARD: 500, WALLET: 200 });
  await svc.recomputeShiftTotals(shiftId, db);
  const flowRoute = `/api/shifts/close-flow?branchId=${f.branchId}`;
  const money = await request<{ stage: string; shift: Record<string, unknown>; materials: { duePreview: boolean } }>(f.cashier, flowRoute);
  assert.equal(money.status, 200, money.text); assert.equal(money.body.stage, "MONEY"); assert.equal(money.body.materials.duePreview, true);
  for (const key of ["expectedCashAmount", "totalCashSales", "totalCardSales", "totalWalletSales"]) assert.equal(key in money.body.shift, false);
  const paymentCount = await db.payment.count({ where: { shiftId } }), orderCount = await db.order.count({ where: { cafeId: f.cafeId } });
  assert.equal((await request(f.cashier, `/api/shifts/${shiftId}/close`, "POST", { actualCardAmount: 480, actualWalletAmount: 220, handoverTarget: "SHIFT_TO_SHIFT" })).status, 400, "blank cash is never zero");
  const closeBody = { actualCashAmount: 1600, actualCardAmount: 480, actualWalletAmount: 220, handoverTarget: "SHIFT_TO_SHIFT" };
  const closed = await request<{ handover: { required: boolean; handoverId: string }; materials: { due: boolean; reason: string } }>(f.cashier, `/api/shifts/${shiftId}/close`, "POST", closeBody);
  assert.equal(closed.status, 200, closed.text); assert.equal(closed.body.handover.required, true); assert.deepEqual([closed.body.materials.due, closed.body.materials.reason], [true, "EVERY_SHIFT"]);
  const shift = await db.shift.findUniqueOrThrow({ where: { id: shiftId }, include: { tenderReconciliations: { orderBy: { method: "asc" } } } });
  assert.equal(shift.status, "AWAITING_HANDOVER"); assert.equal(Number(shift.cashDifference), 0);
  assert.deepEqual(shift.tenderReconciliations.map(t => [t.method, Number(t.expectedAmount), Number(t.actualAmount), Number(t.varianceAmount), t.reasonNote]), [["CARD", 500, 480, -20, null], ["WALLET", 200, 220, 20, null]]);
  assert.equal(await db.varianceCase.count({ where: { shiftId, type: "TENDER", status: "OPEN" } }), 2); assert.equal(await db.varianceCase.count({ where: { shiftId, type: "CASH" } }), 0);
  assert.equal((await request(f.cashier, `/api/shifts/${shiftId}/close`, "POST", closeBody)).status, 400);
  assert.equal(await db.tenderReconciliation.count({ where: { shiftId } }), 2);
  assert.equal(await db.payment.count({ where: { shiftId } }), paymentCount); assert.equal(await db.order.count({ where: { cafeId: f.cafeId } }), orderCount);
  const handoverId = closed.body.handover.handoverId;
  const resumed = await request<{ stage: string; handover: { id: string } }>(f.cashier, flowRoute); assert.equal(resumed.body.stage, "MATERIALS"); assert.equal(resumed.body.handover.id, handoverId);
  const started = await request<{ countSession: { id: string } }>(f.cashier, "/api/handovers", "POST", { action: "start_count", handoverId }); assert.equal(started.status, 200, started.text);
  const sessionId = started.body.countSession.id;
  const detail = await request<{ session: { lines: { id: string; inventoryItemId: string; expectedQuantity?: unknown }[] } }>(f.cashier, `/api/stock-counts/${sessionId}`);
  assert.equal(detail.status, 200, detail.text); assert.deepEqual(detail.body.session.lines.map(l => l.inventoryItemId).sort(), [alpha.id, beta.id].sort());
  assert.ok(detail.body.session.lines.every(l => !("expectedQuantity" in l)), "outgoing quantities are blind");
  const save = (inventoryItemId: string, countedQuantity: number) => request(f.cashier, `/api/stock-counts/${sessionId}/lines/${detail.body.session.lines.find(l => l.inventoryItemId === inventoryItemId)!.id}`, "PATCH", { countedQuantity, expectedCountedAt: null });
  assert.equal((await save(alpha.id, 9)).status, 200);
  const incomplete = await request<{ missingItems: string[] }>(f.cashier, "/api/handovers", "POST", { action: "finish_outgoing", handoverId });
  assert.equal(incomplete.status, 409, incomplete.text); assert.deepEqual(incomplete.body.missingItems, [beta.name]);
  assert.equal((await save(beta.id, 6)).status, 200);
  const finished = await request<{ status: string; recordedDifferences: number; systemValidated: boolean; alreadySubmitted: boolean }>(f.cashier, "/api/handovers", "POST", { action: "finish_outgoing", handoverId, note: "عد تجريبي بفروق فعلية" });
  assert.equal(finished.status, 200, finished.text); assert.deepEqual([finished.body.status, finished.body.recordedDifferences, finished.body.systemValidated, finished.body.alreadySubmitted], ["OUTGOING_SUBMITTED", 2, false, false]);
  const repeated = await request<{ alreadySubmitted: boolean }>(f.cashier, "/api/handovers", "POST", { action: "finish_outgoing", handoverId }); assert.equal(repeated.status, 200); assert.equal(repeated.body.alreadySubmitted, true);
  assert.equal(await db.auditLog.count({ where: { action: "HANDOVER_SUBMITTED", entityId: handoverId } }), 1);
  const count = await db.stockCountSession.findUniqueOrThrow({ where: { id: sessionId }, include: { lines: true } });
  assert.equal(count.status, "CONFIRMED"); assert.equal(count.confirmedById, null); assert.deepEqual(count.lines.map(l => Number(l.varianceQuantity)).sort(), [-1, 1]);
  assert.ok(count.lines.every(l => l.disposition !== "VARIANCE_CONFIRMED"));
  assert.equal(await db.auditLog.count({ where: { action: "COUNT_SYSTEM_VALIDATED", entityId: sessionId } }), 0);
  assert.equal(await db.auditLog.count({ where: { action: "COUNT_OUTGOING_DECLARED", entityId: sessionId } }), 1);
  assert.ok((await db.shiftMaterialsDecision.findUniqueOrThrow({ where: { shiftId } })).satisfiedAt);
  assert.equal((await request<{ stage: string }>(f.cashier, flowRoute)).body.stage, "DONE");
  const report = await request<{ report: { cash: { difference: number }; tenders: { method: string; variance: number }[] }; materials: { handover: { status: string; evidence: string }; lines: { name: string; difference: number; receiving: unknown }[] } }>(f.owner, `/api/shifts/${shiftId}/report`);
  assert.equal(report.status, 200, report.text); assert.equal(report.body.report.cash.difference, 0); assert.deepEqual(report.body.report.tenders.map(t => [t.method, t.variance]), [["CARD", -20], ["WALLET", 20]]);
  assert.deepEqual([report.body.materials.handover.status, report.body.materials.handover.evidence], ["OUTGOING_SUBMITTED", "OUTGOING_DECLARED"]);
  assert.equal((await request(f.cashier, `/api/shifts/${shiftId}/report`)).status, 403);
  // The manager is the synthetic incoming custodian; no signature is invented.
  await openShift(f, f.manager, 0);
  const incoming = await request<{ handover: { count: { countVersion: string; outgoingDeclared: boolean; lines: { id: string; inventoryItemId: string }[] } } }>(f.manager, `/api/handovers/${handoverId}`);
  assert.equal(incoming.status, 200, incoming.text); assert.equal(incoming.body.handover.count.outgoingDeclared, true);
  const acknowledgement = await request<{ lines: { decision: string; varianceQuantity: number | null }[] }>(f.manager, `/api/handovers/${handoverId}/acknowledge`, "POST", {
    countSessionId: sessionId, countVersion: incoming.body.handover.count.countVersion,
    lines: incoming.body.handover.count.lines.map(l => ({ stockCountLineId: l.id, incomingCountedQuantity: l.inventoryItemId === alpha.id ? 8 : null })), idempotencyKey: randomUUID(),
  });
  assert.equal(acknowledgement.status, 200, acknowledgement.text); assert.ok(acknowledgement.body.lines.every(l => l.decision === "ACCEPTED"));
  const acceptBody = { idempotencyKey: randomUUID(), countedOpeningCash: 1580 };
  const accepted = await request<{ status: string }>(f.manager, `/api/handovers/${handoverId}/accept`, "POST", acceptBody);
  assert.equal(accepted.status, 200, accepted.text); assert.equal(accepted.body.status, "COMPLETED");
  const acceptReplay = await request<{ status: string }>(f.manager, `/api/handovers/${handoverId}/accept`, "POST", acceptBody); assert.equal(acceptReplay.status, 200); assert.equal(acceptReplay.body.status, "COMPLETED");
  assert.equal(await db.varianceCase.count({ where: { acceptedHandoverId: handoverId, type: "OPENING_EXCEPTION" } }), 1, "optional reason does not erase the actual -20 receipt difference");
  const received = await db.handoverSession.findUniqueOrThrow({ where: { id: handoverId } }); assert.deepEqual([received.proposedOpeningCash, received.countedOpeningCash, received.cashVarianceAmount].map(Number), [1600, 1580, -20]);
  assert.equal(Number((await db.inventoryItem.findUniqueOrThrow({ where: { id: alpha.id } })).currentStock), 8); assert.equal(Number((await db.inventoryItem.findUniqueOrThrow({ where: { id: beta.id } })).currentStock), 6);
  assert.equal(await db.inventoryFreeze.count({ where: { handoverId, releasedAt: null } }), 0);
  const incomingShift = await db.shift.findFirstOrThrow({ where: { cashierId: f.manager.id, status: "OPEN" } }); assert.deepEqual([incomingShift.openingCashAmount, incomingShift.expectedCashAmount].map(Number), [1580, 1580]);
  evidence("two-screen-materials-receipt", { cafeId: f.cafeId, shiftId, handoverId, sessionId, incomingShiftId: incomingShift.id, tenderDifferences: [-20, 20], receiptDifference: -20 });
});

test("weekly materials not due closes money without inventing a count and still enforces branch-custody permission", { timeout: 90_000 }, async () => {
  const f = await fixture("NOTDUE"), stock = await item(f, "selected", 10);
  const today = new Date(new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date()) + "T00:00:00Z").getUTCDay();
  const configured = await request(f.owner, `/api/branches/${f.branchId}/handover-config`, "PATCH", {
    enabled: true, mode: "SELECTED", selectedItemIds: [stock.id], schedule: "MANUAL_ONLY",
    materials: { cadence: "WEEKLY", weekday: (today + 3) % 7, cutoff: "22:00" },
  }); assert.equal(configured.status, 200, configured.text);
  const shiftId = await openShift(f, f.cashier, 100), body = { actualCashAmount: 100, handoverTarget: "BRANCH_CUSTODY" };
  const denied = await request(f.cashier, `/api/shifts/${shiftId}/close`, "POST", body); assert.equal(denied.status, 403, denied.text);
  assert.equal((await db.shift.findUniqueOrThrow({ where: { id: shiftId } })).status, "OPEN");
  const closed = await request<{ handover: { required: boolean }; materials: { due: boolean; reason: string } }>(f.manager, `/api/shifts/${shiftId}/close`, "POST", body);
  assert.equal(closed.status, 200, closed.text); assert.deepEqual([closed.body.handover.required, closed.body.materials.due, closed.body.materials.reason], [false, false, "NOT_DUE"]);
  assert.equal((await db.shift.findUniqueOrThrow({ where: { id: shiftId } })).status, "CLOSED");
  assert.equal(await db.handoverSession.count({ where: { outgoingShiftId: shiftId } }), 0);
  assert.equal(await db.stockCountSession.count({ where: { cafeId: f.cafeId } }), 0);
  assert.equal(await db.inventoryFreeze.count({ where: { cafeId: f.cafeId, releasedAt: null } }), 0);
  const decision = await db.shiftMaterialsDecision.findUniqueOrThrow({ where: { shiftId } }); assert.equal(decision.due, false); assert.equal(decision.reason, "NOT_DUE");
  const nextId = await openShift(f, f.cashier, 100); assert.equal((await db.shift.findUniqueOrThrow({ where: { id: nextId } })).custodyGateReason, null);
});
