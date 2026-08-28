-- Point a case at what caused it, with keys the database can check.
--
-- One investigation domain, four kinds of evidence behind it. The tempting
-- shape is a "sourceType" string beside a "sourceId" string, and it cannot be
-- constrained: nothing would stop an id matching no row, or a type
-- disagreeing with the id next to it. So the sources are separate,
-- explicitly-typed columns with real foreign keys, and a CHECK counts them.
--
-- Every foreign key in this table is created in this file, with its
-- constraint, because all four sources now exist. Zero deferred keys.

CREATE TYPE "VarianceCaseType" AS ENUM ('CASH', 'TENDER', 'STOCK', 'OPENING_EXCEPTION');

CREATE TYPE "VarianceCaseStatus" AS ENUM (
  'OPEN', 'UNDER_INVESTIGATION', 'RESPONSIBILITY_ASSIGNED',
  'APPROVED', 'RESOLVED', 'WAIVED'
);

CREATE TABLE "VarianceCase" (
  "id"       TEXT NOT NULL,
  "cafeId"   TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "type"     "VarianceCaseType" NOT NULL,
  "status"   "VarianceCaseStatus" NOT NULL DEFAULT 'OPEN',

  "shiftId"         TEXT,
  "custodyPeriodId" TEXT,

  "stockCountLineId"       TEXT,
  "tenderReconciliationId" TEXT,
  "openingExceptionId"     TEXT,

  "quantityVariance" DECIMAL(12,3),
  "amountVariance"   DECIMAL(10,2),

  -- NULL is not zero. A shortage nobody can price is not a shortage that
  -- cost nothing, and the paired flag plus reason keep the two apart.
  "financialImpact"                 DECIMAL(12,2),
  "financialImpactAvailable"        BOOLEAN NOT NULL DEFAULT false,
  "financialImpactUnavailableReason" TEXT,

  "confidence" "TheoreticalConfidence" NOT NULL DEFAULT 'UNVERIFIABLE',

  -- Investigation outcome ONLY. No payroll effect in this milestone.
  "assignedResponsibilityUserId" TEXT,

  "blocking" BOOLEAN NOT NULL DEFAULT false,

  "openedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "openedById"     TEXT NOT NULL,
  "resolvedAt"     TIMESTAMP(3),
  "resolvedById"   TEXT,
  "resolutionNote" TEXT,

  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "VarianceCase_pkey" PRIMARY KEY ("id")
);

-- Exactly one originating source, enforced where it cannot be argued with.
--
-- CASH is the fourth arm rather than a fifth column: its evidence is the
-- shift close, which T16 established as the single source of truth for cash,
-- and it is reached through "shiftId". Giving cash its own source column here
-- would have recreated the second cash record that T16 removed.
ALTER TABLE "VarianceCase" ADD CONSTRAINT "VarianceCase_single_source_check" CHECK (
  (CASE WHEN "stockCountLineId"       IS NOT NULL THEN 1 ELSE 0 END) +
  (CASE WHEN "tenderReconciliationId" IS NOT NULL THEN 1 ELSE 0 END) +
  (CASE WHEN "openingExceptionId"     IS NOT NULL THEN 1 ELSE 0 END) +
  (CASE WHEN "type" = 'CASH'          THEN 1 ELSE 0 END) = 1
);

-- One piece of evidence raises one case. This is what makes an engine retry
-- idempotent rather than merely unlikely to duplicate.
CREATE UNIQUE INDEX "VarianceCase_stockCountLineId_key"
  ON "VarianceCase"("stockCountLineId");
CREATE UNIQUE INDEX "VarianceCase_tenderReconciliationId_key"
  ON "VarianceCase"("tenderReconciliationId");
CREATE UNIQUE INDEX "VarianceCase_openingExceptionId_key"
  ON "VarianceCase"("openingExceptionId");

CREATE INDEX "VarianceCase_cafeId_status_idx"      ON "VarianceCase"("cafeId", "status");
CREATE INDEX "VarianceCase_branchId_type_idx"      ON "VarianceCase"("branchId", "type");
CREATE INDEX "VarianceCase_custodyPeriodId_idx"    ON "VarianceCase"("custodyPeriodId");
CREATE INDEX "VarianceCase_shiftId_idx"            ON "VarianceCase"("shiftId");

ALTER TABLE "VarianceCase"
  ADD CONSTRAINT "VarianceCase_cafeId_fkey"
  FOREIGN KEY ("cafeId") REFERENCES "Cafe"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VarianceCase"
  ADD CONSTRAINT "VarianceCase_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VarianceCase"
  ADD CONSTRAINT "VarianceCase_shiftId_fkey"
  FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Restrict on custody is load-bearing: a period with cases attached cannot be
-- deleted, so previous-period responsibility cannot be erased by removing the
-- record of who held the room.
ALTER TABLE "VarianceCase"
  ADD CONSTRAINT "VarianceCase_custodyPeriodId_fkey"
  FOREIGN KEY ("custodyPeriodId") REFERENCES "CustodyPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Restrict on all three source arms: a case exists because something
-- happened, and deleting the evidence while keeping the case would turn an
-- investigation into an assertion.
ALTER TABLE "VarianceCase"
  ADD CONSTRAINT "VarianceCase_stockCountLineId_fkey"
  FOREIGN KEY ("stockCountLineId") REFERENCES "StockCountLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VarianceCase"
  ADD CONSTRAINT "VarianceCase_tenderReconciliationId_fkey"
  FOREIGN KEY ("tenderReconciliationId") REFERENCES "TenderReconciliation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VarianceCase"
  ADD CONSTRAINT "VarianceCase_openingExceptionId_fkey"
  FOREIGN KEY ("openingExceptionId") REFERENCES "OpeningException"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Somebody opened it, and that cannot become nobody. The other two people
-- are SetNull: archiving a staff account blanks the name, never the case.
ALTER TABLE "VarianceCase"
  ADD CONSTRAINT "VarianceCase_openedById_fkey"
  FOREIGN KEY ("openedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VarianceCase"
  ADD CONSTRAINT "VarianceCase_resolvedById_fkey"
  FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "VarianceCase"
  ADD CONSTRAINT "VarianceCase_assignedResponsibilityUserId_fkey"
  FOREIGN KEY ("assignedResponsibilityUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The cash link, created here with its target. Cash evidence itself does not
-- move: "actualCashAmount" and "cashDifference" stay exactly where T16 left
-- them, and this column only names the investigation they opened.
ALTER TABLE "Shift" ADD COLUMN "cashVarianceCaseId" TEXT;
CREATE UNIQUE INDEX "Shift_cashVarianceCaseId_key" ON "Shift"("cashVarianceCaseId");
ALTER TABLE "Shift"
  ADD CONSTRAINT "Shift_cashVarianceCaseId_fkey"
  FOREIGN KEY ("cashVarianceCaseId") REFERENCES "VarianceCase"("id") ON DELETE SET NULL ON UPDATE CASCADE;
