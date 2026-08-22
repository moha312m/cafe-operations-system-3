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

/** Minimal unpaid order used as a payment target. */
export async function makeOrder(fx: Fixture, marker: string, createdById: string) {
  const product = await db.product.findUniqueOrThrow({ where: { id: fx.productId } });
  const subtotal = Number(product.basePrice);
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
