-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OwnerAction" ADD VALUE 'AMEND_ORDER_REFUND';
ALTER TYPE "OwnerAction" ADD VALUE 'AMEND_ORDER_VOID';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "activeAmendmentId" TEXT,
ADD COLUMN     "invoiceDiscountType" TEXT,
ADD COLUMN     "invoiceDiscountValue" DECIMAL(12,2),
ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "saleShiftId" TEXT;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "invoiceDiscountShare" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "itemDiscountAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "itemDiscountType" TEXT NOT NULL DEFAULT 'NONE',
ADD COLUMN     "itemDiscountValue" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "amendmentId" TEXT,
ADD COLUMN     "amendmentLegKey" TEXT;

-- AlterTable
ALTER TABLE "OwnerActionRequest" ADD COLUMN     "targetAmendmentId" TEXT;

-- CreateTable
CREATE TABLE "OrderRevision" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "amendmentId" TEXT NOT NULL,
    "cafeId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "approverId" TEXT,
    "originalCashierId" TEXT,
    "originalShiftId" TEXT,
    "postingShiftId" TEXT,
    "reason" TEXT NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "oldTotal" DECIMAL(12,2) NOT NULL,
    "newTotal" DECIMAL(12,2) NOT NULL,
    "discountDelta" DECIMAL(12,2) NOT NULL,
    "recognizedDelta" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderAmendment" (
    "id" TEXT NOT NULL,
    "cafeId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "baseRevision" INTEGER NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "before" JSONB NOT NULL,
    "proposed" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'READY',
    "approvalRequired" BOOLEAN NOT NULL DEFAULT false,
    "ownerApprovalRequired" BOOLEAN NOT NULL DEFAULT false,
    "approverId" TEXT,
    "approvalSettingsVersion" INTEGER,
    "ownerRequestId" TEXT,
    "ownerVoidRequestId" TEXT,
    "originalShiftId" TEXT,
    "originalShiftClosed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderAmendment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AmendmentSettlement" (
    "id" TEXT NOT NULL,
    "amendmentId" TEXT NOT NULL,
    "cafeId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "legs" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "evidence" JSONB,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "observedAt" TIMESTAMP(3),

    CONSTRAINT "AmendmentSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesDiscountLimit" (
    "userId" TEXT NOT NULL,
    "cafeId" TEXT NOT NULL,
    "maxPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "maxAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "updatedById" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesDiscountLimit_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "OrderTrace" (
    "id" TEXT NOT NULL,
    "cafeId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "amendmentId" TEXT,
    "revision" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "originalCashierId" TEXT,
    "approverId" TEXT,
    "shiftId" TEXT,
    "reason" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderTrace_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrderRevision_amendmentId_key" ON "OrderRevision"("amendmentId");

-- CreateIndex
CREATE INDEX "OrderRevision_cafeId_branchId_createdAt_idx" ON "OrderRevision"("cafeId", "branchId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OrderRevision_orderId_number_key" ON "OrderRevision"("orderId", "number");

-- CreateIndex
CREATE INDEX "OrderAmendment_cafeId_branchId_orderId_createdAt_idx" ON "OrderAmendment"("cafeId", "branchId", "orderId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OrderAmendment_cafeId_requesterId_requestKey_key" ON "OrderAmendment"("cafeId", "requesterId", "requestKey");

-- CreateIndex
CREATE INDEX "AmendmentSettlement_amendmentId_status_idx" ON "AmendmentSettlement"("amendmentId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AmendmentSettlement_amendmentId_requestKey_key" ON "AmendmentSettlement"("amendmentId", "requestKey");

-- CreateIndex
CREATE INDEX "SalesDiscountLimit_cafeId_idx" ON "SalesDiscountLimit"("cafeId");

-- CreateIndex
CREATE INDEX "OrderTrace_cafeId_branchId_createdAt_idx" ON "OrderTrace"("cafeId", "branchId", "createdAt");

-- CreateIndex
CREATE INDEX "OrderTrace_orderId_createdAt_idx" ON "OrderTrace"("orderId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_amendmentLegKey_key" ON "Payment"("amendmentLegKey");

-- AddForeignKey
ALTER TABLE "OrderRevision" ADD CONSTRAINT "OrderRevision_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "OrderAmendment" ADD CONSTRAINT "OrderAmendment_order_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT;
ALTER TABLE "OrderTrace" ADD CONSTRAINT "OrderTrace_order_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT;
ALTER TABLE "AmendmentSettlement" ADD CONSTRAINT "AmendmentSettlement_amendment_fkey" FOREIGN KEY ("amendmentId") REFERENCES "OrderAmendment"("id") ON DELETE RESTRICT;
ALTER TABLE "SalesDiscountLimit" ADD CONSTRAINT "SalesDiscountLimit_user_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT;
ALTER TABLE "SalesDiscountLimit" ADD CONSTRAINT "SalesDiscountLimit_range" CHECK ("maxPercent" BETWEEN 0 AND 100 AND "maxAmount" >= 0);
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_discount_range" CHECK ("itemDiscountValue" >= 0 AND "itemDiscountAmount" >= 0 AND "invoiceDiscountShare" >= 0 AND "itemDiscountType" IN ('NONE','PERCENT','FIXED') AND ("itemDiscountType" <> 'PERCENT' OR "itemDiscountValue" <= 100));
ALTER TABLE "OrderAmendment" ADD CONSTRAINT "OrderAmendment_status_check" CHECK ("status" IN ('READY','PENDING_APPROVAL','SETTLING','COMMITTED','CANCELLED'));
ALTER TABLE "AmendmentSettlement" ADD CONSTRAINT "AmendmentSettlement_check" CHECK ("amount" > 0 AND "direction" IN ('COLLECTION','REFUND') AND "status" IN ('PENDING','OBSERVED','CONFIRMED','FAILED','UNKNOWN'));

CREATE FUNCTION nextcup_sales_evidence_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Sales revision and tracing evidence is append-only' USING ERRCODE='23514'; END;
$$;
CREATE TRIGGER "OrderRevision_immutable" BEFORE UPDATE OR DELETE ON "OrderRevision" FOR EACH ROW EXECUTE FUNCTION nextcup_sales_evidence_immutable();
CREATE TRIGGER "OrderTrace_immutable" BEFORE UPDATE OR DELETE ON "OrderTrace" FOR EACH ROW EXECUTE FUNCTION nextcup_sales_evidence_immutable();

