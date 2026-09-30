-- Owner-selected periodic FULL-count boundary per cafe, with optional branch
-- overrides. MANUAL_ONLY is intentionally safe for every existing cafe.

CREATE TYPE "PeriodicFullCountSchedule" AS ENUM (
  'DAILY_LAST_HANDOVER',
  'WEEKLY',
  'MANUAL_ONLY'
);

ALTER TABLE "CafeSettings"
  ADD COLUMN "periodicFullCountSchedule" "PeriodicFullCountSchedule" NOT NULL DEFAULT 'MANUAL_ONLY',
  ADD COLUMN "periodicFullCountWeekday" INTEGER;

ALTER TABLE "Branch"
  ADD COLUMN "periodicFullCountScheduleOverride" "PeriodicFullCountSchedule",
  ADD COLUMN "periodicFullCountWeekdayOverride" INTEGER;

ALTER TABLE "CafeSettings" ADD CONSTRAINT "CafeSettings_weekly_needs_weekday"
  CHECK ("periodicFullCountSchedule" <> 'WEEKLY'
    OR ("periodicFullCountWeekday" IS NOT NULL AND "periodicFullCountWeekday" BETWEEN 0 AND 6));
ALTER TABLE "CafeSettings" ADD CONSTRAINT "CafeSettings_nonweekly_has_no_weekday"
  CHECK ("periodicFullCountSchedule" = 'WEEKLY' OR "periodicFullCountWeekday" IS NULL);

ALTER TABLE "Branch" ADD CONSTRAINT "Branch_weekly_needs_weekday"
  CHECK ("periodicFullCountScheduleOverride" IS DISTINCT FROM 'WEEKLY'
    OR ("periodicFullCountWeekdayOverride" IS NOT NULL AND "periodicFullCountWeekdayOverride" BETWEEN 0 AND 6));
ALTER TABLE "Branch" ADD CONSTRAINT "Branch_nonweekly_has_no_weekday"
  CHECK ("periodicFullCountScheduleOverride" IS NOT DISTINCT FROM 'WEEKLY'
    OR "periodicFullCountWeekdayOverride" IS NULL);
