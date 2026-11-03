-- AlterTable
ALTER TABLE "Shift" ADD COLUMN     "totalExpensePayouts" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "totalExpenseReturns" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "ExpenseCategory" (
    "id" TEXT NOT NULL,
    "cafeId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpenseCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperatingExpense" (
    "id" TEXT NOT NULL,
    "cafeId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "categoryCodeSnapshot" TEXT NOT NULL,
    "categoryNameSnapshot" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EGP',
    "description" TEXT NOT NULL,
    "documentReference" TEXT,
    "actorId" TEXT NOT NULL,
    "actorNameSnapshot" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotencyScope" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,

    CONSTRAINT "OperatingExpense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperatingExpenseReturn" (
    "id" TEXT NOT NULL,
    "expenseId" TEXT NOT NULL,
    "cafeId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EGP',
    "reason" TEXT NOT NULL,
    "documentReference" TEXT,
    "actorId" TEXT NOT NULL,
    "actorNameSnapshot" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotencyScope" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,

    CONSTRAINT "OperatingExpenseReturn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExpenseCategory_cafeId_archivedAt_idx" ON "ExpenseCategory"("cafeId", "archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseCategory_cafeId_code_key" ON "ExpenseCategory"("cafeId", "code");

-- CreateIndex
CREATE INDEX "OperatingExpense_cafeId_branchId_occurredAt_idx" ON "OperatingExpense"("cafeId", "branchId", "occurredAt");

-- CreateIndex
CREATE INDEX "OperatingExpense_shiftId_idx" ON "OperatingExpense"("shiftId");

-- CreateIndex
CREATE UNIQUE INDEX "OperatingExpense_idempotencyScope_idempotencyKey_key" ON "OperatingExpense"("idempotencyScope", "idempotencyKey");

-- CreateIndex
CREATE INDEX "OperatingExpenseReturn_cafeId_branchId_occurredAt_idx" ON "OperatingExpenseReturn"("cafeId", "branchId", "occurredAt");

-- CreateIndex
CREATE INDEX "OperatingExpenseReturn_shiftId_idx" ON "OperatingExpenseReturn"("shiftId");

-- CreateIndex
CREATE INDEX "OperatingExpenseReturn_expenseId_idx" ON "OperatingExpenseReturn"("expenseId");

-- CreateIndex
CREATE UNIQUE INDEX "OperatingExpenseReturn_idempotencyScope_idempotencyKey_key" ON "OperatingExpenseReturn"("idempotencyScope", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "ExpenseCategory" ADD CONSTRAINT "ExpenseCategory_cafeId_fkey" FOREIGN KEY ("cafeId") REFERENCES "Cafe"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseCategory" ADD CONSTRAINT "ExpenseCategory_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperatingExpense" ADD CONSTRAINT "OperatingExpense_cafeId_fkey" FOREIGN KEY ("cafeId") REFERENCES "Cafe"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperatingExpense" ADD CONSTRAINT "OperatingExpense_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperatingExpense" ADD CONSTRAINT "OperatingExpense_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperatingExpense" ADD CONSTRAINT "OperatingExpense_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ExpenseCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperatingExpense" ADD CONSTRAINT "OperatingExpense_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperatingExpenseReturn" ADD CONSTRAINT "OperatingExpenseReturn_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "OperatingExpense"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperatingExpenseReturn" ADD CONSTRAINT "OperatingExpenseReturn_cafeId_fkey" FOREIGN KEY ("cafeId") REFERENCES "Cafe"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperatingExpenseReturn" ADD CONSTRAINT "OperatingExpenseReturn_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperatingExpenseReturn" ADD CONSTRAINT "OperatingExpenseReturn_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperatingExpenseReturn" ADD CONSTRAINT "OperatingExpenseReturn_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ACC-01A guards. File creation only; NOT applied by this delivery.
ALTER TABLE "OperatingExpense" ADD CONSTRAINT "OperatingExpense_amount_check" CHECK ("amount" > 0 AND "amount" <> 'NaN'::numeric AND "currency" = 'EGP');
ALTER TABLE "OperatingExpenseReturn" ADD CONSTRAINT "OperatingExpenseReturn_amount_check" CHECK ("amount" > 0 AND "amount" <> 'NaN'::numeric AND "currency" = 'EGP');

CREATE FUNCTION "immutable_operating_expense"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Executed expense evidence is append-only' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER "OperatingExpense_immutable" BEFORE UPDATE OR DELETE ON "OperatingExpense" FOR EACH ROW EXECUTE FUNCTION "immutable_operating_expense"();
CREATE TRIGGER "OperatingExpenseReturn_immutable" BEFORE UPDATE OR DELETE ON "OperatingExpenseReturn" FOR EACH ROW EXECUTE FUNCTION "immutable_operating_expense"();

CREATE FUNCTION "validate_operating_expense"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  drawer "Shift"%ROWTYPE;
  original "OperatingExpense"%ROWTYPE;
  category "ExpenseCategory"%ROWTYPE;
  received NUMERIC;
BEGIN
  -- Same source lock order as the application: Shift, then original expense.
  SELECT * INTO drawer FROM "Shift" WHERE "id" = NEW."shiftId" FOR UPDATE;
  IF NOT FOUND OR drawer."cafeId" <> NEW."cafeId" OR drawer."branchId" <> NEW."branchId" OR drawer."status" <> 'OPEN'
     OR drawer."cashierId" <> NEW."actorId" OR drawer."custodyGateReason" IS NOT NULL THEN
    RAISE EXCEPTION 'Expense requires the same scoped open drawer and its custodian' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "User" WHERE "id"=NEW."actorId" AND "cafeId"=NEW."cafeId" AND "isActive" AND "archivedAt" IS NULL AND "role" IN ('CAFE_OWNER','BRANCH_MANAGER')) THEN
    RAISE EXCEPTION 'Expense actor is not eligible' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'OperatingExpense' THEN
    SELECT * INTO category FROM "ExpenseCategory" WHERE "id"=NEW."categoryId" AND "cafeId"=NEW."cafeId" AND "archivedAt" IS NULL FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Expense category is not active in this cafe' USING ERRCODE = '23514'; END IF;
    NEW."categoryCodeSnapshot" := category."code";
    NEW."categoryNameSnapshot" := category."nameAr";
  ELSE
    SELECT * INTO original FROM "OperatingExpense" WHERE "id"=NEW."expenseId" FOR UPDATE;
    IF NOT FOUND OR original."cafeId" <> NEW."cafeId" OR original."branchId" <> NEW."branchId" OR original."shiftId" <> NEW."shiftId" OR original."currency" <> NEW."currency" THEN
      RAISE EXCEPTION 'Cash return must belong to the original drawer and expense' USING ERRCODE = '23514';
    END IF;
    SELECT COALESCE(SUM("amount"),0) INTO received FROM "OperatingExpenseReturn" WHERE "expenseId"=original."id";
    IF received + NEW."amount" > original."amount" THEN
      RAISE EXCEPTION 'Cumulative cash returns exceed the payout' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "OperatingExpense_validate" BEFORE INSERT ON "OperatingExpense" FOR EACH ROW EXECUTE FUNCTION "validate_operating_expense"();
CREATE TRIGGER "OperatingExpenseReturn_validate" BEFORE INSERT ON "OperatingExpenseReturn" FOR EACH ROW EXECUTE FUNCTION "validate_operating_expense"();
-- New eligible sources participate in G1, even while their posting is unsupported.
CREATE TRIGGER "OperatingExpense_accounting_close_gate" AFTER INSERT OR UPDATE OR DELETE ON "OperatingExpense" FOR EACH ROW EXECUTE FUNCTION "accounting_close_gate"();
CREATE TRIGGER "OperatingExpenseReturn_accounting_close_gate" AFTER INSERT OR UPDATE OR DELETE ON "OperatingExpenseReturn" FOR EACH ROW EXECUTE FUNCTION "accounting_close_gate"();
