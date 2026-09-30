import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import {
  MARKER_TABLE,
  TEST_DB_NAME,
  TEST_DB_PORT,
} from "./test-db.mjs";

const OWNER_HOST = "127.0.0.1";
const OWNER_PORT = "5433";
const OWNER_DATABASE = "postgres";
const SELECT_ONLY = /^\s*SELECT\b/i;
const TIMESTAMP_KEYS = Object.freeze([
  "userMaxUpdatedAt",
  "userMaxLastLoginAt",
  "shiftMaxUpdatedAt",
  "shiftMaxClosedAt",
  "orderMaxUpdatedAt",
  "inventoryItemMaxUpdatedAt",
]);

function quoteIdentifier(identifier) {
  if (typeof identifier !== "string" || identifier.length === 0) {
    throw new TypeError("table must be a non-empty identifier");
  }
  if (identifier.includes("\0")) {
    throw new Error("table identifier cannot contain a null byte");
  }
  return `"${identifier.replaceAll('"', '""')}"`;
}

export function tableDigestSql(table) {
  const schema = quoteIdentifier("public");
  const quoted = quoteIdentifier(table);
  return `SELECT count(*)::bigint AS rows,
       md5(string_agg(t.row_md5, '' ORDER BY t.row_md5)) AS digest
  FROM (
    SELECT md5(x::text) AS row_md5
      FROM ${schema}.${quoted} x
  ) t`;
}

function safeCount(value, label) {
  const count = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return count;
}

function instant(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid snapshot timestamp: ${String(value)}`);
  }
  return parsed.toISOString();
}

export function snapshotShape(rows) {
  const tables = Object.fromEntries(
    [...rows.tables]
      .sort((a, b) => a.table.localeCompare(b.table))
      .map((row) => [
        row.table,
        {
          rows: safeCount(row.rows, `${row.table}.rows`),
          digest: row.digest ?? null,
        },
      ])
  );
  const timestamps = Object.fromEntries(
    TIMESTAMP_KEYS.map((key) => [key, instant(rows.timestamps[key])])
  );

  return {
    capturedAt: instant(rows.capturedAt),
    database: rows.database,
    tables,
    audit: {
      rows: safeCount(rows.audit.rows, "audit.rows"),
      latestCreatedAt: instant(rows.audit.latestCreatedAt),
    },
    timestamps,
    migrations: {
      rows: safeCount(rows.migrations.rows, "migrations.rows"),
      digest: rows.migrations.digest ?? null,
    },
  };
}

function same(left, right) {
  return Object.is(left, right);
}

export function fingerprintDelta(before, after) {
  const changed = [];
  const beforeTables = before.tables ?? {};
  const afterTables = after.tables ?? {};
  const tableNames = [...new Set([
    ...Object.keys(beforeTables),
    ...Object.keys(afterTables),
  ])].sort();

  for (const table of tableNames) {
    const beforeTable = beforeTables[table];
    const afterTable = afterTables[table];
    if (beforeTable === undefined) {
      changed.push({
        path: `tables.${table}`,
        type: "ADDED",
        before: null,
        after: afterTable,
      });
    } else if (afterTable === undefined) {
      changed.push({
        path: `tables.${table}`,
        type: "REMOVED",
        before: beforeTable,
        after: null,
      });
    } else if (
      !same(beforeTable.rows, afterTable.rows) ||
      !same(beforeTable.digest, afterTable.digest)
    ) {
      changed.push({
        path: `tables.${table}`,
        type: "CHANGED",
        before: beforeTable,
        after: afterTable,
      });
    }
  }

  for (const key of ["rows", "latestCreatedAt"]) {
    if (!same(before.audit?.[key], after.audit?.[key])) {
      changed.push({
        path: `audit.${key}`,
        type: "CHANGED",
        before: before.audit?.[key] ?? null,
        after: after.audit?.[key] ?? null,
      });
    }
  }

  for (const key of TIMESTAMP_KEYS) {
    if (!same(before.timestamps?.[key], after.timestamps?.[key])) {
      changed.push({
        path: `timestamps.${key}`,
        type: "CHANGED",
        before: before.timestamps?.[key] ?? null,
        after: after.timestamps?.[key] ?? null,
      });
    }
  }

  for (const key of ["rows", "digest"]) {
    if (!same(before.migrations?.[key], after.migrations?.[key])) {
      changed.push({
        path: `migrations.${key}`,
        type: "CHANGED",
        before: before.migrations?.[key] ?? null,
        after: after.migrations?.[key] ?? null,
      });
    }
  }

  return { zero: changed.length === 0, changed };
}

function parseTarget(rawUrl, allowDisposable) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Fingerprint URL is not a valid PostgreSQL connection URL");
  }
  if (!/^postgres(?:ql)?:$/.test(parsed.protocol)) {
    throw new Error("Fingerprint URL must use PostgreSQL");
  }

  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  const port = parsed.port || "5432";
  if (allowDisposable) {
    if (
      parsed.hostname !== OWNER_HOST ||
      port !== String(TEST_DB_PORT) ||
      database !== TEST_DB_NAME
    ) {
      throw new Error(
        "--allow-disposable only accepts the local marker-bearing disposable database"
      );
    }
  } else {
    if (
      parsed.hostname === OWNER_HOST &&
      port === String(TEST_DB_PORT) &&
      database === TEST_DB_NAME
    ) {
      throw new Error(
        "The disposable database requires the explicit --allow-disposable flag"
      );
    }
    if (
      parsed.hostname !== OWNER_HOST ||
      port !== OWNER_PORT ||
      database !== OWNER_DATABASE
    ) {
      throw new Error(
        "Owner fingerprinting only accepts 127.0.0.1:5433/postgres"
      );
    }
  }
  return { parsed, database };
}

function readOnlyUrl(parsed) {
  const copy = new URL(parsed.href);
  const existing = copy.searchParams.get("options")?.trim();
  copy.searchParams.set(
    "options",
    [existing, "-c default_transaction_read_only=on"].filter(Boolean).join(" ")
  );
  copy.searchParams.set("connection_limit", "1");
  return copy.href;
}

function assertSelect(sql) {
  if (!SELECT_ONLY.test(sql)) {
    throw new Error("OWNER_FINGERPRINT_NON_SELECT_QUERY_BLOCKED");
  }
}

async function select(client, sql, ...values) {
  assertSelect(sql);
  return client.$queryRawUnsafe(sql, ...values);
}

export async function fingerprint(url, { allowDisposable = false } = {}) {
  const { parsed, database: expectedDatabase } = parseTarget(
    url,
    allowDisposable
  );
  const observedQueries = [];
  const client = new PrismaClient({
    datasourceUrl: readOnlyUrl(parsed),
    log: [{ emit: "event", level: "query" }],
  });
  client.$on("query", (event) => observedQueries.push(event.query));

  try {
    if (allowDisposable) {
      const markerRows = await select(
        client,
        `SELECT EXISTS (
           SELECT 1
             FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name = $1
         ) AS present`,
        MARKER_TABLE
      );
      if (!markerRows[0]?.present) {
        throw new Error(
          `Disposable fingerprinting requires the ${MARKER_TABLE} marker`
        );
      }
    }

    const databaseRows = await select(
      client,
      "SELECT current_database() AS database"
    );
    const database = databaseRows[0]?.database;
    if (database !== expectedDatabase) {
      throw new Error("Connected database does not match the validated target");
    }

    const discovered = await select(
      client,
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_type = 'BASE TABLE'
        ORDER BY table_name`
    );
    const tables = [];
    for (const { table_name: table } of discovered) {
      const [digest] = await select(client, tableDigestSql(table));
      tables.push({ table, rows: digest.rows, digest: digest.digest });
    }
    const byName = new Map(tables.map((row) => [row.table, row]));

    const [audit] = await select(
      client,
      `SELECT max("createdAt") AS "latestCreatedAt"
         FROM "AuditLog"`
    );
    const [timestamps] = await select(
      client,
      `SELECT
         (SELECT max("updatedAt") FROM "User") AS "userMaxUpdatedAt",
         (SELECT max("lastLoginAt") FROM "User") AS "userMaxLastLoginAt",
         (SELECT max("updatedAt") FROM "Shift") AS "shiftMaxUpdatedAt",
         (SELECT max("closedAt") FROM "Shift") AS "shiftMaxClosedAt",
         (SELECT max("updatedAt") FROM "Order") AS "orderMaxUpdatedAt",
         (SELECT max("updatedAt") FROM "InventoryItem") AS "inventoryItemMaxUpdatedAt"`
    );
    const migration = byName.get("_prisma_migrations") ?? {
      rows: 0n,
      digest: null,
    };
    const auditTable = byName.get("AuditLog") ?? { rows: 0n };

    for (const sql of observedQueries) assertSelect(sql);
    return snapshotShape({
      capturedAt: new Date(),
      database,
      tables,
      audit: {
        rows: auditTable.rows,
        latestCreatedAt: audit.latestCreatedAt,
      },
      timestamps,
      migrations: migration,
    });
  } finally {
    await client.$disconnect();
  }
}

function parseCli(argv) {
  const options = {
    owner: false,
    allowDisposable: false,
    assertZero: false,
  };
  const values = new Set(["--url", "--out", "--before", "--after"]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (values.has(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      options[arg.slice(2)] = value;
      index += 1;
    } else if (arg === "--owner") {
      options.owner = true;
    } else if (arg === "--allow-disposable") {
      options.allowDisposable = true;
    } else if (arg === "--assert-zero") {
      options.assertZero = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function repositoryRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
}

function boundedOutputPath(file) {
  const repo = path.resolve(repositoryRoot());
  const output = path.resolve(repo, file);
  const basename = path.basename(output);
  if (
    path.dirname(output) !== repo ||
    !/^\.owner-fingerprint-[A-Za-z0-9._-]+\.json$/.test(basename)
  ) {
    throw new Error(
      "Fingerprint output must be a .owner-fingerprint-*.json file in the repository root"
    );
  }
  if (existsSync(output)) {
    throw new Error("Refusing to overwrite an existing fingerprint file");
  }
  return output;
}

async function runCli(argv = process.argv.slice(2)) {
  const options = parseCli(argv);
  if (options.owner && options.allowDisposable) {
    throw new Error("--owner and --allow-disposable are mutually exclusive");
  }

  if (options.before || options.after || options.assertZero) {
    if (
      !options.before ||
      !options.after ||
      !options.assertZero ||
      options.owner ||
      options.allowDisposable ||
      options.url ||
      options.out
    ) {
      throw new Error(
        "Delta mode requires only --before <file> --after <file> --assert-zero"
      );
    }
    const before = JSON.parse(readFileSync(options.before, "utf8"));
    const after = JSON.parse(readFileSync(options.after, "utf8"));
    const delta = fingerprintDelta(before, after);
    console.log(JSON.stringify(delta, null, 2));
    if (!delta.zero) process.exitCode = 1;
    return delta;
  }

  if (!options.out || options.assertZero || options.before || options.after) {
    throw new Error("Fingerprint mode requires --out <file>");
  }
  let url;
  if (options.owner) {
    if (options.url) throw new Error("--owner reads OWNER_DATABASE_URL, not --url");
    url = process.env.OWNER_DATABASE_URL;
    if (!url) throw new Error("OWNER_DATABASE_URL is not set");
  } else {
    if (!options.url || !options.allowDisposable) {
      throw new Error(
        "Disposable mode requires --url <url> --allow-disposable"
      );
    }
    url = options.url;
  }

  const output = boundedOutputPath(options.out);
  const temporary = `${output}.tmp-${process.pid}`;
  const result = await fingerprint(url, {
    allowDisposable: options.allowDisposable,
  });
  try {
    writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    renameSync(temporary, output);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  console.log(
    `Captured ${Object.keys(result.tables).length} public tables from database ${result.database}`
  );
  console.log(`Wrote ${path.basename(output)}`);
  return result;
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
