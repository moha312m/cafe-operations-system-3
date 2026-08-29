-- One counted shelf: the original evidence, the working figure, and the
-- ledger version the expectation was captured at.
--
-- Three columns that must never be collapsed into fewer:
--
--   countedQuantity           what the counter wrote down. Written once at
--                             capture and never updated. If a correction
--                             overwrote it, the original observation would be
--                             gone and no investigation could ask what was
--                             first reported.
--   effectiveCountedQuantity  what the business acts on. Equals the counted
--                             figure until an APPROVED correction supersedes
--                             it; rebase, variance and export read this one.
--   itemVersion               the count point. Provenance: it says which
--                             committed movements the expectation included,
--                             so a movement posted mid-count is replayed
--                             rather than mistaken for a shortage.
--
-- costImpact is nullable and paired with costImpactAvailable. A missing cost
-- must read back NULL, never 0 — "we cannot value this shortage" and "this
-- shortage cost nothing" are opposite claims, and writing 0 for the first
-- turns an unknown into an exoneration nobody granted.
--
-- ON DELETE RESTRICT on inventoryItemId is deliberate: a confirmed count is
-- evidence, and deleting an ingredient must not erase the record of it having
-- been counted.
--
-- Rollback:
--   DROP TABLE "StockCountLine";
--   DROP TYPE "TheoreticalConfidence"; DROP TYPE "CountLineDisposition";

CREATE TYPE "CountLineDisposition" AS ENUM (
  'PENDING', 'COUNTED', 'WITHIN_TOLERANCE', 'OUTSIDE_TOLERANCE',
  'RECOUNT_REQUIRED', 'RESOLVED_WITHIN_TOLERANCE', 'VARIANCE_CONFIRMED'
);

CREATE TYPE "TheoreticalConfidence" AS ENUM ('VERIFIED', 'PARTIAL', 'UNVERIFIABLE');

CREATE TABLE "StockCountLine" (
  "id"                       TEXT NOT NULL,
  "sessionId"                TEXT NOT NULL,
  "inventoryItemId"          TEXT NOT NULL,
  "unit"                     "InventoryUnit" NOT NULL,
  "expectedQuantity"         DECIMAL(12,3),
  "countedQuantity"          DECIMAL(12,3),
  "effectiveCountedQuantity" DECIMAL(12,3),
  "varianceQuantity"         DECIMAL(12,3),
  "countedAt"                TIMESTAMP(3),
  "counterId"                TEXT,
  "itemVersion"              BIGINT,
  "expectedBasis"            TEXT,
  "confidence"               "TheoreticalConfidence" NOT NULL DEFAULT 'UNVERIFIABLE',
  "confidenceIssues"         JSONB,
  "confidenceWindowFrom"     TIMESTAMP(3),
  "disposition"              "CountLineDisposition" NOT NULL DEFAULT 'PENDING',
  "costImpact"               DECIMAL(12,2),
  "costImpactAvailable"      BOOLEAN NOT NULL DEFAULT false,
  "costUnavailableReason"    TEXT,
  "reasonCodeId"             TEXT,
  "reasonNote"               TEXT,
  "createdAt"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StockCountLine_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StockCountLine_sessionId_inventoryItemId_key"
  ON "StockCountLine"("sessionId", "inventoryItemId");
CREATE INDEX "StockCountLine_sessionId_idx" ON "StockCountLine"("sessionId");
CREATE INDEX "StockCountLine_inventoryItemId_idx" ON "StockCountLine"("inventoryItemId");
CREATE INDEX "StockCountLine_disposition_idx" ON "StockCountLine"("disposition");

ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "StockCountSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_inventoryItemId_fkey"
  FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_counterId_fkey"
  FOREIGN KEY ("counterId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_reasonCodeId_fkey"
  FOREIGN KEY ("reasonCodeId") REFERENCES "ReasonCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;
