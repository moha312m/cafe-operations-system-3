-- Orders served while a stock handover froze the branch: the recipe is
-- deducted when the freeze is released. Additive only: one new table.

-- CreateTable
CREATE TABLE "DeferredStockDeduction" (
    "id" TEXT NOT NULL,
    "cafeId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "freezeId" TEXT NOT NULL,
    "handoverId" TEXT NOT NULL,
    "servedById" TEXT,
    "servedAt" TIMESTAMP(3) NOT NULL,
    "appliedAt" TIMESTAMP(3),
    "appliedCustodyPeriodId" TEXT,
    "appliedShiftId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeferredStockDeduction_pkey" PRIMARY KEY ("id"),
    -- Applied means it landed somewhere: never an applied row with no custody.
    CONSTRAINT "DeferredStockDeduction_applied_has_custody" CHECK (
        "appliedAt" IS NULL OR "appliedCustodyPeriodId" IS NOT NULL
    )
);

-- CreateIndex
CREATE UNIQUE INDEX "DeferredStockDeduction_orderId_key" ON "DeferredStockDeduction"("orderId");

-- CreateIndex
CREATE INDEX "DeferredStockDeduction_handoverId_appliedAt_idx" ON "DeferredStockDeduction"("handoverId", "appliedAt");

-- CreateIndex
CREATE INDEX "DeferredStockDeduction_branchId_appliedAt_idx" ON "DeferredStockDeduction"("branchId", "appliedAt");

-- AddForeignKey
ALTER TABLE "DeferredStockDeduction" ADD CONSTRAINT "DeferredStockDeduction_cafeId_fkey" FOREIGN KEY ("cafeId") REFERENCES "Cafe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeferredStockDeduction" ADD CONSTRAINT "DeferredStockDeduction_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeferredStockDeduction" ADD CONSTRAINT "DeferredStockDeduction_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
