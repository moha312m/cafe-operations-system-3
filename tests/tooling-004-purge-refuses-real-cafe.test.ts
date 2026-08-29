// TOOLING-004 — no test cleanup helper may delete a non-test café.
//
// `purgeCafe` discovers its own table list from `information_schema` and
// deletes an entire café graph. That is the right shape for a teardown and a
// catastrophic shape for a typo, because these suites run against the
// working database — the one that also holds the owner's real café, their
// real staff, their real orders and their real takings.
//
// Refusing an empty id, which is where TOOLING-003 left things, guards
// against one specific accident: a `before` that threw before assigning. It
// does nothing about the accident that actually matters. A real café id is
// not empty. `purgeCafe(fx.cafeId)` — the seeded fixture id, reached for out
// of habit because half the helpers in this file take it — is a single
// plausible keystroke away from erasing the business.
//
// So the decision is taken from the database rather than from the caller.
// The café row is loaded and required to carry the `PH1-` marker that only
// `tag()` writes, and everything else is refused: a real café, a café with
// no marker, an id matching nothing at all. The guard runs before the table
// list is read, so a refusal is not "we deleted less than we might have" —
// it is "no DELETE was issued".
//
// The last test is the one that makes the rest more than a promise: it
// records every raw statement `purgeCafe` executes during a refused call and
// asserts the list is empty.

import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import {
  TAG_PREFIX, TEST_CAFE_SLUG_PREFIX, assertPurgeableTestCafe, db, fixture, purgeCafe, tag,
} from "./helpers/db";

after(async () => { await db.$disconnect(); });

/** A café built the way every suite builds one, so it carries the marker. */
async function taggedCafe(marker: string) {
  const cafe = await db.cafe.create({
    data: {
      name: `${marker} cafe`,
      slug: marker.toLowerCase(),
      settings: { create: {} },
      branches: { create: [{ name: `${marker} main` }] },
    },
    include: { branches: true },
  });
  return cafe.id;
}

/**
 * Enough of the owner's data to notice if any of it moved.
 *
 * Counted across the tables a purge would walk first, not just `Cafe`: the
 * failure being guarded against removes the café last, so a census that only
 * watched the café row would report "unchanged" after the staff list had
 * already gone.
 */
async function ownerCensus(cafeId: string) {
  return {
    cafe: await db.cafe.count({ where: { id: cafeId } }),
    branches: await db.branch.count({ where: { cafeId } }),
    users: await db.user.count({ where: { cafeId } }),
    products: await db.product.count({ where: { cafeId } }),
    orders: await db.order.count({ where: { cafeId } }),
    payments: await db.payment.count({ where: { cafeId } }),
    shifts: await db.shift.count({ where: { cafeId } }),
    inventory: await db.inventoryItem.count({ where: { cafeId } }),
    settings: await db.cafeSettings.count({ where: { cafeId } }),
  };
}

describe("TOOLING-004 purgeCafe refuses anything that is not a test fixture", () => {
  test("the seeded café is a real café and carries no test marker", async () => {
    // Guards the suite against becoming vacuous. If the seed ever started
    // naming its café `PH1-…`, every rejection test below would still pass
    // while proving nothing, because the thing they refuse to delete would
    // have become deletable.
    const fx = await fixture();
    const cafe = await db.cafe.findUniqueOrThrow({
      where: { id: fx.cafeId },
      select: { name: true, slug: true },
    });
    assert.equal(
      cafe.slug.startsWith(TEST_CAFE_SLUG_PREFIX), false,
      `the seeded café must not look like a fixture — its slug is "${cafe.slug}"`
    );
    assert.equal(cafe.name.includes(TAG_PREFIX), false);
  });

  test("a tagged test café is purgeable", async () => {
    // The permissive half. A guard that refuses everything is not a guard,
    // it is an outage, so the allowed case is asserted first.
    const marker = tag("TOOL004A");
    const cafeId = await taggedCafe(marker);

    const cleared = await assertPurgeableTestCafe(cafeId);
    assert.equal(cleared.id, cafeId, "the guard returns what it cleared");
    assert.equal(cleared.slug, marker.toLowerCase());

    await purgeCafe(cafeId);
    assert.equal(await db.cafe.count({ where: { id: cafeId } }), 0);
  });

  test("the real owner café is refused, and nothing of theirs moves", async () => {
    const fx = await fixture();
    const before = await ownerCensus(fx.cafeId);

    // A census that is already empty proves nothing about what survived it.
    assert.equal(before.cafe, 1, "the owner café must be present to be protected");
    assert.ok(before.branches > 0, "and must have data worth protecting");
    assert.ok(before.users > 0);
    assert.ok(before.products > 0);

    await assert.rejects(
      () => purgeCafe(fx.cafeId),
      /no PH1 test marker|somebody's real café|non-test café/,
      "the refusal must say the café is real, not merely that something failed"
    );

    assert.deepEqual(
      await ownerCensus(fx.cafeId), before,
      "every owner row is exactly where it was"
    );
  });

  test("an untagged café that is not the seeded one is refused too", async () => {
    // The rule is "carries the marker", not "is not the seed". A second real
    // café — a second branch of the business, a café created by hand while
    // debugging — is protected by the same sentence.
    const marker = tag("TOOL004B");
    const cafe = await db.cafe.create({
      data: { name: "Untagged Café", slug: `untagged-${marker.toLowerCase()}` },
    });
    try {
      await assert.rejects(
        () => purgeCafe(cafe.id),
        /non-test café/,
      );
      assert.equal(await db.cafe.count({ where: { id: cafe.id } }), 1, "it is still there");
    } finally {
      // Removed by id through the stable delegate — deliberately NOT through
      // the helper this suite exists to keep away from untagged cafés.
      await db.cafe.deleteMany({ where: { id: cafe.id } });
    }
  });

  test("an id matching nothing is refused rather than absorbed", async () => {
    await assert.rejects(
      () => purgeCafe(`cmt-not-a-real-id-${tag("TOOL004C")}`),
      /no such café/,
      "an id that matches nothing is a bug in the suite that produced it"
    );
  });

  test("an empty id is refused", async () => {
    await assert.rejects(() => purgeCafe(""), /refusing to run an unscoped delete/);
  });

  test("the guard runs before any DELETE is issued", async () => {
    // The claim the rest of the suite rests on. "The owner's rows are still
    // there" is consistent with a purge that ran, failed on every Restrict
    // key and left the trunk standing. This asserts the stronger thing: on a
    // refused call, `purgeCafe` executes no raw statement at all.
    const fx = await fixture();

    const executed: string[] = [];
    const queried: string[] = [];
    const realExecute = db.$executeRawUnsafe.bind(db);
    const realQuery = db.$queryRaw.bind(db);

    // Cast through `unknown`: these are overloaded Prisma methods and the
    // recorder only needs to observe the call, not reproduce the signature.
    const client = db as unknown as Record<string, unknown>;
    client.$executeRawUnsafe = (sql: string, ...args: unknown[]) => {
      executed.push(sql);
      return (realExecute as (s: string, ...a: unknown[]) => unknown)(sql, ...args);
    };
    client.$queryRaw = (...args: unknown[]) => {
      queried.push(String(args[0]));
      return (realQuery as (...a: unknown[]) => unknown)(...args);
    };

    try {
      await assert.rejects(() => purgeCafe(fx.cafeId), /non-test café/);
    } finally {
      client.$executeRawUnsafe = realExecute;
      client.$queryRaw = realQuery;
    }

    assert.deepEqual(executed, [], "a refused purge issues no DELETE");
    assert.deepEqual(queried, [], "and never even reads the table list");
  });

  test("the recorder used above would have caught a DELETE", async () => {
    // Without this, the previous test's empty array could mean "the guard
    // worked" or "the recorder was never wired up". Same recorder, allowed
    // café: the statements must show up.
    const marker = tag("TOOL004D");
    const cafeId = await taggedCafe(marker);

    const executed: string[] = [];
    const realExecute = db.$executeRawUnsafe.bind(db);
    const client = db as unknown as Record<string, unknown>;
    client.$executeRawUnsafe = (sql: string, ...args: unknown[]) => {
      executed.push(sql);
      return (realExecute as (s: string, ...a: unknown[]) => unknown)(sql, ...args);
    };

    try {
      await purgeCafe(cafeId);
    } finally {
      client.$executeRawUnsafe = realExecute;
    }

    assert.ok(executed.length > 0, "an allowed purge does issue DELETEs");
    assert.ok(
      executed.some((sql) => /DELETE FROM "Cafe"/.test(sql)),
      "including the one that removes the café itself"
    );
    assert.equal(await db.cafe.count({ where: { id: cafeId } }), 0);
  });

  test("the guard refuses to run outside the test runner at all", async () => {
    // `node --test` sets NODE_TEST_CONTEXT in every file it runs, so this is
    // the runner's own signal rather than a flag somebody has to remember.
    // An ad-hoc script that imports this helper inherits no destructive
    // power from it.
    const marker = tag("TOOL004E");
    const cafeId = await taggedCafe(marker);
    const real = process.env.NODE_TEST_CONTEXT;

    try {
      delete process.env.NODE_TEST_CONTEXT;
      await assert.rejects(
        () => purgeCafe(cafeId),
        /test-only teardown/,
        "outside the runner even a properly tagged café is refused"
      );
      assert.equal(
        await db.cafe.count({ where: { id: cafeId } }), 1,
        "and the tagged café is still standing"
      );
    } finally {
      if (real === undefined) delete process.env.NODE_TEST_CONTEXT;
      else process.env.NODE_TEST_CONTEXT = real;
    }

    await purgeCafe(cafeId); // back inside the runner, it goes
    assert.equal(await db.cafe.count({ where: { id: cafeId } }), 0);
  });

  test("no café this suite created outlived it", async () => {
    const stragglers = await db.cafe.findMany({
      where: { OR: [{ slug: { startsWith: "ph1-tool004" } }, { slug: { contains: "untagged-ph1-" } }] },
      select: { slug: true },
    });
    assert.deepEqual(stragglers, []);
  });
});
