import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import type { Prisma } from "@prisma/client";
import { db, assertTestDatabase } from "./db";
export { db };
export const ORIGIN = "http://127.0.0.1:3106";
export const PASSWORD = "ACC01A-synthetic-only-2026";
const run = JSON.parse(readFileSync("artifacts/acc-01a/current-runtime-run.json", "utf8")) as { run: string; dir: string };
export const RUN_DIR = run.dir;
export const RUN_ID = run.run;
const cookies = new Map<string, string>();
export type Actor = { id: string; email: string; name: string };
export type Fixture = { marker: string; cafeId: string; branchId: string; otherBranchId: string; owner: Actor; manager: Actor; cashier: Actor; shiftId: string; categoryId: string };
export type Expense = { id: string; branchId: string; shiftId: string; amount: number; returnedAmount: number; unrecoveredAmount: number; returns: { id: string; amount: number }[] };
export function journal(kind: string, data: unknown) { appendFileSync(path.join(RUN_DIR, "runtime-journal.jsonl"), JSON.stringify({ at: new Date().toISOString(), kind, data }) + "\n"); }
export async function http<T = Record<string, unknown>>(actor: Actor, url: string, method = "GET", body?: unknown, key?: string) {
  const res = await fetch(ORIGIN + url, { method, signal: AbortSignal.timeout(60000), headers: { "Content-Type": "application/json", cookie: cookies.get(actor.id) ?? "", ...(key ? { "Idempotency-Key": key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text(); let parsed: T; try { parsed = JSON.parse(text) as T; } catch { throw new Error("Non-JSON API response " + res.status + ": " + text.slice(0, 200)); }
  return { status: res.status, body: parsed, headers: res.headers };
}
export async function login(actor: Actor) {
  const res = await fetch(ORIGIN + "/api/auth/login", { method: "POST", signal: AbortSignal.timeout(60000), headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: actor.email, password: PASSWORD }) });
  const text = await res.text(); assert.equal(res.status, 200, "synthetic login: " + text.slice(0, 200));
  cookies.set(actor.id, res.headers.getSetCookie().map(c => c.split(";")[0]).join("; "));
}
let ready: Promise<void> | undefined;
export function environmentReady() { return ready ??= verify(); }
async function verify() {
  const url = new URL(process.env.DATABASE_URL ?? "");
  assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.port, "5434"); assert.equal(url.pathname, "/cafe_ops_test_finf5");
  await assertTestDatabase();
  const evidence = await db.$transaction(async tx => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    const [identity] = await tx.$queryRaw<{ database: string; port: string; data_directory: string; system_identifier: string }[]>`SELECT current_database() AS database,current_setting('port') AS port,current_setting('data_directory') AS data_directory,system_identifier::text FROM pg_control_system()`;
    const marker = await tx.$queryRaw<{ id: number; note: string }[]>`SELECT id,note FROM "_disposable_test_database" ORDER BY id`;
    const migrations = await tx.$queryRaw<{ migration_name: string; checksum: string; finished: boolean }[]>`SELECT migration_name,checksum,finished_at IS NOT NULL AS finished FROM "_prisma_migrations" WHERE migration_name IN ('20261029100000_accounting_projection_tracking','20261030190000_drawer_operating_expenses') ORDER BY migration_name`;
    return { identity, marker, migrations };
  });
  assert.equal(evidence.identity.database, "cafe_ops_test_finf5"); assert.equal(evidence.identity.system_identifier, "7693368256609479860"); assert.equal(evidence.identity.data_directory.replaceAll("\\", "/"), "C:/Dev/_nextcup_test_postgres/pgdata");
  assert.deepEqual(evidence.marker, [{ id: 1, note: "Disposable. Automated tests create and delete data here. Never point this at real cafe data." }]);
  assert.equal(evidence.migrations.length, 2); assert.ok(evidence.migrations.every(m => m.finished));
  const manifest = JSON.parse(readFileSync("artifacts/acc-01a/source-manifest.json", "utf8")) as { file: string; sha256: string }[];
  for (const f of manifest) assert.equal(createHash("sha256").update(readFileSync(f.file)).digest("hex"), f.sha256, "delivered source drift " + f.file);
  const marker = "ACC01A-PROBE-" + randomUUID();
  const probe = await db.cafe.create({ data: { name: marker, slug: marker.toLowerCase(), settings: { create: { stockCountPolicy: "NO_SHIFT_COUNT" } }, branches: { create: { name: marker + " branch", menuSlug: "probe" } } } });
  const response = await fetch(ORIGIN + "/menu/" + probe.slug + "/probe", { signal: AbortSignal.timeout(60000) });
  const html = await response.text(); assert.equal(response.status, 200); assert.ok(html.includes(marker), "source/server/database correspondence failed");
  journal("source-server-database-proof", { ...evidence, sourceFiles: manifest.length, cafeId: probe.id, nonce: marker, origin: ORIGIN, retained: true });
}
export async function fixture(label: string, opening = 1000, category = true): Promise<Fixture> {
  await environmentReady();
  const marker = "ACC01A-" + label + "-" + randomUUID().slice(0, 8);
  const cafe = await db.cafe.create({ data: { name: marker, slug: marker.toLowerCase(), currency: "EGP", settings: { create: { stockCountPolicy: "NO_SHIFT_COUNT", inventoryEnabled: false, shiftManagementEnabled: true } }, branches: { create: [{ name: marker + " main", menuSlug: "main" }, { name: marker + " annex", menuSlug: "annex" }] } }, include: { branches: { orderBy: { name: "asc" } } } });
  const branchId = cafe.branches.find(b => b.name.endsWith("main"))!.id, otherBranchId = cafe.branches.find(b => b.name.endsWith("annex"))!.id;
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const actor = (suffix: string, role: "CAFE_OWNER" | "BRANCH_MANAGER" | "CASHIER", branch: string | null) => db.user.create({ data: { cafeId: cafe.id, branchId: branch, name: marker + " " + suffix, email: marker.toLowerCase() + "-" + suffix + "@example.invalid", passwordHash, role }, select: { id: true, email: true, name: true } });
  const owner = await actor("owner", "CAFE_OWNER", null), manager = await actor("manager", "BRANCH_MANAGER", branchId), cashier = await actor("cashier", "CASHIER", branchId);
  for (const a of [owner, manager, cashier]) await login(a);
  // Qualify this synthetic manager explicitly; legacy fallback grants need not include expenses.
  const granted = await http(owner, "/api/users/" + manager.id + "/permissions", "PUT", { overrides: [{ key: "expenses.view", allowed: true }, { key: "expenses.manage", allowed: true }] });
  assert.equal(granted.status, 200, "authorize the owned synthetic manager");
  const opened = await http<{ shift: { id: string } }>(manager, "/api/shifts", "POST", { branchId, openingCashAmount: opening });
  assert.ok([200,201].includes(opened.status), "open synthetic drawer: " + JSON.stringify(opened.body));
  let categoryId = "";
  if (category) { const created = await http<{ category: { id: string } }>(owner, "/api/expenses/categories", "POST", { code: "OPERATING", nameAr: "تنظيف تشغيلي تجريبي", classification: "OPERATING_EXPENSE" }); assert.equal(created.status,201); categoryId = created.body.category.id; }
  const fx = { marker, cafeId: cafe.id, branchId, otherBranchId, owner, manager, cashier, shiftId: opened.body.shift.id, categoryId };
  journal("retained-fixture", fx); return fx;
}
export function body(fx: Fixture, amount = 120, description = "مصروف تشغيل تجريبي") { return { branchId: fx.branchId, categoryId: fx.categoryId, amount, description }; }
export const pay = (fx: Fixture, amount = 120, key = randomUUID(), description?: string) => http<Expense>(fx.manager, "/api/expenses", "POST", body(fx, amount, description), key);
export const receive = (fx: Fixture, id: string, amount: number, key = randomUUID()) => http<Expense>(fx.manager, "/api/expenses/" + id + "/returns", "POST", { amount, reason: "استلام نقد فعلي تجريبي" }, key);
export const snapshot = (fx: Fixture) => db.shift.findUniqueOrThrow({ where: { id: fx.shiftId } });
export async function removeOwnedCache(fx: Fixture, source: { cafeId: string; actorId: string; idempotencyScope: string; idempotencyKey: string; requestHash: string }) {
  assert.equal(source.cafeId, fx.cafeId); assert.equal(source.actorId, fx.manager.id);
  assert.ok((await db.cafe.findUniqueOrThrow({ where: { id: fx.cafeId } })).name.startsWith(fx.marker));
  const result = await db.idempotencyKey.deleteMany({ where: { scope: source.idempotencyScope, key: source.idempotencyKey, requestHash: source.requestHash } });
  assert.equal(result.count, 1); journal("owned-response-cache-removed", { cafeId: fx.cafeId, scope: source.idempotencyScope, key: source.idempotencyKey });
}
export async function waitFor(check: () => Promise<boolean>, label: string, timeout = 1700) {
  const until = Date.now() + timeout; while (Date.now() < until) { if (await check()) return; await new Promise(r => setTimeout(r, 20)); } assert.fail("bounded coordination not reached: " + label);
}
export async function blockedOn(relation: string) {
  const rows = await db.$queryRaw<{ pid: number; wait_event: string }[]>`SELECT pid,wait_event FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query ILIKE ${'%'+relation+'%'}`;
  if(rows.length) journal("observed-database-lock-wait",{relation,backends:rows});
  return rows.length>0;
}
export async function locked<T>(prepare: (tx: Prisma.TransactionClient) => Promise<void>, work: (release: () => void) => Promise<T>) {
  let entered!: () => void, release!: () => void;
  const enteredPromise = new Promise<void>(r => { entered = r; }), releasePromise = new Promise<void>(r => { release = r; });
  const holder = db.$transaction(async tx => { await prepare(tx); entered(); await releasePromise; }, { timeout: 15000 });
  try { await Promise.race([enteredPromise, holder.then(() => { throw Error("holder ended early"); })]); return await work(release); }
  finally { release(); await holder; }
}
