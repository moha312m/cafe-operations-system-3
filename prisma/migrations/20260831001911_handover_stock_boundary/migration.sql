-- M19 — the handover stock boundary.
--
-- Additive only. No historical row is read, rewritten or removed: a boundary
-- is written forward by an acceptance, never backfilled onto handovers that
-- closed before this table existed.
--
-- There is deliberately no variance column and no actor column. An
-- unverified row carries the book figure for an item nobody counted, and it
-- must have nowhere to record a difference it cannot know or a person it
-- cannot name.

-- CreateEnum
CREATE TYPE "BoundarySource" AS ENUM ('PHYSICAL_COUNT', 'SYSTEM_CARRIED');

-- CreateTable
CREATE TABLE "HandoverStockBoundary" (
    "id" TEXT NOT NULL,
    "handoverId" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "source" "BoundarySource" NOT NULL,
    "verified" BOOLEAN NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "itemVersion" BIGINT NOT NULL,
    "stockCountLineId" TEXT,
    "unitCostSnapshot" DECIMAL(12,2),
    "unitCostSource" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HandoverStockBoundary_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HandoverStockBoundary_handoverId_idx" ON "HandoverStockBoundary"("handoverId");

-- CreateIndex
CREATE INDEX "HandoverStockBoundary_inventoryItemId_idx" ON "HandoverStockBoundary"("inventoryItemId");

-- CreateIndex
CREATE INDEX "HandoverStockBoundary_stockCountLineId_idx" ON "HandoverStockBoundary"("stockCountLineId");

-- CreateIndex
-- One boundary per handover per item: a second row would be a second answer
-- to one question, and is refused by the database rather than by convention.
CREATE UNIQUE INDEX "HandoverStockBoundary_handoverId_inventoryItemId_key" ON "HandoverStockBoundary"("handoverId", "inventoryItemId");

-- AddForeignKey
ALTER TABLE "HandoverStockBoundary" ADD CONSTRAINT "HandoverStockBoundary_handoverId_fkey" FOREIGN KEY ("handoverId") REFERENCES "HandoverSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- Restrict on both evidence references: a boundary is a statement about a
-- specific ingredient and a specific observation, and is unreadable once
-- either of them is gone.
ALTER TABLE "HandoverStockBoundary" ADD CONSTRAINT "HandoverStockBoundary_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HandoverStockBoundary" ADD CONSTRAINT "HandoverStockBoundary_stockCountLineId_fkey" FOREIGN KEY ("stockCountLineId") REFERENCES "StockCountLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
