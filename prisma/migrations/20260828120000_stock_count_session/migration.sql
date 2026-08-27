-- A physical count as a first-class session.
--
-- Spec §4. The distinction from an ADJUSTMENT is the point: a manager must be
-- able to tell a physical recount from somebody's tweak, and that is
-- impossible if both are recorded the same way.
--
-- `custodyPeriodId` is a real foreign key to the STOCK custody the count was
-- taken under. That is what lets a shortage be attributed to whoever actually
-- held the room, rather than to whoever happened to be on shift.
--
-- `lockedByHandoverId` is deliberately ABSENT here. It ships in M8, in the
-- same migration as the HandoverSession table it points at — every FK-bearing
-- column in this milestone is created together with its constraint, so no
-- column ever waits for the FK that checks it.
--
-- The partial unique index permits at most one non-terminal session per
-- branch: two live counts of one branch would be two contradictory answers
-- about the same shelves at the same moment.
--
-- Rollback:
--   DROP INDEX "StockCountSession_one_active_per_branch";
--   DROP TABLE "StockCountSession";
--   DROP TYPE "StockCountStatus";

CREATE TYPE "StockCountStatus" AS ENUM (
  'DRAFT', 'IN_PROGRESS', 'SUBMITTED', 'RECOUNT_REQUIRED', 'CONFIRMED', 'LOCKED'
);

CREATE TABLE "StockCountSession" (
  "id"              TEXT NOT NULL,
  "cafeId"          TEXT NOT NULL,
  "branchId"        TEXT NOT NULL,
  "shiftId"         TEXT,
  "custodyPeriodId" TEXT,
  "type"            "StockCountType" NOT NULL,
  "status"          "StockCountStatus" NOT NULL DEFAULT 'DRAFT',
  "mode"            "StockCountMode" NOT NULL DEFAULT 'BLIND',
  -- How the scope was derived ("ALL_ELIGIBLE" | "CRITICAL_ONLY"), recorded so
  -- a count can be audited without re-deriving it from today's configuration.
  "scopeDerivation" TEXT NOT NULL,
  "startedAt"       TIMESTAMP(3),
  "submittedAt"     TIMESTAMP(3),
  "confirmedAt"     TIMESTAMP(3),
  "lockedAt"        TIMESTAMP(3),
  "initiatedById"   TEXT NOT NULL,
  "firstCounterId"  TEXT,
  "confirmedById"   TEXT,
  "idempotencyKey"  TEXT,
  "notes"           TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StockCountSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StockCountSession_idempotencyKey_key" ON "StockCountSession"("idempotencyKey");
CREATE INDEX "StockCountSession_cafeId_createdAt_idx" ON "StockCountSession"("cafeId", "createdAt");
CREATE INDEX "StockCountSession_branchId_status_idx" ON "StockCountSession"("branchId", "status");
CREATE INDEX "StockCountSession_custodyPeriodId_idx" ON "StockCountSession"("custodyPeriodId");

CREATE UNIQUE INDEX "StockCountSession_one_active_per_branch"
  ON "StockCountSession"("branchId")
  WHERE "status" IN ('DRAFT', 'IN_PROGRESS', 'SUBMITTED', 'RECOUNT_REQUIRED');

ALTER TABLE "StockCountSession" ADD CONSTRAINT "StockCountSession_cafeId_fkey"
  FOREIGN KEY ("cafeId") REFERENCES "Cafe"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StockCountSession" ADD CONSTRAINT "StockCountSession_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StockCountSession" ADD CONSTRAINT "StockCountSession_shiftId_fkey"
  FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- SET NULL, not CASCADE: the count is evidence and must outlive the custody
-- row, holding a NULL rather than a dangling reference.
ALTER TABLE "StockCountSession" ADD CONSTRAINT "StockCountSession_custodyPeriodId_fkey"
  FOREIGN KEY ("custodyPeriodId") REFERENCES "CustodyPeriod"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "StockCountSession" ADD CONSTRAINT "StockCountSession_initiatedById_fkey"
  FOREIGN KEY ("initiatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockCountSession" ADD CONSTRAINT "StockCountSession_firstCounterId_fkey"
  FOREIGN KEY ("firstCounterId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "StockCountSession" ADD CONSTRAINT "StockCountSession_confirmedById_fkey"
  FOREIGN KEY ("confirmedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
