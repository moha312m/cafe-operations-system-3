import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { captureUnitCost } from "@/lib/variance-confidence";
import { submitCountSession } from "@/lib/stock-count";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, countItem } from "./helpers/count";
import { as, requireServer } from "./helpers/http";

test("COUNT-017 captures a positive observed unit cost at judgement time", () => {
  const capturedAt = new Date("2026-08-30T12:00:00.000Z");

  assert.deepEqual(captureUnitCost(12.5, capturedAt), {
    available: true,
    unitCost: 12.5,
    source: "INVENTORY_ITEM_COST_PER_UNIT",
    capturedAt,
  });
});

test("COUNT-017 treats unusable costs as missing", () => {
  const capturedAt = new Date("2026-08-30T12:00:00.000Z");
  for (const value of [null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.deepEqual(captureUnitCost(value, capturedAt), { available: false, reason: "MISSING_COST" });
  }
});

test("COUNT-017 migration is additive and leaves legacy rows untouched", () => {
  const migration = readFileSync(join(process.cwd(), "prisma/migrations/20260830235911_count_unit_cost_snapshot/migration.sql"), "utf8");
  assert.match(migration, /ADD COLUMN "unitCostSnapshot" DECIMAL\(12,2\)/);
  assert.match(migration, /ADD COLUMN "unitCostSource" TEXT/);
  assert.match(migration, /ADD COLUMN "unitCostCapturedAt" TIMESTAMP\(3\)/);
  assert.doesNotMatch(migration, /\b(?:DEFAULT|INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
});

test("COUNT-017 persists the observed cost with a submission, independently of confidence", async () => {
  await requireServer();
  const fx = await countCafe("COUNT017");
  try {
    const item = await countItem(fx, "snapshot item", { stock: 10, isCritical: true, costPerUnit: 12.5 });
    const session = await db.stockCountSession.create({
      data: {
        cafeId: fx.cafeId, branchId: fx.branchId, type: "CRITICAL",
        scopeDerivation: "CRITICAL_ONLY", status: "IN_PROGRESS", initiatedById: fx.manager.id,
        lines: { create: [{ inventoryItemId: item.id, unit: "KG" }] },
      },
      select: { id: true, lines: { select: { id: true } } },
    });
    const lineId = session.lines[0].id;
    const captured = await as(fx.cashier.email, `/api/stock-counts/${session.id}/lines/${lineId}`, {
      method: "PATCH", body: JSON.stringify({ countedQuantity: 8 }),
    });
    assert.ok(captured.status < 300, captured.text);
    await submitCountSession({ sessionId: session.id, submittedById: fx.manager.id });

    const line = await db.stockCountLine.findUniqueOrThrow({ where: { id: lineId } });
    assert.equal(line.unitCostSnapshot?.toString(), "12.5");
    assert.equal(line.unitCostSource, "INVENTORY_ITEM_COST_PER_UNIT");
    assert.ok(line.unitCostCapturedAt instanceof Date);
    assert.equal(line.confidence, "UNVERIFIABLE");
    assert.equal(line.costImpactAvailable, false);

    await db.inventoryItem.update({ where: { id: item.id }, data: { costPerUnit: 99 } });
    const unchanged = await db.stockCountLine.findUniqueOrThrow({ where: { id: lineId } });
    assert.equal(unchanged.unitCostSnapshot?.toString(), "12.5");
  } finally {
    await teardownTaggedCafe(fx.cafeId, [], { disconnect: true });
  }
});
