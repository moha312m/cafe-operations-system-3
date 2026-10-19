CREATE TYPE "OwnerAction" AS ENUM ('CANCEL_ORDER', 'VOID_ORDER_ITEM', 'REFUND_ORDER', 'REFUND_PAYMENT');
CREATE TYPE "OwnerActionMode" AS ENUM ('OWNER_REQUEST', 'OWNER_PASSCODE', 'EITHER');
CREATE TYPE "OwnerActionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXECUTED', 'STALE', 'EXPIRED');

CREATE TABLE "OwnerActionSettings" (
  "id" TEXT NOT NULL,
  "cafeId" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "refundMode" "OwnerActionMode" NOT NULL DEFAULT 'OWNER_REQUEST',
  "cancelMode" "OwnerActionMode" NOT NULL DEFAULT 'OWNER_REQUEST',
  "itemVoidMode" "OwnerActionMode" NOT NULL DEFAULT 'OWNER_REQUEST',
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OwnerActionSettings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OwnerActionSettings_cafeId_fkey" FOREIGN KEY ("cafeId") REFERENCES "Cafe"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "OwnerActionSettings_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "OwnerActionSettings_cafeId_key" ON "OwnerActionSettings"("cafeId");

CREATE TABLE "OwnerActionRequest" (
  "id" TEXT NOT NULL,
  "cafeId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "requesterId" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "action" "OwnerAction" NOT NULL,
  "targetOrderId" TEXT,
  "targetOrderItemId" TEXT,
  "targetPaymentId" TEXT,
  "reason" TEXT NOT NULL,
  "targetSnapshot" JSONB NOT NULL,
  "targetFingerprint" VARCHAR(64) NOT NULL,
  "amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
  "mode" "OwnerActionMode" NOT NULL,
  "settingsVersion" INTEGER NOT NULL,
  "status" "OwnerActionStatus" NOT NULL DEFAULT 'PENDING',
  "idempotencyKey" VARCHAR(64) NOT NULL,
  "credentialVersion" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "decidedAt" TIMESTAMP(3),
  "decidedById" TEXT,
  "decisionNote" TEXT,
  "executedAt" TIMESTAMP(3),
  "executorId" TEXT,
  "executionIdempotencyKey" VARCHAR(64),
  CONSTRAINT "OwnerActionRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OwnerActionRequest_target_shape_check" CHECK (
    ("action" IN ('CANCEL_ORDER', 'REFUND_ORDER') AND "targetOrderId" IS NOT NULL AND "targetOrderItemId" IS NULL AND "targetPaymentId" IS NULL) OR
    ("action" = 'VOID_ORDER_ITEM' AND "targetOrderId" IS NOT NULL AND "targetOrderItemId" IS NOT NULL AND "targetPaymentId" IS NULL) OR
    ("action" = 'REFUND_PAYMENT' AND "targetPaymentId" IS NOT NULL AND "targetOrderItemId" IS NULL)
  ),
  CONSTRAINT "OwnerActionRequest_cafeId_fkey" FOREIGN KEY ("cafeId") REFERENCES "Cafe"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "OwnerActionRequest_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "OwnerActionRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "OwnerActionRequest_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "OwnerActionRequest_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "OwnerActionRequest_executorId_fkey" FOREIGN KEY ("executorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "OwnerActionRequest_targetOrderId_fkey" FOREIGN KEY ("targetOrderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "OwnerActionRequest_targetOrderItemId_fkey" FOREIGN KEY ("targetOrderItemId") REFERENCES "OrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "OwnerActionRequest_targetPaymentId_fkey" FOREIGN KEY ("targetPaymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "OwnerActionRequest_requesterId_idempotencyKey_key" ON "OwnerActionRequest"("requesterId", "idempotencyKey");
CREATE INDEX "OwnerActionRequest_cafeId_status_createdAt_idx" ON "OwnerActionRequest"("cafeId", "status", "createdAt");
CREATE INDEX "OwnerActionRequest_branchId_status_createdAt_idx" ON "OwnerActionRequest"("branchId", "status", "createdAt");
CREATE INDEX "OwnerActionRequest_ownerId_status_createdAt_idx" ON "OwnerActionRequest"("ownerId", "status", "createdAt");
CREATE INDEX "OwnerActionRequest_targetOrderId_idx" ON "OwnerActionRequest"("targetOrderId");
CREATE INDEX "OwnerActionRequest_targetPaymentId_idx" ON "OwnerActionRequest"("targetPaymentId");
CREATE INDEX "OwnerActionRequest_targetOrderItemId_idx" ON "OwnerActionRequest"("targetOrderItemId");

CREATE TABLE "OwnerActionEvent" (
  "id" TEXT NOT NULL,
  "cafeId" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "event" VARCHAR(40) NOT NULL,
  "note" TEXT,
  "details" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OwnerActionEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OwnerActionEvent_cafeId_fkey" FOREIGN KEY ("cafeId") REFERENCES "Cafe"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "OwnerActionEvent_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "OwnerActionRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "OwnerActionEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "OwnerActionEvent_cafeId_createdAt_idx" ON "OwnerActionEvent"("cafeId", "createdAt");
CREATE INDEX "OwnerActionEvent_requestId_createdAt_idx" ON "OwnerActionEvent"("requestId", "createdAt");