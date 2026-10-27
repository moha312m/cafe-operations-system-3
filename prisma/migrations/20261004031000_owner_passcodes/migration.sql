CREATE TYPE "OwnerActionApprovalMethod" AS ENUM ('OWNER_REQUEST', 'OWNER_PASSCODE');
ALTER TABLE "OwnerActionRequest" ADD COLUMN "decisionMethod" "OwnerActionApprovalMethod";

CREATE TABLE "OwnerPasscode" (
  "id" TEXT NOT NULL,
  "cafeId" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "passcodeHash" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OwnerPasscode_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OwnerPasscode_cafeId_fkey" FOREIGN KEY ("cafeId") REFERENCES "Cafe"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "OwnerPasscode_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "OwnerPasscode_cafeId_key" ON "OwnerPasscode"("cafeId");

CREATE TABLE "OwnerPasscodeAttempt" (
  "id" TEXT NOT NULL,
  "cafeId" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "passcodeId" TEXT NOT NULL,
  "requesterId" TEXT NOT NULL,
  "requestId" TEXT,
  "success" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OwnerPasscodeAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OwnerPasscodeAttempt_cafeId_fkey" FOREIGN KEY ("cafeId") REFERENCES "Cafe"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "OwnerPasscodeAttempt_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "OwnerPasscodeAttempt_passcodeId_fkey" FOREIGN KEY ("passcodeId") REFERENCES "OwnerPasscode"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "OwnerPasscodeAttempt_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "OwnerPasscodeAttempt_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "OwnerActionRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "OwnerPasscodeAttempt_cafeId_ownerId_requesterId_createdAt_idx" ON "OwnerPasscodeAttempt"("cafeId", "ownerId", "requesterId", "createdAt");
CREATE INDEX "OwnerPasscodeAttempt_requestId_idx" ON "OwnerPasscodeAttempt"("requestId");