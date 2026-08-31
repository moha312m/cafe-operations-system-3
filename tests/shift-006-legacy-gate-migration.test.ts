import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

test("SHIFT-006 M13 preserves the legacy NULL/NULL operational state without a backfill", async () => {
  const migration = await readFile(path.join(process.cwd(), "prisma/migrations/20260830231911_shift_custody_gate/migration.sql"), "utf8");
  assert.match(migration, /CREATE TYPE "ShiftCustodyGate"/);
  assert.match(migration, /ADD COLUMN "custodyReadyAt" TIMESTAMP\(3\)/);
  assert.match(migration, /ADD COLUMN "custodyGateReason" "ShiftCustodyGate"/);
  assert.match(migration, /CHECK \("custodyGateReason" IS NULL OR "custodyReadyAt" IS NULL\)/);
  assert.doesNotMatch(migration, /\b(UPDATE|INSERT|DELETE)\b/i);
});
