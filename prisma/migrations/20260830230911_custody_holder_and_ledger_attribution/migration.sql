-- CreateEnum
CREATE TYPE "CustodyHolderType" AS ENUM ('USER', 'BRANCH');

-- AlterTable
ALTER TABLE "CustodyPeriod"
  ADD COLUMN "holderType" "CustodyHolderType" NOT NULL DEFAULT 'USER',
  ADD COLUMN "openedById" TEXT,
  ADD COLUMN "acceptedById" TEXT,
  ADD COLUMN "acceptedAt" TIMESTAMP(3),
  ADD COLUMN "responsibleShiftId" TEXT;

-- AlterTable
ALTER TABLE "InventoryTransaction"
  ADD COLUMN "custodyPeriodId" TEXT,
  ADD COLUMN "shiftId" TEXT;

-- CreateIndex
CREATE INDEX "CustodyPeriod_branchId_holderType_status_idx" ON "CustodyPeriod"("branchId", "holderType", "status");

-- CreateIndex
CREATE INDEX "CustodyPeriod_responsibleShiftId_idx" ON "CustodyPeriod"("responsibleShiftId");

-- CreateIndex
CREATE INDEX "InventoryTransaction_custodyPeriodId_type_idx" ON "InventoryTransaction"("custodyPeriodId", "type");

-- CreateIndex
CREATE INDEX "InventoryTransaction_shiftId_idx" ON "InventoryTransaction"("shiftId");

-- AddForeignKey
ALTER TABLE "CustodyPeriod" ADD CONSTRAINT "CustodyPeriod_openedById_fkey" FOREIGN KEY ("openedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustodyPeriod" ADD CONSTRAINT "CustodyPeriod_acceptedById_fkey" FOREIGN KEY ("acceptedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustodyPeriod" ADD CONSTRAINT "CustodyPeriod_responsibleShiftId_fkey" FOREIGN KEY ("responsibleShiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryTransaction" ADD CONSTRAINT "InventoryTransaction_custodyPeriodId_fkey" FOREIGN KEY ("custodyPeriodId") REFERENCES "CustodyPeriod"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryTransaction" ADD CONSTRAINT "InventoryTransaction_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;
