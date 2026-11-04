-- STEP 4B.2 closeout: forward corrections to the guards from 20261104120000 (that migration and
-- its checksum are untouched). Functions only: no table, column or row is changed, and existing
-- mapping rows are not rewritten or re-validated. Reproduced gaps closed here:
--   1. an account needed by a FUTURE mapping interval could be deactivated;
--   2. mappings could name cost of sales, purchase discounts, inventory loss or cash differences;
--   3. the closed-period rule for mapping dates existed only in the API;
--   4. an account used by a mapping could still change type, side or postability;
--   5. deactivating an account and mapping to it concurrently could both commit.

-- System accounts whose posting meaning is not an ordinary operating expense. Identity only:
-- never a code prefix or an Arabic name. Mirrored by NON_OPERATING_EXPENSE_KEYS in the application.
CREATE FUNCTION "expense_mapping_excluded_key"(key TEXT) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(key IN ('COST_OF_SALES', 'PURCHASE_DISCOUNTS', 'INVENTORY_LOSS', 'CASH_OVER_SHORT'), false)
$$;

-- One serialisation point for "is this account usable by a mapping": the mapping insert and any
-- change to an account's activity, type, side or postability take the same lock per books.
CREATE FUNCTION "expense_mapping_lock"(entity TEXT) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('expense-mapping-account'), hashtext(entity));
END;
$$;

CREATE OR REPLACE FUNCTION "expense_mapping_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  category_cafe TEXT; entity_cafe TEXT; acc RECORD; latest DATE;
BEGIN
  PERFORM "expense_mapping_lock"(NEW."entityId");
  -- A period close takes the books' row lock; sharing it orders this insert against a concurrent close.
  PERFORM 1 FROM "AccountingEntity" WHERE "id" = NEW."entityId" FOR SHARE;

  SELECT "cafeId" INTO category_cafe FROM "ExpenseCategory" WHERE "id" = NEW."categoryId";
  SELECT "cafeId" INTO entity_cafe FROM "AccountingEntity" WHERE "id" = NEW."entityId";
  IF category_cafe IS DISTINCT FROM NEW."cafeId" OR entity_cafe IS DISTINCT FROM NEW."cafeId" THEN
    RAISE EXCEPTION 'Mapping category and books must belong to the mapping cafe' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."accountId" IS NOT NULL THEN
    SELECT "entityId", "isPostable", "isActive", "type", "systemKey" INTO acc FROM "AccountingAccount" WHERE "id" = NEW."accountId";
    IF NOT FOUND OR acc."entityId" <> NEW."entityId" OR NOT acc."isPostable" OR NOT acc."isActive" OR acc."type" <> 'EXPENSE' THEN
      RAISE EXCEPTION 'Mapped account must be an active postable expense account of the same books' USING ERRCODE = 'check_violation';
    END IF;
    IF "expense_mapping_excluded_key"(acc."systemKey") THEN
      RAISE EXCEPTION 'Mapped account is not an ordinary operating expense account' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM "AccountingPeriod" WHERE "entityId" = NEW."entityId" AND "status" = 'CLOSED' AND "endsOn" >= NEW."effectiveFrom") THEN
    RAISE EXCEPTION 'Mapping date falls in a closed accounting period' USING ERRCODE = 'check_violation';
  END IF;
  SELECT max("effectiveFrom") INTO latest FROM "ExpenseCategoryAccountMapping" WHERE "categoryId" = NEW."categoryId";
  IF latest IS NOT NULL AND NEW."effectiveFrom" <= latest THEN
    RAISE EXCEPTION 'Mapping dates only move forward' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "accounting_account_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
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

  IF NEW."isActive" <> OLD."isActive" OR NEW."type" <> OLD."type" OR NEW."normalBalance" <> OLD."normalBalance" OR NEW."isPostable" <> OLD."isPostable" THEN
    PERFORM "expense_mapping_lock"(OLD."entityId");
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
    IF EXISTS (SELECT 1 FROM "ExpenseCategoryAccountMapping" WHERE "accountId" = OLD."id") THEN
      RAISE EXCEPTION 'An account named by an expense category mapping keeps its type, side and postable flag' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF (NEW."type" <> OLD."type" OR (NOT OLD."isPostable" AND NEW."isPostable"))
     AND EXISTS (SELECT 1 FROM "AccountingAccount" WHERE "parentId" = OLD."id") THEN
    RAISE EXCEPTION 'An account with children keeps its type and stays a header' USING ERRCODE = 'check_violation';
  END IF;

  -- Needed by a mapping interval that has not ended: the row in force today for its category, or
  -- any row that starts later (a future row, or one whose successor is also in the future).
  -- Intervals that ended in the past do not protect the account.
  IF OLD."isActive" AND NOT NEW."isActive" AND EXISTS (
    SELECT 1 FROM "ExpenseCategoryAccountMapping" m
     WHERE m."accountId" = OLD."id"
       AND (m."effectiveFrom" > (now() AT TIME ZONE 'Africa/Cairo')::date
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
