-- Branch currency (v1: one currency per cafe, 2-decimal currencies only).
--
-- "Cafe"."currency" already exists and is what every screen reads, so it stays the cafe's currency and
-- is the single source of truth. "Branch"."currencyCode" mirrors it per branch (the column the later
-- mixed-currency batch will own) and is backfilled FROM the cafe's current value - never a blanket EGP,
-- so no existing cafe is silently relabelled.
--
-- Guards (the app service enforces the same rules first and maps these errors to Arabic 409s):
--   C2  a branch always carries its cafe's currency (insert copies it; an update must equal it; changing
--       the cafe's currency cascades to its branches in the same statement).
--   C4  the currency is locked once the cafe has any financial record. The table list below is mirrored by
--       CURRENCY_LOCK_TABLES in src/lib/currency.ts; a test keeps the two in step.
--   Only 2-decimal currencies may be stored (3-decimal and 0-decimal codes would be truncated by the
--   2-decimal money columns), so those codes are refused at the database too.
-- No data is converted or rewritten besides the new column's backfill.

ALTER TABLE "Cafe" ADD CONSTRAINT "Cafe_currency_shape_check" CHECK ("currency" ~ '^[A-Z]{3}$');

ALTER TABLE "Branch" ADD COLUMN "currencyCode" TEXT;
UPDATE "Branch" b SET "currencyCode" = c."currency" FROM "Cafe" c WHERE c."id" = b."cafeId";
ALTER TABLE "Branch" ALTER COLUMN "currencyCode" SET NOT NULL;
ALTER TABLE "Branch" ALTER COLUMN "currencyCode" SET DEFAULT 'EGP';
ALTER TABLE "Branch" ADD CONSTRAINT "Branch_currencyCode_shape_check" CHECK ("currencyCode" ~ '^[A-Z]{3}$');

ALTER TABLE "Cafe" ADD CONSTRAINT "Cafe_currency_two_decimals_check" CHECK ("currency" NOT IN (
  'BHD','IQD','JOD','KWD','LYD','OMR','TND',
  'BIF','CLP','DJF','GNF','ISK','JPY','KMF','KRW','PYG','RWF','UGX','UYI','VND','VUV','XAF','XOF','XPF',
  'CLF','UYW'));
ALTER TABLE "Branch" ADD CONSTRAINT "Branch_currencyCode_two_decimals_check" CHECK ("currencyCode" NOT IN (
  'BHD','IQD','JOD','KWD','LYD','OMR','TND',
  'BIF','CLP','DJF','GNF','ISK','JPY','KMF','KRW','PYG','RWF','UGX','UYI','VND','VUV','XAF','XOF','XPF',
  'CLF','UYW'));

CREATE FUNCTION "currency_lock_has_records"(p_cafe TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql STABLE AS $$
DECLARE
  t TEXT;
  found BOOLEAN;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'Shift','Order','Payment','OrderRevision','AmendmentSettlement','TableSession',
    'OperatingExpense','OperatingExpenseReturn',
    'PurchaseInvoice','PurchasePayment',
    'MoneyAccount','MoneyTransfer','MoneyMovement',
    'AccountingEntity','JournalLine',
    'InventoryTransaction',
    'CashStorage','CashDeliveryDeclaration','OpeningCashReceipt','CustodyPeriod','ShiftCashDisposition','HandoverSession',
    'LoyaltyTransaction','HistoricalSaleLine'
  ] LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE "cafeId" = $1)', t) INTO found USING p_cafe;
    IF found THEN
      RETURN TRUE;
    END IF;
  END LOOP;
  RETURN FALSE;
END;
$$;

-- A new branch always starts in its cafe's currency.
CREATE FUNCTION "branch_currency_on_insert"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cafe_currency TEXT;
BEGIN
  SELECT "currency" INTO cafe_currency FROM "Cafe" WHERE "id" = NEW."cafeId";
  IF cafe_currency IS NOT NULL THEN
    NEW."currencyCode" := cafe_currency;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Branch_currency_on_insert" BEFORE INSERT ON "Branch"
  FOR EACH ROW EXECUTE FUNCTION "branch_currency_on_insert"();

CREATE FUNCTION "branch_currency_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cafe_currency TEXT;
BEGIN
  IF NEW."currencyCode" IS DISTINCT FROM OLD."currencyCode" THEN
    IF "currency_lock_has_records"(NEW."cafeId") THEN
      RAISE EXCEPTION 'CURRENCY_LOCKED: the branch currency cannot change once the cafe has financial records';
    END IF;
    SELECT "currency" INTO cafe_currency FROM "Cafe" WHERE "id" = NEW."cafeId";
    IF NEW."currencyCode" IS DISTINCT FROM cafe_currency THEN
      RAISE EXCEPTION 'CURRENCY_MISMATCH: every branch of a cafe must use the cafe currency';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Branch_currency_guard" BEFORE UPDATE OF "currencyCode" ON "Branch"
  FOR EACH ROW EXECUTE FUNCTION "branch_currency_guard"();

CREATE FUNCTION "cafe_currency_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."currency" IS DISTINCT FROM OLD."currency" AND "currency_lock_has_records"(OLD."id") THEN
    RAISE EXCEPTION 'CURRENCY_LOCKED: the cafe currency cannot change once the cafe has financial records';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Cafe_currency_guard" BEFORE UPDATE OF "currency" ON "Cafe"
  FOR EACH ROW EXECUTE FUNCTION "cafe_currency_guard"();

CREATE FUNCTION "cafe_currency_cascade"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."currency" IS DISTINCT FROM OLD."currency" THEN
    UPDATE "Branch" SET "currencyCode" = NEW."currency"
      WHERE "cafeId" = NEW."id" AND "currencyCode" IS DISTINCT FROM NEW."currency";
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER "Cafe_currency_cascade" AFTER UPDATE OF "currency" ON "Cafe"
  FOR EACH ROW EXECUTE FUNCTION "cafe_currency_cascade"();
