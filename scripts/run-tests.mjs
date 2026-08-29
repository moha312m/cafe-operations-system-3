// `npm test`.
//
// Its whole job is to make the safe path the default one. It never passes
// `.env` to the test process — that file names the developer's own database,
// and inheriting it is exactly how a test run came to write 552 audit rows
// into the owner's café. It supplies the test DATABASE_URL itself, and
// refuses to start unless every part of the environment agrees.
//
// (It does READ one value out of `.env`, at the very end, under a different
// name, so TOOLING-006 can open a read-only connection and prove the
// developer's database stayed still. See that block for why.)
//
// Three things are checked before a single test file loads, because a failure
// here is cheap and a failure halfway through a suite is not:
//
//   1. the URL is a test URL                (name convention)
//   2. the database says it is disposable   (marker row — positive proof)
//   3. the HTTP server the tests will drive reads THAT SAME database
//
// The third is the one that is easy to forget and impossible to detect from
// inside a test. HTTP suites drive a real Next.js server; if the runner used
// the test database while localhost still pointed at the owner's, fixtures
// would be created in one database and every API call would act on the other.
// Split-brain would look like ordinary test failures while quietly writing to
// real café data.
//
// It is proved rather than assumed, and without adding any endpoint to the
// application: the runner writes a uniquely-named café into the test database
// and asks the server to render its public menu. A name the server can only
// have read from the database it is actually connected to is proof of
// co-location; nothing about how the server was launched is taken on trust.
// The probe café is removed afterwards either way.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import {
  TEST_DATABASE_URL,
  TEST_BASE_URL,
  TEST_SERVER_PORT,
  assertTestDatabaseUrl,
  assertTestDatabaseMarker,
  clusterRunning,
  REPO_ROOT as REPO_ROOT_DIR,
} from "./test-db.mjs";

const HELP = `
  npm run testdb:up      provision + start the disposable test database
  npm run testserver     start the test app server on port ${TEST_SERVER_PORT}
  npm test               run the suite against both

Your own dev server on :3000 and database on :5433 are untouched by these,
and are never used by automated tests.
`;

function die(message) {
  console.error(`\n${message}\n${HELP}`);
  process.exit(1);
}

// ── 1. the URL is a test URL ──
// NODE_TEST_CONTEXT is set by `node --test`, which has not started yet, so it
// is asserted here on the runner's behalf; the child gets the real thing.
try {
  assertTestDatabaseUrl(TEST_DATABASE_URL, {
    ...process.env,
    NODE_TEST_CONTEXT: "runner",
  });
} catch (e) {
  die(e.message);
}

if (!clusterRunning()) {
  die("The disposable test PostgreSQL cluster is not running.");
}

// ── 2. the database says it is disposable ──
const probe = new PrismaClient({ datasourceUrl: TEST_DATABASE_URL });
let marker;
try {
  marker = await assertTestDatabaseMarker(probe);
} catch (e) {
  await probe.$disconnect();
  die(e.message);
}

const where = await probe.$queryRawUnsafe(
  `SELECT current_database() AS database, current_setting('port') AS port`
);
const local = { database: where[0].database, port: String(where[0].port) };

// ── 3. the server under test reads that same database ──
const nonce = `PH1-PROBE-${randomUUID()}`;
let probeCafeId = null;
try {
  const cafe = await probe.cafe.create({
    data: {
      name: nonce,
      slug: nonce.toLowerCase(),
      settings: { create: {} },
      branches: { create: [{ name: `${nonce} branch`, menuSlug: "probe" }] },
    },
  });
  probeCafeId = cafe.id;

  const r = await fetch(`${TEST_BASE_URL}/menu/${nonce.toLowerCase()}/probe`, {
    signal: AbortSignal.timeout(60_000),
  });
  const html = await r.text();

  if (!html.includes(nonce)) {
    die(
      "SPLIT BRAIN: the test server is not reading the test database.\n" +
        `  runner wrote café "${nonce}" into ${local.database} @ :${local.port}\n` +
        `  server at ${TEST_BASE_URL} cannot see it (HTTP ${r.status}).\n` +
        "Restart the test server with `npm run testserver` so it inherits the\n" +
        "test DATABASE_URL. Do NOT point the tests at your :3000 dev server."
    );
  }
} catch (e) {
  if (e?.message?.startsWith?.("SPLIT BRAIN")) throw e;
  die(
    `The test app server on ${TEST_BASE_URL} is not answering (${e.message}). ` +
      "HTTP suites cannot run without it."
  );
} finally {
  // The probe is scaffolding, not data. Remove it whether or not it proved
  // the point, and scope every delete to the café it created.
  if (probeCafeId) {
    await probe.branch.deleteMany({ where: { cafeId: probeCafeId } });
    await probe.cafeSettings.deleteMany({ where: { cafeId: probeCafeId } });
    await probe.cafe.deleteMany({ where: { id: probeCafeId } });
  }
  await probe.$disconnect();
}

console.log(
  `Test environment verified:\n` +
    `  database : ${local.database} @ 127.0.0.1:${local.port}\n` +
    `  server   : ${TEST_BASE_URL} (proved to read the same database)\n` +
    `  marker   : ${marker.note}\n`
);

// ── the developer's URL, for VERIFICATION only ──
//
// TOOLING-006 proves the negative — that a real HTTP test leaves no audit
// row, no login timestamp and no order in the developer's database. It can
// only prove that by opening a second connection and looking, and a check
// that silently skips because it could not connect is worse than no check at
// all: it reports green for "we did not look".
//
// So `.env` is read here, deliberately, for exactly one value, and handed on
// under a DIFFERENT NAME. Nothing reads it as DATABASE_URL, the guard is
// unaffected, and TOOLING-006 uses it read-only. If it turns out to name the
// test database itself, it is withheld rather than passed, because comparing
// the test database against itself would prove nothing while looking like it
// had.
function ownerUrlForVerification() {
  try {
    const raw = readFileSync(path.join(REPO_ROOT_DIR, ".env"), "utf8");
    const line = raw
      .split(/\r?\n/)
      .find((l) => /^\s*DATABASE_URL\s*=/.test(l));
    if (!line) return null;
    const value = line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
    if (!value) return null;
    const a = new URL(value);
    const b = new URL(TEST_DATABASE_URL);
    if (a.port === b.port && a.pathname === b.pathname) return null; // same db
    return value;
  } catch {
    return null;
  }
}
const ownerUrl = ownerUrlForVerification();
console.log(
  ownerUrl
    ? "  verify   : developer database reachable — cross-database checks will run\n"
    : "  verify   : developer database URL unavailable — cross-database checks will SKIP\n"
);

// ── run ──
// DATABASE_URL is set for the CHILD only, and `.env` is deliberately NOT
// loaded: nothing in the test process may inherit the developer's database.
const passed = process.argv.slice(2);
const child = spawn(
  process.execPath,
  [
    "--import", "tsx",
    "--test-concurrency=1",
    "--test",
    ...(passed.length ? passed : ["tests/**/*.test.ts"]),
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      DATABASE_URL: TEST_DATABASE_URL,
      TEST_BASE_URL,
      ...(ownerUrl ? { OWNER_DATABASE_URL_FOR_VERIFICATION: ownerUrl } : {}),
      NODE_ENV: process.env.NODE_ENV === "production" ? "test" : process.env.NODE_ENV,
    },
  }
);
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
