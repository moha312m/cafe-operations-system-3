-- STEP 4B.2: effective-dated expense category -> account mapping and a guard on
-- AccountingAccount. Adds one table and triggers only: no existing
-- column or row is changed, nothing is posted, nothing is backfilled.

CREATE TABLE "ExpenseCategoryAccountMapping" (
    "id" TEXT NOT NULL,
    "cafeId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "accountId" TEXT,
    "effectiveFrom" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "approvalRef" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExpenseCategoryAccountMapping_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ExpenseCategoryAccountMapping_text" CHECK (length(btrim("reason")) >= 3 AND length(btrim("approvalRef")) >= 3)
);

CREATE UNIQUE INDEX "ExpenseCategoryAccountMapping_categoryId_effectiveFrom_key" ON "ExpenseCategoryAccountMapping"("categoryId", "effectiveFrom");
CREATE INDEX "ExpenseCategoryAccountMapping_cafeId_categoryId_effectiveFr_idx" ON "ExpenseCategoryAccountMapping"("cafeId", "categoryId", "effectiveFrom");
CREATE INDEX "ExpenseCategoryAccountMapping_accountId_idx" ON "ExpenseCategoryAccountMapping"("accountId");

ALTER TABLE "ExpenseCategoryAccountMapping" ADD CONSTRAINT "ExpenseCategoryAccountMapping_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "AccountingEntity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ExpenseCategoryAccountMapping" ADD CONSTRAINT "ExpenseCategoryAccountMapping_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ExpenseCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ExpenseCategoryAccountMapping" ADD CONSTRAINT "ExpenseCategoryAccountMapping_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "AccountingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ExpenseCategoryAccountMapping" ADD CONSTRAINT "ExpenseCategoryAccountMapping_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Append-only: a mapping is ended by a later row, never edited or deleted.
CREATE FUNCTION "accounting_setup_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END;
$$;
CREATE TRIGGER "ExpenseCategoryAccountMapping_immutable" BEFORE UPDATE OR DELETE ON "ExpenseCategoryAccountMapping"
  FOR EACH ROW EXECUTE FUNCTION "accounting_setup_append_only"();

-- A mapping row ties one café's category to one account of that café's entity:
-- an active, postable expense account, or NULL to end the mapping. Dates only move forward.
CREATE FUNCTION "expense_mapping_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  category_cafe TEXT; entity_cafe TEXT; acc RECORD; latest DATE;
BEGIN
  SELECT "cafeId" INTO category_cafe FROM "ExpenseCategory" WHERE "id" = NEW."categoryId";
  SELECT "cafeId" INTO entity_cafe FROM "AccountingEntity" WHERE "id" = NEW."entityId";
  IF category_cafe IS DISTINCT FROM NEW."cafeId" OR entity_cafe IS DISTINCT FROM NEW."cafeId" THEN
    RAISE EXCEPTION 'Mapping category and books must belong to the mapping cafe' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."accountId" IS NOT NULL THEN
    SELECT "entityId", "isPostable", "isActive", "type" INTO acc FROM "AccountingAccount" WHERE "id" = NEW."accountId";
    IF NOT FOUND OR acc."entityId" <> NEW."entityId" OR NOT acc."isPostable" OR NOT acc."isActive" OR acc."type" <> 'EXPENSE' THEN
      RAISE EXCEPTION 'Mapped account must be an active postable expense account of the same books' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  SELECT max("effectiveFrom") INTO latest FROM "ExpenseCategoryAccountMapping" WHERE "categoryId" = NEW."categoryId";
  IF latest IS NOT NULL AND NEW."effectiveFrom" <= latest THEN
    RAISE EXCEPTION 'Mapping dates only move forward' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ExpenseCategoryAccountMapping_guard" BEFORE INSERT ON "ExpenseCategoryAccountMapping"
  FOR EACH ROW EXECUTE FUNCTION "expense_mapping_guard"();

-- A parent is a header of the same books and type, with no cycle and a bounded depth.
CREATE FUNCTION "accounting_check_parent"(self TEXT, parent TEXT, entity TEXT, account_type "AccountType") RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  p RECORD; cur TEXT := parent; depth INTEGER := 0;
BEGIN
  SELECT "entityId", "type", "isPostable" INTO p FROM "AccountingAccount" WHERE "id" = parent;
  IF NOT FOUND OR p."entityId" <> entity THEN
    RAISE EXCEPTION 'Parent must be an account of the same books' USING ERRCODE = 'check_violation';
  END IF;
  IF p."type" <> account_type THEN
    RAISE EXCEPTION 'Parent must have the same account type' USING ERRCODE = 'check_violation';
  END IF;
  IF p."isPostable" THEN
    RAISE EXCEPTION 'Parent must be a header account' USING ERRCODE = 'check_violation';
  END IF;
  WHILE cur IS NOT NULL LOOP
    IF cur = self THEN
      RAISE EXCEPTION 'An account cannot sit under itself' USING ERRCODE = 'check_violation';
    END IF;
    depth := depth + 1;
    IF depth > 8 THEN
      RAISE EXCEPTION 'Account tree is too deep' USING ERRCODE = 'check_violation';
    END IF;
    SELECT "parentId" INTO cur FROM "AccountingAccount" WHERE "id" = cur;
  END LOOP;
END;
$$;

-- What may change on an account once the books are in use. Names and the active
-- flag stay editable; identity and meaning do not move under posted lines.
CREATE FUNCTION "accounting_account_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."parentId" IS NOT NULL THEN
      PERFORM "accounting_check_parent"(NEW."id", NEW."parentId", NEW."entityId", NEW."type");
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."cafeId" <> OLD."cafeId" OR NEW."entityId" <> OLD."entityId" THEN
    RAISE EXCEPTION 'An account never moves between cafes or books' USING ERRCODE = 'check_violation';
  END IF;

  -- System accounts are posted to by key, so their code and name stay free to change; their
  -- key, type, side and postable flag do not. A header's key may move (chart sync adopts keyless headers).
  IF OLD."systemKey" IS NOT NULL THEN
    IF (OLD."isPostable" AND NEW."systemKey" IS DISTINCT FROM OLD."systemKey") OR NEW."type" <> OLD."type"
       OR NEW."normalBalance" <> OLD."normalBalance" OR NEW."isPostable" <> OLD."isPostable" THEN
      RAISE EXCEPTION 'System accounts keep their key, type, side and postable flag' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."isActive" AND NOT NEW."isActive" THEN
      RAISE EXCEPTION 'System accounts cannot be deactivated' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."systemKey" IS NOT NULL AND OLD."isPostable" THEN
    RAISE EXCEPTION 'Only a header account can take a system key' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."type" <> OLD."type" OR NEW."normalBalance" <> OLD."normalBalance" OR (OLD."isPostable" AND NOT NEW."isPostable") THEN
    IF EXISTS (SELECT 1 FROM "JournalLine" WHERE "accountId" = OLD."id") THEN
      RAISE EXCEPTION 'An account with posted lines keeps its type, side and postable flag' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF (NEW."type" <> OLD."type" OR (NOT OLD."isPostable" AND NEW."isPostable"))
     AND EXISTS (SELECT 1 FROM "AccountingAccount" WHERE "parentId" = OLD."id") THEN
    RAISE EXCEPTION 'An account with children keeps its type and stays a header' USING ERRCODE = 'check_violation';
  END IF;

  -- Still the mapping in force: the latest row of a category, or the row in force
  -- today (a later row may be dated in the future). Remap before deactivating.
  IF OLD."isActive" AND NOT NEW."isActive" AND EXISTS (
    SELECT 1 FROM "ExpenseCategoryAccountMapping" m
     WHERE m."accountId" = OLD."id"
       AND (m."effectiveFrom" = (SELECT max(m2."effectiveFrom") FROM "ExpenseCategoryAccountMapping" m2 WHERE m2."categoryId" = m."categoryId")
         OR m."effectiveFrom" = (SELECT max(m3."effectiveFrom") FROM "ExpenseCategoryAccountMapping" m3
                                  WHERE m3."categoryId" = m."categoryId" AND m3."effectiveFrom" <= (now() AT TIME ZONE 'Africa/Cairo')::date))) THEN
    RAISE EXCEPTION 'Remap the expense categories that use this account before deactivating it' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."parentId" IS DISTINCT FROM OLD."parentId" OR NEW."type" <> OLD."type" THEN
    IF NEW."parentId" IS NOT NULL THEN
      PERFORM "accounting_check_parent"(NEW."id", NEW."parentId", NEW."entityId", NEW."type");
    END IF;
  END IF;
  IF NEW."parentId" IS DISTINCT FROM OLD."parentId" AND EXISTS (
    WITH RECURSIVE tree AS (
      SELECT "id" FROM "AccountingAccount" WHERE "id" = OLD."id"
      UNION ALL
      SELECT a."id" FROM "AccountingAccount" a JOIN tree t ON a."parentId" = t."id")
    SELECT 1 FROM "JournalLine" l
      JOIN "JournalEntry" j ON j."id" = l."entryId"
      JOIN "AccountingPeriod" p ON p."id" = j."periodId"
     WHERE l."accountId" IN (SELECT "id" FROM tree) AND p."status" = 'CLOSED') THEN
    RAISE EXCEPTION 'An account with lines in a closed period cannot be moved' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "AccountingAccount_guard" BEFORE INSERT OR UPDATE ON "AccountingAccount"
  FOR EACH ROW EXECUTE FUNCTION "accounting_account_guard"();
