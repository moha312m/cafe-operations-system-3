-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE');

-- CreateEnum
CREATE TYPE "BalanceSide" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "AccountingPeriodStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateTable
CREATE TABLE "AccountingEntity" (
    "id" TEXT NOT NULL,
    "cafeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "nextEntryNumber" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountingEntity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountingAccount" (
    "id" TEXT NOT NULL,
    "cafeId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "AccountType" NOT NULL,
    "normalBalance" "BalanceSide" NOT NULL,
    "systemKey" TEXT,
    "isPostable" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "parentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountingAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountingPeriod" (
    "id" TEXT NOT NULL,
    "cafeId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "startsOn" DATE NOT NULL,
    "endsOn" DATE NOT NULL,
    "status" "AccountingPeriodStatus" NOT NULL DEFAULT 'OPEN',
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountingPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalEntry" (
    "id" TEXT NOT NULL,
    "cafeId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "entryDate" DATE NOT NULL,
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "description" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT,
    "sourceKey" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "reversalOfId" TEXT,
    "createdById" TEXT,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalLine" (
    "id" TEXT NOT NULL,
    "cafeId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "branchId" TEXT,
    "debit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "memo" TEXT,

    CONSTRAINT "JournalLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AccountingEntity_cafeId_key" ON "AccountingEntity"("cafeId");

-- CreateIndex
CREATE INDEX "AccountingAccount_cafeId_idx" ON "AccountingAccount"("cafeId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountingAccount_entityId_code_key" ON "AccountingAccount"("entityId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "AccountingAccount_entityId_systemKey_key" ON "AccountingAccount"("entityId", "systemKey");

-- CreateIndex
CREATE INDEX "AccountingPeriod_cafeId_idx" ON "AccountingPeriod"("cafeId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountingPeriod_entityId_startsOn_key" ON "AccountingPeriod"("entityId", "startsOn");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_reversalOfId_key" ON "JournalEntry"("reversalOfId");

-- CreateIndex
CREATE INDEX "JournalEntry_cafeId_idx" ON "JournalEntry"("cafeId");

-- CreateIndex
CREATE INDEX "JournalEntry_periodId_idx" ON "JournalEntry"("periodId");

-- CreateIndex
CREATE INDEX "JournalEntry_entityId_entryDate_idx" ON "JournalEntry"("entityId", "entryDate");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_entityId_number_key" ON "JournalEntry"("entityId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_entityId_sourceKey_key" ON "JournalEntry"("entityId", "sourceKey");

-- CreateIndex
CREATE INDEX "JournalLine_cafeId_idx" ON "JournalLine"("cafeId");

-- CreateIndex
CREATE INDEX "JournalLine_entryId_idx" ON "JournalLine"("entryId");

-- CreateIndex
CREATE INDEX "JournalLine_accountId_idx" ON "JournalLine"("accountId");

-- AddForeignKey
ALTER TABLE "AccountingEntity" ADD CONSTRAINT "AccountingEntity_cafeId_fkey" FOREIGN KEY ("cafeId") REFERENCES "Cafe"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountingAccount" ADD CONSTRAINT "AccountingAccount_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "AccountingEntity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountingAccount" ADD CONSTRAINT "AccountingAccount_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "AccountingAccount"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountingPeriod" ADD CONSTRAINT "AccountingPeriod_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "AccountingEntity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountingPeriod" ADD CONSTRAINT "AccountingPeriod_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "AccountingEntity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "AccountingPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "JournalEntry"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "JournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "AccountingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Ledger invariants ───────────────────────────────────────────────
-- Enforced here and not only in the posting service, so no code path
-- (a script, a future route, a console) can write books that do not balance.

-- A line is one-sided and never negative.
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_one_side_check"
  CHECK ("debit" >= 0 AND "credit" >= 0 AND (("debit" = 0) <> ("credit" = 0)));

ALTER TABLE "AccountingPeriod" ADD CONSTRAINT "AccountingPeriod_range_check"
  CHECK ("endsOn" >= "startsOn");

-- Entries and lines are append-only; a correction is a reversing entry.
CREATE FUNCTION "ledger_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Ledger rows are immutable; post a reversing entry instead' USING ERRCODE = 'check_violation';
END;
$$;
CREATE TRIGGER "JournalEntry_immutable" BEFORE UPDATE OR DELETE ON "JournalEntry"
  FOR EACH ROW EXECUTE FUNCTION "ledger_append_only"();
CREATE TRIGGER "JournalLine_immutable" BEFORE UPDATE OR DELETE ON "JournalLine"
  FOR EACH ROW EXECUTE FUNCTION "ledger_append_only"();

-- A period never moves, never overlaps another, and only goes OPEN -> CLOSED.
CREATE FUNCTION "accounting_period_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Accounting periods are never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'OPEN' THEN
      RAISE EXCEPTION 'A period starts OPEN' USING ERRCODE = 'check_violation';
    END IF;
    -- The entity lock serialises period creation, so two overlapping
    -- periods cannot both pass the check below.
    PERFORM 1 FROM "AccountingEntity" e WHERE e."id" = NEW."entityId" AND e."cafeId" = NEW."cafeId" FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Period entity belongs to another cafe' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM "AccountingPeriod" p WHERE p."entityId" = NEW."entityId"
               AND p."startsOn" <= NEW."endsOn" AND NEW."startsOn" <= p."endsOn") THEN
      RAISE EXCEPTION 'Accounting periods may not overlap' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."entityId" <> OLD."entityId" OR NEW."cafeId" <> OLD."cafeId"
     OR NEW."startsOn" <> OLD."startsOn" OR NEW."endsOn" <> OLD."endsOn" THEN
    RAISE EXCEPTION 'A period never moves' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 'CLOSED' THEN
    RAISE EXCEPTION 'A closed period stays closed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'CLOSED' AND (NEW."closedAt" IS NULL OR NEW."closedById" IS NULL) THEN
    RAISE EXCEPTION 'Closing a period records who and when' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "AccountingPeriod_immutable_guard" BEFORE INSERT OR UPDATE OR DELETE ON "AccountingPeriod"
  FOR EACH ROW EXECUTE FUNCTION "accounting_period_guard"();

-- An entry lands in an OPEN period of its own entity that contains its date.
-- FOR SHARE on the period serialises posting against closing, which takes
-- the period FOR UPDATE: a post either commits before the close or sees it.
CREATE FUNCTION "journal_entry_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  period RECORD;
BEGIN
  -- Prisma stores UTC with milliseconds; compare in the same form.
  NEW."postedAt" := (now() AT TIME ZONE 'UTC')::timestamp(3);
  SELECT p."entityId", p."cafeId", p."status", p."startsOn", p."endsOn" INTO period
    FROM "AccountingPeriod" p WHERE p."id" = NEW."periodId" FOR SHARE;
  IF NOT FOUND OR period."entityId" <> NEW."entityId" OR period."cafeId" <> NEW."cafeId" THEN
    RAISE EXCEPTION 'Entry period belongs to another entity' USING ERRCODE = 'check_violation';
  END IF;
  IF period."status" <> 'OPEN' THEN
    RAISE EXCEPTION 'Accounting period is closed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."entryDate" < period."startsOn" OR NEW."entryDate" > period."endsOn" THEN
    RAISE EXCEPTION 'Entry date is outside its period' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."reversalOfId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "JournalEntry" j WHERE j."id" = NEW."reversalOfId" AND j."entityId" = NEW."entityId") THEN
    RAISE EXCEPTION 'A reversal belongs to the same entity' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "JournalEntry_guard" BEFORE INSERT ON "JournalEntry"
  FOR EACH ROW EXECUTE FUNCTION "journal_entry_guard"();

-- A line belongs to an entry created in this same transaction (postedAt is
-- the transaction timestamp), to a postable, active account of the same
-- entity, and to a branch of the same cafe.
CREATE FUNCTION "journal_line_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  entry RECORD;
BEGIN
  SELECT j."cafeId", j."entityId", j."postedAt" INTO entry FROM "JournalEntry" j WHERE j."id" = NEW."entryId";
  IF NOT FOUND OR entry."cafeId" <> NEW."cafeId" THEN
    RAISE EXCEPTION 'Line belongs to another cafe' USING ERRCODE = 'check_violation';
  END IF;
  IF entry."postedAt" <> (now() AT TIME ZONE 'UTC')::timestamp(3) THEN
    RAISE EXCEPTION 'Lines are written with their entry, never added later' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "AccountingAccount" a WHERE a."id" = NEW."accountId"
                 AND a."entityId" = entry."entityId" AND a."isPostable" AND a."isActive") THEN
    RAISE EXCEPTION 'Line account is not a postable account of this entity' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."branchId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "Branch" b WHERE b."id" = NEW."branchId" AND b."cafeId" = NEW."cafeId") THEN
    RAISE EXCEPTION 'Line branch belongs to another cafe' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "JournalLine_guard" BEFORE INSERT ON "JournalLine"
  FOR EACH ROW EXECUTE FUNCTION "journal_line_guard"();

-- Every entry balances, with at least two lines, when the transaction commits.
CREATE FUNCTION "journal_entry_balanced"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target TEXT;
  total_debit NUMERIC;
  total_credit NUMERIC;
  line_count INT;
BEGIN
  IF TG_TABLE_NAME = 'JournalLine' THEN target := NEW."entryId"; ELSE target := NEW."id"; END IF;
  SELECT coalesce(sum(l."debit"), 0), coalesce(sum(l."credit"), 0), count(*)
    INTO total_debit, total_credit, line_count
    FROM "JournalLine" l WHERE l."entryId" = target;
  IF line_count < 2 OR total_debit <> total_credit OR total_debit = 0 THEN
    RAISE EXCEPTION 'Journal entry % does not balance (debit %, credit %, % lines)', target, total_debit, total_credit, line_count
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "JournalLine_balanced" AFTER INSERT ON "JournalLine"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "journal_entry_balanced"();
CREATE CONSTRAINT TRIGGER "JournalEntry_balanced" AFTER INSERT ON "JournalEntry"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "journal_entry_balanced"();
