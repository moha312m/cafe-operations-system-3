// TOOLING-006 — the isolation boundary, proved against two real databases.
//
// TOOLING-005 proves the guard refuses the wrong URL. That is a statement
// about a function. This suite is a statement about the SYSTEM: it opens a
// second connection to the developer's own database and asserts that the
// things a test run used to leave there — audit rows, login timestamps,
// orders, payments, shifts — appear only in the test database.
//
// Nothing here is mocked. A mock cannot fail the way the real thing failed:
// the original contamination was not a wrong function call, it was a correct
// function call against the wrong database. Only two live connections can
// show the difference.
//
// If the owner database is not reachable, the cross-database assertions are
// skipped rather than passed. A guard that cannot be checked has not been
// shown to hold, and saying so is better than a green tick that means
// "we did not look".

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { db, assertTestDatabase, tag, teardownTaggedCafe } from "./helpers/db";
import { countCafe, type CountCafe } from "./helpers/count";
import { requireServer, as, BASE } from "./helpers/http";
import { MARKER_TABLE, TEST_DB_NAME_PATTERN } from "../scripts/test-db.mjs";

/**
 * A read-only connection to the developer's own database.
 *
 * Not DATABASE_URL — that is now the TEST database, which is the very thing
 * being demonstrated. `npm test` reads the developer's URL out of `.env` and
 * passes it under this deliberately distinct name, so nothing can mistake it
 * for the connection tests write through, and the guard is unaffected.
 *
 * Used strictly read-only: every query below is a COUNT or a digest. If it is
 * absent or will not connect, the checks that need it SKIP rather than pass —
 * a green tick that means "we did not look" is worse than an honest skip.
 */
const OWNER_URL = process.env.OWNER_DATABASE_URL_FOR_VERIFICATION;
let owner: PrismaClient | null = null;
let ownerReachable = false;

let fx: CountCafe;

before(async () => {
  await requireServer();
  if (!OWNER_URL) { ownerReachable = false; return; }
  owner = new PrismaClient({ datasourceUrl: OWNER_URL });
  try {
    await owner.$queryRawUnsafe("SELECT 1");
    ownerReachable = true;
  } catch {
    ownerReachable = false;
  }
});

after(async () => {
  await teardownTaggedCafe(fx ? [fx.cafeId] : []);
  if (owner) await owner.$disconnect();
  await db.$disconnect();
});

/** Counts of everything a test run used to leave in the owner's records. */
async function ownerCounts(client: PrismaClient) {
  return {
    audit: await client.auditLog.count(),
    orders: await client.order.count(),
    payments: await client.payment.count(),
    shifts: await client.shift.count(),
    cafes: await client.cafe.count(),
  };
}

describe("TOOLING-006 tests are connected to the disposable database", () => {
  test("the runner's database is the test database, by name and by marker", async () => {
    const rows = await db.$queryRawUnsafe<{ database: string; port: string }[]>(
      `SELECT current_database() AS database, current_setting('port') AS port`
    );
    assert.match(
      rows[0].database,
      TEST_DB_NAME_PATTERN,
      `tests must run against a test database, not "${rows[0].database}"`
    );
    assert.notEqual(rows[0].database, "postgres", "never the developer's own database");

    // Positive proof, not a naming heuristic.
    const marker = await db.$queryRawUnsafe<{ note: string }[]>(
      `SELECT "note" FROM "${MARKER_TABLE}"`
    );
    assert.equal(marker.length, 1, "the disposable-database marker must be present");
    assert.match(marker[0].note, /[Dd]isposable/);
  });

  test("assertTestDatabase resolves here, and is what fixtures wait on", async () => {
    await assertTestDatabase();
  });

  test("the owner database is a DIFFERENT database on a different port", async (t) => {
    if (!ownerReachable) return t.skip("owner database not reachable — cannot compare");
    const mine = await db.$queryRawUnsafe<{ d: string; p: string }[]>(
      `SELECT current_database() AS d, current_setting('port') AS p`
    );
    const theirs = await owner!.$queryRawUnsafe<{ d: string; p: string }[]>(
      `SELECT current_database() AS d, current_setting('port') AS p`
    );
    assert.notEqual(mine[0].d, theirs[0].d, "different database name");
    assert.notEqual(String(mine[0].p), String(theirs[0].p), "different cluster port");
  });

  test("the owner database carries NO disposable marker", async (t) => {
    if (!ownerReachable) return t.skip("owner database not reachable — cannot compare");
    // The guard's whole premise: the marker is what separates the two, so the
    // owner's database must not accidentally be carrying one.
    await assert.rejects(
      () => owner!.$queryRawUnsafe(`SELECT "note" FROM "${MARKER_TABLE}"`),
      "the owner database must never look disposable"
    );
  });
});

describe("TOOLING-006 test writes land only in the test database", () => {
  test("a fixture café, its audit rows, orders, payments and shifts stay here", async (t) => {
    if (!ownerReachable) return t.skip("owner database not reachable — cannot compare");

    const before = await ownerCounts(owner!);

    // A representative slice of what a real suite does: create a café with
    // real accounts, sign them in over HTTP, take an order, collect for it.
    fx = await countCafe("TOOL006");
    const marker = tag("TOOL006-order");

    const category = await db.menuCategory.create({
      data: { cafeId: fx.cafeId, name: `${fx.marker} drinks` },
    });
    const product = await db.product.create({
      data: {
        cafeId: fx.cafeId, categoryId: category.id,
        name: `${fx.marker} tea`, basePrice: "50.00",
      },
    });

    const created = await as<{ order?: { id: string } }>(fx.owner.email, "/api/orders", {
      method: "POST",
      body: JSON.stringify({
        branchId: fx.branchId, type: "TAKEAWAY", collectionMode: "PENDING",
        customerName: marker,
        items: [{ productId: product.id, quantity: 1, addOnIds: [] }],
      }),
    });
    assert.equal(created.status, 201, `order should be created here: ${created.text}`);

    // It exists in the test database…
    assert.equal(
      await db.order.count({ where: { cafeId: fx.cafeId } }), 1,
      "the order must exist in the test database"
    );
    assert.ok(
      await db.auditLog.count({ where: { cafeId: fx.cafeId } }) > 0,
      "audit rows must be written somewhere — here"
    );

    // …and the owner's database has not moved at all.
    const after = await ownerCounts(owner!);
    assert.deepEqual(
      after, before,
      "an HTTP order, its audit rows and its café must not touch the owner database"
    );
  });

  test("logging in over HTTP moves no timestamp in the owner database", async (t) => {
    if (!ownerReachable) return t.skip("owner database not reachable — cannot compare");

    // `lastLoginAt` drift on the owner's staff accounts was one of the
    // symptoms. `countCafe` signs five accounts in, so a login has already
    // happened by the time this runs.
    const digest = async (client: PrismaClient) =>
      (await client.$queryRawUnsafe<{ d: string }[]>(
        `SELECT md5(COALESCE(string_agg(x.line,'|' ORDER BY x.line),'')) AS d
           FROM (SELECT t::text AS line FROM "User" t) x`
      ))[0].d;

    const before = await digest(owner!);
    await as(fx.manager.email, "/api/auth/me");
    assert.equal(
      await digest(owner!), before,
      "no owner User row may change — not even lastLoginAt"
    );
  });

  test("the HTTP server under test is the test server, not the dev server", async () => {
    // The split-brain case. `npm test` proves co-location before any test
    // runs; this pins the port so a stray TEST_BASE_URL cannot quietly point
    // the suite at the developer's :3000 server.
    assert.match(BASE, /:3100$/, `tests must drive the test server, got ${BASE}`);
  });
});
