-- CreateEnum
CREATE TYPE "ProjectionIssueKind" AS ENUM ('UNPOSTABLE', 'CHANGED', 'DISAPPEARED', 'FAILED', 'LATE_EVENT', 'ASSUMED_DATE');

-- CreateEnum
CREATE TYPE "ProjectionIssueSeverity" AS ENUM ('BLOCKING', 'WARNING');

-- CreateTable
CREATE TABLE "AccountingProjectionRun" (
    "id" TEXT NOT NULL,
    "cafeId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "windowFrom" TIMESTAMP(3) NOT NULL,
    "windowTo" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "posted" INTEGER NOT NULL DEFAULT 0,
    "replayed" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "issueCount" INTEGER NOT NULL DEFAULT 0,
    "actorId" TEXT,

    CONSTRAINT "AccountingProjectionRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountingProjectionIssue" (
    "id" TEXT NOT NULL,
    "cafeId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "kind" "ProjectionIssueKind" NOT NULL,
    "severity" "ProjectionIssueSeverity" NOT NULL,
    "reason" TEXT NOT NULL,
    "eventAt" TIMESTAMP(3) NOT NULL,
    "branchId" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastRunId" TEXT,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "AccountingProjectionIssue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccountingProjectionRun_cafeId_startedAt_idx" ON "AccountingProjectionRun"("cafeId", "startedAt");

-- CreateIndex
CREATE INDEX "AccountingProjectionIssue_cafeId_resolvedAt_idx" ON "AccountingProjectionIssue"("cafeId", "resolvedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AccountingProjectionIssue_entityId_sourceKey_kind_key" ON "AccountingProjectionIssue"("entityId", "sourceKey", "kind");


-- ── Close gate ──────────────────────────────────────────────────────
-- Every write to a table the shadow books read from takes a SHARED
-- transaction-level advisory lock for its café. Closing a period takes the
-- same lock EXCLUSIVELY before it re-runs the checklist, so a close waits
-- for in-flight source writes to commit (and then sees them), and source
-- writes that start during a close wait until it commits. Nothing is ever
-- refused here: operations never fail because of the books, and an event
-- that lands in a period after it closed is reported as a late event.
CREATE FUNCTION "accounting_close_key"(cafe TEXT) RETURNS BIGINT LANGUAGE sql IMMUTABLE AS $$
  SELECT hashtextextended('accounting-close:' || cafe, 0)
$$;

CREATE FUNCTION "accounting_close_gate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM pg_advisory_xact_lock_shared("accounting_close_key"(OLD."cafeId"));
  ELSE
    PERFORM pg_advisory_xact_lock_shared("accounting_close_key"(NEW."cafeId"));
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "Order_accounting_close_gate" AFTER INSERT OR UPDATE OR DELETE ON "Order" FOR EACH ROW EXECUTE FUNCTION "accounting_close_gate"();
CREATE TRIGGER "Payment_accounting_close_gate" AFTER INSERT OR UPDATE OR DELETE ON "Payment" FOR EACH ROW EXECUTE FUNCTION "accounting_close_gate"();
CREATE TRIGGER "OrderRevision_accounting_close_gate" AFTER INSERT OR UPDATE OR DELETE ON "OrderRevision" FOR EACH ROW EXECUTE FUNCTION "accounting_close_gate"();
CREATE TRIGGER "PurchaseInvoice_accounting_close_gate" AFTER INSERT OR UPDATE OR DELETE ON "PurchaseInvoice" FOR EACH ROW EXECUTE FUNCTION "accounting_close_gate"();
CREATE TRIGGER "PurchasePayment_accounting_close_gate" AFTER INSERT OR UPDATE OR DELETE ON "PurchasePayment" FOR EACH ROW EXECUTE FUNCTION "accounting_close_gate"();
CREATE TRIGGER "InventoryTransaction_accounting_close_gate" AFTER INSERT OR UPDATE OR DELETE ON "InventoryTransaction" FOR EACH ROW EXECUTE FUNCTION "accounting_close_gate"();
CREATE TRIGGER "CashStorage_accounting_close_gate" AFTER INSERT OR UPDATE OR DELETE ON "CashStorage" FOR EACH ROW EXECUTE FUNCTION "accounting_close_gate"();
CREATE TRIGGER "CashStorageMovement_accounting_close_gate" AFTER INSERT OR UPDATE OR DELETE ON "CashStorageMovement" FOR EACH ROW EXECUTE FUNCTION "accounting_close_gate"();
CREATE TRIGGER "Shift_accounting_close_gate" AFTER INSERT OR UPDATE OR DELETE ON "Shift" FOR EACH ROW EXECUTE FUNCTION "accounting_close_gate"();
