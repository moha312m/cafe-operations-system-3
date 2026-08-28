-- Two sides, two custodies, and stock the incoming hand can check.
--
-- An earlier revision verified only cash on the incoming side, which made a
-- stock handover one-sided in practice: the incoming custodian signed for a
-- store room they had never inspected, and there was nowhere to record that
-- they had not. "HandoverStockAcknowledgement" is that record.
--
-- Four custody columns because custody is scope-separated and a handover has
-- two sides. Collapsing any pair would make a cash-only or stock-only
-- handover inexpressible, and those are the ordinary cases.
--
-- "StockCountSession"."lockedByHandoverId" lands here rather than in an
-- earlier migration because this is the migration that creates the table it
-- points at. A foreign key born with its target is the point of R3.3.

CREATE TYPE "HandoverStatus" AS ENUM (
  'DRAFT', 'OUTGOING_SUBMITTED', 'INCOMING_REVIEW',
  'ACCEPTED', 'REJECTED', 'MANAGER_EXCEPTION', 'COMPLETED'
);

CREATE TYPE "OpeningExceptionKind" AS ENUM (
  'CASH_MISMATCH', 'STOCK_MISMATCH', 'FREE_FORM_OPENING',
  'NO_INCOMING', 'FIRST_OPENING', 'MANAGER_ADJUSTMENT'
);

CREATE TYPE "StockAckDecision" AS ENUM ('ACCEPTED', 'DISPUTED');

-- ───────────────────────────── The handover ──────────────────────────────
CREATE TABLE "HandoverSession" (
  "id"       TEXT NOT NULL,
  "cafeId"   TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "status"   "HandoverStatus" NOT NULL DEFAULT 'DRAFT',

  "outgoingCashCustodyId"  TEXT,
  "outgoingStockCustodyId" TEXT,
  "incomingCashCustodyId"  TEXT,
  "incomingStockCustodyId" TEXT,

  "outgoingShiftId" TEXT NOT NULL,
  "incomingShiftId" TEXT,
  "outgoingUserId"  TEXT NOT NULL,
  "incomingUserId"  TEXT,

  "stockCountSessionId" TEXT,
  "idempotencyKey"      TEXT,

  "submittedAt" TIMESTAMP(3),
  "reviewedAt"  TIMESTAMP(3),
  "acceptedAt"  TIMESTAMP(3),
  "rejectedAt"  TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),

  "rejectionReasonCodeId" TEXT,
  "rejectionNote"         TEXT,

  "exceptionById"   TEXT,
  "exceptionReason" TEXT,
  "exceptionAt"     TIMESTAMP(3),

  "proposedOpeningCash" DECIMAL(10,2),
  "countedOpeningCash"  DECIMAL(10,2),
  "cashVarianceAmount"  DECIMAL(10,2),
  "cashVerifiedAt"      TIMESTAMP(3),
  "cashVerifiedById"    TEXT,

  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "HandoverSession_pkey" PRIMARY KEY ("id")
);

-- Spec §10: a refused handover is the loudest kind of outside-tolerance
-- difference, and free text is not a reason. The column stays nullable
-- because a DRAFT has nothing to explain; the reason becomes mandatory at
-- the moment the status says somebody refused.
ALTER TABLE "HandoverSession"
  ADD CONSTRAINT "HandoverSession_rejection_reason_required"
  CHECK ("status" <> 'REJECTED' OR "rejectionReasonCodeId" IS NOT NULL);

-- Exception authority is manager/owner only. An exception naming nobody is
-- precisely the record that makes that unenforceable afterwards.
ALTER TABLE "HandoverSession"
  ADD CONSTRAINT "HandoverSession_exception_authority_required"
  CHECK ("status" <> 'MANAGER_EXCEPTION' OR "exceptionById" IS NOT NULL);

CREATE UNIQUE INDEX "HandoverSession_idempotencyKey_key"
  ON "HandoverSession"("idempotencyKey");
CREATE INDEX "HandoverSession_cafeId_status_idx"
  ON "HandoverSession"("cafeId", "status");
CREATE INDEX "HandoverSession_branchId_createdAt_idx"
  ON "HandoverSession"("branchId", "createdAt");
CREATE INDEX "HandoverSession_outgoingShiftId_idx"
  ON "HandoverSession"("outgoingShiftId");

-- One live handover per branch. REJECTED counts as live: it is unfinished
-- business that a recheck resumes, not a closed record.
CREATE UNIQUE INDEX "HandoverSession_one_active_per_branch"
  ON "HandoverSession"("branchId")
  WHERE "status" IN ('DRAFT', 'OUTGOING_SUBMITTED', 'INCOMING_REVIEW', 'REJECTED');

-- ────────────────── The incoming side's stock evidence ───────────────────
CREATE TABLE "HandoverStockAcknowledgement" (
  "id"               TEXT NOT NULL,
  "handoverId"       TEXT NOT NULL,
  "stockCountLineId" TEXT NOT NULL,

  "incomingCountedQuantity" DECIMAL(12,3),
  "handedOverQuantity"      DECIMAL(12,3) NOT NULL,
  "varianceQuantity"        DECIMAL(12,3),

  "decision"            "StockAckDecision" NOT NULL DEFAULT 'ACCEPTED',
  "disputeReasonCodeId" TEXT,
  "disputeNote"         TEXT,

  "acknowledgedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "acknowledgedById" TEXT NOT NULL,

  CONSTRAINT "HandoverStockAcknowledgement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HandoverStockAcknowledgement_handoverId_stockCountLineId_key"
  ON "HandoverStockAcknowledgement"("handoverId", "stockCountLineId");
CREATE INDEX "HandoverStockAcknowledgement_handoverId_idx"
  ON "HandoverStockAcknowledgement"("handoverId");

-- ────────────────────── Opening against the evidence ─────────────────────
CREATE TABLE "OpeningException" (
  "id"              TEXT NOT NULL,
  "cafeId"          TEXT NOT NULL,
  "branchId"        TEXT NOT NULL,
  "shiftId"         TEXT,
  "custodyPeriodId" TEXT,
  "handoverId"      TEXT,

  "kind" "OpeningExceptionKind" NOT NULL,

  "proposedAmount" DECIMAL(10,2),
  "actualAmount"   DECIMAL(10,2),
  "varianceAmount" DECIMAL(10,2),

  -- Non-nullable, per spec §17. An exception is somebody overriding what the
  -- records say; a stated reason is the minimum of what that costs.
  "reasonCodeId"   TEXT NOT NULL,
  "note"           TEXT,
  "authorizedById" TEXT NOT NULL,

  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "OpeningException_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OpeningException_cafeId_createdAt_idx"
  ON "OpeningException"("cafeId", "createdAt");
CREATE INDEX "OpeningException_branchId_kind_idx"
  ON "OpeningException"("branchId", "kind");
CREATE INDEX "OpeningException_handoverId_idx"
  ON "OpeningException"("handoverId");

-- ──────────── The count learns which handover froze it (R3.3) ────────────
ALTER TABLE "StockCountSession" ADD COLUMN "lockedByHandoverId" TEXT;
CREATE INDEX "StockCountSession_lockedByHandoverId_idx"
  ON "StockCountSession"("lockedByHandoverId");

-- ───────────────────────────── Foreign keys ──────────────────────────────
ALTER TABLE "HandoverSession"
  ADD CONSTRAINT "HandoverSession_cafeId_fkey"
  FOREIGN KEY ("cafeId") REFERENCES "Cafe"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HandoverSession"
  ADD CONSTRAINT "HandoverSession_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Restrict on all four: custody is the accountability record, and deleting
-- the period a handover cites would erase who was answerable while leaving
-- the transfer standing.
ALTER TABLE "HandoverSession"
  ADD CONSTRAINT "HandoverSession_outgoingCashCustodyId_fkey"
  FOREIGN KEY ("outgoingCashCustodyId") REFERENCES "CustodyPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HandoverSession"
  ADD CONSTRAINT "HandoverSession_outgoingStockCustodyId_fkey"
  FOREIGN KEY ("outgoingStockCustodyId") REFERENCES "CustodyPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HandoverSession"
  ADD CONSTRAINT "HandoverSession_incomingCashCustodyId_fkey"
  FOREIGN KEY ("incomingCashCustodyId") REFERENCES "CustodyPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HandoverSession"
  ADD CONSTRAINT "HandoverSession_incomingStockCustodyId_fkey"
  FOREIGN KEY ("incomingStockCustodyId") REFERENCES "CustodyPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "HandoverSession"
  ADD CONSTRAINT "HandoverSession_outgoingShiftId_fkey"
  FOREIGN KEY ("outgoingShiftId") REFERENCES "Shift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HandoverSession"
  ADD CONSTRAINT "HandoverSession_incomingShiftId_fkey"
  FOREIGN KEY ("incomingShiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "HandoverSession"
  ADD CONSTRAINT "HandoverSession_outgoingUserId_fkey"
  FOREIGN KEY ("outgoingUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HandoverSession"
  ADD CONSTRAINT "HandoverSession_incomingUserId_fkey"
  FOREIGN KEY ("incomingUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "HandoverSession"
  ADD CONSTRAINT "HandoverSession_exceptionById_fkey"
  FOREIGN KEY ("exceptionById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "HandoverSession"
  ADD CONSTRAINT "HandoverSession_cashVerifiedById_fkey"
  FOREIGN KEY ("cashVerifiedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "HandoverSession"
  ADD CONSTRAINT "HandoverSession_stockCountSessionId_fkey"
  FOREIGN KEY ("stockCountSessionId") REFERENCES "StockCountSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "HandoverSession"
  ADD CONSTRAINT "HandoverSession_rejectionReasonCodeId_fkey"
  FOREIGN KEY ("rejectionReasonCodeId") REFERENCES "ReasonCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "HandoverStockAcknowledgement"
  ADD CONSTRAINT "HandoverStockAcknowledgement_handoverId_fkey"
  FOREIGN KEY ("handoverId") REFERENCES "HandoverSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HandoverStockAcknowledgement"
  ADD CONSTRAINT "HandoverStockAcknowledgement_stockCountLineId_fkey"
  FOREIGN KEY ("stockCountLineId") REFERENCES "StockCountLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HandoverStockAcknowledgement"
  ADD CONSTRAINT "HandoverStockAcknowledgement_acknowledgedById_fkey"
  FOREIGN KEY ("acknowledgedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HandoverStockAcknowledgement"
  ADD CONSTRAINT "HandoverStockAcknowledgement_disputeReasonCodeId_fkey"
  FOREIGN KEY ("disputeReasonCodeId") REFERENCES "ReasonCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "OpeningException"
  ADD CONSTRAINT "OpeningException_cafeId_fkey"
  FOREIGN KEY ("cafeId") REFERENCES "Cafe"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OpeningException"
  ADD CONSTRAINT "OpeningException_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OpeningException"
  ADD CONSTRAINT "OpeningException_shiftId_fkey"
  FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OpeningException"
  ADD CONSTRAINT "OpeningException_custodyPeriodId_fkey"
  FOREIGN KEY ("custodyPeriodId") REFERENCES "CustodyPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OpeningException"
  ADD CONSTRAINT "OpeningException_handoverId_fkey"
  FOREIGN KEY ("handoverId") REFERENCES "HandoverSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- Restrict, unlike the SetNull above: there is no valid state for this row
-- without a reason, so the reason cannot be retired out from under it.
ALTER TABLE "OpeningException"
  ADD CONSTRAINT "OpeningException_reasonCodeId_fkey"
  FOREIGN KEY ("reasonCodeId") REFERENCES "ReasonCode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OpeningException"
  ADD CONSTRAINT "OpeningException_authorizedById_fkey"
  FOREIGN KEY ("authorizedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The column whose target this migration just created.
ALTER TABLE "StockCountSession"
  ADD CONSTRAINT "StockCountSession_lockedByHandoverId_fkey"
  FOREIGN KEY ("lockedByHandoverId") REFERENCES "HandoverSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
