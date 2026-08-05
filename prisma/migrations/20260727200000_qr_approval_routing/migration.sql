-- QR menu order approval routing settings.

-- CreateEnum
CREATE TYPE "QrApprovalMode" AS ENUM ('AUTO_CONFIRM', 'ROLE_BASED', 'SPECIFIC_USER', 'ANY_AUTHORIZED_USER', 'CASHIER_DIRECT', 'WAITER_APPROVAL', 'MANAGER_APPROVAL', 'KITCHEN_DIRECT');
CREATE TYPE "ApprovalStatus" AS ENUM ('NOT_REQUIRED', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "Order"
  ADD COLUMN "approvalStatus" "ApprovalStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
  ADD COLUMN "approvalModeSnapshot" "QrApprovalMode",
  ADD COLUMN "assignedApproverRole" "Role",
  ADD COLUMN "assignedApproverUserId" TEXT;

-- CreateTable
CREATE TABLE "QrOrderApprovalSettings" (
    "id" TEXT NOT NULL,
    "cafeId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "approvalMode" "QrApprovalMode" NOT NULL DEFAULT 'ANY_AUTHORIZED_USER',
    "targetRole" "Role",
    "targetUserId" TEXT,
    "autoConfirm" BOOLEAN NOT NULL DEFAULT false,
    "allowApproverToEditOrder" BOOLEAN NOT NULL DEFAULT true,
    "allowApproverToRejectOrder" BOOLEAN NOT NULL DEFAULT true,
    "sendToKitchenAfterApproval" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QrOrderApprovalSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "QrOrderApprovalSettings_branchId_key" ON "QrOrderApprovalSettings"("branchId");
CREATE INDEX "QrOrderApprovalSettings_cafeId_idx" ON "QrOrderApprovalSettings"("cafeId");
CREATE INDEX "Order_branchId_approvalStatus_idx" ON "Order"("branchId", "approvalStatus");
CREATE INDEX "Order_assignedApproverUserId_idx" ON "Order"("assignedApproverUserId");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_assignedApproverUserId_fkey" FOREIGN KEY ("assignedApproverUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "QrOrderApprovalSettings" ADD CONSTRAINT "QrOrderApprovalSettings_cafeId_fkey" FOREIGN KEY ("cafeId") REFERENCES "Cafe"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QrOrderApprovalSettings" ADD CONSTRAINT "QrOrderApprovalSettings_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QrOrderApprovalSettings" ADD CONSTRAINT "QrOrderApprovalSettings_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
