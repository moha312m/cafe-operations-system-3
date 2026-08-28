// Shared harness for Phase 1 (Cash Integrity) regression tests.
//
// These are integration tests: they run against a real local Postgres,
// exercising the actual Prisma client and service layer rather than mocks —
// a cash-custody invariant is only meaningful if the database agrees with it.
//
// That "real" database used to be whichever one `.env` named, which in
// practice was the developer's own — the one holding the owner's live café.
// It is now a DEDICATED DISPOSABLE TEST DATABASE, and this module refuses to
// load if pointed at anything else (TOOLING-005).
//
// Every record created here is tagged "PH1-…" so remediation data is
// distinguishable from audit data and can be removed independently.

import { PrismaClient, type Role } from "@prisma/client";
import type { SessionUser } from "@/lib/auth";
import {
  assertTestDatabaseUrl,
  assertTestDatabaseMarker,
} from "../../scripts/test-db.mjs";

// Fail closed at IMPORT, before a client exists and therefore before any
// query can be issued. This is the cheap half of the guard, and it catches
// the accident that actually happened: the harness inheriting the owner's
// DATABASE_URL out of .env. Synchronous on purpose — an async check here
// could not stop the module from finishing loading.
assertTestDatabaseUrl(process.env.DATABASE_URL);

export const db = new PrismaClient();

/**
 * The other half of the guard: ask the database whether it is disposable.
 *
 * A name is a heuristic — `cafe_ops_test` typed against port 5433 would sail
 * through the URL check and be catastrophically wrong. The marker table can
 * only exist in a database somebody deliberately provisioned as throwaway,
 * so it is positive proof rather than trust.
 *
 * Memoised: one query per test process, awaited where writing begins
 * (fixture creation, tagged-café creation) and where deleting begins (the
 * café purge), so neither a fixture nor a cleanup can run against a database
 * that has not vouched for itself.
 */
let markerCheck: Promise<unknown> | null = null;
export function assertTestDatabase(): Promise<unknown> {
  markerCheck ??= assertTestDatabaseMarker(db);
  return markerCheck;
}

export const TAG_PREFIX = "PH1";

let counter = 0;
/** A collision-free, clearly-labelled marker for one test's records. */
export function tag(finding: string): string {
  counter += 1;
  return `${TAG_PREFIX}-${finding}-${process.pid}-${counter}`;
}

export type Fixture = {
  cafeId: string;
  branchId: string;
  /** A simple product with no variants and no add-ons. */
  productId: string;
  unitPrice: number;
};

/**
 * Reuse the existing seeded cafe/branch/product rather than creating a new
 * tenant per run. Phase 1 is about cash arithmetic, not tenancy.
 */
export async function fixture(): Promise<Fixture> {
  // Writing starts here for most suites: everything they create hangs off the
  // café this returns. Prove the database is disposable before handing it out.
  await assertTestDatabase();

  const branch = await db.branch.findFirst({
    where: { isActive: true },
    orderBy: { createdAt: "asc" },
  });
  if (!branch) throw new Error("No seeded branch — run `npm run db:seed` first");

  const product = await db.product.findFirst({
    where: { cafeId: branch.cafeId, isActive: true, variants: { none: {} } },
    orderBy: { createdAt: "asc" },
  });
  if (!product) throw new Error("No variant-free seeded product available");

  return {
    cafeId: branch.cafeId,
    branchId: branch.id,
    productId: product.id,
    unitPrice: Number(product.basePrice),
  };
}

/** Build a SessionUser for a seeded account without touching auth/cookies. */
export async function sessionFor(email: string): Promise<SessionUser> {
  const u = await db.user.findUnique({ where: { email } });
  if (!u) throw new Error(`Seeded user ${email} not found`);
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role as Role,
    cafeId: u.cafeId,
    branchId: u.branchId,
  };
}

/**
 * Establish the custody precondition explicitly. A custody test that relies
 * on ambient shift state is not a test — leftover OPEN shifts from earlier
 * runs or manual verification would otherwise silently invert the result.
 */
export async function clearOpenShifts(branchId: string, cashierId: string) {
  const open = await db.shift.findMany({
    where: { branchId, cashierId, status: "OPEN" },
    select: { id: true },
  });
  for (const s of open) {
    await db.payment.updateMany({ where: { shiftId: s.id }, data: { shiftId: null } });
    await db.shift.delete({ where: { id: s.id } });
  }
}

/** Open a shift directly, bypassing the HTTP route. */
export async function openShift(
  fx: Fixture,
  cashierId: string,
  openingCash: number
) {
  const last = await db.shift.aggregate({
    where: { branchId: fx.branchId },
    _max: { shiftNumber: true },
  });
  return db.shift.create({
    data: {
      cafeId: fx.cafeId,
      branchId: fx.branchId,
      cashierId,
      shiftNumber: (last._max.shiftNumber ?? 0) + 1,
      openingCashAmount: openingCash,
      expectedCashAmount: openingCash,
    },
  });
}

/**
 * Minimal unpaid order used as a payment target. `total` is explicit so cash
 * arithmetic can be asserted against exact figures; it defaults to the
 * product's base price.
 */
export async function makeOrder(
  fx: Fixture,
  marker: string,
  createdById: string,
  total?: number
) {
  const product = await db.product.findUniqueOrThrow({ where: { id: fx.productId } });
  const subtotal = total ?? Number(product.basePrice);
  return db.order.create({
    data: {
      cafeId: fx.cafeId,
      branchId: fx.branchId,
      orderNumber: (await nextOrderNumber(fx.branchId)),
      type: "TAKEAWAY",
      status: "CONFIRMED",
      source: "CASHIER_POS",
      customerName: marker,
      subtotal,
      taxAmount: 0,
      discountAmount: 0,
      serviceChargeAmount: 0,
      total: subtotal,
      remainingAmount: subtotal,
      paymentStatus: "PENDING_COLLECTION",
      createdById,
      items: {
        create: [{
          productId: product.id,
          productName: product.name,
          unitPrice: subtotal,
          quantity: 1,
          lineTotal: subtotal,
        }],
      },
    },
  });
}

async function nextOrderNumber(branchId: string) {
  const last = await db.order.aggregate({
    where: { branchId },
    _max: { orderNumber: true },
  });
  return (last._max.orderNumber ?? 0) + 1;
}

/** Remove every record created under a marker. Orders cascade to payments. */
export async function cleanup(marker: string) {
  const orders = await db.order.findMany({
    where: { customerName: { startsWith: marker } },
    select: { id: true },
  });
  const ids = orders.map((o) => o.id);
  if (ids.length) {
    await db.inventoryTransaction.deleteMany({ where: { orderId: { in: ids } } });
    await db.order.deleteMany({ where: { id: { in: ids } } });
  }
}

/** Remove a shift created by a test (after its orders are gone). */
export async function cleanupShift(shiftId: string) {
  await db.payment.deleteMany({ where: { shiftId } });
  await db.shift.deleteMany({ where: { id: shiftId } });
}

/**
 * A product this test owns outright, with no recipe and no variants.
 *
 * Suites that exercise ordering, serving or table-close policy used to reach
 * for "the first variant-free product on the menu". That made them depend on
 * whichever café data happened to be loaded: once a real menu was imported,
 * the first such product was a coffee whose recipe wants beans the branch has
 * no stock of, so the stock guard refused the handover and thirteen tests
 * about *payment policy* failed for reasons of *inventory*.
 *
 * Deliberately recipe-free: a missing recipe is reported and skipped rather
 * than blocking service, so this product can always be served and the only
 * thing left governing the outcome is the policy under test.
 */
export async function policyProduct(fx: Fixture, marker: string) {
  const category = await db.menuCategory.findFirstOrThrow({
    where: { cafeId: fx.cafeId },
    orderBy: { createdAt: "asc" },
  });
  return db.product.create({
    data: {
      cafeId: fx.cafeId,
      categoryId: category.id,
      name: `${marker} test item`,
      basePrice: 75,
    },
  });
}

/**
 * Drop a product created by `policyProduct`, once its orders are gone.
 *
 * The guard is not defensive padding. Prisma reads `undefined` in a `where` as
 * "no filter", so if a suite's `before` throws before the product exists, an
 * unguarded `deleteMany` here would match every row and empty the menu.
 */
export async function cleanupProduct(productId: string | undefined) {
  if (!productId) return;
  await db.recipe.deleteMany({ where: { productId } });
  await db.product.deleteMany({ where: { id: productId } });
}

export type TestIngredients = Awaited<ReturnType<typeof testIngredients>>;

/**
 * Two ingredients the test creates for itself: a mass stocked in KG and a
 * liquid stocked in LITER.
 *
 * The recipe suites used to pin the seeded «بن» and «لبن» by name and inherit
 * their prices, so every conversion and costing assertion silently depended on
 * one café's ingredient list never changing. Importing a real menu renamed
 * «بن» to «بن إسبريسو» and twenty-five tests stopped at the fixture lookup.
 *
 * The unit prices below are the ones the assertions have always used; stating
 * them here makes the expected costs derivable from the test itself instead of
 * from data it does not control.
 */
export async function testIngredients(fx: Fixture, marker: string) {
  const mass = await db.inventoryItem.create({
    data: {
      cafeId: fx.cafeId, branchId: fx.branchId,
      name: `${marker} beans`, unit: "KG", costPerUnit: 450, currentStock: 12,
    },
  });
  const liquid = await db.inventoryItem.create({
    data: {
      cafeId: fx.cafeId, branchId: fx.branchId,
      name: `${marker} milk`, unit: "LITER", costPerUnit: 38, currentStock: 30,
    },
  });
  return { beans: mass, milk: liquid };
}

/**
 * Remove ingredients created by `testIngredients`, once recipes are gone.
 *
 * Ids are collected before the query for the same reason as `cleanupProduct`:
 * a `where` that resolves to `undefined` would match the café's whole store.
 */
export async function cleanupIngredients(ing: Partial<TestIngredients>) {
  const ids = [ing.beans?.id, ing.milk?.id].filter((id): id is string => !!id);
  if (ids.length === 0) return;
  await db.inventoryItem.deleteMany({ where: { id: { in: ids } } });
}

// ───────────────────────── Tagged-café teardown ──────────────────────
//
// A suite that creates its own café used to unwind it by hand: delete the
// leaf tables, then the trunk, then the café, in one straight-line `after`.
// That reads well and fails badly. Two of the T9–T15 schema suites ran RED
// on purpose — the point of the run was that a model did NOT exist yet — and
// their teardown opened with `db.<newModel>.deleteMany(...)`. Reading a
// property off an absent Prisma delegate throws a TypeError, the rest of the
// hook never ran, and the tagged café stayed behind in the owner's working
// database. The RED test proved its point and left litter proving it.
//
// So teardown is split into two halves with different guarantees:
//
//   * the caller's steps are best-effort and independent — one throwing is
//     reported and does not stop the next, because a cleanup step is a
//     convenience, not the contract;
//   * the root purge is the contract, always runs, and is expressed against
//     the live database catalogue rather than the generated Prisma client,
//     so it cannot be broken by the absence of the very model a RED test is
//     there to prove absent.
//
// In a GREEN run nothing throws and the observable behaviour is exactly what
// the hand-written sequence did.

/** Postgres identifiers we are willing to interpolate into raw SQL. */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The persisted mark that makes a café a test fixture.
 *
 * Not a new convention — `tag()` already produces `PH1-…` and every café
 * factory in `tests/` lower-cases that marker into the slug. The prefix is
 * derived from `TAG_PREFIX` rather than written out again so the two cannot
 * drift apart.
 */
export const TEST_CAFE_SLUG_PREFIX = `${TAG_PREFIX.toLowerCase()}-`;

/**
 * Whether we are inside the repository's own test runner.
 *
 * `node --test` sets NODE_TEST_CONTEXT in every file it runs, and `npm test`
 * is `node --test`, so this is the runner's own signal rather than a flag
 * somebody has to remember to set. Absence is treated as "not a test", which
 * is the fail-closed reading: an ad-hoc script that imports this helper gets
 * no destructive power from it.
 */
function inTestRunner(): boolean {
  return Boolean(process.env.NODE_TEST_CONTEXT) && process.env.NODE_ENV !== "production";
}

/**
 * The gate on `purgeCafe`, and the reason it can be trusted at all.
 *
 * `purgeCafe` discovers its own table list and deletes a whole café graph.
 * That is the right shape for a teardown and a catastrophic shape for a
 * typo: these suites run against the working database, which also holds the
 * owner's real café, so "the caller passed the right id" is not something
 * worth relying on. Refusing an empty id is not enough — a real id is not
 * empty.
 *
 * So the decision is taken from the DATABASE, not from the caller: load the
 * row and require the mark that only a test factory writes. Everything else
 * is refused, including a café that does not exist, because an id matching
 * nothing is a bug being reported rather than a no-op to absorb quietly.
 *
 * Returns the row so the caller has proof of what it is about to delete.
 */
export async function assertPurgeableTestCafe(
  cafeId: string
): Promise<{ id: string; name: string; slug: string }> {
  if (!inTestRunner()) {
    throw new Error(
      "purgeCafe is a test-only teardown and refuses to run outside the test " +
        "runner (NODE_TEST_CONTEXT is unset, or NODE_ENV is production)."
    );
  }
  if (typeof cafeId !== "string" || cafeId.length === 0) {
    throw new Error("purgeCafe needs a café id — refusing to run an unscoped delete");
  }
  // Deleting starts here. The café-level guard below asks "is this row a test
  // fixture"; this one asks the prior question, "is this DATABASE one we may
  // delete from at all". Both are needed: a tagged café in the owner's
  // database would satisfy the first and still be a write we must never make.
  await assertTestDatabase();

  const cafe = await db.cafe.findUnique({
    where: { id: cafeId },
    select: { id: true, name: true, slug: true },
  });

  if (!cafe) {
    throw new Error(
      `purgeCafe refuses café ${cafeId}: no such café. An id that matches ` +
        `nothing is a bug in the suite, not an empty teardown.`
    );
  }
  if (!cafe.slug.startsWith(TEST_CAFE_SLUG_PREFIX)) {
    throw new Error(
      `purgeCafe refuses café ${cafeId} ("${cafe.name}", slug "${cafe.slug}"): ` +
        `it carries no ${TAG_PREFIX} test marker, so it is somebody's real café. ` +
        `No test cleanup helper may delete a non-test café.`
    );
  }
  return cafe;
}

/**
 * Delete a TEST café and everything scoped to it, without naming a model.
 *
 * `assertPurgeableTestCafe` runs first and unconditionally, before the table
 * list is even read: nothing here reaches a DELETE until the database itself
 * has confirmed the target carries a test marker.
 *
 * The table list comes from `information_schema` — every base table in the
 * current schema carrying a `cafeId` column — so a table that does not exist
 * yet is simply never discovered, and a table added by a later migration is
 * covered without editing this helper.
 *
 * Deletion order is discovered rather than declared. Several foreign keys are
 * deliberately `Restrict` (a custody record naming who was answerable must
 * outlive the staff account, a counted line must outlive the ingredient), so
 * a single pass in catalogue order will block. Blocked tables are retried on
 * the next pass; each pass that removes anything unblocks the next layer, and
 * the loop stops as soon as a pass makes no progress.
 *
 * Throws only if the café itself survives — the one condition that means
 * litter is left in the working database.
 */
export async function purgeCafe(cafeId: string): Promise<void> {
  await assertPurgeableTestCafe(cafeId);

  const scoped = await db.$queryRaw<{ table_name: string }[]>`
    SELECT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = current_schema()
       AND t.table_type = 'BASE TABLE'
       AND c.column_name = 'cafeId'
  `;

  let pending = scoped.map((r) => r.table_name).filter((n) => SAFE_IDENTIFIER.test(n));
  let lastFailure: unknown;

  while (pending.length > 0) {
    const blocked: string[] = [];
    for (const table of pending) {
      try {
        await db.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "cafeId" = $1`, cafeId);
      } catch (e) {
        lastFailure = e;
        blocked.push(table);
      }
    }
    if (blocked.length === pending.length) break; // no progress — stop retrying
    pending = blocked;
  }

  try {
    await db.$executeRawUnsafe(`DELETE FROM "Cafe" WHERE "id" = $1`, cafeId);
  } catch (e) {
    lastFailure = e;
  }

  const survivors = await db.cafe.count({ where: { id: cafeId } });
  if (survivors > 0) {
    throw new Error(
      `Tagged café ${cafeId} survived teardown and is now litter in the working ` +
        `database. Last failure: ${describeError(lastFailure)}`
    );
  }
}

function describeError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

/**
 * The `after` hook for a suite that owns its café.
 *
 * `steps` run first, in order, each isolated from the next: a step that
 * throws is reported to stderr and the remaining steps still run. They exist
 * for records the purge cannot reach — anything hanging off the SEEDED café
 * rather than the tagged one. Nothing that lives under the tagged café needs
 * a step at all; the purge takes it.
 *
 * The purge then runs unconditionally and is what actually guarantees the
 * café is gone.
 */
export async function teardownTaggedCafe(
  cafeIds: string | string[] | undefined,
  steps: Array<() => Promise<unknown>> = [],
  options: { disconnect?: boolean } = {}
): Promise<void> {
  const ids = (Array.isArray(cafeIds) ? cafeIds : [cafeIds]).filter(
    (id): id is string => typeof id === "string" && id.length > 0
  );

  try {
    for (const step of steps) {
      try {
        await step();
      } catch (e) {
        // Deliberately swallowed. A cleanup step is best-effort; the café
        // purge below is the guarantee, and it must not be skipped because
        // an optional step referred to a model that is not there yet.
        console.warn(`[teardown] cleanup step failed, continuing: ${describeError(e)}`);
      }
    }
    for (const id of ids) await purgeCafe(id);
  } finally {
    if (options.disconnect) await db.$disconnect();
  }
}
