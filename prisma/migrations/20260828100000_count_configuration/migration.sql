-- Count configuration: policy, reason codes, and which items are critical.
--
-- Criticality is a property of the ingredient, set by the owner. That is what
-- lets the count-start endpoint derive scope on the SERVER rather than
-- trusting a list of item ids from the caller — if the client named the
-- items, a custodian could leave the short one out and the count would come
-- back clean by construction.
--
-- Two backfill choices carry the weight here, and both exist so that no
-- café's operation changes behind its back:
--
--   stockCountPolicy defaults to HYBRID for a NEW café, but every EXISTING
--   café is pinned to NO_SHIFT_COUNT. A shop that has never counted at
--   handover must not find out tomorrow that it is required to; it moves to
--   HYBRID through the configuration UI, when its owner decides to.
--
--   isCritical defaults to false with NO backfill flipping anything true.
--   A guess here would put items into the daily count that nobody selected.
--
-- CYCLE is a StockCountPolicy but deliberately NOT a StockCountType: a café
-- may express the intent, but no count can be STARTED as one because there
-- is no cycle engine. The resolver refuses it rather than running a FULL
-- count and labelling it a cycle.
--
-- Rollback (additive):
--   ALTER TABLE "InventoryItem" DROP COLUMN "isCritical";
--   ALTER TABLE "Branch" DROP COLUMN "stockCountPolicyOverride",
--     DROP COLUMN "handoverCountTypeOverride",
--     DROP COLUMN "periodicCountTypeOverride",
--     DROP COLUMN "stockCountModeOverride";
--   ALTER TABLE "CafeSettings" DROP COLUMN "stockCountPolicy",
--     DROP COLUMN "handoverCountType", DROP COLUMN "periodicCountType",
--     DROP COLUMN "stockCountMode";
--   DROP TABLE "ReasonCode";
--   DROP TYPE "ReasonDomain"; DROP TYPE "StockCountMode";
--   DROP TYPE "StockCountType"; DROP TYPE "StockCountPolicy";

CREATE TYPE "StockCountPolicy" AS ENUM ('CRITICAL', 'FULL', 'CYCLE', 'HYBRID', 'NO_SHIFT_COUNT');
CREATE TYPE "StockCountType"   AS ENUM ('CRITICAL', 'FULL');
CREATE TYPE "StockCountMode"   AS ENUM ('BLIND', 'OPEN');
CREATE TYPE "ReasonDomain"     AS ENUM ('STOCK', 'CASH', 'TENDER', 'HANDOVER');

-- Owner-defined vocabulary for why a figure differs from its expectation.
-- Scoped by domain because the same word means different things in different
-- places: a "SHORT" in CASH is not a "SHORT" in STOCK.
CREATE TABLE "ReasonCode" (
  "id"        TEXT NOT NULL,
  "cafeId"    TEXT NOT NULL,
  "domain"    "ReasonDomain" NOT NULL,
  "code"      TEXT NOT NULL,
  "label"     TEXT NOT NULL,
  "isActive"  BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReasonCode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReasonCode_cafeId_domain_code_key" ON "ReasonCode"("cafeId", "domain", "code");
CREATE INDEX "ReasonCode_cafeId_domain_idx" ON "ReasonCode"("cafeId", "domain");

ALTER TABLE "ReasonCode" ADD CONSTRAINT "ReasonCode_cafeId_fkey"
  FOREIGN KEY ("cafeId") REFERENCES "Cafe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Café-level count configuration. Column DEFAULTs are what a NEW café gets.
ALTER TABLE "CafeSettings"
  ADD COLUMN "stockCountPolicy"  "StockCountPolicy" NOT NULL DEFAULT 'HYBRID',
  ADD COLUMN "handoverCountType" "StockCountType"   NOT NULL DEFAULT 'CRITICAL',
  ADD COLUMN "periodicCountType" "StockCountType"   NOT NULL DEFAULT 'FULL',
  ADD COLUMN "stockCountMode"    "StockCountMode"   NOT NULL DEFAULT 'BLIND';

-- …and every café that already exists is pinned to today's behaviour, which
-- is "we do not count at handover". This UPDATE is the whole reason the
-- column default and the backfill differ.
UPDATE "CafeSettings" SET "stockCountPolicy" = 'NO_SHIFT_COUNT';

-- Branch overrides. NULL means inherit — the same shape
-- dineInServingPolicyOverride already uses, so a branch that has never been
-- configured stays distinguishable from one deliberately set to its café's
-- value.
ALTER TABLE "Branch"
  ADD COLUMN "stockCountPolicyOverride"  "StockCountPolicy",
  ADD COLUMN "handoverCountTypeOverride" "StockCountType",
  ADD COLUMN "periodicCountTypeOverride" "StockCountType",
  ADD COLUMN "stockCountModeOverride"    "StockCountMode";

-- Criticality: opt-in, per item, chosen by the owner. No backfill sets it.
ALTER TABLE "InventoryItem" ADD COLUMN "isCritical" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "InventoryItem_branchId_isCritical_archivedAt_idx"
  ON "InventoryItem"("branchId", "isCritical", "archivedAt");
