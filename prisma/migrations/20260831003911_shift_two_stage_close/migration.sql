-- M21 — the two-stage close on Shift.
--
-- `handoverRequired` records the verdict THIS close reached, so a later
-- configuration change cannot retroactively rewrite whether a shift owed a
-- handover. `financiallyClosedAt` is stamped on either path; `stockClosedAt`
-- stays NULL until handover acceptance answers for the shelf.
--
-- Every column is additive: existing rows keep their history, take the
-- `false` default and two NULLs, and nothing is backfilled. A shift closed
-- before this migration truthfully has no answer for these, and inventing
-- one would be a statement nobody made.

-- AlterTable
ALTER TABLE "Shift" ADD COLUMN     "handoverRequired" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "financiallyClosedAt" TIMESTAMP(3),
ADD COLUMN     "stockClosedAt" TIMESTAMP(3);
