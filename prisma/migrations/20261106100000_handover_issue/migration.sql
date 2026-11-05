-- Direct handover: «الإبلاغ عن اختلاف». Additive only; no existing row is touched.

CREATE TYPE "HandoverIssueKind" AS ENUM ('CASH', 'STOCK_ITEM', 'OTHER');
CREATE TYPE "HandoverIssueStatus" AS ENUM ('OPEN', 'RESOLVED');

CREATE TABLE "HandoverIssue" (
  "id" TEXT NOT NULL,
  "cafeId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "handoverId" TEXT NOT NULL,
  "kind" "HandoverIssueKind" NOT NULL,
  "inventoryItemId" TEXT,
  "itemNameSnapshot" VARCHAR(200),
  "amount" DECIMAL(12,3),
  "description" VARCHAR(1000) NOT NULL,
  "afterAcceptance" BOOLEAN NOT NULL,
  "status" "HandoverIssueStatus" NOT NULL DEFAULT 'OPEN',
  "reportedById" TEXT NOT NULL,
  "reportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "idempotencyKey" VARCHAR(200) NOT NULL,
  "resolvedById" TEXT,
  "resolvedAt" TIMESTAMP(3),
  "resolutionNote" VARCHAR(1000),
  CONSTRAINT "HandoverIssue_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "HandoverIssue_description_check" CHECK (length(btrim("description")) > 0),
  CONSTRAINT "HandoverIssue_subject_check" CHECK (
    ("kind" = 'CASH' AND "amount" IS NOT NULL AND "amount" >= 0 AND "inventoryItemId" IS NULL)
    OR ("kind" = 'STOCK_ITEM' AND "inventoryItemId" IS NOT NULL)
    OR ("kind" = 'OTHER')
  ),
  CONSTRAINT "HandoverIssue_resolution_check" CHECK (
    ("status" = 'OPEN' AND "resolvedById" IS NULL AND "resolvedAt" IS NULL)
    OR ("status" = 'RESOLVED' AND "resolvedById" IS NOT NULL AND "resolvedAt" IS NOT NULL AND length(btrim("resolutionNote")) > 0)
  )
);

CREATE UNIQUE INDEX "HandoverIssue_handoverId_reportedById_idempotencyKey_key" ON "HandoverIssue"("handoverId", "reportedById", "idempotencyKey");
CREATE INDEX "HandoverIssue_cafeId_status_reportedAt_idx" ON "HandoverIssue"("cafeId", "status", "reportedAt");
CREATE INDEX "HandoverIssue_handoverId_idx" ON "HandoverIssue"("handoverId");

ALTER TABLE "HandoverIssue" ADD CONSTRAINT "HandoverIssue_cafeId_fkey" FOREIGN KEY ("cafeId") REFERENCES "Cafe"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HandoverIssue" ADD CONSTRAINT "HandoverIssue_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HandoverIssue" ADD CONSTRAINT "HandoverIssue_handoverId_fkey" FOREIGN KEY ("handoverId") REFERENCES "HandoverSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HandoverIssue" ADD CONSTRAINT "HandoverIssue_reportedById_fkey" FOREIGN KEY ("reportedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HandoverIssue" ADD CONSTRAINT "HandoverIssue_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A report is evidence: its subject and text never change, and it is never deleted.
CREATE FUNCTION "handover_issue_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A handover issue cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF NEW."cafeId" IS DISTINCT FROM OLD."cafeId" OR NEW."branchId" IS DISTINCT FROM OLD."branchId"
     OR NEW."handoverId" IS DISTINCT FROM OLD."handoverId" OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."inventoryItemId" IS DISTINCT FROM OLD."inventoryItemId" OR NEW."amount" IS DISTINCT FROM OLD."amount"
     OR NEW."description" IS DISTINCT FROM OLD."description" OR NEW."afterAcceptance" IS DISTINCT FROM OLD."afterAcceptance"
     OR NEW."reportedById" IS DISTINCT FROM OLD."reportedById" OR NEW."reportedAt" IS DISTINCT FROM OLD."reportedAt" THEN
    RAISE EXCEPTION 'A handover issue report is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" = 'RESOLVED' AND NEW."status" IS DISTINCT FROM 'RESOLVED' THEN
    RAISE EXCEPTION 'A resolved handover issue cannot be reopened' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "HandoverIssue_immutable_guard" BEFORE UPDATE OR DELETE ON "HandoverIssue"
  FOR EACH ROW EXECUTE FUNCTION "handover_issue_guard"();
