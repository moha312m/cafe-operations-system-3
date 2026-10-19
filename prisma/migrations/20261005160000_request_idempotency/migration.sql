ALTER TYPE "ShiftStatus" ADD VALUE IF NOT EXISTS 'SUSPENDED';
CREATE TYPE "IdempotencyStatus" AS ENUM ('STARTED', 'COMPLETED');
CREATE TABLE "IdempotencyKey" (
  "id" TEXT PRIMARY KEY,
  "scope" VARCHAR(512) NOT NULL,
  "key" VARCHAR(128) NOT NULL,
  "requestHash" VARCHAR(64) NOT NULL,
  "status" "IdempotencyStatus" NOT NULL DEFAULT 'STARTED',
  "ownerToken" TEXT NOT NULL,
  "lockedUntil" TIMESTAMP(3) NOT NULL,
  "response" JSONB,
  "statusCode" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "IdempotencyKey_scope_key_key" ON "IdempotencyKey" ("scope", "key");
CREATE INDEX "IdempotencyKey_status_lockedUntil_idx" ON "IdempotencyKey" ("status", "lockedUntil");
