-- CreateEnum
CREATE TYPE "ShiftCustodyGate" AS ENUM ('AWAITING_CUSTODY_TRANSFER', 'AWAITING_OPENING_VERIFICATION');

-- AlterTable
ALTER TABLE "Shift"
  ADD COLUMN "custodyReadyAt" TIMESTAMP(3),
  ADD COLUMN "custodyGateReason" "ShiftCustodyGate";

-- CreateIndex
CREATE INDEX "Shift_branchId_custodyGateReason_idx" ON "Shift"("branchId", "custodyGateReason");

-- CreateIndex
CREATE INDEX "Shift_branchId_custodyReadyAt_idx" ON "Shift"("branchId", "custodyReadyAt");

-- AddConstraint
ALTER TABLE "Shift"
  ADD CONSTRAINT "Shift_custody_gate_ready_consistent"
  CHECK ("custodyGateReason" IS NULL OR "custodyReadyAt" IS NULL);
