import fs from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

test("offline schema contract: default-off gate and nullable immutable legacy snapshots", () => {
  const schema = fs.readFileSync("prisma/schema.prisma", "utf8");
  assert.match(schema, /finishedGoodsSalesEnabled\s+Boolean\s+@default\(false\)/);
  assert.match(schema, /stockMode\s+ProductStockMode\s+@default\(RECIPE\)/);
  assert.match(schema, /stockModeSnapshot\s+ProductStockMode\?/);
  assert.match(schema, /model FinishedGoodsReturn/);
});

test("offline migration contract: reviewed SQL-only guards are included (not execution proof)", () => {
  const sql = fs.readFileSync("prisma/migrations/20261011210000_finished_goods_sales/migration.sql", "utf8");
  assert.match(sql, /WHERE "variantId" IS NULL/);
  assert.match(sql, /FOR UPDATE/);
  assert.match(sql, /CREATE TRIGGER/);
  assert.match(sql, /IS TRUE/);
});
