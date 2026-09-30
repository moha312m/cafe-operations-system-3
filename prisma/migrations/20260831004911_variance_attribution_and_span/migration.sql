-- M22 — attribution and the period span.
--
-- A stock difference used to carry the custody the COUNT happened to name.
-- That is not a statement about who is answerable for the gap: between two
-- counts a shelf can cross boundaries nobody verified, or change hands
-- entirely. `attribution` makes the verdict explicit and stores it once, at
-- open time, so no reader re-infers it later from columns that have moved on.
--
-- Additive throughout. Every existing row takes `NOT_APPLICABLE`, which is
-- the truthful answer for a CASH, TENDER or OPENING_EXCEPTION case and for
-- every stock case opened before handover accountability existed. Nothing is
-- backfilled: inventing a verdict for a span nobody recorded would be a
-- statement nobody made.
--
-- `StockVarianceSpan.fromBoundaryId` and `toBoundaryId` are deliberately
-- plain columns, not foreign keys. Boundaries cascade away with their
-- handover, and `VarianceCase.acceptedHandoverId` is SET NULL precisely so
-- the case survives that deletion; a RESTRICT would contradict it, and a
-- CASCADE would delete the span out from under a case that still exists.

-- CreateEnum
CREATE TYPE "VarianceAttribution" AS ENUM ('VERIFIED_SHIFT', 'PERIOD_UNRESOLVED', 'BRANCH_CUSTODY', 'NOT_APPLICABLE');

-- AlterTable
ALTER TABLE "VarianceCase" ADD COLUMN     "acceptedHandoverId" TEXT,
ADD COLUMN     "attribution" "VarianceAttribution" NOT NULL DEFAULT 'NOT_APPLICABLE';

-- CreateTable
CREATE TABLE "StockVarianceSpan" (
    "id" TEXT NOT NULL,
    "varianceCaseId" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "fromBoundaryId" TEXT,
    "fromVerifiedAt" TIMESTAMP(3),
    "toBoundaryId" TEXT NOT NULL,
    "toVerifiedAt" TIMESTAMP(3) NOT NULL,
    "unverifiedBoundaryCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockVarianceSpan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockVarianceSpanCustody" (
    "id" TEXT NOT NULL,
    "spanId" TEXT NOT NULL,
    "custodyPeriodId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockVarianceSpanCustody_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StockVarianceSpan_varianceCaseId_key" ON "StockVarianceSpan"("varianceCaseId");

-- CreateIndex
CREATE INDEX "StockVarianceSpan_inventoryItemId_idx" ON "StockVarianceSpan"("inventoryItemId");

-- CreateIndex
CREATE INDEX "StockVarianceSpan_toBoundaryId_idx" ON "StockVarianceSpan"("toBoundaryId");

-- CreateIndex
CREATE INDEX "StockVarianceSpanCustody_custodyPeriodId_idx" ON "StockVarianceSpanCustody"("custodyPeriodId");

-- CreateIndex
CREATE UNIQUE INDEX "StockVarianceSpanCustody_spanId_custodyPeriodId_key" ON "StockVarianceSpanCustody"("spanId", "custodyPeriodId");

-- CreateIndex
CREATE INDEX "VarianceCase_acceptedHandoverId_idx" ON "VarianceCase"("acceptedHandoverId");

-- AddForeignKey
ALTER TABLE "VarianceCase" ADD CONSTRAINT "VarianceCase_acceptedHandoverId_fkey" FOREIGN KEY ("acceptedHandoverId") REFERENCES "HandoverSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockVarianceSpan" ADD CONSTRAINT "StockVarianceSpan_varianceCaseId_fkey" FOREIGN KEY ("varianceCaseId") REFERENCES "VarianceCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockVarianceSpan" ADD CONSTRAINT "StockVarianceSpan_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockVarianceSpanCustody" ADD CONSTRAINT "StockVarianceSpanCustody_spanId_fkey" FOREIGN KEY ("spanId") REFERENCES "StockVarianceSpan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockVarianceSpanCustody" ADD CONSTRAINT "StockVarianceSpanCustody_custodyPeriodId_fkey" FOREIGN KEY ("custodyPeriodId") REFERENCES "CustodyPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
