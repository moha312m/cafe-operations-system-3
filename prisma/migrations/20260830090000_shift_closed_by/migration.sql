-- Who accepted the cash count, recorded on the close itself.
--
-- A shift close is the moment a named custodian is discharged of the money
-- they were holding. "Shift"."cashierId" says who HELD the drawer; nothing
-- said who ACCEPTED the count. Those are different people whenever a manager
-- closes somebody else's shift, which is an ordinary and deliberately
-- supervised act — the route has always permitted it and has always recorded
-- "closedByManager: true" in the audit line.
--
-- Until now that audit line was the only place the closer's identity existed.
-- That is enough to answer "who did this" when somebody goes looking, and not
-- enough for what T33 needs: a completed cash close has to be a self-contained
-- historical record — expected, counted, variance, reason, actor, time — so
-- the owner's external accounting can read one row per close instead of
-- joining AuditLog on an action string and parsing a JSON blob for the actor.
--
-- Everything else T33 needs already exists and is reused rather than
-- duplicated: "expectedCashAmount", "actualCashAmount" and "cashDifference"
-- are the pre-existing close columns, "cashReasonNote" is the reason field
-- T16 added and nothing had yet written, and "cashVarianceCaseId" is the link
-- T18 created with the VarianceCase table. This column is the one gap.
--
-- NULLABLE, and deliberately not backfilled. A shift closed before this
-- migration truthfully has no recorded closer, and defaulting it to
-- "cashierId" would manufacture an acceptance nobody performed — precisely the
-- kind of invented evidence the cash-reconciliation columns were left NULL to
-- avoid when T16 added them (see CASH-001, which asserts that emptiness).

ALTER TABLE "Shift" ADD COLUMN "closedById" TEXT;

-- ON DELETE SET NULL, which differs from "cashierId" on purpose.
--
-- The custodian is load-bearing evidence: a shift may not outlive the person
-- answerable for its drawer, so that key restricts. Who signed the close is a
-- fact about an act rather than a party to it, and archiving a manager years
-- later must not be blocked by, nor silently erase, the shifts they closed —
-- the audit row and the variance case still name them.
ALTER TABLE "Shift"
  ADD CONSTRAINT "Shift_closedById_fkey"
  FOREIGN KEY ("closedById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- "which shifts did this person close" is a supervision question somebody will
-- actually ask, and the column is highly selective.
CREATE INDEX "Shift_closedById_idx" ON "Shift"("closedById");
