CREATE TABLE "AmendmentTenderReference" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "cafeId" TEXT NOT NULL,
 "branchId" TEXT NOT NULL,
 "attemptId" TEXT NOT NULL REFERENCES "AmendmentSettlement"("id") ON DELETE RESTRICT,
 "method" TEXT NOT NULL CHECK ("method" IN ('CARD','WALLET')),
 "reference" VARCHAR(200) NOT NULL CHECK (length(trim("reference")) >= 3),
 "actorId" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "AmendmentTenderReference_cafeId_method_reference_key" ON "AmendmentTenderReference" ("cafeId","method","reference");
CREATE INDEX "AmendmentTenderReference_attemptId_idx" ON "AmendmentTenderReference" ("attemptId");
CREATE TRIGGER "AmendmentTenderReference_immutable" BEFORE UPDATE OR DELETE ON "AmendmentTenderReference" FOR EACH ROW EXECUTE FUNCTION nextcup_sales_evidence_immutable();
