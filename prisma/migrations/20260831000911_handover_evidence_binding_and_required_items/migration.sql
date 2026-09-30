CREATE TYPE "HandoverTarget" AS ENUM ('SHIFT_TO_SHIFT', 'BRANCH_CUSTODY');
CREATE TYPE "HandoverStockMode" AS ENUM ('FULL', 'SELECTED');
CREATE TYPE "RequiredItemTrigger" AS ENUM ('REGULAR_MODE', 'PERIODIC_DAILY', 'PERIODIC_WEEKLY', 'MANUAL_FULL');
CREATE TYPE "StockCountAccountabilityContext" AS ENUM ('NONE', 'HANDOVER', 'BRANCH_OPENING_VERIFICATION');

ALTER TABLE "HandoverSession"
  ADD COLUMN "target" "HandoverTarget",
  ADD COLUMN "resolvedTarget" "HandoverTarget",
  ADD COLUMN "acceptedStockCountSessionId" TEXT,
  ADD COLUMN "stockMode" "HandoverStockMode",
  ADD COLUMN "requiredItemTrigger" "RequiredItemTrigger",
  ADD COLUMN "requiredItemCount" INTEGER,
  ADD COLUMN "periodicScheduleSnapshot" "PeriodicFullCountSchedule",
  ADD COLUMN "periodicWeekdaySnapshot" INTEGER,
  ADD COLUMN "configSnapshotAt" TIMESTAMP(3),
  ADD COLUMN "businessDateSnapshot" TEXT;

ALTER TABLE "StockCountSession"
  ADD COLUMN "accountabilityContext" "StockCountAccountabilityContext" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "handoverId" TEXT,
  ADD COLUMN "openingBranchCustodyPeriodId" TEXT;

ALTER TABLE "StockCountSession"
  ADD CONSTRAINT "StockCountSession_accountability_context_check" CHECK (
    ("accountabilityContext" = 'NONE' AND "handoverId" IS NULL AND "openingBranchCustodyPeriodId" IS NULL)
    OR ("accountabilityContext" = 'HANDOVER' AND "handoverId" IS NOT NULL AND "openingBranchCustodyPeriodId" IS NULL)
    OR ("accountabilityContext" = 'BRANCH_OPENING_VERIFICATION' AND "handoverId" IS NULL AND "openingBranchCustodyPeriodId" IS NOT NULL)
  );

CREATE TABLE "HandoverRequiredItem" (
  "id" TEXT NOT NULL,
  "handoverId" TEXT NOT NULL,
  "inventoryItemId" TEXT NOT NULL,
  "itemNameSnapshot" TEXT NOT NULL,
  "unitSnapshot" "InventoryUnit" NOT NULL,
  "isCriticalSnapshot" BOOLEAN NOT NULL,
  "satisfiedByLineId" TEXT,
  "omitted" BOOLEAN NOT NULL DEFAULT false,
  "omissionNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HandoverRequiredItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HandoverSession_acceptedStockCountSessionId_key" ON "HandoverSession"("acceptedStockCountSessionId");
CREATE INDEX "StockCountSession_handoverId_idx" ON "StockCountSession"("handoverId");
CREATE INDEX "StockCountSession_openingBranchCustodyPeriodId_idx" ON "StockCountSession"("openingBranchCustodyPeriodId");
CREATE UNIQUE INDEX "HandoverRequiredItem_satisfiedByLineId_key" ON "HandoverRequiredItem"("satisfiedByLineId");
CREATE UNIQUE INDEX "HandoverRequiredItem_handoverId_inventoryItemId_key" ON "HandoverRequiredItem"("handoverId", "inventoryItemId");
CREATE INDEX "HandoverRequiredItem_handoverId_idx" ON "HandoverRequiredItem"("handoverId");
CREATE INDEX "HandoverRequiredItem_inventoryItemId_idx" ON "HandoverRequiredItem"("inventoryItemId");

ALTER TABLE "HandoverSession"
  ADD CONSTRAINT "HandoverSession_acceptedStockCountSessionId_fkey"
  FOREIGN KEY ("acceptedStockCountSessionId") REFERENCES "StockCountSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "StockCountSession"
  ADD CONSTRAINT "StockCountSession_handoverId_fkey"
  FOREIGN KEY ("handoverId") REFERENCES "HandoverSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "StockCountSession_openingBranchCustodyPeriodId_fkey"
  FOREIGN KEY ("openingBranchCustodyPeriodId") REFERENCES "CustodyPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "HandoverRequiredItem"
  ADD CONSTRAINT "HandoverRequiredItem_handoverId_fkey"
  FOREIGN KEY ("handoverId") REFERENCES "HandoverSession"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "HandoverRequiredItem_inventoryItemId_fkey"
  FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "HandoverRequiredItem_satisfiedByLineId_fkey"
  FOREIGN KEY ("satisfiedByLineId") REFERENCES "StockCountLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
