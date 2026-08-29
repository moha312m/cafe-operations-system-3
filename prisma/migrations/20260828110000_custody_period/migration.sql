-- Custody: who is answerable for what, and for how long.
--
-- CASH and STOCK are separate scopes because they are separately held. The
-- ordinary café case is the cashier holding the drawer while the barista
-- holds the store room, and a single `BOTH` scope cannot express it — nor can
-- a `custodyPeriodId` column on Shift, which could only ever name one. So a
-- shift links to custody through a join table, and one shift may hold one
-- CASH period and one STOCK period at the same time.
--
-- Shift gains NO column here. `Shift.cashierId` is untouched and stays
-- NOT NULL: the existing POS cash path resolves custody through it, and that
-- is the one flow this system already gets right. Nothing in this migration
-- moves it.
--
-- The partial unique index is the substantive constraint: a branch may hold
-- at most one OPEN period per scope. Without it two open stock custodies
-- could coexist at one branch, and a shortage would have two answerable
-- holders — which is the same as having none.
--
-- Rollback:
--   DROP INDEX "CustodyPeriod_one_open_per_branch_scope";
--   DROP TABLE "ShiftCustody"; DROP TABLE "CustodyParticipant";
--   DROP TABLE "CustodyPeriod";
--   DROP TYPE "CustodyStatus"; DROP TYPE "CustodyRole"; DROP TYPE "CustodyScope";

CREATE TYPE "CustodyScope"  AS ENUM ('CASH', 'STOCK');
CREATE TYPE "CustodyRole"   AS ENUM ('PRIMARY', 'SHARED');
CREATE TYPE "CustodyStatus" AS ENUM ('OPEN', 'TRANSFERRED', 'CLOSED');

CREATE TABLE "CustodyPeriod" (
  "id"                TEXT NOT NULL,
  "cafeId"            TEXT NOT NULL,
  "branchId"          TEXT NOT NULL,
  "scope"             "CustodyScope" NOT NULL,
  "status"            "CustodyStatus" NOT NULL DEFAULT 'OPEN',
  "startedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endedAt"           TIMESTAMP(3),
  -- CASH scope only; a stock custody has no drawer.
  "openingCashAmount" DECIMAL(10,2),
  "closingCashAmount" DECIMAL(10,2),
  -- The chain: which custody this one took over from. Unique, so a period
  -- cannot be claimed as the predecessor of two successors.
  "previousPeriodId"  TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CustodyPeriod_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CustodyPeriod_previousPeriodId_key" ON "CustodyPeriod"("previousPeriodId");
CREATE INDEX "CustodyPeriod_cafeId_status_idx" ON "CustodyPeriod"("cafeId", "status");
CREATE INDEX "CustodyPeriod_branchId_scope_status_idx" ON "CustodyPeriod"("branchId", "scope", "status");

-- At most one OPEN custody per branch per scope.
CREATE UNIQUE INDEX "CustodyPeriod_one_open_per_branch_scope"
  ON "CustodyPeriod"("branchId", "scope") WHERE "status" = 'OPEN';

CREATE TABLE "CustodyParticipant" (
  "id"              TEXT NOT NULL,
  "custodyPeriodId" TEXT NOT NULL,
  "userId"          TEXT NOT NULL,
  "role"            "CustodyRole" NOT NULL DEFAULT 'PRIMARY',
  "joinedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leftAt"          TIMESTAMP(3),
  CONSTRAINT "CustodyParticipant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CustodyParticipant_custodyPeriodId_userId_key"
  ON "CustodyParticipant"("custodyPeriodId", "userId");
CREATE INDEX "CustodyParticipant_userId_idx" ON "CustodyParticipant"("userId");

-- A shift may hold one CASH and one STOCK period at once, and a period may
-- span shifts. Neither owns the other, so this is a join, not a column.
CREATE TABLE "ShiftCustody" (
  "id"              TEXT NOT NULL,
  "shiftId"         TEXT NOT NULL,
  "custodyPeriodId" TEXT NOT NULL,
  -- Denormalised from the period so the partial unique below can exist.
  "scope"           "CustodyScope" NOT NULL,
  "linkedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ShiftCustody_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ShiftCustody_shiftId_scope_key" ON "ShiftCustody"("shiftId", "scope");
CREATE UNIQUE INDEX "ShiftCustody_shiftId_custodyPeriodId_key" ON "ShiftCustody"("shiftId", "custodyPeriodId");
CREATE INDEX "ShiftCustody_custodyPeriodId_idx" ON "ShiftCustody"("custodyPeriodId");

ALTER TABLE "CustodyPeriod" ADD CONSTRAINT "CustodyPeriod_cafeId_fkey"
  FOREIGN KEY ("cafeId") REFERENCES "Cafe"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustodyPeriod" ADD CONSTRAINT "CustodyPeriod_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustodyPeriod" ADD CONSTRAINT "CustodyPeriod_previousPeriodId_fkey"
  FOREIGN KEY ("previousPeriodId") REFERENCES "CustodyPeriod"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CustodyParticipant" ADD CONSTRAINT "CustodyParticipant_custodyPeriodId_fkey"
  FOREIGN KEY ("custodyPeriodId") REFERENCES "CustodyPeriod"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustodyParticipant" ADD CONSTRAINT "CustodyParticipant_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ShiftCustody" ADD CONSTRAINT "ShiftCustody_shiftId_fkey"
  FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShiftCustody" ADD CONSTRAINT "ShiftCustody_custodyPeriodId_fkey"
  FOREIGN KEY ("custodyPeriodId") REFERENCES "CustodyPeriod"("id") ON DELETE CASCADE ON UPDATE CASCADE;
