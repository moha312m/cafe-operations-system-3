// ── What accepted orders have already promised ───────────────────────
//
// The shelf balance is not the answer to "how many more can we make".
// `InventoryItem.currentStock` only moves at SERVED — the deduction is a
// locked, ledgered, audited mutation and it belongs at the moment the drink
// is handed over — so between acceptance and handover the ice cream for three
// milkshakes is spoken for and still counted as available. Free quantity is
// `currentStock` MINUS the live rows this module manages.
//
// ── Why the read is one statement ──
//
// SERVED does three things atomically: it moves the balance, it stamps
// `stockDeductedAt`, and it releases the order's commitments. A reader that
// took the balance in one query and the commitments in another could land
// either side of that commit — and if it read the OLD balance and the NEW
// (released) commitments it would see a branch richer than it has ever been.
// So both come back from a single SELECT, which in PostgreSQL is one
// snapshot: there is no instant at which both the stock movement and the
// commitment apply, and no instant at which neither does.
//
// ── Why writing takes locks ──
//
// A number on a screen is not a reservation. Two tills reading "5 available"
// and each accepting 4 leaves the café owing eight portions of a five-portion
// ingredient, discovered hours later at SERVED with the drinks made and the
// money taken. Acceptance therefore locks the branch rows it needs, re-reads
// stock and commitments underneath those locks, and writes the order with its
// commitment or writes neither.
//
// The locks live for one transaction and are never held while anybody waits
// for a cashier — which is exactly why the read path above holds none.

import type { Prisma, PrismaClient, InventoryUnit } from "@prisma/client";
import { round3 } from "@/lib/costing";

type Client = Prisma.TransactionClient | PrismaClient;

/**
 * The statuses whose orders have been ACCEPTED and not yet finalised.
 *
 * PENDING_WAITER_APPROVAL is deliberately absent: a QR order sitting in the
 * approval queue is a request, not a promise, and reserving stock for one
 * would let an unattended tablet empty a branch's availability. It commits
 * when a person approves it.
 *
 * SERVED, CANCELLED and REJECTED are absent because they are endings — the
 * first has moved into `currentStock`, the other two never will.
 */
export const COMMITTED_STATUSES = ["CONFIRMED", "PREPARING", "READY"] as const;

export type FreeQuantity = {
  inventoryItemId: string;
  name: string;
  unit: InventoryUnit;
  /** The shelf balance, unchanged by anything here. */
  currentStock: number;
  /** Live, undeducted claims from accepted orders. Always >= 0. */
  committed: number;
  /** What a NEW sale may draw on. May be negative when stock already is. */
  free: number;
};

type FreeRow = {
  id: string;
  name: string;
  unit: InventoryUnit;
  currentStock: Prisma.Decimal;
  committed: Prisma.Decimal | null;
};

/**
 * Every stock row this branch carries, with its live commitments already
 * netted off — in one statement, and therefore one consistent snapshot.
 *
 * The whole branch is loaded rather than the rows a particular cart happens
 * to name. A branch carries tens of ingredients, not thousands, and the POS
 * board needs all of them anyway; fetching per cart would mean a different
 * query shape for the two callers, which is how they start disagreeing.
 *
 * Both filters are load-bearing. `cafeId` and `branchId` scope the shelf, and
 * the commitment sub-select is scoped to the same branch: ingredients are
 * matched by name+unit across a café, so an unscoped join would let the annex
 * make this counter look stocked.
 */
export async function readBranchFreeQuantities(
  client: Client,
  cafeId: string,
  branchId: string
): Promise<FreeQuantity[]> {
  const rows = await client.$queryRaw<FreeRow[]>`
    SELECT i."id", i."name", i."unit", i."currentStock", c."committed"
      FROM "InventoryItem" i
      LEFT JOIN (
        SELECT oc."inventoryItemId", SUM(oc."quantity") AS "committed"
          FROM "OrderInventoryCommitment" oc
          JOIN "Order" o ON o."id" = oc."orderId"
         WHERE oc."releasedAt" IS NULL
           AND oc."branchId" = ${branchId}
           -- Belt and braces against the status: a commitment whose order has
           -- been finalised by some path that forgot to release it must stop
           -- counting anyway. Availability is what a cashier acts on, and it
           -- must not depend on every future writer remembering a step.
           AND o."stockDeductedAt" IS NULL
           AND o."status" IN ('CONFIRMED', 'PREPARING', 'READY')
         GROUP BY oc."inventoryItemId"
      ) c ON c."inventoryItemId" = i."id"
     WHERE i."cafeId" = ${cafeId}
       AND i."branchId" = ${branchId}
       AND i."archivedAt" IS NULL
     ORDER BY i."name" ASC, i."id" ASC
  `;

  return rows.map((r) => {
    const currentStock = round3(Number(r.currentStock));
    const committed = round3(Number(r.committed ?? 0));
    return {
      inventoryItemId: r.id,
      name: r.name,
      unit: r.unit,
      currentStock,
      committed,
      // Deliberately not clamped. A branch that has sold into a negative
      // balance has a negative free quantity, and flattening that to zero
      // here would hide the size of the hole from the deduction check. The
      // display clamps the COUNT at zero; the quantity stays honest.
      free: round3(currentStock - committed),
    };
  });
}

/**
 * Open orders this branch cannot account for.
 *
 * An order accepted before the commitment ledger existed carries no snapshot,
 * and `OrderItem` records what was SOLD rather than what it consumed. There is
 * no honest way to reconstruct its draw: recomputing from today's recipe would
 * produce a figure the order was never accepted under, which is the exact
 * substitution this feature exists to prevent.
 *
 * So they are counted and disclosed rather than guessed. The condition clears
 * itself — those orders reach SERVED or CANCELLED in the ordinary course of a
 * shift, and everything accepted since carries its own snapshot.
 */
export async function countUncommittedOpenOrders(
  client: Client,
  branchId: string
): Promise<number> {
  const [row] = await client.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count
      FROM "Order"
     WHERE "branchId" = ${branchId}
       AND "status" IN ('CONFIRMED', 'PREPARING', 'READY')
       AND "stockDeductedAt" IS NULL
       AND "inventoryCommittedAt" IS NULL
  `;
  return Number(row?.count ?? 0);
}

/**
 * Take the branch rows this order needs, in a deterministic order.
 *
 * `ORDER BY id` is not cosmetic: two transactions locking the same two rows in
 * opposite orders deadlock, and the SERVED-time deduction sorts by the same
 * key for the same reason. Sorting by a stable, arbitrary key is what makes
 * the two paths interleave safely without either knowing about the other.
 *
 * Nothing is returned but the fact that the locks are held — the balances are
 * then read through `readBranchFreeQuantities`, inside the same transaction
 * and therefore behind these locks.
 */
export async function lockBranchItems(
  tx: Prisma.TransactionClient,
  inventoryItemIds: string[]
): Promise<void> {
  if (inventoryItemIds.length === 0) return;
  await tx.$queryRaw`
    SELECT "id" FROM "InventoryItem"
     WHERE "id" = ANY(${inventoryItemIds}::text[])
     ORDER BY "id"
     FOR UPDATE
  `;
}

export type CommitmentLine = {
  inventoryItemId: string;
  quantity: number;
  unit: InventoryUnit;
};

/**
 * Record what this order will consume, once, at acceptance.
 *
 * `inventoryCommittedAt` is stamped even when there is nothing to record. An
 * order that legitimately consumes nothing — a bottled drink marked
 * NOT_APPLICABLE, or a sale OVERRIDE_ALL let through against a recipe nobody
 * wrote — has no rows and IS accounted for, and without the stamp it would be
 * indistinguishable from an order accepted before this ledger existed, whose
 * draw genuinely is unknown.
 *
 * Must be called inside the transaction that creates the order, behind the
 * locks taken above. A commitment written in a second transaction is a
 * commitment another till can overtake.
 */
export async function persistOrderCommitments(
  tx: Prisma.TransactionClient,
  args: { orderId: string; cafeId: string; branchId: string; lines: CommitmentLine[] }
): Promise<void> {
  if (args.lines.length > 0) {
    await tx.orderInventoryCommitment.createMany({
      data: args.lines.map((l) => ({
        orderId: args.orderId,
        cafeId: args.cafeId,
        branchId: args.branchId,
        inventoryItemId: l.inventoryItemId,
        quantity: round3(l.quantity),
        unit: l.unit,
      })),
    });
  }
  await tx.order.update({
    where: { id: args.orderId },
    data: { inventoryCommittedAt: new Date() },
  });
}

/**
 * Stop an order's commitments counting, without losing them.
 *
 * Deleting would release the availability and destroy the evidence in the
 * same statement — and the two endings are not the same fact. `DEDUCTED` means
 * the customer got the drink and the quantity is now in the ledger;
 * `CANCELLED` means it was never going to leave the shelf. A released row is
 * the only place that distinction survives.
 *
 * `releasedAt IS NULL` in the filter makes this idempotent: a second call
 * matches nothing rather than restamping a row with a later time.
 *
 * MUST run in the same transaction as the thing it describes — the locked
 * deduction, or the cancelling status update — so there is no instant where
 * the stock has moved and the commitment still applies, nor one where neither
 * does.
 */
export async function releaseOrderCommitments(
  tx: Prisma.TransactionClient,
  orderId: string,
  reason: "DEDUCTED" | "CANCELLED"
): Promise<number> {
  const { count } = await tx.orderInventoryCommitment.updateMany({
    where: { orderId, releasedAt: null },
    data: { releasedAt: new Date(), releaseReason: reason },
  });
  return count;
}
