// Task-specific retained-fixture harness. No historical helper, expected hash,
// database, or environment file is retargeted by importing this module.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PrismaClient } from "@prisma/client";

export type IntegrationDatabaseKey = "replay" | "upgrade";
export type IntegrationMigration = { name: string; checksum: string };
export type IntegrationConfig = {
  runId: string;
  host: string;
  port: number;
  dataDirectory: string;
  systemIdentifier: string;
  databases: Record<IntegrationDatabaseKey, { name: string; oid: string | number; ownedByRun: string }>;
  markerNote: string;
  migrations89: IntegrationMigration[];
  migrations91: IntegrationMigration[];
  sourceManifestPath: string;
  sourceManifestSha256: string;
  baselineManifestSha256: string;
  authorizedSourceChanges?: string[];
  authSecret: string;
  baseUrl?: string;
  correspondence?: IntegrationCorrespondence;
};
export type IntegrationQueryClient = {
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
};
export type IntegrationClient = IntegrationQueryClient & {
  $transaction<T>(body: (tx: IntegrationQueryClient) => Promise<T>): Promise<T>;
};
type ProbeClient = IntegrationClient & Pick<PrismaClient, "cafe">;
export type IntegrationCorrespondence = {
  runId: string; database: string; oid: string; baseUrl: string;
  cafeId: string; branchId: string; nonce: string; verifiedAt: string;
};
export type IntegrationDatabaseProof = {
  runId: string; database: string; oid: string; host: string; port: number;
  dataDirectory: string; systemIdentifier: string; completedMigrations: 89 | 91;
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CONTINUATION = path.join(ROOT, "artifacts/integration-all-approved-20261101/continuation-20261101");
const BASELINE_MANIFEST = path.join(ROOT, "artifacts/integration-all-approved-20261101/final-source-manifest.json");
const BASELINE_MANIFEST_SHA256 = "8394c7dd0d9efa2264c88a7f958aeb7843a066f6b62326a94cef513c970abdda";
const MARKER = "Disposable. Automated tests create and delete data here. Never point this at real cafe data.";
const DIRECTORY = "C:/Dev/_nextcup_test_postgres/pgdata";
const SYSTEM_IDENTIFIER = "7693368256609479860";
const SHA256 = /^[a-f0-9]{64}$/;
const RELEASES: IntegrationMigration[] = [
  { name: "20261030130000_hnd_ux_004_materials_cadence", checksum: "68a441b4f89577464bb11bf9fcd873592c231de49abeb70bf07d232cd978a0a2" },
  { name: "20261030170000_cash_receipt_optional_reason", checksum: "a59df8efb95444bd1efa4d970982d7838fdc86a496d5a8bd805ce32c3897bf62" },
];
const slash = (value: string) => value.replaceAll("\\", "/");
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function within(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
function explicitConfigFile() {
  const value = process.env.INTEGRATION_CONFIG_FILE;
  assert.ok(typeof value === "string" && value.length > 0, "INTEGRATION_CONFIG_FILE must be supplied explicitly; no environment/database fallback");
  const file = path.resolve(value);
  assert.ok(within(CONTINUATION, file), "INTEGRATION_CONFIG_FILE must be in this continuation's evidence directory");
  return file;
}
function checkedBaseUrl(value: unknown): string {
  assert.ok(typeof value === "string", "explicit owned application base URL required");
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw Error("invalid application base URL"); }
  assert.ok(parsed.protocol === "http:" && parsed.hostname === "127.0.0.1" && /^\d+$/.test(parsed.port), "application base URL must use HTTP on 127.0.0.1 with an explicit port");
  assert.ok(Number(parsed.port) >= 1024 && Number(parsed.port) <= 65535, "invalid owned application port");
  assert.ok(!parsed.username && !parsed.password && parsed.pathname === "/" && !parsed.search && !parsed.hash, "application base URL must be a credential-free origin");
  return parsed.origin;
}

/** Pure validation; no implicit environment URL, database call, or receipt. */
export function validateIntegrationConfig(value: unknown): asserts value is IntegrationConfig {
  assert.ok(object(value), "integration configuration must be an object");
  const c = value as unknown as IntegrationConfig;
  assert.ok(typeof c.runId === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{7,99}$/.test(c.runId), "invalid integration run identifier");
  assert.ok(c.host === "127.0.0.1", "integration host must be 127.0.0.1");
  assert.ok(c.port === 5434, "integration port must be 5434");
  assert.ok(c.systemIdentifier === SYSTEM_IDENTIFIER, "integration system identifier mismatch");
  assert.ok(typeof c.dataDirectory === "string" && slash(c.dataDirectory) === DIRECTORY, "integration data directory mismatch");
  assert.ok(object(c.databases) && JSON.stringify(Object.keys(c.databases).sort()) === '["replay","upgrade"]', "database allowlist must contain exactly replay and upgrade");
  for (const key of ["replay", "upgrade"] as const) {
    const database = c.databases[key];
    assert.ok(object(database), "missing allowlisted database");
    assert.ok(typeof database.name === "string" && database.name.length <= 63 && new RegExp(`^cafe_ops_test_integr20261101_${key}_[A-Za-z0-9]{8,64}$`).test(database.name), "invalid allowlisted integration database name");
    const oid = String(database.oid);
    assert.ok(/^[1-9]\d*$/.test(oid) && Number.isSafeInteger(Number(oid)) && Number(oid) <= 4294967295, "positive recorded database OID required");
    assert.ok(database.ownedByRun === c.runId, "database run ownership mismatch");
  }
  assert.ok(String(c.databases.replay.oid) !== String(c.databases.upgrade.oid), "new databases require distinct OIDs");
  assert.ok(c.markerNote === MARKER, "exact historical disposable marker required");
  for (const count of [89, 91] as const) {
    const migrations = c[count === 89 ? "migrations89" : "migrations91"];
    assert.ok(Array.isArray(migrations) && migrations.length === count, `expected complete set of ${count} migrations`);
    const seen = new Set<string>();
    for (const migration of migrations) {
      assert.ok(object(migration) && typeof migration.name === "string" && /^\d{14}_[A-Za-z0-9_]+$/.test(migration.name), "invalid migration name");
      assert.ok(typeof migration.checksum === "string" && SHA256.test(migration.checksum), "invalid migration checksum");
      assert.ok(!seen.has(migration.name), "duplicate migration name");
      seen.add(migration.name);
    }
  }
  for (const release of RELEASES) {
    assert.ok(!c.migrations89.some((m) => m.name === release.name), "historical migration set must exclude both release migrations; do not take the first 89 timestamps");
    assert.ok(c.migrations91.some((m) => m.name === release.name && m.checksum === release.checksum), "release migration checksum mismatch");
  }
  for (const migration of c.migrations89) {
    assert.ok(c.migrations91.some((m) => m.name === migration.name && m.checksum === migration.checksum), "historical migration checksum differs between 89 and 91 sets");
  }
  assert.ok(typeof c.sourceManifestPath === "string" && c.sourceManifestPath.length > 0, "explicit source manifest path required");
  assert.ok(typeof c.sourceManifestSha256 === "string" && SHA256.test(c.sourceManifestSha256), "explicit source manifest checksum required");
  assert.ok(c.baselineManifestSha256 === BASELINE_MANIFEST_SHA256, "immutable baseline source manifest checksum mismatch");
  if (c.authorizedSourceChanges !== undefined) {
    assert.ok(Array.isArray(c.authorizedSourceChanges) && c.authorizedSourceChanges.every((file) => typeof file === "string" && within(ROOT, path.resolve(ROOT, file)) && !path.isAbsolute(file) && slash(file) === file), "invalid reviewed source-change allowlist");
  }
  assert.ok(typeof c.authSecret === "string" && c.authSecret.length >= 32, "explicit synthetic authentication secret of at least 32 characters required");
  if (c.baseUrl !== undefined) checkedBaseUrl(c.baseUrl);
}

export function loadIntegrationConfig(): IntegrationConfig {
  const file = explicitConfigFile();
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, "utf8")); }
  catch { throw Error("Cannot read explicit INTEGRATION_CONFIG_FILE as JSON; no fallback is permitted"); }
  validateIntegrationConfig(value);
  return value;
}

/** The reviewed local disposable cluster uses its existing postgres trust login. */
export function databaseUrl(config: IntegrationConfig, key: IntegrationDatabaseKey): string {
  validateIntegrationConfig(config);
  assert.ok(key === "replay" || key === "upgrade", "database key is outside the two-name allowlist");
  const url = new URL("postgresql://postgres@127.0.0.1:5434");
  url.pathname = "/" + config.databases[key].name;
  url.searchParams.set("schema", "public");
  return url.toString();
}

/** Pure inventory comparison: known-file hashes cannot detect an extra SQL file. */
export function assertMigrationInventory(actualNames: readonly string[], expected: readonly IntegrationMigration[]): void {
  const names = expected.map((migration) => migration.name);
  const unique = new Set(names);
  assert.ok(unique.size === names.length && actualNames.length === names.length && new Set(actualNames).size === actualNames.length, "actual migration.sql inventory differs from the exact pinned migration set");
  assert.deepEqual([...actualNames].sort(), [...names].sort(), "actual migration.sql inventory differs from the exact pinned migration set");
}

/** Hash the manifest bytes first, then every retained source and migration byte. */
export function verifySources(config: IntegrationConfig): { files: number; manifestSha256: string } {
  validateIntegrationConfig(config);
  const manifestPath = path.resolve(ROOT, config.sourceManifestPath);
  assert.ok(manifestPath === BASELINE_MANIFEST || within(CONTINUATION, manifestPath), "source manifest must be the immutable baseline or an explicitly pinned continuation manifest");
  const baselineBytes = readFileSync(BASELINE_MANIFEST);
  assert.ok(hash(baselineBytes) === config.baselineManifestSha256, "immutable baseline source manifest bytes changed");
  const baseline: unknown = JSON.parse(baselineBytes.toString("utf8"));
  assert.ok(object(baseline) && Object.keys(baseline).length === 916, "complete retained 916-file baseline manifest required");
  const bytes = readFileSync(manifestPath);
  assert.ok(hash(bytes) === config.sourceManifestSha256, "source manifest checksum mismatch");
  const manifest: unknown = JSON.parse(bytes.toString("utf8"));
  assert.ok(object(manifest) && Object.keys(baseline).every((file) => Object.hasOwn(manifest, file)), "continuation source manifest must retain every original 916-file baseline path");
  const migrationDirectory = path.join(ROOT, "prisma/migrations");
  const diskMigrations = readdirSync(migrationDirectory, { withFileTypes: true })
    .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && existsSync(path.join(migrationDirectory, entry.name, "migration.sql")))
    .map((entry) => entry.name);
  assertMigrationInventory(diskMigrations, config.migrations91);
  const migrations: IntegrationMigration[] = [];
  for (const [relative, pin] of Object.entries(manifest)) {
    const file = path.resolve(ROOT, relative);
    assert.ok(within(ROOT, file) && object(pin) && typeof pin.sha256 === "string" && SHA256.test(pin.sha256), "invalid retained source manifest entry");
    const content = readFileSync(file);
    assert.ok(hash(content) === pin.sha256 && content.length === pin.bytes, `Retained source changed: ${relative}`);
    const migration = /^prisma\/migrations\/([^/]+)\/migration\.sql$/.exec(slash(relative));
    const prior = baseline[relative];
    if (object(prior) && prior.sha256 !== pin.sha256) {
      assert.ok(!migration && config.authorizedSourceChanges?.includes(relative), `Source change requires explicit reviewed authorization: ${relative}`);
    }
    if (migration) migrations.push({ name: migration[1], checksum: pin.sha256 });
  }
  const sorted = (rows: IntegrationMigration[]) => rows.toSorted((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(sorted(migrations), sorted(config.migrations91), "configured migration checksums differ from retained source bytes");
  return { files: Object.keys(manifest).length, manifestSha256: config.sourceManifestSha256 };
}

/** Read-only identity, ownership, exact marker, and full migration-set proof. */
export async function assertIntegrationDatabase(
  client: IntegrationClient, config: IntegrationConfig, key: IntegrationDatabaseKey, phase: 89 | 91,
): Promise<IntegrationDatabaseProof> {
  // Validate before handing even a SELECT to an injected client.
  databaseUrl(config, key);
  assert.ok(phase === 89 || phase === 91, "migration phase must be 89 or 91");
  const expected = config.databases[key];
  return client.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    const identity = await tx.$queryRawUnsafe<{ database: string; host: string; port: string; directory: string; system_identifier: string; oid: string }[]>(
      "SELECT current_database() AS database, host(inet_server_addr()) AS host, current_setting('port') AS port, current_setting('data_directory') AS directory, system_identifier::text AS system_identifier, (SELECT oid::text FROM pg_database WHERE datname = current_database()) AS oid FROM pg_control_system()",
    );
    assert.ok(identity.length === 1, "expected exactly one identity row");
    const row = identity[0];
    assert.ok(row.host === config.host, "database host mismatch");
    assert.ok(row.port === String(config.port), "database port mismatch");
    assert.ok(row.database === expected.name, "database name is outside selected allowlist entry");
    assert.ok(String(row.oid) === String(expected.oid), "database OID mismatch");
    assert.ok(row.system_identifier === config.systemIdentifier, "database system identifier mismatch");
    assert.ok(typeof row.directory === "string" && slash(row.directory) === DIRECTORY, "database data directory mismatch");
    const markers = await tx.$queryRawUnsafe<{ id: number; note: string }[]>('SELECT id,note FROM "_disposable_test_database" ORDER BY id');
    assert.deepEqual(markers, [{ id: 1, note: MARKER }], "exact disposable marker singleton required");
    const rows = await tx.$queryRawUnsafe<{ migration_name: string; checksum: string; finished: boolean; rolled_back: boolean }[]>(
      'SELECT migration_name,checksum,finished_at IS NOT NULL AS finished,rolled_back_at IS NOT NULL AS rolled_back FROM "_prisma_migrations" ORDER BY migration_name',
    );
    assert.ok(rows.every((m) => m.finished === true && m.rolled_back === false), "failed or unresolved migration history is forbidden");
    const migrations = config[phase === 89 ? "migrations89" : "migrations91"];
    assert.ok(rows.length === migrations.length && new Set(rows.map((m) => m.migration_name)).size === rows.length, "completed migration set differs from the exact expected set");
    const expectedByName = new Map(migrations.map((m) => [m.name, m.checksum]));
    for (const migration of rows) {
      assert.ok(expectedByName.has(migration.migration_name), "unexpected completed migration set");
      assert.ok(expectedByName.get(migration.migration_name) === migration.checksum, "applied migration checksum mismatch");
    }
    return { runId: config.runId, database: row.database, oid: String(row.oid), host: row.host, port: config.port, dataDirectory: slash(row.directory), systemIdentifier: row.system_identifier, completedMigrations: phase };
  });
}

/** Append only; fixtures and financial/audit records are deliberately retained. */
export function journalIntegrationEvidence(config: IntegrationConfig, kind: string, data: unknown): void {
  validateIntegrationConfig(config);
  assert.ok(/^[A-Za-z0-9_-]+$/.test(kind), "invalid evidence event kind");
  const redact = (_key: string, value: unknown): unknown => {
    if (/password|authsecret|database_url|token|cookie/i.test(_key)) return "[redacted]";
    return typeof value === "string" ? value.replaceAll(config.authSecret, "[redacted secret]").replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[redacted database URL]") : value;
  };
  const entry = JSON.stringify({ at: new Date().toISOString(), runId: config.runId, kind, data }, redact);
  appendFileSync(path.join(path.dirname(explicitConfigFile()), "integration-runtime-journal.jsonl"), entry + "\n");
}

/** Positive server/database correspondence before any mutating HTTP checks. */
export async function assertHttpCorrespondence(
  client: ProbeClient, config: IntegrationConfig, key: IntegrationDatabaseKey, baseUrl: string,
): Promise<IntegrationCorrespondence> {
  const origin = checkedBaseUrl(baseUrl);
  if (config.baseUrl !== undefined) assert.ok(origin === checkedBaseUrl(config.baseUrl), "application origin differs from explicit integration configuration");
  // Require an evidence location before creating even this owned synthetic row.
  explicitConfigFile();
  verifySources(config);
  const identity = await assertIntegrationDatabase(client, config, key, 91);
  const nonce = "INTEGRATION-PROBE-" + randomUUID();
  const slug = nonce.toLowerCase();
  journalIntegrationEvidence(config, "correspondence-probe-planned", { database: identity.database, oid: identity.oid, nonce, slug, retained: true });
  const cafe = await client.cafe.create({
    data: { name: nonce, slug, currency: "EGP", branches: { create: { name: nonce, menuSlug: "probe" } } },
    include: { branches: true },
  });
  const probe = { runId: config.runId, database: identity.database, oid: identity.oid, baseUrl: origin, cafeId: cafe.id, branchId: cafe.branches[0].id, nonce };
  journalIntegrationEvidence(config, "retained-correspondence-probe", { ...probe, slug, retained: true });
  const response = await fetch(origin + "/menu/" + slug + "/probe", { method: "GET", signal: AbortSignal.timeout(60000), redirect: "error", cache: "no-store" });
  assert.ok(response.status === 200, "public-menu correspondence probe requires HTTP 200");
  assert.ok((await response.text()).includes(nonce), "public-menu correspondence nonce absent; refuse mutating HTTP tests");
  const proof = { ...probe, verifiedAt: new Date().toISOString() };
  journalIntegrationEvidence(config, "verified-http-correspondence", proof);
  return proof;
}

export async function verifyIntegrationRuntime(
  client: ProbeClient, config: IntegrationConfig, key: IntegrationDatabaseKey = "replay", baseUrl = config.baseUrl,
): Promise<{ source: ReturnType<typeof verifySources>; database: IntegrationDatabaseProof; correspondence: IntegrationCorrespondence }> {
  const source = verifySources(config);
  const database = await assertIntegrationDatabase(client, config, key, 91);
  const correspondence = await assertHttpCorrespondence(client, config, key, checkedBaseUrl(baseUrl));
  journalIntegrationEvidence(config, "verified-integration-runtime", { source, database, correspondence });
  return { source, database, correspondence };
}
