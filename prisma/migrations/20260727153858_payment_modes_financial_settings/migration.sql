-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "paidAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'UNPAID',
ADD COLUMN     "remainingAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "serviceChargeAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "serviceRateSnapshot" DECIMAL(10,2),
ADD COLUMN     "taxRateSnapshot" DECIMAL(5,2);

-- CreateTable
CREATE TABLE "BranchFinancialSettings" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "cafeId" TEXT NOT NULL,
    "taxEnabled" BOOLEAN NOT NULL DEFAULT false,
    "taxRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "applyTaxTo" "ChargeApplicationScope" NOT NULL DEFAULT 'ALL_ORDERS',
    "serviceChargeEnabled" BOOLEAN NOT NULL DEFAULT false,
    "serviceChargeType" "ServiceChargeType" NOT NULL DEFAULT 'PERCENTAGE',
    "serviceChargeRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "serviceChargeFixedAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "applyServiceTo" "ChargeApplicationScope" NOT NULL DEFAULT 'DINE_IN_ONLY',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BranchFinancialSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BranchFinancialSettings_branchId_key" ON "BranchFinancialSettings"("branchId");
CREATE INDEX "BranchFinancialSettings_cafeId_idx" ON "BranchFinancialSettings"("cafeId");

-- AddForeignKey
ALTER TABLE "BranchFinancialSettings" ADD CONSTRAINT "BranchFinancialSettings_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
