import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, fixture, sessionFor } from "./helpers/db";

const MIGRATION = join(
  process.cwd(),
  "prisma",
  "migrations",
  "20260830232911_order_served_attribution",
  "migration.sql"
);

class RollbackMigrationProbe extends Error {}

test("ORDER-007 applies M14 to a pre-M14 historical order without fabricating attribution", async () => {
  const sql = readFileSync(MIGRATION, "utf8");
  assert.doesNotMatch(sql, /^\s*(?:INSERT|UPDATE|DELETE)\b/im, "M14 must not backfill or mutate data");

  const fx = await fixture();
  const actor = await sessionFor("cashier@demo.com");
  const historical = await db.order.create({
    data: {
      cafeId: fx.cafeId,
      branchId: fx.branchId,
      orderNumber: (await db.order.aggregate({ where: { branchId: fx.branchId }, _max: { orderNumber: true } }))._max.orderNumber! + 1,
      type: "TAKEAWAY",
      status: "SERVED",
      source: "CASHIER_POS",
      customerName: `ORD7-HISTORICAL-${process.pid}`,
      subtotal: 1,
      taxAmount: 0,
      discountAmount: 0,
      serviceChargeAmount: 0,
      total: 1,
      remainingAmount: 1,
      createdById: actor.id,
      servedAt: new Date(),
    },
  });

  try {
    await assert.rejects(
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'ALTER TABLE "Order" DROP CONSTRAINT "Order_servedById_fkey", DROP CONSTRAINT "Order_servedStockCustodyPeriodId_fkey", DROP CONSTRAINT "Order_servedShiftId_fkey"'
        );
        await tx.$executeRawUnsafe('DROP INDEX "Order_servedById_idx", "Order_servedStockCustodyPeriodId_idx", "Order_servedShiftId_idx"');
        await tx.$executeRawUnsafe(
          'ALTER TABLE "Order" DROP COLUMN "servedById", DROP COLUMN "servedStockCustodyPeriodId", DROP COLUMN "servedShiftId"'
        );
        for (const statement of sql.split(/;\s*(?:\r?\n|$)/)) {
          if (statement.trim()) await tx.$executeRawUnsafe(statement);
        }

        const [row] = await tx.$queryRawUnsafe<{
          servedById: string | null;
          servedStockCustodyPeriodId: string | null;
          servedShiftId: string | null;
        }[]>('SELECT "servedById", "servedStockCustodyPeriodId", "servedShiftId" FROM "Order" WHERE "id" = $1', historical.id);
        assert.deepEqual(row, {
          servedById: null,
          servedStockCustodyPeriodId: null,
          servedShiftId: null,
        });
        throw new RollbackMigrationProbe();
      }),
      RollbackMigrationProbe
    );
  } finally {
    await db.order.delete({ where: { id: historical.id } });
    await db.$disconnect();
  }
});
