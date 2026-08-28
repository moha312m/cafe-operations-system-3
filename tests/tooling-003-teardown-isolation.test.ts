// TOOLING-003 — a RED test must not leave litter behind it.
//
// Two of the T9–T15 schema suites were RED on purpose: the whole point of
// the run was that a Prisma model did not exist yet. Their `after` hooks
// opened with `db.<thatModel>.deleteMany(...)`. Reading `.deleteMany` off an
// absent delegate throws a TypeError, the straight-line hook stopped there,
// and the tagged café it was supposed to remove stayed in the owner's
// working database. The test proved its point and left evidence of it in
// production data.
//
// The failure is structural, not clerical. A teardown written as one
// sequence gives every step veto power over every later step, and the step
// most likely to fail during a schema task is precisely the one naming the
// model under construction.
//
// `teardownTaggedCafe` therefore separates a best-effort half from a
// guaranteed half. This suite is about the guarantee, so every test here
// makes a cleanup step fail on purpose and then asserts against the database
// rather than against the helper's return value: the claim is "nothing is
// left", and only the database can settle that.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { db, tag, purgeCafe, teardownTaggedCafe } from "./helpers/db";

/**
 * A café carrying the children that make a naive `DELETE FROM "Cafe"` fail.
 *
 * `CustodyParticipant.user` is `Restrict` by design — a custody record naming
 * who was answerable has to outlive the staff account. So these rows cannot
 * be removed in catalogue order, which is exactly what the purge's retry
 * loop is for.
 */
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
  const branchId = cafe.branches[0].id;

  const user = await db.user.create({
    data: {
      email: `${marker}@example.invalid`,
      name: `${marker} holder`,
      passwordHash: "no-login-path",
      role: "BRANCH_MANAGER",
      cafeId: cafe.id,
      branchId,
    },
  });

  await db.inventoryItem.create({
    data: {
      cafeId: cafe.id,
      branchId,
      name: `${marker} beans`,
      unit: "KG",
      costPerUnit: 450,
      currentStock: "12.000",
    },
  });

  await db.custodyPeriod.create({
    data: {
      cafeId: cafe.id,
      branchId,
      scope: "STOCK",
      participants: { create: [{ userId: user.id, role: "PRIMARY" }] },
    },
  });

  return { cafeId: cafe.id, branchId, userId: user.id };
}

/** What the working database still holds under this café. */
async function residue(cafeId: string) {
  return {
    cafes: await db.cafe.count({ where: { id: cafeId } }),
    branches: await db.branch.count({ where: { cafeId } }),
    users: await db.user.count({ where: { cafeId } }),
    items: await db.inventoryItem.count({ where: { cafeId } }),
    custody: await db.custodyPeriod.count({ where: { cafeId } }),
  };
}

const NOTHING = { cafes: 0, branches: 0, users: 0, items: 0, custody: 0 };

/**
 * The Prisma client as a cleanup step sees it: a bag of delegates addressed
 * by name. Typing it this way is what lets a step name a model that does not
 * exist yet — the accident under test, reproduced rather than described.
 */
type DelegateBag = Record<
  string,
  { deleteMany: (args: unknown) => Promise<unknown> } | undefined
>;
const delegates = db as unknown as DelegateBag;

/**
 * A model no migration has created. Later work ships it; today it is absent.
 *
 * The marker moves as the milestone builds: `handoverSession` until T17 built
 * it, `varianceCase` until T18 did. Each time, the guard below is what caught
 * the change rather than the suite quietly going vacuous. `stockCountRebase`
 * is T22's, so it holds the role next.
 */
const ABSENT_MODEL = "stockCountRebase";

/** Name the absent model the way a leaking teardown did: without checking. */
async function deleteFromAbsentModel(cafeId: string) {
  const delegate = delegates[ABSENT_MODEL] as {
    deleteMany: (args: unknown) => Promise<unknown>;
  };
  await delegate.deleteMany({ where: { cafeId } });
}

describe("TOOLING-003 teardown survives a cleanup step that cannot run", () => {
  test("the absent delegate this suite relies on is genuinely absent", () => {
    // Guards the rest of the suite against becoming vacuous. Once the model
    // named above exists, the steps below would quietly start succeeding and
    // stop proving anything about failure. This test fails first, and says
    // what to do about it — which is exactly what happened when T17 shipped
    // HandoverSession.
    assert.equal(
      delegates[ABSENT_MODEL],
      undefined,
      `db.${ABSENT_MODEL} now exists — point these tests at a model that does not`
    );
  });

  test("a step reaching for an absent model fails, and the café still goes", async () => {
    const marker = tag("TOOL003A");
    const { cafeId } = await taggedCafe(marker);

    let stepError: unknown = null;
    let laterStepRan = false;

    await teardownTaggedCafe(cafeId, [
      async () => {
        // Verbatim shape of the teardown that leaked: name the model under
        // construction first, before anything stable has been removed.
        try {
          await deleteFromAbsentModel(cafeId);
        } catch (e) {
          stepError = e;
          throw e; // the helper, not the step, is what must cope
        }
      },
      async () => {
        laterStepRan = true;
      },
    ]);

    // 1. the model-dependent step really failed, and for the intended reason
    assert.ok(stepError instanceof TypeError, "an absent delegate throws a TypeError");
    assert.match(
      (stepError as TypeError).message,
      /deleteMany/,
      "the failure must be the absent delegate, not something incidental"
    );

    // 2. a failure in one step did not veto the rest of the teardown
    assert.equal(laterStepRan, true, "the step after the failing one still ran");

    // 3. nothing tagged is left in the working database
    assert.deepEqual(await residue(cafeId), NOTHING, "the tagged café left no litter");
  });

  test("a raw step against a table no migration has created is survived too", async () => {
    // The other half of the RED shape: a suite that reaches past Prisma and
    // writes the SQL itself still names a table the migration has not made.
    const marker = tag("TOOL003B");
    const { cafeId } = await taggedCafe(marker);

    let stepError: unknown = null;
    await teardownTaggedCafe(cafeId, [
      async () => {
        try {
          await db.$executeRawUnsafe('DELETE FROM "TableFromALaterMigration"');
        } catch (e) {
          stepError = e;
          throw e;
        }
      },
    ]);

    assert.ok(stepError, "deleting from a table that is not there must genuinely fail");
    assert.deepEqual(await residue(cafeId), NOTHING);
  });

  test("the purge needs no steps at all — it unwinds Restrict keys on its own", async () => {
    // The strongest form of the guarantee: a teardown whose entire step list
    // is missing still removes the café. The retry loop does the ordering the
    // hand-written sequences used to encode by hand, reading the live
    // catalogue, so a model that does not exist is never named.
    const marker = tag("TOOL003C");
    const { cafeId } = await taggedCafe(marker);

    await purgeCafe(cafeId);

    assert.deepEqual(await residue(cafeId), NOTHING);
  });

  test("a green teardown runs every step, in order, and is otherwise unchanged", async () => {
    const marker = tag("TOOL003D");
    const { cafeId } = await taggedCafe(marker);

    const order: string[] = [];
    await teardownTaggedCafe(cafeId, [
      async () => { order.push("first"); },
      async () => { order.push("second"); },
      async () => { order.push("third"); },
    ]);

    assert.deepEqual(order, ["first", "second", "third"], "steps keep their order");
    assert.deepEqual(await residue(cafeId), NOTHING);
  });

  test("no café id is a no-op, and an empty one is refused outright", async () => {
    // `before` can throw before the café id is assigned. Prisma reads an
    // `undefined` filter as "no filter", so the naive recovery — pass
    // whatever the variable holds — would empty the Cafe table. Neither the
    // helper nor the raw purge takes that chance.
    const before = await db.cafe.count();

    await teardownTaggedCafe(undefined, []);
    await assert.rejects(
      () => purgeCafe(""),
      /refusing to run an unscoped delete/,
      "an empty id must be refused, not treated as a wildcard"
    );

    assert.equal(await db.cafe.count(), before, "no café was touched");
  });

  test("purging an id that matches nothing is refused, not absorbed", async () => {
    // Fail-closed. An id that matches no row is a bug in the suite that
    // produced it, and a teardown that shrugs at one is a teardown that will
    // shrug at the id being wrong in the other direction too. Suites whose
    // `before` never created a café pass `undefined`, which is handled above.
    await assert.rejects(
      () => purgeCafe(`missing-${tag("TOOL003F")}`),
      /no such café/
    );
  });

  test("no café this suite created outlived it", async () => {
    const stragglers = await db.cafe.findMany({
      where: { slug: { startsWith: "ph1-tool003" } },
      select: { id: true, slug: true },
    });
    assert.deepEqual(stragglers, [], "every TOOLING-003 café was torn down");
    await db.$disconnect();
  });
});
