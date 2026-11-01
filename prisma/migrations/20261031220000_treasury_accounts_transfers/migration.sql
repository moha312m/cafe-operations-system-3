-- ACC-02A FILE ONLY. Requires the 88 retained migrations including G1 and ACC-01A.
-- No seed, opening, backfill, legacy source change, or official journal adapter.
CREATE TYPE "MoneyAccountKind" AS ENUM ('TREASURY','BANK','WALLET');
CREATE TYPE "MoneyOpeningState" AS ENUM ('UNSET','APPROVED');
CREATE TYPE "MoneyTransferChannel" AS ENUM ('INTERNAL','INSTAPAY');
CREATE TYPE "MoneyTransferStatus" AS ENUM ('DRAFT','IN_TRANSIT','RECEIVED','CANCELLED');
CREATE TYPE "MoneyMovementKind" AS ENUM ('OPENING','TRANSFER_OUT','TRANSFER_IN');
CREATE TABLE "MoneyAccount" (
 "id" TEXT PRIMARY KEY, "cafeId" TEXT NOT NULL, "branchId" TEXT,
 "code" VARCHAR(30) NOT NULL, "name" VARCHAR(100) NOT NULL, "kind" "MoneyAccountKind" NOT NULL,
 "currency" TEXT NOT NULL DEFAULT 'EGP', "instaPayEnabled" BOOLEAN NOT NULL DEFAULT false,
 "isActive" BOOLEAN NOT NULL DEFAULT true, "openingState" "MoneyOpeningState" NOT NULL DEFAULT 'UNSET',
 "openingAt" TIMESTAMP(3), "openingReference" VARCHAR(160), "openingApprovedById" TEXT, "openingApprovedAt" TIMESTAMP(3),
 "createdById" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL, "version" INTEGER NOT NULL DEFAULT 0,
 CONSTRAINT "MoneyAccount_values" CHECK ("currency"='EGP' AND "code" ~ '^[A-Z0-9_-]{1,30}$' AND length(btrim("name"))>=2 AND "version">=0 AND ("kind"='BANK' OR NOT "instaPayEnabled")),
 CONSTRAINT "MoneyAccount_opening_shape" CHECK (("openingState"='UNSET' AND num_nonnulls("openingAt","openingReference","openingApprovedById","openingApprovedAt")=0) OR ("openingState"='APPROVED' AND num_nonnulls("openingAt","openingReference","openingApprovedById","openingApprovedAt")=4 AND length(btrim("openingReference"))>0))
);
CREATE TABLE "MoneyTransfer" (
 "id" TEXT PRIMARY KEY,"cafeId" TEXT NOT NULL,"fromAccountId" TEXT NOT NULL,"toAccountId" TEXT NOT NULL,
 "amount" DECIMAL(12,2) NOT NULL,"currency" TEXT NOT NULL DEFAULT 'EGP',"channel" "MoneyTransferChannel" NOT NULL,
 "status" "MoneyTransferStatus" NOT NULL DEFAULT 'DRAFT',"reference" VARCHAR(160),"note" VARCHAR(1000) NOT NULL,
 "fromNameSnapshot" VARCHAR(100) NOT NULL,"toNameSnapshot" VARCHAR(100) NOT NULL,
 "creationKey" VARCHAR(128) NOT NULL,"creationFingerprint" VARCHAR(64) NOT NULL,"createdById" TEXT NOT NULL,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "dispatchedById" TEXT,"dispatchedAt" TIMESTAMP(3),"dispatchKey" VARCHAR(128),"dispatchFingerprint" VARCHAR(64),"dispatchReference" VARCHAR(160),
 "receivedById" TEXT,"receivedAt" TIMESTAMP(3),"receiveKey" VARCHAR(128),"receiveFingerprint" VARCHAR(64),"receiveReference" VARCHAR(160),
 "cancelledById" TEXT,"cancelledAt" TIMESTAMP(3),"cancelKey" VARCHAR(128),"cancelFingerprint" VARCHAR(64),"cancelReason" VARCHAR(1000),
 CONSTRAINT "MoneyTransfer_values" CHECK ("currency"='EGP' AND "amount">0 AND "amount"<='9999999999.99' AND "fromAccountId"<>"toAccountId" AND length(btrim("note"))>0 AND length("creationKey")>=8 AND "creationFingerprint" ~ '^[a-f0-9]{64}$'),
 CONSTRAINT "MoneyTransfer_action_identity" CHECK (("dispatchKey" IS NULL OR length("dispatchKey")>=8) AND ("receiveKey" IS NULL OR length("receiveKey")>=8) AND ("cancelKey" IS NULL OR length("cancelKey")>=8) AND ("dispatchFingerprint" IS NULL OR "dispatchFingerprint" ~ '^[a-f0-9]{64}$') AND ("receiveFingerprint" IS NULL OR "receiveFingerprint" ~ '^[a-f0-9]{64}$') AND ("cancelFingerprint" IS NULL OR "cancelFingerprint" ~ '^[a-f0-9]{64}$')),
 CONSTRAINT "MoneyTransfer_state_shape" CHECK (
  ("status"='DRAFT' AND num_nonnulls("dispatchedById","dispatchedAt","dispatchKey","dispatchFingerprint","dispatchReference","receivedById","receivedAt","receiveKey","receiveFingerprint","receiveReference","cancelledById","cancelledAt","cancelKey","cancelFingerprint","cancelReason")=0)
  OR ("status"='IN_TRANSIT' AND num_nonnulls("dispatchedById","dispatchedAt","dispatchKey","dispatchFingerprint")=4 AND num_nonnulls("receivedById","receivedAt","receiveKey","receiveFingerprint","receiveReference","cancelledById","cancelledAt","cancelKey","cancelFingerprint","cancelReason")=0)
  OR ("status"='RECEIVED' AND num_nonnulls("dispatchedById","dispatchedAt","dispatchKey","dispatchFingerprint","receivedById","receivedAt","receiveKey","receiveFingerprint")=8 AND num_nonnulls("cancelledById","cancelledAt","cancelKey","cancelFingerprint","cancelReason")=0)
  OR ("status"='CANCELLED' AND num_nonnulls("cancelledById","cancelledAt","cancelKey","cancelFingerprint","cancelReason")=5 AND length(btrim("cancelReason"))>0 AND num_nonnulls("dispatchedById","dispatchedAt","dispatchKey","dispatchFingerprint","dispatchReference","receivedById","receivedAt","receiveKey","receiveFingerprint","receiveReference")=0))
);
CREATE TABLE "MoneyMovement" (
 "id" TEXT PRIMARY KEY,"cafeId" TEXT NOT NULL,"accountId" TEXT NOT NULL,"transferId" TEXT,
 "kind" "MoneyMovementKind" NOT NULL,"signedAmount" DECIMAL(12,2) NOT NULL,"occurredAt" TIMESTAMP(3) NOT NULL,
 "actorId" TEXT NOT NULL,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"sourceKey" VARCHAR(200) NOT NULL,"openingReference" VARCHAR(160),
 CONSTRAINT "MoneyMovement_sign" CHECK (("kind"='OPENING' AND "signedAmount">=0 AND "transferId" IS NULL AND length(btrim("openingReference"))>0) OR ("kind"='TRANSFER_OUT' AND "signedAmount"<0 AND "transferId" IS NOT NULL AND "openingReference" IS NULL) OR ("kind"='TRANSFER_IN' AND "signedAmount">0 AND "transferId" IS NOT NULL AND "openingReference" IS NULL))
);
CREATE UNIQUE INDEX "MoneyAccount_cafeId_code_key" ON "MoneyAccount"("cafeId","code");
CREATE UNIQUE INDEX "MoneyAccount_cafeId_id_key" ON "MoneyAccount"("cafeId","id");
CREATE INDEX "MoneyAccount_cafeId_branchId_isActive_idx" ON "MoneyAccount"("cafeId","branchId","isActive");
CREATE INDEX "MoneyAccount_cafeId_kind_idx" ON "MoneyAccount"("cafeId","kind");
CREATE UNIQUE INDEX "MoneyTransfer_cafeId_createdById_creationKey_key" ON "MoneyTransfer"("cafeId","createdById","creationKey");
CREATE UNIQUE INDEX "MoneyTransfer_cafeId_id_key" ON "MoneyTransfer"("cafeId","id");
CREATE INDEX "MoneyTransfer_cafeId_status_createdAt_idx" ON "MoneyTransfer"("cafeId","status","createdAt");
CREATE INDEX "MoneyTransfer_fromAccountId_createdAt_idx" ON "MoneyTransfer"("fromAccountId","createdAt");
CREATE INDEX "MoneyTransfer_toAccountId_createdAt_idx" ON "MoneyTransfer"("toAccountId","createdAt");
CREATE UNIQUE INDEX "MoneyMovement_sourceKey_key" ON "MoneyMovement"("sourceKey");
CREATE INDEX "MoneyMovement_accountId_occurredAt_id_idx" ON "MoneyMovement"("accountId","occurredAt","id");
CREATE INDEX "MoneyMovement_cafeId_occurredAt_idx" ON "MoneyMovement"("cafeId","occurredAt");
ALTER TABLE "MoneyAccount" ADD CONSTRAINT "MoneyAccount_cafeId_fkey" FOREIGN KEY ("cafeId") REFERENCES "Cafe"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "MoneyAccount" ADD CONSTRAINT "MoneyAccount_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "MoneyAccount" ADD CONSTRAINT "MoneyAccount_openingApprovedById_fkey" FOREIGN KEY ("openingApprovedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "MoneyTransfer" ADD CONSTRAINT "MoneyTransfer_cafeId_fkey" FOREIGN KEY ("cafeId") REFERENCES "Cafe"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "MoneyTransfer" ADD CONSTRAINT "MoneyTransfer_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "MoneyTransfer" ADD CONSTRAINT "MoneyTransfer_dispatchedById_fkey" FOREIGN KEY ("dispatchedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "MoneyTransfer" ADD CONSTRAINT "MoneyTransfer_receivedById_fkey" FOREIGN KEY ("receivedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "MoneyTransfer" ADD CONSTRAINT "MoneyTransfer_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "MoneyMovement" ADD CONSTRAINT "MoneyMovement_cafeId_fkey" FOREIGN KEY ("cafeId") REFERENCES "Cafe"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "MoneyMovement" ADD CONSTRAINT "MoneyMovement_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "MoneyAccount" ADD CONSTRAINT "MoneyAccount_branch_fkey" FOREIGN KEY ("branchId","cafeId") REFERENCES "Branch"("id","cafeId") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "MoneyTransfer" ADD CONSTRAINT "MoneyTransfer_from_fkey" FOREIGN KEY ("cafeId","fromAccountId") REFERENCES "MoneyAccount"("cafeId","id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "MoneyTransfer" ADD CONSTRAINT "MoneyTransfer_to_fkey" FOREIGN KEY ("cafeId","toAccountId") REFERENCES "MoneyAccount"("cafeId","id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "MoneyMovement" ADD CONSTRAINT "MoneyMovement_account_fkey" FOREIGN KEY ("cafeId","accountId") REFERENCES "MoneyAccount"("cafeId","id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "MoneyMovement" ADD CONSTRAINT "MoneyMovement_transfer_fkey" FOREIGN KEY ("cafeId","transferId") REFERENCES "MoneyTransfer"("cafeId","id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "money_no_delete"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Financial source evidence cannot be deleted' USING ERRCODE='23514'; END $$;
CREATE FUNCTION "money_movement_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Money movements are append-only' USING ERRCODE='23514'; END $$;
CREATE FUNCTION "money_account_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NOT EXISTS (SELECT 1 FROM "User" WHERE "id"=NEW."createdById" AND "cafeId"=NEW."cafeId" AND "role"='CAFE_OWNER') THEN RAISE EXCEPTION 'Account creator scope' USING ERRCODE='23514'; END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['name','instaPayEnabled','isActive','updatedAt','version','openingState','openingAt','openingReference','openingApprovedById','openingApprovedAt']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['name','instaPayEnabled','isActive','updatedAt','version','openingState','openingAt','openingReference','openingApprovedById','openingApprovedAt']) OR NEW."version"<>OLD."version"+1 THEN RAISE EXCEPTION 'Account identity/version is immutable' USING ERRCODE='23514'; END IF;
  IF OLD."openingState"='APPROVED' AND ROW(NEW."openingState",NEW."openingAt",NEW."openingReference",NEW."openingApprovedById",NEW."openingApprovedAt") IS DISTINCT FROM ROW(OLD."openingState",OLD."openingAt",OLD."openingReference",OLD."openingApprovedById",OLD."openingApprovedAt") THEN RAISE EXCEPTION 'Approved opening is immutable' USING ERRCODE='23514'; END IF;
  IF NOT NEW."isActive" AND OLD."isActive" AND (COALESCE((SELECT SUM("signedAmount") FROM "MoneyMovement" WHERE "accountId"=NEW."id"),0)<>0 OR EXISTS(SELECT 1 FROM "MoneyTransfer" WHERE ("fromAccountId"=NEW."id" OR "toAccountId"=NEW."id") AND "status"='IN_TRANSIT')) THEN RAISE EXCEPTION 'Nonzero balance or transfer in transit prevents archive' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW."openingApprovedById" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM "User" WHERE "id"=NEW."openingApprovedById" AND "cafeId"=NEW."cafeId") THEN RAISE EXCEPTION 'Opening approver scope' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION "money_transfer_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a "MoneyAccount"; b "MoneyAccount"; actor TEXT;
BEGIN
 -- Every path locks transfer (if existing), then accounts in the SAME sorted order.
 PERFORM 1 FROM "MoneyAccount" WHERE "id" IN (NEW."fromAccountId",NEW."toAccountId") ORDER BY "id" FOR NO KEY UPDATE;
 SELECT * INTO STRICT a FROM "MoneyAccount" WHERE "id"=NEW."fromAccountId" AND "cafeId"=NEW."cafeId";
 SELECT * INTO STRICT b FROM "MoneyAccount" WHERE "id"=NEW."toAccountId" AND "cafeId"=NEW."cafeId";
 IF a."currency"<>NEW."currency" OR b."currency"<>NEW."currency" THEN RAISE EXCEPTION 'Transfer currency mismatch' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW."status"<>'DRAFT' OR NOT a."isActive" OR NOT b."isActive" THEN RAISE EXCEPTION 'New transfer requires active accounts and draft' USING ERRCODE='23514'; END IF;
  NEW."createdAt":=clock_timestamp() AT TIME ZONE 'UTC'; actor:=NEW."createdById";
  IF NEW."fromNameSnapshot"<>a."name" OR NEW."toNameSnapshot"<>b."name" THEN RAISE EXCEPTION 'Invalid name snapshots' USING ERRCODE='23514'; END IF;
  IF NEW."channel"='INSTAPAY' AND NOT(a."kind"='BANK' AND a."instaPayEnabled" AND b."kind" IN ('BANK','WALLET')) THEN RAISE EXCEPTION 'Invalid InstaPay channel' USING ERRCODE='23514'; END IF;
 ELSE
  IF OLD."status"='DRAFT' AND NEW."status"='IN_TRANSIT' THEN
   IF (to_jsonb(NEW)-ARRAY['status','dispatchedById','dispatchedAt','dispatchKey','dispatchFingerprint','dispatchReference']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','dispatchedById','dispatchedAt','dispatchKey','dispatchFingerprint','dispatchReference']) THEN RAISE EXCEPTION 'Immutable transfer data' USING ERRCODE='23514'; END IF;
   IF NOT a."isActive" OR NOT b."isActive" OR a."openingState"<>'APPROVED' OR COALESCE((SELECT SUM("signedAmount") FROM "MoneyMovement" WHERE "accountId"=a."id"),0)<NEW."amount" THEN RAISE EXCEPTION 'Opening/activity/recorded funds unavailable' USING ERRCODE='23514'; END IF;
   IF NEW."channel"='INSTAPAY' AND NOT(a."kind"='BANK' AND a."instaPayEnabled" AND b."kind" IN ('BANK','WALLET')) THEN RAISE EXCEPTION 'Invalid dispatch channel' USING ERRCODE='23514'; END IF;
   IF (a."kind" IN ('BANK','WALLET') OR NEW."channel"='INSTAPAY') AND COALESCE(length(btrim(NEW."dispatchReference")),0)=0 THEN RAISE EXCEPTION 'Dispatch reference required' USING ERRCODE='23514'; END IF;
   PERFORM pg_advisory_xact_lock_shared("accounting_close_key"(NEW."cafeId"));
   NEW."dispatchedAt":=clock_timestamp() AT TIME ZONE 'UTC'; actor:=NEW."dispatchedById";
  ELSIF OLD."status"='IN_TRANSIT' AND NEW."status"='RECEIVED' THEN
   IF (to_jsonb(NEW)-ARRAY['status','receivedById','receivedAt','receiveKey','receiveFingerprint','receiveReference']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','receivedById','receivedAt','receiveKey','receiveFingerprint','receiveReference']) THEN RAISE EXCEPTION 'Immutable dispatch/original data' USING ERRCODE='23514'; END IF;
   IF NOT b."isActive" THEN RAISE EXCEPTION 'Destination inactive' USING ERRCODE='23514'; END IF;
   IF b."kind" IN ('BANK','WALLET') AND COALESCE(length(btrim(NEW."receiveReference")),0)=0 THEN RAISE EXCEPTION 'Receipt reference required' USING ERRCODE='23514'; END IF;
   PERFORM pg_advisory_xact_lock_shared("accounting_close_key"(NEW."cafeId"));
   NEW."receivedAt":=clock_timestamp() AT TIME ZONE 'UTC'; actor:=NEW."receivedById";
  ELSIF OLD."status"='DRAFT' AND NEW."status"='CANCELLED' THEN
   IF (to_jsonb(NEW)-ARRAY['status','cancelledById','cancelledAt','cancelKey','cancelFingerprint','cancelReason']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','cancelledById','cancelledAt','cancelKey','cancelFingerprint','cancelReason']) THEN RAISE EXCEPTION 'Immutable draft data' USING ERRCODE='23514'; END IF;
   NEW."cancelledAt":=clock_timestamp() AT TIME ZONE 'UTC'; actor:=NEW."cancelledById";
  ELSE RAISE EXCEPTION 'Invalid transfer state transition' USING ERRCODE='23514'; END IF;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM "User" WHERE "id"=actor AND "cafeId"=NEW."cafeId" AND "role"='CAFE_OWNER') THEN RAISE EXCEPTION 'Transfer actor scope' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
-- Source-specific: NEVER replace accounting_close_gate(), which permits old-source late events.
CREATE FUNCTION "money_movement_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a "MoneyAccount"; t "MoneyTransfer"; event_day DATE;
BEGIN
 PERFORM pg_advisory_xact_lock_shared("accounting_close_key"(NEW."cafeId"));
 IF NEW."transferId" IS NOT NULL THEN
  SELECT * INTO STRICT t FROM "MoneyTransfer" WHERE "id"=NEW."transferId" AND "cafeId"=NEW."cafeId" FOR NO KEY UPDATE;
  PERFORM 1 FROM "MoneyAccount" WHERE "id" IN(t."fromAccountId",t."toAccountId") ORDER BY "id" FOR NO KEY UPDATE;
 END IF;
 SELECT * INTO STRICT a FROM "MoneyAccount" WHERE "id"=NEW."accountId" AND "cafeId"=NEW."cafeId" FOR NO KEY UPDATE;
 IF a."currency"<>'EGP' OR NOT EXISTS(SELECT 1 FROM "User" WHERE "id"=NEW."actorId" AND "cafeId"=NEW."cafeId") THEN RAISE EXCEPTION 'Movement currency/actor scope' USING ERRCODE='23514'; END IF;
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
CREATE FUNCTION "money_check_transfer"(target TEXT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE t "MoneyTransfer"; outs INTEGER; ins INTEGER;
BEGIN
 SELECT * INTO STRICT t FROM "MoneyTransfer" WHERE "id"=target;
 SELECT count(*) FILTER(WHERE "kind"='TRANSFER_OUT'),count(*) FILTER(WHERE "kind"='TRANSFER_IN') INTO outs,ins FROM "MoneyMovement" WHERE "transferId"=target;
 IF (t."status" IN('DRAFT','CANCELLED') AND (outs<>0 OR ins<>0)) OR (t."status"='IN_TRANSIT' AND (outs<>1 OR ins<>0)) OR (t."status"='RECEIVED' AND (outs<>1 OR ins<>1)) THEN RAISE EXCEPTION 'Transfer movement cardinality mismatch' USING ERRCODE='23514'; END IF;
END $$;
CREATE FUNCTION "money_check_account"(target TEXT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE a "MoneyAccount"; openings INTEGER; balance NUMERIC;
BEGIN
 SELECT * INTO STRICT a FROM "MoneyAccount" WHERE "id"=target;
 SELECT count(*) FILTER(WHERE "kind"='OPENING'),COALESCE(sum("signedAmount"),0) INTO openings,balance FROM "MoneyMovement" WHERE "accountId"=target;
 IF (a."openingState"='APPROVED' AND openings<>1) OR (a."openingState"='UNSET' AND openings<>0) OR balance<0 THEN RAISE EXCEPTION 'Opening cardinality or negative recorded funds' USING ERRCODE='23514'; END IF;
END $$;
CREATE FUNCTION "money_deferred_transfer"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM "money_check_transfer"(NEW."id"); RETURN NULL; END $$;
CREATE FUNCTION "money_deferred_account"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM "money_check_account"(NEW."id"); RETURN NULL; END $$;
CREATE FUNCTION "money_deferred_movement"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM "money_check_account"(NEW."accountId"); IF NEW."transferId" IS NOT NULL THEN PERFORM "money_check_transfer"(NEW."transferId"); END IF; RETURN NULL; END $$;
CREATE TRIGGER "MoneyAccount_guard" BEFORE INSERT OR UPDATE ON "MoneyAccount" FOR EACH ROW EXECUTE FUNCTION "money_account_guard"();
CREATE TRIGGER "MoneyAccount_no_delete" BEFORE DELETE ON "MoneyAccount" FOR EACH ROW EXECUTE FUNCTION "money_no_delete"();
CREATE TRIGGER "MoneyTransfer_guard" BEFORE INSERT OR UPDATE ON "MoneyTransfer" FOR EACH ROW EXECUTE FUNCTION "money_transfer_guard"();
CREATE TRIGGER "MoneyTransfer_no_delete" BEFORE DELETE ON "MoneyTransfer" FOR EACH ROW EXECUTE FUNCTION "money_no_delete"();
CREATE TRIGGER "MoneyMovement_guard" BEFORE INSERT ON "MoneyMovement" FOR EACH ROW EXECUTE FUNCTION "money_movement_guard"();
CREATE TRIGGER "MoneyMovement_immutable" BEFORE UPDATE OR DELETE ON "MoneyMovement" FOR EACH ROW EXECUTE FUNCTION "money_movement_immutable"();
CREATE CONSTRAINT TRIGGER "MoneyAccount_final" AFTER INSERT OR UPDATE ON "MoneyAccount" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "money_deferred_account"();
CREATE CONSTRAINT TRIGGER "MoneyTransfer_final" AFTER INSERT OR UPDATE ON "MoneyTransfer" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "money_deferred_transfer"();
CREATE CONSTRAINT TRIGGER "MoneyMovement_final" AFTER INSERT ON "MoneyMovement" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "money_deferred_movement"();
