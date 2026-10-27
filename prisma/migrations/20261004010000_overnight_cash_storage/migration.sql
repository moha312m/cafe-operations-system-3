-- CreateEnum
CREATE TYPE "OpeningCashReceiptStatus" AS ENUM ('PENDING', 'DISPUTED', 'DEFERRED', 'ACCEPTED', 'OVERRIDDEN');

-- CreateTable
CREATE TABLE "BranchOpeningSettings" (
    "branchId" TEXT NOT NULL,
    "cafeId" TEXT NOT NULL,
    "overnightCashEnabled" BOOLEAN NOT NULL DEFAULT false,
    "drawerLabel" TEXT NOT NULL DEFAULT 'Main drawer',
    "placeAcceptanceRequired" BOOLEAN NOT NULL DEFAULT false,
    "updatedById" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BranchOpeningSettings_pkey" PRIMARY KEY ("branchId")
);

-- CreateTable
CREATE TABLE "CashStorage" (
    "id" TEXT NOT NULL,
    "cafeId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "outgoingShiftId" TEXT NOT NULL,
    "handoverId" TEXT NOT NULL,
    "closingAmount" DECIMAL(10,2) NOT NULL,
    "leftInDrawer" DECIMAL(10,2) NOT NULL,
    "toTreasury" DECIMAL(10,2) NOT NULL,
    "drawerLabel" TEXT NOT NULL,
    "note" TEXT,
    "declaredById" TEXT NOT NULL,
    "declaredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashStorage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashStorageMovement" (
    "id" TEXT NOT NULL,
    "cafeId" TEXT NOT NULL,
    "storageId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "counterparty" TEXT NOT NULL DEFAULT 'TREASURY',
    "actorId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashStorageMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpeningCashReceipt" (
    "id" TEXT NOT NULL,
    "cafeId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "storageId" TEXT NOT NULL,
    "incomingShiftId" TEXT NOT NULL,
    "claimantId" TEXT NOT NULL,
    "status" "OpeningCashReceiptStatus" NOT NULL DEFAULT 'PENDING',
    "expectedAmount" DECIMAL(10,2) NOT NULL,
    "actualAmount" DECIMAL(10,2),
    "varianceAmount" DECIMAL(10,2),
    "verifiedById" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "idempotencyKey" TEXT,
    "acceptanceFingerprint" TEXT,
    "openingExceptionId" TEXT,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpeningCashReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpeningCashReceiptEvent" (
    "id" TEXT NOT NULL,
    "cafeId" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "note" TEXT,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpeningCashReceiptEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BranchOpeningSettings_cafeId_idx" ON "BranchOpeningSettings"("cafeId");

-- CreateIndex
CREATE INDEX "BranchOpeningSettings_updatedById_idx" ON "BranchOpeningSettings"("updatedById");

-- CreateIndex
CREATE UNIQUE INDEX "CashStorage_outgoingShiftId_key" ON "CashStorage"("outgoingShiftId");

-- CreateIndex
CREATE UNIQUE INDEX "CashStorage_handoverId_key" ON "CashStorage"("handoverId");

-- CreateIndex
CREATE INDEX "CashStorage_cafeId_branchId_declaredAt_idx" ON "CashStorage"("cafeId", "branchId", "declaredAt");

-- CreateIndex
CREATE INDEX "CashStorage_branchId_declaredAt_idx" ON "CashStorage"("branchId", "declaredAt");

-- CreateIndex
CREATE INDEX "CashStorage_declaredById_idx" ON "CashStorage"("declaredById");

-- CreateIndex
CREATE INDEX "CashStorageMovement_cafeId_createdAt_idx" ON "CashStorageMovement"("cafeId", "createdAt");

-- CreateIndex
CREATE INDEX "CashStorageMovement_actorId_idx" ON "CashStorageMovement"("actorId");

-- CreateIndex
CREATE UNIQUE INDEX "CashStorageMovement_storageId_idempotencyKey_key" ON "CashStorageMovement"("storageId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "OpeningCashReceipt_storageId_key" ON "OpeningCashReceipt"("storageId");

-- CreateIndex
CREATE UNIQUE INDEX "OpeningCashReceipt_incomingShiftId_key" ON "OpeningCashReceipt"("incomingShiftId");

-- CreateIndex
CREATE UNIQUE INDEX "OpeningCashReceipt_openingExceptionId_key" ON "OpeningCashReceipt"("openingExceptionId");

-- CreateIndex
CREATE INDEX "OpeningCashReceipt_cafeId_branchId_claimedAt_idx" ON "OpeningCashReceipt"("cafeId", "branchId", "claimedAt");

-- CreateIndex
CREATE INDEX "OpeningCashReceipt_branchId_status_idx" ON "OpeningCashReceipt"("branchId", "status");

-- CreateIndex
CREATE INDEX "OpeningCashReceipt_claimantId_idx" ON "OpeningCashReceipt"("claimantId");

-- CreateIndex
CREATE INDEX "OpeningCashReceipt_verifiedById_idx" ON "OpeningCashReceipt"("verifiedById");

-- CreateIndex
CREATE INDEX "OpeningCashReceiptEvent_receiptId_createdAt_idx" ON "OpeningCashReceiptEvent"("receiptId", "createdAt");

-- CreateIndex
CREATE INDEX "OpeningCashReceiptEvent_cafeId_createdAt_idx" ON "OpeningCashReceiptEvent"("cafeId", "createdAt");

-- CreateIndex
CREATE INDEX "OpeningCashReceiptEvent_actorId_idx" ON "OpeningCashReceiptEvent"("actorId");

-- AddForeignKey
ALTER TABLE "BranchOpeningSettings" ADD CONSTRAINT "BranchOpeningSettings_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchOpeningSettings" ADD CONSTRAINT "BranchOpeningSettings_cafeId_fkey" FOREIGN KEY ("cafeId") REFERENCES "Cafe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchOpeningSettings" ADD CONSTRAINT "BranchOpeningSettings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashStorage" ADD CONSTRAINT "CashStorage_cafeId_fkey" FOREIGN KEY ("cafeId") REFERENCES "Cafe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashStorage" ADD CONSTRAINT "CashStorage_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashStorage" ADD CONSTRAINT "CashStorage_outgoingShiftId_fkey" FOREIGN KEY ("outgoingShiftId") REFERENCES "Shift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashStorage" ADD CONSTRAINT "CashStorage_handoverId_fkey" FOREIGN KEY ("handoverId") REFERENCES "HandoverSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashStorage" ADD CONSTRAINT "CashStorage_declaredById_fkey" FOREIGN KEY ("declaredById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashStorageMovement" ADD CONSTRAINT "CashStorageMovement_cafeId_fkey" FOREIGN KEY ("cafeId") REFERENCES "Cafe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashStorageMovement" ADD CONSTRAINT "CashStorageMovement_storageId_fkey" FOREIGN KEY ("storageId") REFERENCES "CashStorage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashStorageMovement" ADD CONSTRAINT "CashStorageMovement_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpeningCashReceipt" ADD CONSTRAINT "OpeningCashReceipt_cafeId_fkey" FOREIGN KEY ("cafeId") REFERENCES "Cafe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpeningCashReceipt" ADD CONSTRAINT "OpeningCashReceipt_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpeningCashReceipt" ADD CONSTRAINT "OpeningCashReceipt_storageId_fkey" FOREIGN KEY ("storageId") REFERENCES "CashStorage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpeningCashReceipt" ADD CONSTRAINT "OpeningCashReceipt_incomingShiftId_fkey" FOREIGN KEY ("incomingShiftId") REFERENCES "Shift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpeningCashReceipt" ADD CONSTRAINT "OpeningCashReceipt_claimantId_fkey" FOREIGN KEY ("claimantId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpeningCashReceipt" ADD CONSTRAINT "OpeningCashReceipt_verifiedById_fkey" FOREIGN KEY ("verifiedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpeningCashReceipt" ADD CONSTRAINT "OpeningCashReceipt_openingExceptionId_fkey" FOREIGN KEY ("openingExceptionId") REFERENCES "OpeningException"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpeningCashReceiptEvent" ADD CONSTRAINT "OpeningCashReceiptEvent_cafeId_fkey" FOREIGN KEY ("cafeId") REFERENCES "Cafe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpeningCashReceiptEvent" ADD CONSTRAINT "OpeningCashReceiptEvent_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "OpeningCashReceipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpeningCashReceiptEvent" ADD CONSTRAINT "OpeningCashReceiptEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "CashStorage" ADD CONSTRAINT "CashStorage_allocation_check" CHECK ("closingAmount" >= 0 AND "leftInDrawer" >= 0 AND "toTreasury" >= 0 AND "closingAmount" = "leftInDrawer" + "toTreasury");
ALTER TABLE "CashStorageMovement" ADD CONSTRAINT "CashStorageMovement_amount_check" CHECK ("amount" <> 0 AND "counterparty" = 'TREASURY' AND length(trim("reason")) > 0);
ALTER TABLE "OpeningCashReceipt" ADD CONSTRAINT "OpeningCashReceipt_amount_check" CHECK ("expectedAmount" >= 0 AND ("actualAmount" IS NULL OR "actualAmount" >= 0));
ALTER TABLE "OpeningCashReceipt" ADD CONSTRAINT "OpeningCashReceipt_acceptance_check" CHECK (("status" IN ('ACCEPTED','OVERRIDDEN')) = ("acceptedAt" IS NOT NULL AND "actualAmount" IS NOT NULL AND "verifiedById" IS NOT NULL));
