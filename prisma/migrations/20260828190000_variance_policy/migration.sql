-- Keep the shop open unless the owner says otherwise.
--
-- Whether a variance stops a handover is a business decision, not a product
-- constant. A café that finds an 18 g coffee discrepancy every evening and a
-- café that treats any shortage as a stop-the-line event are both being
-- reasonable, and the software's job is to hold whichever one the owner
-- chose.
--
-- So this is additive and permissive. The DEFAULT is what a NEW café gets;
-- the explicit UPDATE below pins every EXISTING café to the same permissive
-- values, because a column default does not touch rows that already exist
-- and a shop must not wake up signed into blocking it never agreed to.
--
-- This is its own migration for the reason item 7 exists: an earlier revision
-- added these columns by editing an already-applied migration, which is how a
-- deployed database and a repository come to disagree permanently. No task in
-- this plan edits a migration a prior task applied, and VAR-003 asserts it.

ALTER TABLE "CafeSettings"
  ADD COLUMN "varianceBlocksHandover"          BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "varianceHardBlockAmount"         DECIMAL(10,2),
  ADD COLUMN "recountRequiredOutsideTolerance" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "recountMaxAttempts"              INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN "allowSelfRecount"                BOOLEAN NOT NULL DEFAULT true;

-- Explicit backfill. Redundant against the defaults above for rows created
-- from now on, and NOT redundant for the rows already there — stating it is
-- what makes the intent for existing cafés reviewable rather than inferred.
UPDATE "CafeSettings" SET
  "varianceBlocksHandover"          = false,
  "varianceHardBlockAmount"         = NULL,
  "recountRequiredOutsideTolerance" = true,
  "recountMaxAttempts"              = 2,
  "allowSelfRecount"                = true;
