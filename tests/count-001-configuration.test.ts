// COUNT-001 — let the owner say what is counted, and what counts as critical.
//
// Criticality is a property of the ingredient, chosen by the owner. That is
// what lets the count-start endpoint derive scope on the SERVER instead of
// trusting a list the caller sent: if the client named the items, a
// custodian could quietly leave the short one out and the count would be
// clean by construction.
//
// The backfill choices are the substance of this task, and both are about
// not changing anybody's operation behind their back:
//
//   • Every EXISTING café is pinned to NO_SHIFT_COUNT, not to the new
//     default. A café that has never counted at handover must not discover
//     tomorrow that it is required to. Next Cup moves to HYBRID through the
//     configuration UI, deliberately, when its owner decides to.
//
//   • Every EXISTING item reads isCritical = false. No café acquires a
//     critical list it did not choose — a backfill that guessed would put
//     items into the daily count that nobody selected.
//
// `StockCountType` deliberately has two values. CYCLE appears in the policy
// enum because a café may express the intent, but there is no cycle engine,
// so no count can be STARTED as one — the resolver refuses it rather than
// quietly running a FULL count and calling it a cycle.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { db, fixture, tag, TAG_PREFIX, type Fixture, teardownTaggedCafe } from "./helpers/db";

const MARKER = tag("COUNT001");
let fx: Fixture;
const cafeIds: string[] = [];
const itemIds: string[] = [];

before(async () => { fx = await fixture(); });

// The ingredients are the exception: they belong to the SEEDED café, which
// the purge must never go near. They are a step; the tagged cafés are the
// guarantee.
after(() =>
  teardownTaggedCafe(
    cafeIds,
    [() => db.inventoryItem.deleteMany({ where: { id: { in: itemIds } } })],
    { disconnect: true }
  )
);

describe("COUNT-001 count configuration", () => {
  test("a reason code persists, and (cafeId, domain, code) rejects a duplicate", async () => {
    const made = await db.reasonCode.create({
      data: {
        cafeId: fx.cafeId, domain: "STOCK",
        code: `${MARKER}-SPILL`, label: "انسكاب",
      },
    });
    try {
      assert.equal(made.isActive, true, "a new reason is usable straight away");

      await assert.rejects(
        () => db.reasonCode.create({
          data: {
            cafeId: fx.cafeId, domain: "STOCK",
            code: `${MARKER}-SPILL`, label: "مرة تانية",
          },
        }),
        (e: { code?: string }) => e.code === "P2002",
        "one code per domain per café — a duplicate would make reporting ambiguous"
      );
    } finally {
      await db.reasonCode.deleteMany({ where: { code: { startsWith: MARKER } } });
    }
  });

  test("all four reason domains store, and the same code may exist in each", async () => {
    // The same word means different things in different places: a "SHORT"
    // in CASH is not a "SHORT" in STOCK, and the unique key is scoped by
    // domain precisely so both can exist.
    const domains = ["STOCK", "CASH", "TENDER", "HANDOVER"] as const;
    try {
      for (const domain of domains) {
        await db.reasonCode.create({
          data: { cafeId: fx.cafeId, domain, code: `${MARKER}-SHORT`, label: `عجز ${domain}` },
        });
      }
      const rows = await db.reasonCode.findMany({
        where: { cafeId: fx.cafeId, code: `${MARKER}-SHORT` },
      });
      assert.equal(rows.length, 4);
      assert.deepEqual([...rows.map((r) => r.domain)].sort(), [...domains].sort());
    } finally {
      await db.reasonCode.deleteMany({ where: { code: { startsWith: MARKER } } });
    }
  });

  test("every pre-existing café reads NO_SHIFT_COUNT", async () => {
    // The backfill's whole point: nobody is newly required to count.
    //
    // "Pre-existing" means created before the migration that added the
    // column — that is the only population the backfill ever touched. A café
    // created afterwards correctly gets the HYBRID column default and is not
    // evidence about the backfill either way.
    //
    // That distinction used to be drawn by NAME: anything not tagged `PH1`
    // was assumed to be the developer's own long-lived café. It worked only
    // because there happened to be exactly one such café and it happened to
    // pre-date the migration. On a freshly migrated database every café is
    // new, the seeded one is untagged, and the test failed for a reason that
    // has nothing to do with what it checks — the same trap its own comment
    // warns about.
    //
    // So the population is now taken from the migration's own timestamp,
    // which is the fact the assertion is actually about. Where no café
    // pre-dates the migration there is nothing to have been signed up, and
    // that is a truthful pass rather than a lucky one.
    const applied = await db.$queryRaw<{ finished_at: Date | null }[]>`
      SELECT "finished_at" FROM "_prisma_migrations"
       WHERE "migration_name" = '20260828100000_count_configuration'
       LIMIT 1
    `;
    const migratedAt = applied[0]?.finished_at ?? null;
    assert.ok(migratedAt, "the count-configuration migration must be recorded as applied");

    const forced = await db.cafeSettings.findMany({
      where: {
        stockCountPolicy: { not: "NO_SHIFT_COUNT" },
        cafe: { createdAt: { lt: migratedAt } },
      },
      select: { cafeId: true, stockCountPolicy: true },
    });
    assert.deepEqual(
      forced, [],
      "an existing café must not be silently signed up for handover counting"
    );
  });

  test("a newly created café reads the HYBRID default", async () => {
    const cafe = await db.cafe.create({
      data: {
        name: `${MARKER} new cafe`, slug: `${MARKER.toLowerCase()}-new`,
        settings: { create: {} },
      },
      include: { settings: true },
    });
    cafeIds.push(cafe.id);

    assert.equal(cafe.settings?.stockCountPolicy, "HYBRID", "new cafés get the recommended policy");
    assert.equal(cafe.settings?.handoverCountType, "CRITICAL", "handover counts the short list");
    assert.equal(cafe.settings?.periodicCountType, "FULL", "the periodic count is everything");
    assert.equal(cafe.settings?.stockCountMode, "BLIND", "and the counter does not see the expectation");
  });

  test("every pre-existing inventory item reads isCritical = false", async () => {
    // Scoped for the same reason as the policy assertion above: a suite that
    // creates its own critical ingredient is exercising the flag, not
    // evidence that the backfill set one.
    const [{ count }] = await db.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count
        FROM "InventoryItem"
       WHERE "isCritical" = true AND "name" NOT LIKE ${`${TAG_PREFIX}%`}
    `;
    assert.equal(
      Number(count), 0,
      "no café acquires a critical list it did not choose"
    );
  });

  test("branch overrides accept NULL, which means inherit", async () => {
    // The same shape dineInServingPolicyOverride already uses: a branch that
    // has never been configured must be distinguishable from one that has
    // deliberately been set to the same value as its café.
    const branch = await db.branch.findUniqueOrThrow({ where: { id: fx.branchId } });
    assert.equal(branch.stockCountPolicyOverride, null);
    assert.equal(branch.handoverCountTypeOverride, null);
    assert.equal(branch.periodicCountTypeOverride, null);
    assert.equal(branch.stockCountModeOverride, null);

    const updated = await db.branch.update({
      where: { id: fx.branchId },
      data: { stockCountPolicyOverride: "FULL" },
    });
    assert.equal(updated.stockCountPolicyOverride, "FULL");

    // Restored immediately: this branch belongs to the demo café, not to
    // this suite, and an override left behind would change its behaviour.
    const restored = await db.branch.update({
      where: { id: fx.branchId },
      data: { stockCountPolicyOverride: null },
    });
    assert.equal(restored.stockCountPolicyOverride, null, "NULL is restorable, not a one-way door");
  });

  test("StockCountType has exactly two values, and CYCLE is not one of them", async () => {
    // CYCLE is expressible as a POLICY (a café may intend it) but is not a
    // startable TYPE, because no cycle engine exists. Encoding that in the
    // type system is what stops a FULL count being run and labelled a cycle.
    const values = await db.$queryRaw<{ label: string }[]>`
      SELECT e.enumlabel AS label
        FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'StockCountType'
       ORDER BY e.enumsortorder
    `;
    assert.deepEqual(values.map((v) => v.label), ["CRITICAL", "FULL"]);

    const policies = await db.$queryRaw<{ label: string }[]>`
      SELECT e.enumlabel AS label
        FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'StockCountPolicy'
       ORDER BY e.enumsortorder
    `;
    assert.ok(
      policies.map((p) => p.label).includes("CYCLE"),
      "a café may still express the intent, even though no count can be started as one"
    );
  });

  test("an item can be marked critical, and the flag is per item", async () => {
    const critical = await db.inventoryItem.create({
      data: {
        cafeId: fx.cafeId, branchId: fx.branchId, name: `${MARKER} critical`,
        unit: "KG", costPerUnit: 450, currentStock: 1, isCritical: true,
      },
    });
    const ordinary = await db.inventoryItem.create({
      data: {
        cafeId: fx.cafeId, branchId: fx.branchId, name: `${MARKER} ordinary`,
        unit: "KG", costPerUnit: 10, currentStock: 1,
      },
    });
    itemIds.push(critical.id, ordinary.id);

    assert.equal(critical.isCritical, true);
    assert.equal(ordinary.isCritical, false, "criticality is opt-in, per item");
  });
});
