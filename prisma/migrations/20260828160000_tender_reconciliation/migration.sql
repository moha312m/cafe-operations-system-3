-- Cash keeps one home, and the other channels get their own.
--
-- An earlier revision of this plan gave CASH a TenderReconciliation row
-- alongside "Shift"."actualCashAmount". That put the same money in two places
-- free to disagree, and demoted the existing, tested close path to a second
-- opinion. The split below follows how the money actually arrives instead.

-- ─────────────── Shift gains what cash reconciliation lacked ──────────────
-- Extending the row the close path already writes, not adding a second one.
-- All four are nullable because NULL is TRUE for every shift closed before
-- this feature existed: backfilling a default would invent a reconciliation
-- nobody performed. "cashVarianceCaseId" is deliberately NOT here — it ships
-- in the migration that creates the VarianceCase table it points at, so the
-- foreign key is born with its target.
ALTER TABLE "Shift"
  ADD COLUMN "cashWithinTolerance" BOOLEAN,
  ADD COLUMN "cashToleranceAmount" DECIMAL(10,2),
  ADD COLUMN "cashReasonCodeId"    TEXT,
  ADD COLUMN "cashReasonNote"      TEXT;

-- SetNull, not Cascade: retiring the vocabulary an owner once used must not
-- delete the shift close it explained.
ALTER TABLE "Shift"
  ADD CONSTRAINT "Shift_cashReasonCodeId_fkey"
  FOREIGN KEY ("cashReasonCodeId") REFERENCES "ReasonCode"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Shift_cashReasonCodeId_idx" ON "Shift"("cashReasonCodeId");

-- ──────────────── The electronic channels get their own record ────────────
CREATE TYPE "TenderReconStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED');

CREATE TABLE "TenderReconciliation" (
  "id"              TEXT NOT NULL,
  "cafeId"          TEXT NOT NULL,
  "branchId"        TEXT NOT NULL,
  "shiftId"         TEXT NOT NULL,
  "method"          "PaymentMethod" NOT NULL,
  "expectedAmount"  DECIMAL(10,2) NOT NULL,
  "actualAmount"    DECIMAL(10,2),
  "varianceAmount"  DECIMAL(10,2),
  "toleranceAmount" DECIMAL(10,2),
  "reasonCodeId"    TEXT,
  "reasonNote"      TEXT,
  "status"          "TenderReconStatus" NOT NULL DEFAULT 'DRAFT',
  "submittedById"   TEXT,
  "submittedAt"     TIMESTAMP(3),
  "approvedById"    TEXT,
  "approvedAt"      TIMESTAMP(3),
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,

  CONSTRAINT "TenderReconciliation_pkey" PRIMARY KEY ("id")
);

-- Enforced by the database, not by convention.
--
-- CASH is excluded because it already has a single source of truth one table
-- over: the drawer counted at close, on "Shift". A row here would be a
-- competing answer, not a cross-check.
--
-- MIXED is excluded for a different reason — it is not a settlement channel
-- at all. It marks an order paid across more than one method, and every part
-- is already a "Payment" row under its own real method, so reconciling MIXED
-- would count the same money twice under a label no processor ever settles.
ALTER TABLE "TenderReconciliation"
  ADD CONSTRAINT "TenderReconciliation_no_cash_check"
  CHECK ("method" IN ('CARD', 'WALLET'));

-- One shift settles a channel once, or the totals mean nothing.
CREATE UNIQUE INDEX "TenderReconciliation_shiftId_method_key"
  ON "TenderReconciliation"("shiftId", "method");
CREATE INDEX "TenderReconciliation_cafeId_status_idx"
  ON "TenderReconciliation"("cafeId", "status");
CREATE INDEX "TenderReconciliation_shiftId_idx"
  ON "TenderReconciliation"("shiftId");

ALTER TABLE "TenderReconciliation"
  ADD CONSTRAINT "TenderReconciliation_cafeId_fkey"
  FOREIGN KEY ("cafeId") REFERENCES "Cafe"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TenderReconciliation"
  ADD CONSTRAINT "TenderReconciliation_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "Branch"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TenderReconciliation"
  ADD CONSTRAINT "TenderReconciliation_shiftId_fkey"
  FOREIGN KEY ("shiftId") REFERENCES "Shift"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TenderReconciliation"
  ADD CONSTRAINT "TenderReconciliation_reasonCodeId_fkey"
  FOREIGN KEY ("reasonCodeId") REFERENCES "ReasonCode"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Who submitted and who approved are separate signatures, and both survive
-- the account being archived: SetNull blanks the name, not the settlement.
ALTER TABLE "TenderReconciliation"
  ADD CONSTRAINT "TenderReconciliation_submittedById_fkey"
  FOREIGN KEY ("submittedById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "TenderReconciliation"
  ADD CONSTRAINT "TenderReconciliation_approvedById_fkey"
  FOREIGN KEY ("approvedById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
