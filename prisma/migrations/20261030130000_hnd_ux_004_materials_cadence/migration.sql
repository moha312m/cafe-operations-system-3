-- HND-UX-004: materials-count cadence, recorded outgoing differences and the
-- per-close materials decision. Additive only: existing branches keep
-- EVERY_SHIFT, which is how every handover-enabled branch already behaved.

-- CreateEnum
CREATE TYPE "MaterialsCountCadence" AS ENUM ('EVERY_SHIFT', 'DAILY', 'WEEKLY');

-- AlterEnum
ALTER TYPE "CountLineDisposition" ADD VALUE 'VARIANCE_RECORDED';

-- AlterTable
ALTER TABLE "Branch" ADD COLUMN     "materialsCountCadence" "MaterialsCountCadence" NOT NULL DEFAULT 'EVERY_SHIFT',
ADD COLUMN     "materialsCountCutoff" TEXT,
ADD COLUMN     "materialsCountWeekday" INTEGER,
ADD COLUMN     "materialsScheduleSince" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "HandoverSession" ADD COLUMN     "outgoingNote" TEXT;

-- CreateTable
CREATE TABLE "ShiftMaterialsDecision" (
    "id" TEXT NOT NULL,
    "cafeId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "handoverId" TEXT,
    "cadence" "MaterialsCountCadence" NOT NULL,
    "weekday" INTEGER,
    "cutoff" TEXT,
    "timezone" TEXT NOT NULL,
    "due" BOOLEAN NOT NULL,
    "reason" TEXT NOT NULL,
    "fullCountDue" BOOLEAN NOT NULL DEFAULT false,
    "periodFrom" TEXT,
    "periodTo" TEXT,
    "coverageFrom" TIMESTAMP(3),
    "nextDueAt" TIMESTAMP(3),
    "satisfiedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShiftMaterialsDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShiftMaterialsDecision_shiftId_key" ON "ShiftMaterialsDecision"("shiftId");

-- CreateIndex
CREATE UNIQUE INDEX "ShiftMaterialsDecision_handoverId_key" ON "ShiftMaterialsDecision"("handoverId");

-- CreateIndex
CREATE INDEX "ShiftMaterialsDecision_branchId_cadence_periodTo_idx" ON "ShiftMaterialsDecision"("branchId", "cadence", "periodTo");

-- AddForeignKey
ALTER TABLE "ShiftMaterialsDecision" ADD CONSTRAINT "ShiftMaterialsDecision_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftMaterialsDecision" ADD CONSTRAINT "ShiftMaterialsDecision_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftMaterialsDecision" ADD CONSTRAINT "ShiftMaterialsDecision_handoverId_fkey" FOREIGN KEY ("handoverId") REFERENCES "HandoverSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- One close may claim a business period. A retry or a concurrent close that
-- computed the same period loses here rather than satisfying it twice.
CREATE UNIQUE INDEX "ShiftMaterialsDecision_one_claim_per_period"
  ON "ShiftMaterialsDecision"("branchId", "cadence", "periodTo")
  WHERE "periodTo" IS NOT NULL;

ALTER TABLE "Branch" ADD CONSTRAINT "Branch_materials_schedule_check" CHECK (
  ("materialsCountWeekday" IS NULL OR "materialsCountWeekday" BETWEEN 0 AND 6) AND
  ("materialsCountCutoff" IS NULL OR "materialsCountCutoff" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') AND
  ("materialsCountCadence" <> 'WEEKLY' OR "materialsCountWeekday" IS NOT NULL) AND
  ("materialsCountCadence" = 'EVERY_SHIFT' OR "materialsCountCutoff" IS NOT NULL)
);
