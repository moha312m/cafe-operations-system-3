-- Module 7: Cashier Shifts, Payments & Daily Closing
-- Safe, additive migration. Existing orders/payments keep working.

-- CreateEnum
CREATE TYPE "ShiftStatus" AS ENUM ('OPEN', 'CLOSED');

-- AlterEnum: PaymentMethod — rename MOBILE_WALLET -> WALLET (preserves the 9
-- existing rows) and add MIXED. Non-destructive: keeps the same enum type OID.
ALTER TYPE "PaymentMethod" RENAME VALUE 'MOBILE_WALLET' TO 'WALLET';
ALTER TYPE "PaymentMethod" ADD VALUE 'MIXED';

-- AlterEnum: PaymentStatus — add PARTIAL, CANCELLED
ALTER TYPE "PaymentStatus" ADD VALUE 'PARTIAL';
ALTER TYPE "PaymentStatus" ADD VALUE 'CANCELLED';

-- AlterTable: Payment — new columns are nullable / defaulted so existing rows
-- stay valid (no NOT-NULL-without-default failures).
ALTER TABLE "Payment"
  ADD COLUMN "branchId"  TEXT,
  ADD COLUMN "cashierId" TEXT,
  ADD COLUMN "shiftId"   TEXT,
  ADD COLUMN "paidAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill existing payments from their order / receiver.
UPDATE "Payment" p
SET "branchId"  = o."branchId",
    "cashierId" = p."receivedById",
    "paidAt"    = p."createdAt",
    "updatedAt" = p."createdAt"
FROM "Order" o
WHERE o."id" = p."orderId";

-- CreateTable: Shift
CREATE TABLE "Shift" (
    "id" TEXT NOT NULL,
    "cafeId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "cashierId" TEXT NOT NULL,
    "shiftNumber" INTEGER NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "openingCashAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "expectedCashAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "actualCashAmount" DECIMAL(10,2),
    "cashDifference" DECIMAL(10,2),
    "totalSales" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "totalCashSales" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "totalCardSales" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "totalWalletSales" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "totalRefunds" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "totalDiscounts" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "orderCount" INTEGER NOT NULL DEFAULT 0,
    "status" "ShiftStatus" NOT NULL DEFAULT 'OPEN',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shift_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Shift_cafeId_idx" ON "Shift"("cafeId");
CREATE INDEX "Shift_branchId_idx" ON "Shift"("branchId");
CREATE INDEX "Shift_cashierId_idx" ON "Shift"("cashierId");
CREATE INDEX "Shift_status_idx" ON "Shift"("status");
CREATE INDEX "Shift_openedAt_idx" ON "Shift"("openedAt");
CREATE INDEX "Shift_closedAt_idx" ON "Shift"("closedAt");
CREATE INDEX "Shift_branchId_status_idx" ON "Shift"("branchId", "status");
CREATE UNIQUE INDEX "Shift_branchId_shiftNumber_key" ON "Shift"("branchId", "shiftNumber");

CREATE INDEX "Payment_branchId_idx" ON "Payment"("branchId");
CREATE INDEX "Payment_shiftId_idx" ON "Payment"("shiftId");
CREATE INDEX "Payment_cashierId_idx" ON "Payment"("cashierId");
CREATE INDEX "Payment_method_idx" ON "Payment"("method");
CREATE INDEX "Payment_status_idx" ON "Payment"("status");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_cafeId_fkey" FOREIGN KEY ("cafeId") REFERENCES "Cafe"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_cashierId_fkey" FOREIGN KEY ("cashierId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
