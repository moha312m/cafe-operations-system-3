// ACC-01B runtime fixtures for supplier-payment recovery and shared-drawer
// tests. Everything is created through the real routes on the owned test
// server and RETAINED as evidence: nothing here purges or resets data.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import type { Prisma } from "@prisma/client";
import { db, assertTestDatabase } from "./db";
export { db };

export const ORIGIN = process.env.TEST_BASE_URL ?? "";
export const PASSWORD = "ACC01B-synthetic-only-2026";
const EVIDENCE = process.env.ACC01B_EVIDENCE_DIR ?? "";
const cookies = new Map<string, string>();

export type Actor = { id: string; email: string; name: string };
export type Fixture = {
  marker: string; cafeId: string; branchId: string; otherBranchId: string;
  owner: Actor; manager: Actor; annexManager: Actor; clerk: Actor;
  shiftId: string | null; categoryId: string; itemId: string;
};
export type PaymentResult = { paidAmount: number; remainingAmount: number; paymentStatus: string; error?: string };

export function journal(kind: string, data: unknown) {
  if (!EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  appendFileSync(path.join(EVIDENCE, "runtime-journal.jsonl"), JSON.stringify({ at: new Date().toISOString(), kind, data }) + "\n");
}

export async function http<T = Record<string, unknown>>(actor: Actor, url: string, method = "GET", body?: unknown, key?: string) {
  const res = await fetch(ORIGIN + url, {
    method, signal: AbortSignal.timeout(60000),
    headers: { "Content-Type": "application/json", cookie: cookies.get(actor.id) ?? "", ...(key ? { "Idempotency-Key": key } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: T;
  try { parsed = JSON.parse(text) as T; } catch { throw new Error("Non-JSON API response " + res.status + ": " + text.slice(0, 200)); }
  return { status: res.status, body: parsed, headers: res.headers };
}

export async function login(actor: Actor) {
  const res = await fetch(ORIGIN + "/api/auth/login", {
    method: "POST", signal: AbortSignal.timeout(60000), headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: actor.email, password: PASSWORD }),
  });
  const text = await res.text();
  assert.equal(res.status, 200, "synthetic login: " + text.slice(0, 200));
  cookies.set(actor.id, res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; "));
}

let ready: Promise<void> | undefined;
export function environmentReady() { return ready ??= verify(); }
async function verify() {
  const url = new URL(process.env.DATABASE_URL ?? "");
  assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.port, "5434"); assert.equal(url.pathname, "/cafe_ops_test_finf5");
  assert.equal(new URL(ORIGIN).host, "127.0.0.1:3106", "owned test server only");
  await assertTestDatabase();
  const evidence = await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    const [identity] = await tx.$queryRaw<{ database: string; data_directory: string; system_identifier: string }[]>`SELECT current_database() AS database, current_setting('data_directory') AS data_directory, system_identifier::text FROM pg_control_system()`;
    const marker = await tx.$queryRaw<{ id: number; note: string }[]>`SELECT id, note FROM "_disposable_test_database" ORDER BY id`;
    const [migrations] = await tx.$queryRaw<{ done: number; open: number }[]>`SELECT count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)::int AS done, count(*) FILTER (WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)::int AS open FROM "_prisma_migrations"`;
    return { identity, marker, migrations };
  });
  assert.equal(evidence.identity.database, "cafe_ops_test_finf5");
  assert.equal(evidence.identity.system_identifier, "7693368256609479860");
  assert.equal(evidence.identity.data_directory.replaceAll("\\", "/"), "C:/Dev/_nextcup_test_postgres/pgdata");
  assert.deepEqual(evidence.marker, [{ id: 1, note: "Disposable. Automated tests create and delete data here. Never point this at real cafe data." }]);
  assert.deepEqual(evidence.migrations, { done: 88, open: 0 });
  journal("environment-proof", { ...evidence, origin: ORIGIN });
}

/** A retained café: owner, a main-branch manager with a drawer, an annex manager and a clerk. */
export async function fixture(label: string, opening: number | null = 100): Promise<Fixture> {
  await environmentReady();
  const marker = "ACC01B-" + label + "-" + randomUUID().slice(0, 8);
  const cafe = await db.cafe.create({
    data: {
      name: marker, slug: marker.toLowerCase(), currency: "EGP",
      settings: { create: { stockCountPolicy: "NO_SHIFT_COUNT", shiftManagementEnabled: true, purchasesEnabled: true, inventoryEnabled: true } },
      branches: { create: [{ name: marker + " main", menuSlug: "main" }, { name: marker + " annex", menuSlug: "annex" }] },
    },
    include: { branches: { orderBy: { name: "asc" } } },
  });
  const branchId = cafe.branches.find((b) => b.name.endsWith("main"))!.id;
  const otherBranchId = cafe.branches.find((b) => b.name.endsWith("annex"))!.id;
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const actor = (suffix: string, role: "CAFE_OWNER" | "BRANCH_MANAGER" | "CASHIER", branch: string | null) => db.user.create({
    data: { cafeId: cafe.id, branchId: branch, name: marker + " " + suffix, email: marker.toLowerCase() + "-" + suffix + "@example.invalid", passwordHash, role },
    select: { id: true, email: true, name: true },
  });
  const owner = await actor("owner", "CAFE_OWNER", null);
  const manager = await actor("manager", "BRANCH_MANAGER", branchId);
  const annexManager = await actor("annex-manager", "BRANCH_MANAGER", otherBranchId);
  const clerk = await actor("clerk", "BRANCH_MANAGER", branchId);
  for (const a of [owner, manager, annexManager, clerk]) await login(a);
  // Qualify the synthetic managers explicitly; legacy fallbacks need not include expenses.
  for (const m of [manager, clerk]) {
    const granted = await http(owner, "/api/users/" + m.id + "/permissions", "PUT", { overrides: [{ key: "expenses.view", allowed: true }, { key: "expenses.manage", allowed: true }, { key: "purchases.record_payment", allowed: true }] });
    assert.equal(granted.status, 200, "authorize synthetic manager: " + JSON.stringify(granted.body));
  }
  let shiftId: string | null = null;
  if (opening !== null) {
    const opened = await http<{ shift: { id: string } }>(manager, "/api/shifts", "POST", { branchId, openingCashAmount: opening });
    assert.ok([200, 201].includes(opened.status), "open synthetic drawer: " + JSON.stringify(opened.body));
    shiftId = opened.body.shift.id;
  }
  const category = await http<{ category: { id: string } }>(owner, "/api/expenses/categories", "POST", { code: "OPERATING", nameAr: "مصروف تشغيلي ACC-01B", classification: "OPERATING_EXPENSE" });
  assert.equal(category.status, 201, JSON.stringify(category.body));
  const item = await db.inventoryItem.create({ data: { cafeId: cafe.id, branchId, name: marker + " beans", unit: "KG", costPerUnit: 100, currentStock: "0" } });
  const fx = { marker, cafeId: cafe.id, branchId, otherBranchId, owner, manager, annexManager, clerk, shiftId, categoryId: category.body.category.id, itemId: item.id };
  journal("retained-fixture", fx);
  return fx;
}

/** A supplier invoice of `total` (one line), confirmed unless asked otherwise. */
export async function invoice(fx: Fixture, total: number, confirm = true): Promise<string> {
  const created = await http<{ id: string }>(fx.owner, "/api/purchases", "POST", { branchId: fx.branchId, items: [{ inventoryItemId: fx.itemId, quantity: 1, unitCost: total }] });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  if (confirm) {
    const confirmed = await http(fx.owner, "/api/purchases/" + created.body.id + "/confirm", "POST", {});
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  }
  return created.body.id;
}

export const pay = (actor: Actor, invoiceId: string, body: Record<string, unknown>, key = randomUUID()) =>
  http<PaymentResult>(actor, "/api/purchases/" + invoiceId + "/payments", "POST", body, key);
export const drawerPay = (fx: Fixture, invoiceId: string, amount: number, key = randomUUID()) =>
  pay(fx.manager, invoiceId, { amount, method: "CASH", fundingSource: "DRAWER" }, key);
export const expense = (fx: Fixture, amount: number, key = randomUUID()) =>
  http<{ id: string }>(fx.manager, "/api/expenses", "POST", { branchId: fx.branchId, categoryId: fx.categoryId, amount, description: "مصروف ACC-01B" }, key);

export const shift = (fx: Fixture) => db.shift.findUniqueOrThrow({ where: { id: fx.shiftId! } });
export async function ledger(fx: Fixture, invoiceId: string) {
  const inv = await db.purchaseInvoice.findUniqueOrThrow({ where: { id: invoiceId } });
  return {
    paid: String(inv.paidAmount), remaining: String(inv.remainingAmount), status: inv.paymentStatus,
    payments: await db.purchasePayment.findMany({ where: { purchaseInvoiceId: invoiceId }, orderBy: { paidAt: "asc" } }),
    audits: await db.auditLog.count({ where: { cafeId: fx.cafeId, action: "PURCHASE_PAYMENT_RECORDED", entityId: invoiceId } }),
  };
}

export async function waitFor(check: () => Promise<boolean>, label: string, timeout = 5000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await check()) return; await new Promise((r) => setTimeout(r, 20)); }
  assert.fail("bounded coordination not reached: " + label);
}
/** True once at least `count` other backends wait on a lock for a query naming `relation`. */
export async function blockedOn(relation: string, count = 1) {
  const rows = await db.$queryRaw<{ pid: number }[]>`SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query ILIKE ${"%" + relation + "%"}`;
  if (rows.length >= count) journal("observed-database-lock-wait", { relation, backends: rows.length });
  return rows.length >= count;
}
/** Hold rows in one transaction while `work` queues requests behind them. */
export async function locked<T>(prepare: (tx: Prisma.TransactionClient) => Promise<void>, work: (release: () => void) => Promise<T>) {
  let entered!: () => void, release!: () => void;
  const enteredPromise = new Promise<void>((r) => { entered = r; });
  const releasePromise = new Promise<void>((r) => { release = r; });
  const holder = db.$transaction(async (tx) => { await prepare(tx); entered(); await releasePromise; }, { timeout: 20000 });
  try {
    await Promise.race([enteredPromise, holder.then(() => { throw Error("holder ended early"); })]);
    return await work(release);
  } finally { release(); await holder; }
}
