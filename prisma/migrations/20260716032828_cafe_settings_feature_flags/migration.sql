-- CreateEnum
CREATE TYPE "CafeWorkflowMode" AS ENUM ('FULL_SERVICE', 'SMALL_CAFE', 'TAKEAWAY_ONLY', 'RESTAURANT');

-- CreateEnum
CREATE TYPE "QrOrderRoutingMode" AS ENUM ('WAITER_APPROVAL', 'CASHIER_DIRECT', 'KITCHEN_DIRECT', 'AUTO_CONFIRMED');

-- CreateTable
CREATE TABLE "CafeSettings" (
    "id" TEXT NOT NULL,
    "cafeId" TEXT NOT NULL,
    "workflowMode" "CafeWorkflowMode" NOT NULL DEFAULT 'FULL_SERVICE',
    "qrOrderRoutingMode" "QrOrderRoutingMode" NOT NULL DEFAULT 'WAITER_APPROVAL',
    "aiAssistantEnabled" BOOLEAN NOT NULL DEFAULT false,
    "qrMenuEnabled" BOOLEAN NOT NULL DEFAULT true,
    "waiterApprovalEnabled" BOOLEAN NOT NULL DEFAULT true,
    "kitchenScreenEnabled" BOOLEAN NOT NULL DEFAULT true,
    "inventoryEnabled" BOOLEAN NOT NULL DEFAULT true,
    "shiftManagementEnabled" BOOLEAN NOT NULL DEFAULT true,
    "advancedReportsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "excelImportEnabled" BOOLEAN NOT NULL DEFAULT true,
    "recipeCostingEnabled" BOOLEAN NOT NULL DEFAULT true,
    "staffManagementEnabled" BOOLEAN NOT NULL DEFAULT true,
    "branchManagementEnabled" BOOLEAN NOT NULL DEFAULT true,
    "requireShiftForQrOrders" BOOLEAN NOT NULL DEFAULT false,
    "allowCashierToPrepareOrders" BOOLEAN NOT NULL DEFAULT false,
    "allowCashierToServeOrders" BOOLEAN NOT NULL DEFAULT false,
    "enableTables" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CafeSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CafeSettings_cafeId_key" ON "CafeSettings"("cafeId");

-- AddForeignKey
ALTER TABLE "CafeSettings" ADD CONSTRAINT "CafeSettings_cafeId_fkey" FOREIGN KEY ("cafeId") REFERENCES "Cafe"("id") ON DELETE CASCADE ON UPDATE CASCADE;
