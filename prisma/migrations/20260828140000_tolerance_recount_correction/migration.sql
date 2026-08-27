-- Rules for closeness, and records for second looks.
--
-- ToleranceRule is scoped four ways for stock (CAFE, BRANCH, CATEGORY, ITEM)
-- and once for tender. Narrowest wins; T15 resolves the precedence. The three
-- tolerance columns are all nullable because a rule may constrain quantity, a
-- percentage, an amount, or a combination — and "not set" must stay
-- distinguishable from "set to zero", which is an exact-match requirement.
--
-- StockCountRecount is a RECORD, not an update to the line. It captures its
-- OWN expectedQuantity at its OWN itemVersion, because the shelf may have
-- moved between the first count and the second: measuring a recount against
-- the original expectation would invent a variance that never existed.
--
-- StockCountCorrection.reasonCodeId is NOT NULL, deliberately. A correction
-- is somebody altering a recorded observation — the act that most needs a
-- stated reason and a second signature, which is why it also defaults to
-- PENDING_APPROVAL rather than taking effect on write.
--
-- Rollback:
--   DROP TABLE "StockCountCorrection"; DROP TABLE "StockCountRecount";
--   DROP TABLE "ToleranceRule";
--   DROP TYPE "CorrectionStatus"; DROP TYPE "RecountKind";
--   DROP TYPE "ToleranceScope";

CREATE TYPE "ToleranceScope"   AS ENUM ('CAFE', 'BRANCH', 'CATEGORY', 'ITEM', 'TENDER');
CREATE TYPE "RecountKind"      AS ENUM ('INDEPENDENT', 'SELF_RECOUNT');
CREATE TYPE "CorrectionStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'REJECTED');

CREATE TABLE "ToleranceRule" (
  "id"                TEXT NOT NULL,
  "cafeId"            TEXT NOT NULL,
  "scope"             "ToleranceScope" NOT NULL,
  "branchId"          TEXT,
  "category"          TEXT,
  "inventoryItemId"   TEXT,
  "tenderMethod"      "PaymentMethod",
  "quantityTolerance" DECIMAL(12,3),
  "percentTolerance"  DECIMAL(5,2),
  "amountTolerance"   DECIMAL(10,2),
  "isActive"          BOOLEAN NOT NULL DEFAULT true,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ToleranceRule_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ToleranceRule_cafeId_scope_idx" ON "ToleranceRule"("cafeId", "scope");
CREATE INDEX "ToleranceRule_branchId_idx" ON "ToleranceRule"("branchId");
CREATE INDEX "ToleranceRule_inventoryItemId_idx" ON "ToleranceRule"("inventoryItemId");

CREATE TABLE "StockCountRecount" (
  "id"               TEXT NOT NULL,
  "lineId"           TEXT NOT NULL,
  "attempt"          INTEGER NOT NULL,
  "kind"             "RecountKind" NOT NULL,
  "countedQuantity"  DECIMAL(12,3) NOT NULL,
  -- Re-captured at its own count point; see the header note.
  "expectedQuantity" DECIMAL(12,3) NOT NULL,
  "itemVersion"      BIGINT NOT NULL,
  "varianceQuantity" DECIMAL(12,3) NOT NULL,
  "countedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "counterId"        TEXT NOT NULL,
  "resolved"         BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "StockCountRecount_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StockCountRecount_lineId_attempt_key" ON "StockCountRecount"("lineId", "attempt");
CREATE INDEX "StockCountRecount_lineId_idx" ON "StockCountRecount"("lineId");

CREATE TABLE "StockCountCorrection" (
  "id"                 TEXT NOT NULL,
  "lineId"             TEXT NOT NULL,
  "oldCountedQuantity" DECIMAL(12,3) NOT NULL,
  "newCountedQuantity" DECIMAL(12,3) NOT NULL,
  "reasonCodeId"       TEXT NOT NULL,
  "note"               TEXT,
  "actorId"            TEXT NOT NULL,
  "status"             "CorrectionStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
  "approvedById"       TEXT,
  "approvedAt"         TIMESTAMP(3),
  "rejectedReason"     TEXT,
  -- True when the correction post-dates a custody transfer (T30).
  "postCustodyTransfer" BOOLEAN NOT NULL DEFAULT false,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StockCountCorrection_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "StockCountCorrection_lineId_idx" ON "StockCountCorrection"("lineId");
CREATE INDEX "StockCountCorrection_status_idx" ON "StockCountCorrection"("status");

ALTER TABLE "ToleranceRule" ADD CONSTRAINT "ToleranceRule_cafeId_fkey"
  FOREIGN KEY ("cafeId") REFERENCES "Cafe"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ToleranceRule" ADD CONSTRAINT "ToleranceRule_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ToleranceRule" ADD CONSTRAINT "ToleranceRule_inventoryItemId_fkey"
  FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StockCountRecount" ADD CONSTRAINT "StockCountRecount_lineId_fkey"
  FOREIGN KEY ("lineId") REFERENCES "StockCountLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StockCountRecount" ADD CONSTRAINT "StockCountRecount_counterId_fkey"
  FOREIGN KEY ("counterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "StockCountCorrection" ADD CONSTRAINT "StockCountCorrection_lineId_fkey"
  FOREIGN KEY ("lineId") REFERENCES "StockCountLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StockCountCorrection" ADD CONSTRAINT "StockCountCorrection_reasonCodeId_fkey"
  FOREIGN KEY ("reasonCodeId") REFERENCES "ReasonCode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockCountCorrection" ADD CONSTRAINT "StockCountCorrection_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockCountCorrection" ADD CONSTRAINT "StockCountCorrection_approvedById_fkey"
  FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
