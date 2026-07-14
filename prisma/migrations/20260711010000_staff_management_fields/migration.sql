-- Staff management: phone, last login tracking, and soft-delete (archive).
-- Additive only — existing users keep working (all columns nullable).

ALTER TABLE "User"
  ADD COLUMN "phone" TEXT,
  ADD COLUMN "lastLoginAt" TIMESTAMP(3),
  ADD COLUMN "archivedAt" TIMESTAMP(3);
