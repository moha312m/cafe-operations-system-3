-- WhatsApp Business shift report: the café's connection and a delivery log.
-- Additive only: two new tables, nothing existing is altered.

-- CreateTable
CREATE TABLE "WhatsAppIntegration" (
    "id" TEXT NOT NULL,
    "cafeId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "phoneNumberId" TEXT,
    "accessTokenCipher" TEXT,
    "templateName" TEXT,
    "templateLanguage" TEXT NOT NULL DEFAULT 'ar',
    "recipientPhone" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppIntegration_pkey" PRIMARY KEY ("id"),
    -- Enabled means every field a send needs is present.
    CONSTRAINT "WhatsAppIntegration_enabled_complete" CHECK (
        NOT "enabled" OR (
            "phoneNumberId" IS NOT NULL AND "accessTokenCipher" IS NOT NULL
            AND "templateName" IS NOT NULL AND "recipientPhone" IS NOT NULL
        )
    )
);

-- CreateTable
CREATE TABLE "WhatsAppMessageLog" (
    "id" TEXT NOT NULL,
    "cafeId" TEXT NOT NULL,
    "branchId" TEXT,
    "shiftId" TEXT,
    "kind" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "providerMessageId" TEXT,
    "error" TEXT,
    "recipientMasked" TEXT,
    "triggeredById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsAppMessageLog_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "WhatsAppMessageLog_status_check" CHECK ("status" IN ('SENT', 'FAILED')),
    CONSTRAINT "WhatsAppMessageLog_trigger_check" CHECK ("trigger" IN ('AUTO', 'MANUAL', 'TEST'))
);

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppIntegration_cafeId_key" ON "WhatsAppIntegration"("cafeId");

-- CreateIndex
CREATE INDEX "WhatsAppMessageLog_cafeId_createdAt_idx" ON "WhatsAppMessageLog"("cafeId", "createdAt");

-- CreateIndex
CREATE INDEX "WhatsAppMessageLog_shiftId_kind_status_idx" ON "WhatsAppMessageLog"("shiftId", "kind", "status");

-- AddForeignKey
ALTER TABLE "WhatsAppIntegration" ADD CONSTRAINT "WhatsAppIntegration_cafeId_fkey" FOREIGN KEY ("cafeId") REFERENCES "Cafe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppMessageLog" ADD CONSTRAINT "WhatsAppMessageLog_cafeId_fkey" FOREIGN KEY ("cafeId") REFERENCES "Cafe"("id") ON DELETE CASCADE ON UPDATE CASCADE;
