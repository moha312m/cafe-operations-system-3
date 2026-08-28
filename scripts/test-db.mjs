// The dedicated test database: its guard, and the commands that manage it.
//
// `npm test` used to run `node --env-file-if-exists=.env …`. `.env` carries
// the developer's own DATABASE_URL — the owner's live café — and
// `new PrismaClient()` reads it. That one line is why a full test run wrote
// 552 AuditLog rows into the owner's records, moved `lastLoginAt` on their
// staff accounts, and drifted `updatedAt` on Branch and CafeSettings. No
// fixture was wrong and no cleanup helper misfired; everything simply
// happened in the wrong database.
//
// So tests no longer get to inherit an environment. They get a database that
// has to prove what it is first.
//
// ── The guard ──
//
// Four independent conditions, and a typo in any of them fails CLOSED:
//
//   1. NODE_TEST_CONTEXT — set by `node --test` itself, so it is the runner's
//      own signal rather than a flag somebody has to remember. Absence means
//      an ad-hoc script imported the test helpers, and such a script gets no
//      write power from them.
//   2. NODE_ENV is not production.
//   3. The database NAME matches the approved convention.
//   4. The database CARRIES A MARKER that a person deliberately created.
//
// The fourth is the one that does the real work. A name is a heuristic: it
// can be typed onto the wrong server, and `cafe_ops_test` on port 5433 would
// look just as convincing as on 5434. A marker row can only exist in a
// database that was provisioned as disposable, so it is positive proof rather
// than trust. The first three can all be satisfied by accident; the fourth
// cannot.
//
// The pure half is exported separately from the half that touches anything,
// which is what lets TOOLING-005 prove every refusal without a live
// connection and without ever pointing at the owner's database.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

/**
 * Database names an automated test may write to.
 *
 * Anchored at both ends, with an optional suffix so parallel or per-branch
 * test databases stay possible. `cafe_ops` is deliberately NOT matched, and
 * neither is anything that merely CONTAINS the word test — the prefix is what
 * carries the meaning, and loose containment is how `cafe_ops_testing_prod`
 * would talk its way in.
 */
export const TEST_DB_NAME_PATTERN = /^cafe_ops_test(_[A-Za-z0-9]+)*$/;

/** How the test cluster is addressed. Deliberately not port 5433. */
export const TEST_DB_PORT = 5434;
export const TEST_DB_NAME = "cafe_ops_test";
export const TEST_DATABASE_URL = `postgresql://postgres@127.0.0.1:${TEST_DB_PORT}/${TEST_DB_NAME}?schema=public`;
export const TEST_SERVER_PORT = 3100;
export const TEST_BASE_URL = `http://localhost:${TEST_SERVER_PORT}`;

/** The table whose existence is the database's own statement about itself. */
export const MARKER_TABLE = "_disposable_test_database";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..");
export const TEST_CLUSTER_ROOT = "C:\\Dev\\_nextcup_test_postgres";
export const TEST_PGDATA = path.join(TEST_CLUSTER_ROOT, "pgdata");
export const PG_BIN = "C:\\Dev\\_nextcup_postgres\\pg17\\bin";

/**
 * Refuse anything that is not demonstrably a test database, by URL and
 * environment alone.
 *
 * Pure: no connection, no filesystem, no process state beyond the `env` it is
 * handed. Throws with a message that names what was actually connected to, so
 * a misconfiguration is diagnosable rather than merely refused.
 */
export function assertTestDatabaseUrl(url, env = process.env) {
  if (env.NODE_ENV === "production") {
    throw new Error(
      "Refusing to run test fixtures with NODE_ENV=production. Production is " +
        "never a place to create and delete data."
    );
  }
  if (!env.NODE_TEST_CONTEXT) {
    throw new Error(
      "Refusing to hand out test-fixture powers outside the test runner: " +
        "NODE_TEST_CONTEXT is unset. `node --test` sets it; an ad-hoc script " +
        "does not, and does not get write access to a fixture database."
    );
  }
  if (typeof url !== "string" || url.length === 0) {
    throw new Error(
      "DATABASE_URL is not set for the test run. It is not inherited from " +
        ".env on purpose — that file names the developer's own database. " +
        "Run `npm test`, which supplies the test URL, or see TESTING.md."
    );
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`DATABASE_URL is not a parseable connection URL: ${url}`);
  }

  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!TEST_DB_NAME_PATTERN.test(name)) {
    throw new Error(
      `Refusing to run automated tests against database "${name}" at ` +
        `${parsed.hostname}:${parsed.port || 5432}. Tests may only write to a ` +
        `database named ${TEST_DB_NAME} (optionally suffixed). ` +
        (name === "postgres"
          ? "`postgres` is the developer's own database and holds real café data. "
          : "") +
        "See TESTING.md for how to start the test database."
    );
  }
  return { name, host: parsed.hostname, port: parsed.port || "5432" };
}

/**
 * The check the URL guard cannot make: ask the database whether it is
 * disposable, and believe only the answer it gives about itself.
 *
 * `client` is anything with Prisma's `$queryRawUnsafe`. Kept separate from the
 * pure guard so the refusal paths stay testable without a server.
 */
export async function assertTestDatabaseMarker(client) {
  let rows;
  try {
    rows = await client.$queryRawUnsafe(
      `SELECT "note" FROM "${MARKER_TABLE}" LIMIT 1`
    );
  } catch {
    throw new Error(
      `The connected database carries no ${MARKER_TABLE} marker, so it has ` +
        `not been provisioned as disposable and no test may write to it. ` +
        `A correct-looking name is not proof — the marker is. ` +
        `Run \`npm run testdb:up\` to provision one.`
    );
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(
      `${MARKER_TABLE} exists but is empty, so the database cannot vouch for ` +
        `itself. Re-provision with \`npm run testdb:up\`.`
    );
  }
  return rows[0];
}

// ─────────────────────────── provisioning CLI ────────────────────────

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    // Only `npx` needs the shell to resolve. A direct .exe must NOT get it:
    // with shell:true Windows re-joins argv on spaces, which turns pg_ctl's
    // `-o "-p 5434"` into two arguments and fails with "too many arguments".
    shell: opts.shell ?? false,
    stdio: opts.quiet ? "pipe" : "inherit",
    cwd: opts.cwd ?? REPO_ROOT,
    env: { ...process.env, ...(opts.env ?? {}) },
  });
  return { ok: r.status === 0, status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const npx = (args, opts = {}) => run("npx", args, { ...opts, shell: true });

const pgctl = (...args) => run(path.join(PG_BIN, "pg_ctl.exe"), args, { quiet: true });

export function clusterRunning() {
  const r = pgctl("status", "-D", TEST_PGDATA);
  return r.ok && /server is running/.test(r.out);
}

/** Create the cluster if it does not exist, then start it on the test port. */
function up() {
  if (!existsSync(TEST_PGDATA)) {
    console.log(`Creating disposable test cluster at ${TEST_PGDATA} …`);
    mkdirSync(TEST_CLUSTER_ROOT, { recursive: true });
    const r = run(path.join(PG_BIN, "initdb.exe"), [
      "-D", TEST_PGDATA, "-U", "postgres", "-A", "trust", "-E", "UTF8",
    ], { quiet: true });
    if (!r.ok) { console.error(r.out); process.exit(1); }
  }
  if (clusterRunning()) {
    console.log(`Test cluster already running on port ${TEST_DB_PORT}.`);
  } else {
    const r = pgctl(
      "start", "-D", TEST_PGDATA,
      "-l", path.join(TEST_CLUSTER_ROOT, "pg.log"),
      "-o", `-p ${TEST_DB_PORT}`, "-w", "-t", "60"
    );
    if (!r.ok) { console.error(r.out); process.exit(1); }
    console.log(`Test cluster started on port ${TEST_DB_PORT}.`);
  }
  return prepare();
}

/** Create the database, stamp the marker, apply migrations, seed. */
function prepare() {
  const adminUrl = `postgresql://postgres@127.0.0.1:${TEST_DB_PORT}/postgres`;

  // CREATE DATABASE cannot run inside a transaction, and `prisma db execute`
  // wraps a file in one, so this goes through a tiny inline client instead.
  const create = run(process.execPath, ["-e", `
    const { PrismaClient } = require("@prisma/client");
    const c = new PrismaClient({ datasourceUrl: ${JSON.stringify(adminUrl)} });
    (async () => {
      const rows = await c.$queryRawUnsafe(
        "SELECT 1 FROM pg_database WHERE datname = '${TEST_DB_NAME}'");
      if (rows.length === 0) {
        await c.$executeRawUnsafe('CREATE DATABASE "${TEST_DB_NAME}"');
        console.log("created database ${TEST_DB_NAME}");
      } else {
        console.log("database ${TEST_DB_NAME} already present");
      }
    })().catch((e) => { console.error(e.message); process.exit(1); })
      .finally(() => c.$disconnect());
  `], { quiet: true });
  console.log(create.out.trim());
  if (!create.ok) process.exit(1);

  const migrate = npx(["prisma", "migrate", "deploy"], {
    env: { DATABASE_URL: TEST_DATABASE_URL },
    quiet: true,
  });
  if (!migrate.ok) { console.error(migrate.out); process.exit(1); }
  console.log("migrations applied");

  // The marker is stamped AFTER migrations, because `migrate deploy` on an
  // empty database is the one operation allowed to reshape everything here.
  const stamp = run(process.execPath, ["-e", `
    const { PrismaClient } = require("@prisma/client");
    const c = new PrismaClient({ datasourceUrl: ${JSON.stringify(TEST_DATABASE_URL)} });
    (async () => {
      await c.$executeRawUnsafe(\`CREATE TABLE IF NOT EXISTS "${MARKER_TABLE}" (
        "id" integer PRIMARY KEY DEFAULT 1,
        "note" text NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "${MARKER_TABLE}_singleton" CHECK ("id" = 1))\`);
      await c.$executeRawUnsafe(\`INSERT INTO "${MARKER_TABLE}" ("id","note")
        VALUES (1, 'Disposable. Automated tests create and delete data here. Never point this at real cafe data.')
        ON CONFLICT ("id") DO NOTHING\`);
      console.log("marker stamped");
    })().catch((e) => { console.error(e.message); process.exit(1); })
      .finally(() => c.$disconnect());
  `], { quiet: true });
  console.log(stamp.out.trim());
  if (!stamp.ok) process.exit(1);

  // Seeded demo café + demo accounts. Legacy suites reach for both; they now
  // find them HERE rather than in the owner's database. The seed is
  // self-skipping, so re-running prepare is safe.
  const seed = npx(["tsx", "prisma/seed.ts"], {
    env: { DATABASE_URL: TEST_DATABASE_URL },
    quiet: true,
  });
  if (!seed.ok) { console.error(seed.out); process.exit(1); }
  console.log(seed.out.trim().split("\n").slice(-1)[0] || "seeded");
  console.log(`\nTest database ready: ${TEST_DATABASE_URL}`);
  return 0;
}

function down() {
  if (!clusterRunning()) { console.log("Test cluster is not running."); return 0; }
  const r = pgctl("stop", "-D", TEST_PGDATA, "-m", "fast", "-w", "-t", "60");
  console.log(r.ok ? "Test cluster stopped." : r.out);
  return r.ok ? 0 : 1;
}

/** Delete the cluster entirely. Disposable means disposable. */
function destroy() {
  down();
  if (existsSync(TEST_PGDATA)) {
    rmSync(TEST_CLUSTER_ROOT, { recursive: true, force: true });
    console.log(`Removed ${TEST_CLUSTER_ROOT}.`);
  }
  return 0;
}

function status() {
  console.log(`cluster dir : ${TEST_PGDATA}`);
  console.log(`running     : ${clusterRunning()}`);
  console.log(`test URL    : ${TEST_DATABASE_URL}`);
  console.log(`test server : ${TEST_BASE_URL}`);
  return 0;
}

// `pathToFileURL`, not string surgery: on Windows a hand-built
// `file://C:/…` has one slash too few to equal Node's `file:///C:/…`, and the
// CLI would silently never run.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const cmd = process.argv[2];
  const table = { up, down, prepare, destroy, status };
  if (!table[cmd]) {
    console.error(`usage: node scripts/test-db.mjs <${Object.keys(table).join("|")}>`);
    process.exit(2);
  }
  process.exit(table[cmd]() ?? 0);
}
