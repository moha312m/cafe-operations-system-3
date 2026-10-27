-- Additive assignment metadata only. No existing stock, shifts, custody or users are rewritten.
ALTER TABLE "User"
  ADD COLUMN "temporaryBranchId" TEXT,
  ADD COLUMN "temporaryBranchUntil" TIMESTAMP(3),
  ADD COLUMN "temporaryBranchStartedAt" TIMESTAMP(3),
  ADD COLUMN "temporaryBranchCancelledAt" TIMESTAMP(3);
ALTER TABLE "User" ADD CONSTRAINT "User_temporaryBranchId_fkey"
  FOREIGN KEY ("temporaryBranchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
