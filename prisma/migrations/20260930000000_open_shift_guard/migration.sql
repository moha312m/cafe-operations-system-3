-- M25 — one OPEN shift per cashier per branch.
--
-- The POS has always held this rule: `POST /api/shifts` looks for the
-- cashier's OPEN shift and, finding one, answers `alreadyOpen` rather than
-- opening a second drawer. But it was held by a read, and a read takes no
-- lock under READ COMMITTED — the default here, and the only isolation level
-- this repository configures. One cashier signing in on two devices passed
-- the check twice and opened two drawers in their own name, and the close
-- then reconciled against half the shift.
--
-- Partial, and deliberately `OPEN` only, which is exactly what the code
-- enforces: both `shifts/route.ts` and `getActiveShift` filter on
-- `status = 'OPEN'`. `AWAITING_HANDOVER` is excluded on purpose — refusing a
-- cashier a new shift while a handover is still outstanding would be a new
-- business rule rather than a repair, and the custody gate already governs
-- that case.
--
-- Same shape as the four partial unique indexes already in this schema
-- (CustodyPeriod_one_open_per_branch_scope, the stock-count and handover
-- session guards, and TableSession_one_open_per_branch_table from M24). Like
-- those, the index exists only here: Prisma's schema language cannot express
-- a partial index, so prisma/schema.prisma is deliberately unchanged.
--
-- Safe to apply: production was verified clean of duplicate OPEN shifts
-- before this was written, and the index would refuse to build against
-- duplicates — which is why the preflight came first. The test suite needed
-- its own remediation before this could land at all: a good deal of it opened
-- a second drawer per test and left the previous one open, a state no café
-- can be in. That work is done (Shift Fixture Remediation Phases 1 and 2).
--
-- Rollback:
--   DROP INDEX "Shift_one_open_per_branch_cashier";

CREATE UNIQUE INDEX "Shift_one_open_per_branch_cashier"
  ON "Shift"("branchId", "cashierId")
  WHERE "status" = 'OPEN';
