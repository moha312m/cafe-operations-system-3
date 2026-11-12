-- Stock handover v2 (owner decision 2026-11-12): count and report, never block.
-- Additive only: six new tables and four enums. Nothing existing is altered.

-- CreateEnum
CREATE TYPE "StockHandoverReviewStatus" AS ENUM ('OPEN', 'IN_REVIEW', 'REVIEWED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "StockHandoverClassification" AS ENUM ('UNCLASSIFIED', 'EXPLAINED_BY_MOVEMENTS', 'COUNT_ERROR', 'UNRECORDED_USAGE', 'WASTE_OR_DAMAGE', 'RECEIVING_OR_TRANSFER', 'LOSS_UNEXPLAINED', 'OTHER');

-- CreateEnum
CREATE TYPE "StockComparisonReliability" AS ENUM ('CONFIRMED', 'PROVISIONAL', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "NotificationKind" AS ENUM ('STOCK_HANDOVER_DISCREPANCY', 'STOCK_HANDOVER_MISSING_COUNT');

-- CreateTable
CREATE TABLE "StockHandoverIncomingCount" (
    "id" TEXT NOT NULL,
    "cafeId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "handoverId" TEXT NOT NULL,
    "shiftId" TEXT,
    "counterId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockHandoverIncomingCount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockHandoverIncomingLine" (
    "id" TEXT NOT NULL,
    "countId" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "unit" "InventoryUnit" NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "countedAt" TIMESTAMP(3) NOT NULL,
    "itemVersion" BIGINT NOT NULL,
    "counterId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "reason" VARCHAR(500),
    "idempotencyKey" VARCHAR(200) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockHandoverIncomingLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockHandoverComparison" (
    "id" TEXT NOT NULL,
    "cafeId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "handoverId" TEXT NOT NULL,
    "version" VARCHAR(64) NOT NULL,
    "reliability" "StockComparisonReliability" NOT NULL,
    "itemCount" INTEGER NOT NULL,
    "rawDifferenceCount" INTEGER NOT NULL,
    "adjustedDifferenceCount" INTEGER NOT NULL,
    "unavailableCount" INTEGER NOT NULL,
    "lines" JSONB NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockHandoverComparison_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockHandoverReview" (
    "id" TEXT NOT NULL,
    "cafeId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "handoverId" TEXT NOT NULL,
    "status" "StockHandoverReviewStatus" NOT NULL DEFAULT 'OPEN',
    "classification" "StockHandoverClassification" NOT NULL DEFAULT 'UNCLASSIFIED',
    "lastActorId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockHandoverReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockHandoverReviewNote" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "text" VARCHAR(2000) NOT NULL,
    "statusFrom" "StockHandoverReviewStatus",
    "statusTo" "StockHandoverReviewStatus",
    "classificationFrom" "StockHandoverClassification",
    "classificationTo" "StockHandoverClassification",
    "idempotencyKey" VARCHAR(200) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockHandoverReviewNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "cafeId" TEXT NOT NULL,
    "branchId" TEXT,
    "recipientId" TEXT NOT NULL,
    "kind" "NotificationKind" NOT NULL,
    "handoverId" TEXT,
    "comparisonId" TEXT,
    "dedupeKey" VARCHAR(300) NOT NULL,
    "title" VARCHAR(300) NOT NULL,
    "body" VARCHAR(2000) NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "deliveryAttempts" INTEGER NOT NULL DEFAULT 0,
    "readAt" TIMESTAMP(3),

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StockHandoverIncomingCount_handoverId_key" ON "StockHandoverIncomingCount"("handoverId");

-- CreateIndex
CREATE INDEX "StockHandoverIncomingCount_cafeId_branchId_startedAt_idx" ON "StockHandoverIncomingCount"("cafeId", "branchId", "startedAt");

-- CreateIndex
CREATE INDEX "StockHandoverIncomingLine_inventoryItemId_idx" ON "StockHandoverIncomingLine"("inventoryItemId");

-- CreateIndex
CREATE UNIQUE INDEX "StockHandoverIncomingLine_countId_inventoryItemId_revision_key" ON "StockHandoverIncomingLine"("countId", "inventoryItemId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "StockHandoverIncomingLine_countId_idempotencyKey_key" ON "StockHandoverIncomingLine"("countId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "StockHandoverComparison_cafeId_branchId_computedAt_idx" ON "StockHandoverComparison"("cafeId", "branchId", "computedAt");

-- CreateIndex
CREATE UNIQUE INDEX "StockHandoverComparison_handoverId_version_key" ON "StockHandoverComparison"("handoverId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "StockHandoverReview_handoverId_key" ON "StockHandoverReview"("handoverId");

-- CreateIndex
CREATE INDEX "StockHandoverReview_cafeId_status_createdAt_idx" ON "StockHandoverReview"("cafeId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "StockHandoverReview_branchId_status_idx" ON "StockHandoverReview"("branchId", "status");

-- CreateIndex
CREATE INDEX "StockHandoverReviewNote_reviewId_createdAt_idx" ON "StockHandoverReviewNote"("reviewId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "StockHandoverReviewNote_reviewId_idempotencyKey_key" ON "StockHandoverReviewNote"("reviewId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_dedupeKey_key" ON "Notification"("dedupeKey");

-- CreateIndex
CREATE INDEX "Notification_recipientId_readAt_createdAt_idx" ON "Notification"("recipientId", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_cafeId_kind_createdAt_idx" ON "Notification"("cafeId", "kind", "createdAt");

-- AddForeignKey
ALTER TABLE "StockHandoverIncomingCount" ADD CONSTRAINT "StockHandoverIncomingCount_cafeId_fkey" FOREIGN KEY ("cafeId") REFERENCES "Cafe"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockHandoverIncomingCount" ADD CONSTRAINT "StockHandoverIncomingCount_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockHandoverIncomingCount" ADD CONSTRAINT "StockHandoverIncomingCount_handoverId_fkey" FOREIGN KEY ("handoverId") REFERENCES "HandoverSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockHandoverIncomingCount" ADD CONSTRAINT "StockHandoverIncomingCount_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockHandoverIncomingCount" ADD CONSTRAINT "StockHandoverIncomingCount_counterId_fkey" FOREIGN KEY ("counterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockHandoverIncomingLine" ADD CONSTRAINT "StockHandoverIncomingLine_countId_fkey" FOREIGN KEY ("countId") REFERENCES "StockHandoverIncomingCount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockHandoverIncomingLine" ADD CONSTRAINT "StockHandoverIncomingLine_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockHandoverIncomingLine" ADD CONSTRAINT "StockHandoverIncomingLine_counterId_fkey" FOREIGN KEY ("counterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockHandoverComparison" ADD CONSTRAINT "StockHandoverComparison_cafeId_fkey" FOREIGN KEY ("cafeId") REFERENCES "Cafe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockHandoverComparison" ADD CONSTRAINT "StockHandoverComparison_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockHandoverComparison" ADD CONSTRAINT "StockHandoverComparison_handoverId_fkey" FOREIGN KEY ("handoverId") REFERENCES "HandoverSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockHandoverReview" ADD CONSTRAINT "StockHandoverReview_cafeId_fkey" FOREIGN KEY ("cafeId") REFERENCES "Cafe"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockHandoverReview" ADD CONSTRAINT "StockHandoverReview_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockHandoverReview" ADD CONSTRAINT "StockHandoverReview_handoverId_fkey" FOREIGN KEY ("handoverId") REFERENCES "HandoverSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockHandoverReview" ADD CONSTRAINT "StockHandoverReview_lastActorId_fkey" FOREIGN KEY ("lastActorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockHandoverReviewNote" ADD CONSTRAINT "StockHandoverReviewNote_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "StockHandoverReview"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockHandoverReviewNote" ADD CONSTRAINT "StockHandoverReviewNote_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_cafeId_fkey" FOREIGN KEY ("cafeId") REFERENCES "Cafe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_handoverId_fkey" FOREIGN KEY ("handoverId") REFERENCES "HandoverSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_comparisonId_fkey" FOREIGN KEY ("comparisonId") REFERENCES "StockHandoverComparison"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Observations and review notes are append-only: a correction is a new row.
CREATE FUNCTION "stock_handover_v2_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only; record a new revision or note instead', TG_TABLE_NAME USING ERRCODE = '23514';
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER "StockHandoverIncomingLine_append_only"
  BEFORE UPDATE ON "StockHandoverIncomingLine"
  FOR EACH ROW EXECUTE FUNCTION "stock_handover_v2_append_only"();

CREATE TRIGGER "StockHandoverReviewNote_append_only"
  BEFORE UPDATE ON "StockHandoverReviewNote"
  FOR EACH ROW EXECUTE FUNCTION "stock_handover_v2_append_only"();

-- A non-first revision must say why it corrects the earlier one.
ALTER TABLE "StockHandoverIncomingLine" ADD CONSTRAINT "StockHandoverIncomingLine_revision_reason_check"
  CHECK ("revision" >= 1 AND ("revision" = 1 OR ("reason" IS NOT NULL AND length(btrim("reason")) > 0)));
ALTER TABLE "StockHandoverIncomingLine" ADD CONSTRAINT "StockHandoverIncomingLine_quantity_check"
  CHECK ("quantity" >= 0);
