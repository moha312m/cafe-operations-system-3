// Early low-stock warning: when an ingredient counts as "low".
//
// `minimumStock` defaults to 0, so a café that never typed a minimum for each
// ingredient was only told about an item once it had already run out. The
// café-wide percent closes that gap without inventing quantities: the
// threshold is a share of the item's own most recent delivery, which is a
// real recorded movement. An item with no delivery on record keeps whatever
// minimum it has — nothing is guessed for it.
//
// Read-only. Nothing here writes stock, ledger rows or settings.

import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { stockStatus, type StockStatus } from "@/lib/inventory";

export const DEFAULT_LOW_STOCK_ALERT_PERCENT = 20;
export const MAX_LOW_STOCK_ALERT_PERCENT = 90;

/** Stock arriving at the branch. Opening balances are recorded as PURCHASE. */
const DELIVERY_TYPES = ["PURCHASE", "TRANSFER_IN"] as const;

export async function getLowStockAlertPercent(cafeId: string): Promise<number> {
  const settings = await db.cafeSettings.findUnique({
    where: { cafeId },
    select: { lowStockAlertPercent: true },
  });
  return settings?.lowStockAlertPercent ?? DEFAULT_LOW_STOCK_ALERT_PERCENT;
}

/** Quantity of each item's most recent delivery, scoped to one café. */
export async function lastDeliveryQuantities(
  cafeId: string,
  itemIds: string[]
): Promise<Map<string, number>> {
  if (itemIds.length === 0) return new Map();
  const rows = await db.$queryRaw<Array<{ inventoryItemId: string; quantity: Prisma.Decimal }>>`
    SELECT DISTINCT ON ("inventoryItemId") "inventoryItemId", "quantity"
      FROM "InventoryTransaction"
     WHERE "cafeId" = ${cafeId}
       AND "inventoryItemId" IN (${Prisma.join(itemIds)})
       AND "type"::text IN (${Prisma.join([...DELIVERY_TYPES])})
       AND "quantity" > 0
     ORDER BY "inventoryItemId", "createdAt" DESC, "itemVersion" DESC`;
  return new Map(rows.map((r) => [r.inventoryItemId, Number(r.quantity)]));
}

export function lowStockThreshold(
  minimumStock: number,
  lastDelivery: number | undefined,
  percent: number
): number {
  const fromDelivery = lastDelivery && percent > 0 ? (lastDelivery * percent) / 100 : 0;
  return Math.round(Math.max(minimumStock, fromDelivery) * 1000) / 1000;
}

export type StockAlertFields = { alertThreshold: number; status: StockStatus };

/** Attach the effective threshold and status to items of one café. */
export async function withStockAlerts<
  T extends { id: string; currentStock: Prisma.Decimal | number; minimumStock: Prisma.Decimal | number }
>(cafeId: string, items: T[]): Promise<Array<T & StockAlertFields>> {
  const [percent, deliveries] = await Promise.all([
    getLowStockAlertPercent(cafeId),
    lastDeliveryQuantities(cafeId, items.map((i) => i.id)),
  ]);
  return items.map((item) => {
    const alertThreshold = lowStockThreshold(Number(item.minimumStock), deliveries.get(item.id), percent);
    return { ...item, alertThreshold, status: stockStatus(Number(item.currentStock), alertThreshold) };
  });
}
