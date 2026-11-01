import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readResaleHandoff, assertMatchedResaleBuild, sha256, RESALE_CLONE, APPROVED_RESALE_MIGRATION } from "./resale-acceptance-guard.mjs";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(project, "artifacts/commercial-readiness/2026-10-10-owner-uat/resale-real-acceptance");
const mode = process.argv[2];
const files = ["resale-003-serving-concurrency.test.ts", "resale-008-live-acceptance.test.ts", "resale-009-live-handover.test.ts", "resale-010-live-history-costs.test.ts"];
// Reuse only suites owning their CountCafe fixtures. The general runner's
// verification connection to the main database is excluded from this scope.
const regressions = ["handover-016-carry-open-orders.test.ts", "ledger-007-freeze-guard.test.ts", "purchase-001-confirm-integrity.test.ts"];
const newColumns = { Product: ["stockMode"], CafeSettings: ["finishedGoodsSalesEnabled"], OrderItem: ["stockModeSnapshot", "stockAcceptedAt", "stockProductIdSnapshot", "stockVariantIdSnapshot", "finishedStockCafeId", "finishedStockBranchId", "finishedStockItemId", "finishedStockUnit", "finishedStockQuantity", "finishedStockDeductedAt", "finishedStockTransactionId"] };
const quoted = value => '"' + value.replaceAll('"', '""') + '"';
const save = (name, value) => { fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2) + "\n"); };

async function snapshot(client, ignoreNewColumns = false) {
  const tables = await client.$queryRawUnsafe(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name NOT IN ('_prisma_migrations','_disposable_test_database') ORDER BY table_name`);
  const result = {};
  for (const { table_name: table } of tables) {
    // Server returns row hashes only: no credentials/private business values.
    const rows = await client.$queryRawUnsafe(`SELECT md5((to_jsonb(t) - $1::text[])::text) AS hash FROM public.${quoted(table)} t ORDER BY hash`, ignoreNewColumns ? newColumns[table] ?? [] : []);
    result[table] = rows.map(row => row.hash);
  }
  return result;
}
async function catalog(client) {
  // Hash definitions/identities only; do not expose stored SQL bodies.
  return client.$queryRawUnsafe(`SELECT kind,id,hash FROM (
    SELECT 'function' AS kind,p.oid::text AS id,md5(pg_get_functiondef(p.oid)) AS hash FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind IN ('f','p')
    UNION ALL SELECT 'trigger',t.oid::text,md5(pg_get_triggerdef(t.oid)||t.tgenabled::text) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
    UNION ALL SELECT 'constraint',c.oid::text,md5(pg_get_constraintdef(c.oid)) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public'
    UNION ALL SELECT 'index',c.oid::text,md5(pg_get_indexdef(c.oid)) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='i'
  ) objects ORDER BY kind,id`);
}
function assertPreserved(before, after, allowNew) {
  for (const [table, rows] of Object.entries(before)) {
    const counts = new Map(); for (const hash of after[table] ?? []) counts.set(hash, (counts.get(hash) ?? 0) + 1);
    for (const hash of rows) { assert.ok(counts.get(hash) > 0, "Existing data changed/deleted in " + table); counts.set(hash, counts.get(hash) - 1); }
    if (!allowNew) assert.equal(after[table]?.length, rows.length, "Migration changed row count: " + table);
  }
}
async function history(client, applied) {
  const expected = fs.readdirSync(path.join(project, "prisma/migrations"), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => ({ name: e.name, checksum: sha256(fs.readFileSync(path.join(project, "prisma/migrations", e.name, "migration.sql"))) }));
  const rows = await client.$queryRawUnsafe(`SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY started_at`);
  for (const row of rows) {
    const local = expected.find(m => m.name === row.migration_name);
    assert.ok(local, "Unexpected migration history; stop without reset");
    assert.equal(row.checksum, local.checksum, "Migration checksum drift: " + row.migration_name);
    assert.ok(row.finished_at && !row.rolled_back_at, "Unfinished/rolled-back history requires review");
  }
  for (const migration of expected) {
    const count = rows.filter(row => row.migration_name === migration.name).length;
    assert.equal(count, migration.name === APPROVED_RESALE_MIGRATION && !applied ? 0 : 1, "Unexpected pending/duplicate migration: " + migration.name);
  }
  return expected;
}
async function identity(client, handoff) {
  const [row] = await client.$queryRawUnsafe(`SELECT current_database() AS database, current_setting('port') AS port, current_setting('data_directory') AS data_directory, system_identifier::text FROM pg_control_system()`);
  assert.equal(row.database, RESALE_CLONE.database); assert.equal(String(row.port), RESALE_CLONE.port); assert.equal(row.system_identifier, RESALE_CLONE.systemIdentifier);
  const expectedData = path.join(project, "artifacts/commercial-readiness/2026-10-07-ui006-pg-diagnosis/runtime/pgdata").replaceAll("\\", "/").toLowerCase();
  assert.equal(row.data_directory.replaceAll("\\", "/").toLowerCase(), expectedData);
  const markers = await client.$queryRawUnsafe(`SELECT * FROM "_disposable_test_database"`);
  assert.equal(markers.length, 1, "Exact singleton disposable marker required");
  assert.equal(sha256(JSON.stringify(markers)), handoff.clone.markerSha256, "Disposable marker differs from fresh recovery evidence");
  return { database: row.database, port: Number(row.port), systemIdentifier: row.system_identifier, markerVerified: true };
}
async function child(args, cwd, env) {
  return new Promise((resolve, reject) => {
    const processChild = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const chunks = [];
    // Buffer complete output before redaction, so chunk boundaries cannot
    // disclose a password split across stdout/stderr events.
    for (const stream of [processChild.stdout, processChild.stderr]) stream.on("data", chunk => chunks.push(chunk));
    processChild.once("error", reject); processChild.once("exit", code => {
      let output = Buffer.concat(chunks).toString("utf8").replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[database URL omitted]");
      const url = new URL(env.DATABASE_URL);
      for (const value of [url.password, decodeURIComponent(url.password)]) if (value) output = output.replaceAll(value, "[credential omitted]");
      fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, `${mode.slice(2)}-${Date.now()}.log`), output);
      console.log(output);
      if (args.includes("--test") && code === 0) {
        const count = output.match(/# tests (\d+)/); const pass = output.match(/# pass (\d+)/);
        if (!count || Number(count[1]) === 0 || Number(count[1]) !== Number(pass?.[1])) { reject(new Error("No complete real test execution; skipped/empty suites cannot PASS acceptance")); return; }
      }
      if (code === 0) resolve(); else reject(new Error("Scoped child failed: exit " + code));
    });
  });
}
async function coLocation(client, base) {
  const nonce = "RESALE-PROBE-" + randomUUID();
  const cafe = await client.cafe.create({ data: { name: nonce, slug: nonce.toLowerCase(), settings: { create: {} }, branches: { create: { name: nonce, menuSlug: "probe", publicMenuEnabled: true } } }, include: { branches: true } });
  try {
    const response = await fetch(`${base}/menu/${cafe.slug}/probe`, { signal: AbortSignal.timeout(30_000) });
    assert.ok(response.ok && (await response.text()).includes(nonce), "App/clone co-location not proven");
  } finally {
    // Approved existing probe cleanup; exact new IDs, no history or goods.
    await client.branch.deleteMany({ where: { cafeId: cafe.id } });
    await client.cafeSettings.deleteMany({ where: { cafeId: cafe.id } }); await client.cafe.delete({ where: { id: cafe.id } });
  }
}
async function main() {
  if (!mode || mode === "--help") {
    console.log("Clone-only acceptance: --preflight (read-only), --migrate (approved additive migration only), --test, --regressions, --browser-prepare, --browser-finish-returns, --browser-finish. Requires fresh RESALE_RUNTIME_HANDOFF, exact DATABASE_URL and TEST_BASE_URL. Never starts runtime, provisions/reseeds, reads .env/main DB, or deletes resale history."); return;
  }
  assert.ok(["--preflight", "--migrate", "--test", "--regressions", "--browser-prepare", "--browser-finish-returns", "--browser-finish"].includes(mode));
  const handoff = readResaleHandoff(); // Fail before Prisma/network without new supported-host proof.
  const manifest = assertMatchedResaleBuild(handoff, project);
  const native = JSON.parse(fs.readFileSync(handoff.nativeEvidencePath, "utf8"));
  for (const key of ["jobMembership", "hostPid", "at", "status"]) assert.deepEqual(native[key], handoff.nativeHost[key]);
  assert.equal(sha256(fs.readFileSync(handoff.nativeEvidencePath)), handoff.nativeEvidenceSha256);
  assert.equal(sha256(fs.readFileSync(path.join(project, "artifacts/commercial-readiness/2026-10-10-owner-uat/native-guard.ps1"))), "d9fc767e5eb884269ade0382e759bdcca3c7754ae86c101ab2bb4697ed4a4bf3");
  const ownRequire = createRequire(path.join(manifest.isolated, "package.json"));
  const { PrismaClient } = ownRequire("@prisma/client");
  const client = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  try {
    const clone = await identity(client, handoff);
    const applied = !!(await client.$queryRawUnsafe(`SELECT 1 FROM "_prisma_migrations" WHERE migration_name=$1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL`, APPROVED_RESALE_MIGRATION)).length;
    const chain = await history(client, applied);
    const before = await snapshot(client, !applied); // Current owner activity/data baseline, not historical proof.
    const catalogBefore = await catalog(client);
    save("preflight.json", { at: new Date().toISOString(), status: "PASS", clone, buildId: manifest.buildId, migrationApplied: applied, chain, existingData: before, catalog: catalogBefore, writes: 0 });
    if (mode === "--preflight") return;
    if (mode === "--migrate") {
      assert.equal(applied, false, "Already applied: verify, do not reapply");
      assert.equal(chain.find(m => m.name === APPROVED_RESALE_MIGRATION)?.checksum, handoff.approvedMigrationSha256);
      assertPreserved(before, await snapshot(client, true), false); // Recheck owner activity immediately before mutation.
      const backup = handoff.backup;
      assert.ok(backup?.path && backup.tocVerified === true, "Reviewed recoverable clone backup required before migration");
      assert.ok(path.resolve(backup.path).startsWith(project + path.sep));
      assert.equal(sha256(fs.readFileSync(backup.path)), backup.sha256);
      assert.equal(backup.cloneSystemIdentifier, clone.systemIdentifier); assert.equal(backup.database, clone.database);
      assert.equal(backup.baselineSha256, sha256(JSON.stringify(before)), "Backup must correspond to the current owner-data baseline");
      await child(["node_modules/prisma/build/index.js", "migrate", "deploy", "--schema", "prisma/schema.prisma"], manifest.isolated, { ...process.env, PRISMA_GENERATE_SKIP_AUTOINSTALL: "true" });
      await identity(client, handoff); await history(client, true); assertPreserved(before, await snapshot(client, true), false);
      assert.equal(await client.productStockBinding.count(), 0); assert.equal(await client.finishedGoodsReturn.count(), 0);
      assert.equal(await client.product.count({ where: { stockMode: { not: "RECIPE" } } }), 0);
      assert.equal(await client.orderItem.count({ where: { stockModeSnapshot: { not: null } } }), 0);
      assert.equal(await client.cafeSettings.count({ where: { finishedGoodsSalesEnabled: true } }), 0);
      save("migration.json", { at: new Date().toISOString(), status: "APPLIED_AND_PRESERVATION_VERIFIED", clone, migration: APPROVED_RESALE_MIGRATION, noBackfill: true, dataPreserved: true }); return;
    }
    assert.equal(applied, true, "Approved migration must be applied/verified before tests");
    const browserStage = mode.startsWith("--browser-");
    let scope;
    if (browserStage && mode !== "--browser-prepare") {
      scope = JSON.parse(fs.readFileSync(path.join(out, "browser-scope.json"), "utf8"));
      assert.equal(scope.buildId, manifest.buildId); assert.equal(scope.clone.systemIdentifier, clone.systemIdentifier);
    }
    const allowedCafeIds = scope?.cafeIds ?? [];
    assert.equal(await client.cafeSettings.count({ where: { finishedGoodsSalesEnabled: true, cafeId: { notIn: allowedCafeIds } } }), 0, "Stop on unexpected feature activation outside owned test scopes");
    await coLocation(client, process.env.TEST_BASE_URL);
    if (browserStage) {
      const journalDir = scope?.journalDir ?? path.join(out, "owned-fixtures", randomUUID());
      const fixturesFile = scope?.fixturesFile ?? path.join(out, "browser-fixtures-" + randomUUID() + ".json");
      let failure;
      try {
        await child(["--import", "tsx", "--test", "tests/resale-012-browser-fixtures.test.ts"], manifest.isolated, { ...process.env, NODE_ENV: "test", RESALE_ACCEPTANCE_PREFLIGHT_VERIFIED: "1", RESALE_ACCEPTANCE_JOURNAL_DIR: journalDir, RESALE_BROWSER_FIXTURES: fixturesFile, RESALE_BROWSER_PHASE: mode.slice("--browser-".length) });
      } catch (error) { failure = error; }
      const owned = fs.existsSync(journalDir) ? fs.readdirSync(journalDir).filter(f => f.endsWith(".json")).map(f => JSON.parse(fs.readFileSync(path.join(journalDir, f), "utf8"))) : [];
      for (const record of owned) {
        assert.equal((await client.cafe.findUniqueOrThrow({ where: { id: record.cafeId } })).name, record.marker + " cafe");
        if (failure || mode === "--browser-finish") await client.cafeSettings.update({ where: { cafeId: record.cafeId }, data: { finishedGoodsSalesEnabled: false } });
      }
      assertPreserved(scope?.existingData ?? before, await snapshot(client), true);
      save("browser-scope.json", { at: new Date().toISOString(), status: failure ? "FIXTURE_STAGE_FAILED_GATES_OFF" : mode === "--browser-prepare" ? "PREPARED_NOT_RUN" : mode.slice(2), existingData: scope?.existingData ?? before, clone, buildId: manifest.buildId, journalDir, fixturesFile, cafeIds: owned.map(f => f.cafeId), browserResultsFile: path.join(out, "browser-results.json"), historiesRetained: true });
      if (mode === "--browser-finish" || failure) assert.equal(await client.cafeSettings.count({ where: { finishedGoodsSalesEnabled: true } }), 0);
      if (failure) throw failure;
      return;
    }
    const selected = mode === "--test" ? files : regressions;
    const journalDir = path.join(out, "owned-fixtures", randomUUID());
    let failure;
    try {
      await child(["--import", "tsx", "--test", ...selected.map(f => "tests/" + f)], manifest.isolated, { ...process.env, NODE_ENV: "test", RUN_RESALE_CLONE_TESTS: "1", RESALE_ACCEPTANCE_PREFLIGHT_VERIFIED: "1", RESALE_ACCEPTANCE_JOURNAL_DIR: journalDir });
    } catch (error) { failure = error; }
    // Also handles a setup failure after registration but before fixture return.
    // Never deletes history or modifies any unregistered/pre-existing cafe.
    if (fs.existsSync(journalDir)) for (const file of fs.readdirSync(journalDir).filter(f => f.endsWith(".json"))) {
      const owned = JSON.parse(fs.readFileSync(path.join(journalDir, file), "utf8"));
      const cafe = await client.cafe.findUnique({ where: { id: owned.cafeId } });
      if (!cafe) { assert.equal(owned.cleanup, "OWNED_RECIPE_FIXTURE_REMOVED"); continue; }
      assert.equal(cafe.name, owned.marker + " cafe", "Ownership mismatch: stop cleanup");
      await client.cafeSettings.update({ where: { cafeId: cafe.id }, data: { finishedGoodsSalesEnabled: false } });
    }
    const after = await snapshot(client); assertPreserved(before, after, true);
    assert.deepEqual(await catalog(client), catalogBefore, "Catalog changed or test hook retained: stop; use owned catalog journal for scoped recovery");
    assert.equal(await client.cafeSettings.count({ where: { finishedGoodsSalesEnabled: true } }), 0, "Test-owned feature gates must be disabled at completion");
    save(mode === "--test" ? "database.json" : "regressions.json", { at: new Date().toISOString(), status: failure ? "FAIL" : "PASS", files: selected, clone, buildId: manifest.buildId, existingDataPreserved: true, browser: "NOT RUN", ownerAcceptance: "PENDING", deployment: "NOT AUTHORIZED / NOT READY" });
    if (failure) throw failure;
  } finally { await client.$disconnect(); }
}
await main().catch(error => { console.error(error.message); process.exitCode = 1; });
