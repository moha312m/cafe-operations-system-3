-- M20 — the AWAITING_HANDOVER shift status, and nothing else.
--
-- It ships alone because PostgreSQL will not let a value added by
-- `ALTER TYPE ... ADD VALUE` be USED by the same transaction that added it.
-- Prisma runs every migration in its own transaction, so this one has to
-- commit before M21's columns, the application code or any test may name it.
--
-- `BEFORE 'CLOSED'` keeps the stored enum in the datamodel's order — a shift
-- moves OPEN -> AWAITING_HANDOVER -> CLOSED, and sorting on the column should
-- say so.

-- AlterEnum
ALTER TYPE "ShiftStatus" ADD VALUE 'AWAITING_HANDOVER' BEFORE 'CLOSED';
