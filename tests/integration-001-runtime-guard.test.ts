import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  assertIntegrationDatabase,
  assertMigrationInventory,
  databaseUrl,
  loadIntegrationConfig,
  validateIntegrationConfig,
  verifySources,
  type IntegrationClient,
  type IntegrationConfig,
} from "./helpers/integration-runtime";

// Pure refusal coverage. This file neither imports Prisma at runtime nor opens
// a socket, creates runtime receipts, or writes database/application fixtures.
const marker = "Disposable. Automated tests create and delete data here. Never point this at real cafe data.";
const releases = [
  { name: "20261030130000_hnd_ux_004_materials_cadence", checksum: "68a441b4f89577464bb11bf9fcd873592c231de49abeb70bf07d232cd978a0a2" },
  { name: "20261030170000_cash_receipt_optional_reason", checksum: "a59df8efb95444bd1efa4d970982d7838fdc86a496d5a8bd805ce32c3897bf62" },
];
function config(): IntegrationConfig {
  const migrations89 = Array.from({ length: 89 }, (_, i) => ({
    name: `20260101${String(i).padStart(6, "0")}_synthetic`,
    checksum: String(i + 1).padStart(64, "0"),
  }));
  return {
    runId: "integration-20261101-pure-refusal-only",
    host: "127.0.0.1", port: 5434,
    dataDirectory: "C:/Dev/_nextcup_test_postgres/pgdata",
    systemIdentifier: "7693368256609479860",
    databases: {
      replay: { name: "cafe_ops_test_integr20261101_replay_0123456789abcdef", oid: "180001", ownedByRun: "integration-20261101-pure-refusal-only" },
      upgrade: { name: "cafe_ops_test_integr20261101_upgrade_fedcba9876543210", oid: "180002", ownedByRun: "integration-20261101-pure-refusal-only" },
    },
    markerNote: marker, migrations89, migrations91: [...migrations89, ...releases],
    sourceManifestPath: "artifacts/integration-all-approved-20261101/final-source-manifest.json",
    sourceManifestSha256: "0".repeat(64),
    baselineManifestSha256: "8394c7dd0d9efa2264c88a7f958aeb7843a066f6b62326a94cef513c970abdda",
    authSecret: "synthetic-pure-test-secret-at-least-32-chars",
  };
}
type Facts = {
  identity: { database: string; host: string; port: string; directory: string; system_identifier: string; oid: string }[];
  marker: { id: number; note: string }[];
  migrations: { migration_name: string; checksum: string; finished: boolean; rolled_back: boolean }[];
};
function facts(c: IntegrationConfig, phase: 89 | 91 = 91): Facts {
  return {
    identity: [{ database: c.databases.replay.name, host: c.host, port: String(c.port), directory: c.dataDirectory, system_identifier: c.systemIdentifier, oid: String(c.databases.replay.oid) }],
    marker: [{ id: 1, note: marker }],
    migrations: c[phase === 89 ? "migrations89" : "migrations91"].map((m) => ({ migration_name: m.name, checksum: m.checksum, finished: true, rolled_back: false })),
  };
}
function fake(rows: Facts) {
  const calls: string[] = [];
  const query = {
    async $executeRawUnsafe(sql: string) { calls.push(sql); assert.equal(sql, "SET TRANSACTION READ ONLY"); return 0; },
    async $queryRawUnsafe<T = unknown>(sql: string): Promise<T> {
      calls.push(sql);
      assert.equal(calls[0], "SET TRANSACTION READ ONLY", "all identity checks occur in a read-only transaction");
      if (sql.includes("pg_control_system")) {
        assert.match(sql, /host\(inet_server_addr\(\)\) AS host/, "normalize PostgreSQL inet /32 rendering in SQL; retain an exact host check");
        return structuredClone(rows.identity) as T;
      }
      if (sql.includes("_disposable_test_database")) return structuredClone(rows.marker) as T;
      if (sql.includes("_prisma_migrations")) return structuredClone(rows.migrations) as T;
      throw Error("Unexpected fake query");
    },
  };
  const client: IntegrationClient = { ...query, async $transaction(body) { return body(query); } };
  return { client, calls };
}

describe("integration runtime guard: explicit configuration", () => {
  test("requires INTEGRATION_CONFIG_FILE and never falls back to DATABASE_URL", () => {
    const previous = process.env.INTEGRATION_CONFIG_FILE;
    delete process.env.INTEGRATION_CONFIG_FILE;
    try { assert.throws(() => loadIntegrationConfig(), /INTEGRATION_CONFIG_FILE/); }
    finally { if (previous !== undefined) process.env.INTEGRATION_CONFIG_FILE = previous; }
  });

  const badConfigs: [string, (c: IntegrationConfig) => void, RegExp][] = [
    ["host", (c) => { c.host = "localhost"; }, /host/],
    ["owner port", (c) => { c.port = 5433; }, /port/],
    ["alternate port", (c) => { c.port = 5442; }, /port/],
    ["cluster identifier", (c) => { c.systemIdentifier = "7693368256609479861"; }, /system identifier/],
    ["data directory", (c) => { c.dataDirectory = "C:/Dev/owner/pgdata"; }, /data directory/],
    ["directory traversal", (c) => { c.dataDirectory += "/../pgdata"; }, /data directory/],
    ["historical finance target", (c) => { c.databases.replay.name = "cafe_ops_test_finf5"; }, /database name/],
    ["unsuffixed target", (c) => { c.databases.replay.name = "cafe_ops_test"; }, /database name/],
    ["swapped allowlist key", (c) => { c.databases.replay.name = c.databases.upgrade.name; }, /database name/],
    ["third allowlisted target", (c) => { Object.assign(c.databases, { other: { ...c.databases.replay } }); }, /exactly replay and upgrade/],
    ["missing allowlisted target", (c) => { Reflect.deleteProperty(c.databases, "upgrade"); }, /exactly replay and upgrade/],
    ["missing OID", (c) => { c.databases.replay.oid = ""; }, /OID/],
    ["shared OID", (c) => { c.databases.upgrade.oid = c.databases.replay.oid; }, /distinct OIDs/],
    ["unowned database", (c) => { c.databases.replay.ownedByRun = "other-run"; }, /run ownership/],
    ["missing run identifier", (c) => { c.runId = ""; }, /run identifier/],
    ["altered marker", (c) => { c.markerNote = "disposable"; }, /marker/],
    ["incomplete migration set", (c) => { c.migrations91.pop(); }, /91 migrations/],
    ["duplicate migration", (c) => { c.migrations91[1] = c.migrations91[0]; }, /duplicate migration/],
    ["invalid checksum", (c) => { c.migrations91[0].checksum = "not-a-hash"; }, /checksum/],
    ["historical checksum drift", (c) => { c.migrations91[0] = { ...c.migrations91[0], checksum: "f".repeat(64) }; }, /historical migration/],
    ["first-89 shortcut", (c) => { c.migrations89[88] = releases[0]; }, /historical migration set/],
    ["release checksum drift", (c) => { c.migrations91[89] = { ...releases[0], checksum: "f".repeat(64) }; }, /release migration/],
    ["changed baseline manifest pin", (c) => { c.baselineManifestSha256 = "f".repeat(64); }, /baseline source manifest checksum/],
    ["source allowlist traversal", (c) => { c.authorizedSourceChanges = ["../owner/source.ts"]; }, /source-change allowlist/],
  ];
  for (const [label, mutate, expected] of badConfigs) {
    test(`refuses ${label} before querying`, async () => {
      const c = config(); const db = fake(facts(c)); mutate(c);
      await assert.rejects(() => assertIntegrationDatabase(db.client, c, "replay", 91), expected);
      assert.equal(db.calls.length, 0);
    });
  }
  test("constructs only explicitly allowlisted URLs without inherited connection settings", () => {
    const c = config(); validateIntegrationConfig(c);
    assert.equal(databaseUrl(c, "replay"), `postgresql://postgres@127.0.0.1:5434/${c.databases.replay.name}?schema=public`);
    assert.throws(() => databaseUrl(c, "other" as "replay"), /database key/);
  });
  test("refuses an unpinned source manifest before reading its entries", () => {
    assert.throws(() => verifySources(config()), /source manifest checksum/);
  });
});

describe("integration runtime guard: read-only database facts", () => {
  const badFacts: [string, (f: Facts) => void, RegExp][] = [
    ["absent identity", (f) => { f.identity = []; }, /one identity/],
    ["wrong host", (f) => { f.identity[0].host = "192.0.2.1"; }, /database host/],
    ["unnormalized inet mask", (f) => { f.identity[0].host = "127.0.0.1/32"; }, /database host/],
    ["wrong port", (f) => { f.identity[0].port = "5433"; }, /database port/],
    ["wrong database", (f) => { f.identity[0].database = "cafe_ops_test_finf5"; }, /database name/],
    ["wrong OID", (f) => { f.identity[0].oid = "190001"; }, /database OID/],
    ["wrong cluster", (f) => { f.identity[0].system_identifier = "1"; }, /database system identifier/],
    ["wrong directory", (f) => { f.identity[0].directory = "C:/Dev/owner/pgdata"; }, /database data directory/],
    ["absent marker", (f) => { f.marker = []; }, /exact disposable marker/],
    ["extra marker", (f) => { f.marker.push({ id: 2, note: marker }); }, /exact disposable marker/],
    ["wrong marker ID", (f) => { f.marker[0].id = 2; }, /exact disposable marker/],
    ["wrong marker text", (f) => { f.marker[0].note = "disposable"; }, /exact disposable marker/],
    ["missing migration", (f) => { f.migrations.pop(); }, /migration set/],
    ["unexpected migration", (f) => { f.migrations[0].migration_name = "20260101000000_unexpected"; }, /migration set/],
    ["duplicate applied migration", (f) => { f.migrations[1] = f.migrations[0]; }, /migration set/],
    ["applied checksum drift", (f) => { f.migrations[0].checksum = "f".repeat(64); }, /migration checksum/],
    ["unfinished migration", (f) => { f.migrations[0].finished = false; }, /failed or unresolved migration/],
    ["rolled-back migration", (f) => { f.migrations[0].rolled_back = true; }, /failed or unresolved migration/],
  ];
  for (const [label, mutate, expected] of badFacts) {
    test(`refuses ${label}`, async () => {
      const c = config(); const rows = facts(c); mutate(rows);
      await assert.rejects(() => assertIntegrationDatabase(fake(rows).client, c, "replay", 91), expected);
    });
  }
  test("accepts exact fake facts in a read-only transaction without generating runtime evidence", async () => {
    for (const phase of [89, 91] as const) {
      const c = config(); const db = fake(facts(c, phase));
      const result = await assertIntegrationDatabase(db.client, c, "replay", phase);
      assert.equal(result.completedMigrations, phase);
      assert.equal(result.oid, "180001");
      assert.equal(db.calls[0], "SET TRANSACTION READ ONLY");
      assert.equal(db.calls.length, 4);
    }
  });
});

describe("integration runtime guard: migration inventory", () => {
  test("refuses an unmanifested migration.sql even when every pinned migration remains present", () => {
    const pinned = config().migrations91;
    const disk = [...pinned.map((m) => m.name), "20261101000000_unreviewed_extra_migration"];
    assert.throws(() => assertMigrationInventory(disk, pinned), /actual migration.sql inventory/);
  });
  test("refuses a substituted migration even when the directory count still equals 91", () => {
    const pinned = config().migrations91;
    const disk = pinned.map((m) => m.name);
    disk[0] = "20261101000000_unreviewed_replacement";
    assert.throws(() => assertMigrationInventory(disk, pinned), /actual migration.sql inventory/);
  });
  test("refuses a missing or duplicate inventory entry", () => {
    const pinned = config().migrations91;
    assert.throws(() => assertMigrationInventory(pinned.slice(1).map((m) => m.name), pinned), /actual migration.sql inventory/);
    const duplicate = pinned.map((m) => m.name); duplicate[0] = duplicate[1];
    assert.throws(() => assertMigrationInventory(duplicate, pinned), /actual migration.sql inventory/);
  });
  test("accepts the complete inventory independently of directory enumeration order", () => {
    const pinned = config().migrations91;
    assert.doesNotThrow(() => assertMigrationInventory(pinned.map((m) => m.name).reverse(), pinned));
  });
});
