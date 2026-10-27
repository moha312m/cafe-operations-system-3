CREATE TABLE "BranchReportingVersion" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "branchId" TEXT NOT NULL REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "effectiveDate" TEXT NOT NULL,
 "startTime" TEXT NOT NULL,
 "endTime" TEXT NOT NULL,
 "timezone" TEXT NOT NULL,
 "is24Hours" BOOLEAN NOT NULL,
 "createdById" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "BranchReportingVersion_time_check" CHECK (
   "startTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND
   "endTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND
   ("is24Hours" = ("startTime" = "endTime"))
 )
);
CREATE UNIQUE INDEX "BranchReportingVersion_branchId_effectiveDate_key" ON "BranchReportingVersion"("branchId", "effectiveDate");
