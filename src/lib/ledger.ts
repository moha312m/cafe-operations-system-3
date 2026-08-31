// THE single writer of InventoryItem.currentStock and InventoryTransaction.
//
// Physical counting compares a shelf against a theoretical balance, and that
// comparison is only meaningful if the balance has a cursor: a point such
// that everything at or below it is committed and reflected in
// `currentStock`, and nothing above it has been assigned. `InventoryItem
// .ledgerVersion` is that cursor, and it only works if EVERY mutation obeys
// one contract:
//
//     BEGIN
//       SELECT currentStock, ledgerVersion … WHERE id = $1 FOR UPDATE
//       v := ledgerVersion + 1
//       UPDATE InventoryItem SET currentStock = …, ledgerVersion = v
//       INSERT InventoryTransaction (…, itemVersion = v)
//     COMMIT
//
// The row lock serialises every mutator of that item, so version N+1 cannot
// be assigned until N is committed and visible: version order IS commit
// order, per item, by construction. A rolled-back increment rolls back with
// the row, so there are no gaps — something a sequence cannot offer, since
// nextval() assigns at INSERT and is non-transactional.
//
// "Every mutation" is load-bearing, which is why there is one function
// rather than a convention. Before this module there were six writers; two
// of them (item creation, and the manual movement route's array-form
// $transaction) were structurally incapable of holding a row lock at all.
// LEDGER-002 test 5 reads the source tree and asserts no seventh appears.
//
// All quantity arithmetic here is round3. That is not incidental: stock is
// Decimal(12,3) because 18 g of coffee is 0.018 kg, and purchase confirm
// used to round the whole balance to two decimals — turning an 18 g receipt
// into 20 g, in the very baseline every count is measured against.

import type { Prisma, PrismaClient, InventoryTransactionType, InventoryUnit } from "@prisma/client";
import { round3 } from "@/lib/costing";

export type StockAttributionSnapshot = {
  custodyPeriodId: string | null;
  shiftId: string | null;
};

export type StockMutation = {
  inventoryItemId: string;
  type: InventoryTransactionType;
  /** Signed delta, already in the item's stock unit. */
  quantity: number;
  cafeId: string;
  branchId: string;
  unitCost?: number | null;
  totalCost?: number | null;
  note?: string | null;
  orderId?: string | null;
  createdById?: string | null;
  /** Refuse to go below zero unless the café allows it. Defaults to refusing. */
  allowNegative?: boolean;
  /** A purchase may refresh the item's reference cost in the same write. */
  newCostPerUnit?: number | null;
  /** Message used when the guard refuses, so call sites keep their wording. */
  insufficientMessage?: string;
  /**
   * Historical stock-accountability snapshot. When omitted, the branch's
   * active STOCK custody supplies both values; when supplied, the pair is
   * written verbatim so mixed historical evidence cannot be constructed.
   */
  attribution?: StockAttributionSnapshot;
};

export type StockMutationResult = {
  inventoryItemId: string;
  stockBefore: number;
  stockAfter: number;
  itemVersion: bigint;
  transactionId: string;
  custodyPeriodId: string | null;
  shiftId: string | null;
};

type LockedItem = {
  currentStock: number;
  ledgerVersion: bigint;
  unit: InventoryUnit;
  costPerUnit: number;
};

/**
 * Resolve stock accountability from the branch's active STOCK custody.
 * Responsibility belongs to that custody period, not to an operational
 * shift or any custody participant.
 */
export async function resolveStockAttribution(
  tx: Prisma.TransactionClient,
  branchId: string
): Promise<StockAttributionSnapshot> {
  const custody = await tx.custodyPeriod.findFirst({
    where: { branchId, scope: "STOCK", status: "OPEN" },
    select: { id: true, responsibleShiftId: true },
  });

  return custody
    ? { custodyPeriodId: custody.id, shiftId: custody.responsibleShiftId }
    : { custodyPeriodId: null, shiftId: null };
}

/**
 * Read `currentStock` and `ledgerVersion` together, under this item's row
 * lock, inside the caller's transaction.
 *
 * Both values must come from the same locked read. Reading them separately
 * would reintroduce exactly the window the version exists to close: a
 * movement could land between the two reads, making the balance and the
 * cursor describe different instants.
 */
export async function lockItemForUpdate(
  tx: Prisma.TransactionClient,
  inventoryItemId: string
): Promise<LockedItem> {
  const rows = await tx.$queryRaw<
    { currentStock: Prisma.Decimal; ledgerVersion: bigint; unit: InventoryUnit; costPerUnit: Prisma.Decimal }[]
  >`
    SELECT "currentStock", "ledgerVersion", "unit", "costPerUnit"
      FROM "InventoryItem"
     WHERE "id" = ${inventoryItemId}
     FOR UPDATE
  `;
  const row = rows[0];
  if (!row) throw new Error(`Inventory item ${inventoryItemId} not found`);

  return {
    currentStock: Number(row.currentStock),
    ledgerVersion: BigInt(row.ledgerVersion),
    unit: row.unit,
    costPerUnit: Number(row.costPerUnit),
  };
}

/**
 * Apply one stock movement: lock, advance the version, update the balance,
 * and insert the ledger row — all under the one lock.
 *
 * MUST be called inside an interactive transaction (`db.$transaction(async
 * (tx) => …)`). The array form cannot hold a row lock across statements, so
 * a caller using it would silently lose the guarantee.
 */
export async function applyStockMutation(
  tx: Prisma.TransactionClient,
  m: StockMutation
): Promise<StockMutationResult> {
  const locked = await lockItemForUpdate(tx, m.inventoryItemId);
  const attribution = m.attribution ?? await resolveStockAttribution(tx, m.branchId);

  const delta = round3(m.quantity);
  const stockBefore = round3(locked.currentStock);
  const stockAfter = round3(stockBefore + delta);

  if (stockAfter < 0 && m.allowNegative !== true) {
    throw new Error(
      m.insufficientMessage ?? "لا توجد كمية كافية في المخزون"
    );
  }

  const itemVersion = locked.ledgerVersion + BigInt(1);

  await tx.inventoryItem.update({
    where: { id: m.inventoryItemId },
    data: {
      currentStock: stockAfter,
      ledgerVersion: itemVersion,
      ...(m.newCostPerUnit !== undefined && m.newCostPerUnit !== null
        ? { costPerUnit: m.newCostPerUnit }
        : {}),
    },
  });

  const row = await tx.inventoryTransaction.create({
    data: {
      cafeId: m.cafeId,
      branchId: m.branchId,
      inventoryItemId: m.inventoryItemId,
      type: m.type,
      quantity: delta,
      unitCost: m.unitCost ?? null,
      totalCost: m.totalCost ?? null,
      note: m.note ?? null,
      orderId: m.orderId ?? null,
      createdById: m.createdById ?? null,
      custodyPeriodId: attribution.custodyPeriodId,
      shiftId: attribution.shiftId,
      itemVersion,
    },
    select: { id: true },
  });

  return {
    inventoryItemId: m.inventoryItemId,
    stockBefore,
    stockAfter,
    itemVersion,
    transactionId: row.id,
    custodyPeriodId: attribution.custodyPeriodId,
    shiftId: attribution.shiftId,
  };
}

/**
 * Net delta for an item strictly above `fromVersion`, with the number of
 * movements that produced it.
 *
 * Used by the rebase replay: a movement posted between a count point and its
 * confirmation is neither an error nor silently absorbed — it sits above the
 * captured version, is excluded from that line's expected figure, and is
 * replayed onto the rebase so `currentStock` ends correct.
 */
export async function ledgerDeltaAbove(
  tx: Prisma.TransactionClient | PrismaClient,
  inventoryItemId: string,
  fromVersion: bigint
): Promise<{ delta: number; movementCount: number }> {
  const rows = await tx.$queryRaw<{ delta: Prisma.Decimal | null; movements: bigint }[]>`
    SELECT COALESCE(SUM("quantity"), 0) AS delta, COUNT(*)::bigint AS movements
      FROM "InventoryTransaction"
     WHERE "inventoryItemId" = ${inventoryItemId}
       AND "itemVersion" > ${fromVersion}
  `;
  return {
    delta: round3(Number(rows[0]?.delta ?? 0)),
    movementCount: Number(rows[0]?.movements ?? 0),
  };
}
