// Shared harness for Phase 1 (Cash Integrity) regression tests.
//
// These are integration tests: they run against the real local Postgres
// configured in .env, exercising the actual Prisma client and service layer
// rather than mocks — a cash-custody invariant is only meaningful if the
// database agrees with it.
//
// Every record created here is tagged "PH1-…" so remediation data is
// distinguishable from audit data and can be removed independently.

import { PrismaClient, type Role } from "@prisma/client";
import type { SessionUser } from "@/lib/auth";

export const db = new PrismaClient();

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
