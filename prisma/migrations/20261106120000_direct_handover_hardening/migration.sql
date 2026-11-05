-- Direct handover hardening. Additive: no table or column changes, no data touched.
--
-- 1. One drawer partition per shift. The overnight branch-custody declaration (CashStorage) and the
--    direct-handover disposition (ShiftCashDisposition) both describe where a closed shift's counted
--    cash went; a shift may carry at most one of them. Both services refuse first; this is the backstop.
CREATE FUNCTION "shift_cash_single_partition"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target TEXT;
BEGIN
  IF TG_TABLE_NAME = 'ShiftCashDisposition' THEN
    target := NEW."shiftId";
    PERFORM 1 FROM "Shift" WHERE "id" = target FOR UPDATE;
    IF EXISTS (SELECT 1 FROM "CashStorage" WHERE "outgoingShiftId" = target) THEN
      RAISE EXCEPTION 'This shift already declared its cash as overnight drawer storage' USING ERRCODE = '23514';
    END IF;
  ELSE
    target := NEW."outgoingShiftId";
    PERFORM 1 FROM "Shift" WHERE "id" = target FOR UPDATE;
    IF EXISTS (SELECT 1 FROM "ShiftCashDisposition" WHERE "shiftId" = target) THEN
      RAISE EXCEPTION 'This shift already recorded a direct-handover cash disposition' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ShiftCashDisposition_single_partition" BEFORE INSERT ON "ShiftCashDisposition"
  FOR EACH ROW EXECUTE FUNCTION "shift_cash_single_partition"();
CREATE TRIGGER "CashStorage_single_partition" BEFORE INSERT ON "CashStorage"
  FOR EACH ROW EXECUTE FUNCTION "shift_cash_single_partition"();

-- 2. An owner's on-behalf confirmation («تأكيد نيابةً عن المستلم») is not the recipient's own: the named
--    recipient may still dispute it. A recipient's own confirmation stays final. Who confirmed, when and
--    on what basis never changes once written.
CREATE OR REPLACE FUNCTION "cash_delivery_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Cash delivery declarations cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF NEW."cafeId" IS DISTINCT FROM OLD."cafeId" OR NEW."branchId" IS DISTINCT FROM OLD."branchId"
     OR NEW."dispositionId" IS DISTINCT FROM OLD."dispositionId" OR NEW."shiftId" IS DISTINCT FROM OLD."shiftId"
     OR NEW."destination" IS DISTINCT FROM OLD."destination" OR NEW."recipientId" IS DISTINCT FROM OLD."recipientId"
     OR NEW."amount" IS DISTINCT FROM OLD."amount" OR NEW."declaredById" IS DISTINCT FROM OLD."declaredById"
     OR NEW."declaredAt" IS DISTINCT FROM OLD."declaredAt" THEN
    RAISE EXCEPTION 'A cash delivery declaration is immutable evidence' USING ERRCODE = '23514';
  END IF;
  IF OLD."confirmedById" IS NOT NULL AND (NEW."confirmedById" IS DISTINCT FROM OLD."confirmedById"
     OR NEW."confirmedAt" IS DISTINCT FROM OLD."confirmedAt" OR NEW."confirmedByException" IS DISTINCT FROM OLD."confirmedByException"
     OR NEW."exceptionReason" IS DISTINCT FROM OLD."exceptionReason") THEN
    RAISE EXCEPTION 'A recorded confirmation cannot be rewritten' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" = 'CONFIRMED' AND NEW."status" IS DISTINCT FROM 'CONFIRMED'
     AND NOT (OLD."confirmedByException" AND NEW."status" = 'DISPUTED' AND NEW."disputedById" = OLD."recipientId") THEN
    RAISE EXCEPTION 'A confirmed delivery cannot be reopened' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" = 'RESOLVED' AND NEW."status" IS DISTINCT FROM 'RESOLVED' THEN
    RAISE EXCEPTION 'A resolved delivery dispute cannot be reopened' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
