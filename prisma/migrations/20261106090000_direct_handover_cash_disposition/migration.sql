-- Direct shift handover: closing cash disposition, recipient confirmation and direct acceptance.
-- Additive only. No existing table is rewritten, no data is backfilled, and every new column is nullable.
-- Historical handovers keep directAcknowledgedAt = NULL and are displayed as they always were.

CREATE TYPE "CashDeliveryDestination" AS ENUM ('OWNER', 'MANAGER');
CREATE TYPE "CashDeliveryStatus" AS ENUM ('DECLARED', 'CONFIRMED', 'DISPUTED', 'RESOLVED');

ALTER TABLE "HandoverSession"
  ADD COLUMN "directAcknowledgedAt" TIMESTAMP(3),
  ADD COLUMN "directAcknowledgedById" TEXT,
  ADD COLUMN "directReviewVersion" TEXT;

CREATE TABLE "ShiftCashDisposition" (
  "id" TEXT NOT NULL,
  "cafeId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "shiftId" TEXT NOT NULL,
  "handoverId" TEXT,
  "countedCash" DECIMAL(10,2) NOT NULL,
  "expectedCash" DECIMAL(10,2) NOT NULL,
  "cashDifference" DECIMAL(10,2) NOT NULL,
  "deliveredAmount" DECIMAL(10,2) NOT NULL,
  "retainedAmount" DECIMAL(10,2) NOT NULL,
  "note" VARCHAR(1000),
  "fingerprint" VARCHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(200) NOT NULL,
  "declaredById" TEXT NOT NULL,
  "declaredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ShiftCashDisposition_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ShiftCashDisposition_amounts_check" CHECK (
    "countedCash" >= 0 AND "deliveredAmount" >= 0 AND "retainedAmount" >= 0
    AND "deliveredAmount" + "retainedAmount" = "countedCash"
    AND "cashDifference" = "countedCash" - "expectedCash"
  )
);

CREATE TABLE "CashDeliveryDeclaration" (
  "id" TEXT NOT NULL,
  "cafeId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "dispositionId" TEXT NOT NULL,
  "shiftId" TEXT NOT NULL,
  "handoverId" TEXT,
  "destination" "CashDeliveryDestination" NOT NULL,
  "recipientId" TEXT NOT NULL,
  "amount" DECIMAL(10,2) NOT NULL,
  "reference" VARCHAR(160),
  "status" "CashDeliveryStatus" NOT NULL DEFAULT 'DECLARED',
  "declaredById" TEXT NOT NULL,
  "declaredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "confirmedById" TEXT,
  "confirmedAt" TIMESTAMP(3),
  "confirmedByException" BOOLEAN NOT NULL DEFAULT false,
  "exceptionReason" VARCHAR(1000),
  "confirmKey" VARCHAR(200),
  "disputedById" TEXT,
  "disputedAt" TIMESTAMP(3),
  "disputeNote" VARCHAR(1000),
  "claimedReceivedAmount" DECIMAL(10,2),
  "resolvedById" TEXT,
  "resolvedAt" TIMESTAMP(3),
  "resolutionNote" VARCHAR(1000),
  "resolvedAmount" DECIMAL(10,2),
  CONSTRAINT "CashDeliveryDeclaration_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CashDeliveryDeclaration_amount_check" CHECK ("amount" > 0),
  CONSTRAINT "CashDeliveryDeclaration_claimed_check" CHECK ("claimedReceivedAmount" IS NULL OR ("claimedReceivedAmount" >= 0 AND "claimedReceivedAmount" <= "amount")),
  CONSTRAINT "CashDeliveryDeclaration_resolved_check" CHECK ("resolvedAmount" IS NULL OR ("resolvedAmount" >= 0 AND "resolvedAmount" <= "amount")),
  CONSTRAINT "CashDeliveryDeclaration_state_check" CHECK (
    ("status" = 'DECLARED' AND "confirmedById" IS NULL AND "disputedById" IS NULL AND "resolvedById" IS NULL)
    OR ("status" = 'CONFIRMED' AND "confirmedById" IS NOT NULL AND "confirmedAt" IS NOT NULL AND "disputedById" IS NULL AND "resolvedById" IS NULL)
    OR ("status" = 'DISPUTED' AND "disputedById" IS NOT NULL AND "disputedAt" IS NOT NULL AND length(btrim("disputeNote")) > 0 AND "resolvedById" IS NULL)
    OR ("status" = 'RESOLVED' AND "disputedById" IS NOT NULL AND "resolvedById" IS NOT NULL AND "resolvedAt" IS NOT NULL AND "resolvedAmount" IS NOT NULL AND length(btrim("resolutionNote")) > 0)
  ),
  CONSTRAINT "CashDeliveryDeclaration_exception_check" CHECK (
    NOT "confirmedByException" OR (length(btrim("exceptionReason")) > 0 AND "confirmedById" IS NOT NULL AND "confirmedById" <> "recipientId")
  )
);

CREATE UNIQUE INDEX "ShiftCashDisposition_shiftId_key" ON "ShiftCashDisposition"("shiftId");
CREATE UNIQUE INDEX "ShiftCashDisposition_handoverId_key" ON "ShiftCashDisposition"("handoverId");
CREATE INDEX "ShiftCashDisposition_cafeId_branchId_declaredAt_idx" ON "ShiftCashDisposition"("cafeId", "branchId", "declaredAt");
CREATE INDEX "ShiftCashDisposition_declaredById_idx" ON "ShiftCashDisposition"("declaredById");
CREATE INDEX "CashDeliveryDeclaration_cafeId_status_declaredAt_idx" ON "CashDeliveryDeclaration"("cafeId", "status", "declaredAt");
CREATE INDEX "CashDeliveryDeclaration_recipientId_status_idx" ON "CashDeliveryDeclaration"("recipientId", "status");
CREATE INDEX "CashDeliveryDeclaration_dispositionId_idx" ON "CashDeliveryDeclaration"("dispositionId");
CREATE INDEX "CashDeliveryDeclaration_shiftId_idx" ON "CashDeliveryDeclaration"("shiftId");
CREATE INDEX "CashDeliveryDeclaration_branchId_status_idx" ON "CashDeliveryDeclaration"("branchId", "status");

ALTER TABLE "HandoverSession" ADD CONSTRAINT "HandoverSession_directAcknowledgedById_fkey" FOREIGN KEY ("directAcknowledgedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ShiftCashDisposition" ADD CONSTRAINT "ShiftCashDisposition_cafeId_fkey" FOREIGN KEY ("cafeId") REFERENCES "Cafe"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShiftCashDisposition" ADD CONSTRAINT "ShiftCashDisposition_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShiftCashDisposition" ADD CONSTRAINT "ShiftCashDisposition_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShiftCashDisposition" ADD CONSTRAINT "ShiftCashDisposition_handoverId_fkey" FOREIGN KEY ("handoverId") REFERENCES "HandoverSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShiftCashDisposition" ADD CONSTRAINT "ShiftCashDisposition_declaredById_fkey" FOREIGN KEY ("declaredById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CashDeliveryDeclaration" ADD CONSTRAINT "CashDeliveryDeclaration_cafeId_fkey" FOREIGN KEY ("cafeId") REFERENCES "Cafe"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CashDeliveryDeclaration" ADD CONSTRAINT "CashDeliveryDeclaration_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CashDeliveryDeclaration" ADD CONSTRAINT "CashDeliveryDeclaration_dispositionId_fkey" FOREIGN KEY ("dispositionId") REFERENCES "ShiftCashDisposition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CashDeliveryDeclaration" ADD CONSTRAINT "CashDeliveryDeclaration_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CashDeliveryDeclaration" ADD CONSTRAINT "CashDeliveryDeclaration_handoverId_fkey" FOREIGN KEY ("handoverId") REFERENCES "HandoverSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CashDeliveryDeclaration" ADD CONSTRAINT "CashDeliveryDeclaration_declaredById_fkey" FOREIGN KEY ("declaredById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CashDeliveryDeclaration" ADD CONSTRAINT "CashDeliveryDeclaration_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CashDeliveryDeclaration" ADD CONSTRAINT "CashDeliveryDeclaration_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CashDeliveryDeclaration" ADD CONSTRAINT "CashDeliveryDeclaration_disputedById_fkey" FOREIGN KEY ("disputedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CashDeliveryDeclaration" ADD CONSTRAINT "CashDeliveryDeclaration_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The declaration is evidence. Who declared what, to whom and how much, never changes; only the
-- confirmation / dispute / resolution columns move, and a deleted row would erase the obligation.
CREATE FUNCTION "cash_delivery_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Cash delivery declarations cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF NEW."cafeId" IS DISTINCT FROM OLD."cafeId" OR NEW."branchId" IS DISTINCT FROM OLD."branchId"
     OR NEW."dispositionId" IS DISTINCT FROM OLD."dispositionId" OR NEW."shiftId" IS DISTINCT FROM OLD."shiftId"
     OR NEW."destination" IS DISTINCT FROM OLD."destination" OR NEW."recipientId" IS DISTINCT FROM OLD."recipientId"
     OR NEW."amount" IS DISTINCT FROM OLD."amount" OR NEW."declaredById" IS DISTINCT FROM OLD."declaredById"
     OR NEW."declaredAt" IS DISTINCT FROM OLD."declaredAt" THEN
    RAISE EXCEPTION 'A cash delivery declaration is immutable evidence' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" = 'CONFIRMED' AND NEW."status" IS DISTINCT FROM 'CONFIRMED' THEN
    RAISE EXCEPTION 'A confirmed delivery cannot be reopened' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" = 'RESOLVED' AND NEW."status" IS DISTINCT FROM 'RESOLVED' THEN
    RAISE EXCEPTION 'A resolved delivery dispute cannot be reopened' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "CashDeliveryDeclaration_immutable_guard" BEFORE UPDATE OR DELETE ON "CashDeliveryDeclaration"
  FOR EACH ROW EXECUTE FUNCTION "cash_delivery_guard"();

CREATE FUNCTION "shift_cash_disposition_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A closing cash disposition cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF NEW."countedCash" IS DISTINCT FROM OLD."countedCash" OR NEW."expectedCash" IS DISTINCT FROM OLD."expectedCash"
     OR NEW."deliveredAmount" IS DISTINCT FROM OLD."deliveredAmount" OR NEW."retainedAmount" IS DISTINCT FROM OLD."retainedAmount"
     OR NEW."shiftId" IS DISTINCT FROM OLD."shiftId" OR NEW."fingerprint" IS DISTINCT FROM OLD."fingerprint"
     OR NEW."declaredById" IS DISTINCT FROM OLD."declaredById" OR NEW."declaredAt" IS DISTINCT FROM OLD."declaredAt" THEN
    RAISE EXCEPTION 'A closing cash disposition is written once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ShiftCashDisposition_immutable_guard" BEFORE UPDATE OR DELETE ON "ShiftCashDisposition"
  FOR EACH ROW EXECUTE FUNCTION "shift_cash_disposition_guard"();
