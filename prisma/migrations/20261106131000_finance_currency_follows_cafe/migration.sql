-- Drawer expenses and the treasury follow the cafe's currency (C9 of the branch-currency work).
--
-- Before: four CHECKs and one trigger clause allowed exactly one currency, EGP. After: each money row must carry
-- the currency of its cafe (a new BEFORE INSERT trigger), and the CHECKs only require a well-formed 2-decimal
-- code. The rule is not weaker: one allowed currency per cafe, and an EGP cafe behaves exactly as before.
-- Every other predicate of the four CHECKs is copied unchanged from the migrations that created them, and
-- "money_movement_guard" is the deployed body with exactly one clause changed
-- (a."currency"<>'EGP'  ->  a."currency"<>(the cafe's currency)); tests/cur-002 compares both against the
-- original migrations. No data is rewritten: every existing row is EGP and still satisfies the new CHECKs.
-- The cafe currency itself is locked by the branch_currency migration once any of these rows exists.

ALTER TABLE "OperatingExpense" DROP CONSTRAINT "OperatingExpense_amount_check";
ALTER TABLE "OperatingExpense" ADD CONSTRAINT "OperatingExpense_amount_check" CHECK ("amount" > 0 AND "amount" <> 'NaN'::numeric AND "currency" ~ '^[A-Z]{3}$' AND "currency" NOT IN ('BHD','IQD','JOD','KWD','LYD','OMR','TND','BIF','CLP','DJF','GNF','ISK','JPY','KMF','KRW','PYG','RWF','UGX','UYI','VND','VUV','XAF','XOF','XPF','CLF','UYW'));
ALTER TABLE "OperatingExpenseReturn" DROP CONSTRAINT "OperatingExpenseReturn_amount_check";
ALTER TABLE "OperatingExpenseReturn" ADD CONSTRAINT "OperatingExpenseReturn_amount_check" CHECK ("amount" > 0 AND "amount" <> 'NaN'::numeric AND "currency" ~ '^[A-Z]{3}$' AND "currency" NOT IN ('BHD','IQD','JOD','KWD','LYD','OMR','TND','BIF','CLP','DJF','GNF','ISK','JPY','KMF','KRW','PYG','RWF','UGX','UYI','VND','VUV','XAF','XOF','XPF','CLF','UYW'));
ALTER TABLE "MoneyAccount" DROP CONSTRAINT "MoneyAccount_values";
ALTER TABLE "MoneyAccount" ADD CONSTRAINT "MoneyAccount_values" CHECK ("currency" ~ '^[A-Z]{3}$' AND "currency" NOT IN ('BHD','IQD','JOD','KWD','LYD','OMR','TND','BIF','CLP','DJF','GNF','ISK','JPY','KMF','KRW','PYG','RWF','UGX','UYI','VND','VUV','XAF','XOF','XPF','CLF','UYW') AND "code" ~ '^[A-Z0-9_-]{1,30}$' AND length(btrim("name"))>=2 AND "version">=0 AND ("kind"='BANK' OR NOT "instaPayEnabled"));
ALTER TABLE "MoneyTransfer" DROP CONSTRAINT "MoneyTransfer_values";
ALTER TABLE "MoneyTransfer" ADD CONSTRAINT "MoneyTransfer_values" CHECK ("currency" ~ '^[A-Z]{3}$' AND "currency" NOT IN ('BHD','IQD','JOD','KWD','LYD','OMR','TND','BIF','CLP','DJF','GNF','ISK','JPY','KMF','KRW','PYG','RWF','UGX','UYI','VND','VUV','XAF','XOF','XPF','CLF','UYW') AND "amount">0 AND "amount"<='9999999999.99' AND "fromAccountId"<>"toAccountId" AND length(btrim("note"))>0 AND length("creationKey")>=8 AND "creationFingerprint" ~ '^[a-f0-9]{64}$');

CREATE FUNCTION "finance_currency_matches_cafe"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cafe_currency TEXT;
BEGIN
  SELECT "currency" INTO cafe_currency FROM "Cafe" WHERE "id" = NEW."cafeId";
  IF NEW."currency" IS DISTINCT FROM cafe_currency THEN
    RAISE EXCEPTION 'Finance currency must equal the cafe currency' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "OperatingExpense_currency_follows_cafe" BEFORE INSERT ON "OperatingExpense"
  FOR EACH ROW EXECUTE FUNCTION "finance_currency_matches_cafe"();
CREATE TRIGGER "OperatingExpenseReturn_currency_follows_cafe" BEFORE INSERT ON "OperatingExpenseReturn"
  FOR EACH ROW EXECUTE FUNCTION "finance_currency_matches_cafe"();
CREATE TRIGGER "MoneyAccount_currency_follows_cafe" BEFORE INSERT ON "MoneyAccount"
  FOR EACH ROW EXECUTE FUNCTION "finance_currency_matches_cafe"();
CREATE TRIGGER "MoneyTransfer_currency_follows_cafe" BEFORE INSERT ON "MoneyTransfer"
  FOR EACH ROW EXECUTE FUNCTION "finance_currency_matches_cafe"();

CREATE OR REPLACE FUNCTION "money_movement_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a "MoneyAccount"; t "MoneyTransfer"; event_day DATE;
BEGIN
 PERFORM pg_advisory_xact_lock_shared("accounting_close_key"(NEW."cafeId"));
 IF NEW."transferId" IS NOT NULL THEN
  SELECT * INTO STRICT t FROM "MoneyTransfer" WHERE "id"=NEW."transferId" AND "cafeId"=NEW."cafeId" FOR NO KEY UPDATE;
  PERFORM 1 FROM "MoneyAccount" WHERE "id" IN(t."fromAccountId",t."toAccountId") ORDER BY "id" FOR NO KEY UPDATE;
 END IF;
 SELECT * INTO STRICT a FROM "MoneyAccount" WHERE "id"=NEW."accountId" AND "cafeId"=NEW."cafeId" FOR NO KEY UPDATE;
 IF a."currency"<>(SELECT "currency" FROM "Cafe" WHERE "id"=NEW."cafeId") OR NOT EXISTS(SELECT 1 FROM "User" WHERE "id"=NEW."actorId" AND "cafeId"=NEW."cafeId") THEN RAISE EXCEPTION 'Movement currency/actor scope' USING ERRCODE='23514'; END IF;
 IF NEW."kind"='OPENING' THEN
  IF NEW."sourceKey"<>'money-opening:'||a."id" OR a."openingState"<>'APPROVED' OR NEW."openingReference" IS DISTINCT FROM a."openingReference" OR NEW."actorId" IS DISTINCT FROM a."openingApprovedById" OR NEW."occurredAt" IS DISTINCT FROM a."openingAt" THEN RAISE EXCEPTION 'Opening evidence mismatch' USING ERRCODE='23514'; END IF;
 ELSIF NEW."kind"='TRANSFER_OUT' THEN
  IF NEW."sourceKey"<>'money-transfer:'||t."id"||':out' OR t."status" NOT IN('IN_TRANSIT','RECEIVED') OR NEW."accountId"<>t."fromAccountId" OR NEW."signedAmount"<>-t."amount" OR NEW."actorId" IS DISTINCT FROM t."dispatchedById" OR NEW."occurredAt" IS DISTINCT FROM t."dispatchedAt" THEN RAISE EXCEPTION 'Dispatch movement mismatch' USING ERRCODE='23514'; END IF;
 ELSE
  IF NEW."sourceKey"<>'money-transfer:'||t."id"||':in' OR t."status"<>'RECEIVED' OR NEW."accountId"<>t."toAccountId" OR NEW."signedAmount"<>t."amount" OR NEW."actorId" IS DISTINCT FROM t."receivedById" OR NEW."occurredAt" IS DISTINCT FROM t."receivedAt" THEN RAISE EXCEPTION 'Receipt movement mismatch' USING ERRCODE='23514'; END IF;
 END IF;
 event_day:=((NEW."occurredAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Cairo')::date;
 IF EXISTS(SELECT 1 FROM "AccountingPeriod" WHERE "cafeId"=NEW."cafeId" AND "status"='CLOSED' AND "startsOn"<=event_day AND "endsOn">=event_day) THEN RAISE EXCEPTION 'Money movement falls in a closed accounting period' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
