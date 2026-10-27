CREATE FUNCTION "protect_reporting_version"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Reporting versions are immutable; append a future effective version';
END;
$$;
-- statement-break
CREATE TRIGGER "BranchReportingVersion_immutable"
BEFORE UPDATE OR DELETE ON "BranchReportingVersion"
FOR EACH ROW EXECUTE FUNCTION "protect_reporting_version"();
