-- M24 — one OPEN table session per table.
--
-- `attachOrderToTableSession` decided whether a table already had a bill by
-- reading for one, and nothing else. That read takes no lock, and READ
-- COMMITTED — the default here, and the only isolation level this repository
-- configures — lets two callers pass the same check and both create. Two
-- waiters ringing up one table opened two bills for it, and the customer's
-- money landed on whichever the till happened to read next.
--
-- Partial, and deliberately `OPEN` only. That is exactly what the code
-- enforces: the session lookup filters on `status = 'OPEN'`. A table is used
-- many times a day, so CLOSED and CANCELLED sessions must be free to repeat
-- for the same table — only the live bill is unique.
--
-- Refusing the second write is only half the repair. A waiter who loses the
-- race must not be shown an error: the customer is sitting at ONE table and
-- expects ONE bill, so the loser retries, finds the bill the winner just
-- opened, and joins it. See attachOrderToTableSession.
--
-- Same shape as the three partial unique indexes already in this schema
-- (CustodyPeriod_one_open_per_branch_scope and the stock-count and handover
-- session guards). Like those, the index exists only here: Prisma's schema
-- language cannot express a partial index, so prisma/schema.prisma is
-- deliberately unchanged.
--
-- Safe to apply: production was verified immediately beforehand — zero
-- duplicate OPEN sessions. The index would have failed to build against
-- duplicates, which is why the preflight came first.
--
-- The matching guard for Shift (one OPEN shift per branch/cashier) is NOT
-- here. It is correct, but it is incompatible with existing test fixtures
-- that open a second drawer for the same cashier without closing the first,
-- and it is deferred to its own stage behind that remediation.
--
-- Rollback:
--   DROP INDEX "TableSession_one_open_per_branch_table";

CREATE UNIQUE INDEX "TableSession_one_open_per_branch_table"
  ON "TableSession"("branchId", "tableNumber")
  WHERE "status" = 'OPEN';
