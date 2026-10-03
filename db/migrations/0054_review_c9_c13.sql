-- 0054_review_c9_c13: fixes from the review of C9-C13.
--   * Schedule: an activity no longer in the imported programme but with site progress is kept, flagged as removed,
--     and left out of earned value (it was deleted by its summary's cascade, or counted twice).
--   * Telecom: a site's scope and contract freeze from installation (the first billable milestone), not on air.
--   * Documents: the storage quota counts the files uploaded since the last hourly measurement, under a per-tenant
--     lock, so a burst of uploads cannot go far past the plan.

ALTER TABLE schedule_activities ADD COLUMN removed boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION telecom_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE _s text;
BEGIN
  SELECT status INTO _s FROM telecom_sites WHERE id = COALESCE(NEW.site_id, OLD.site_id) FOR SHARE;
  IF _s IN ('installation', 'on_air', 'pac', 'fac') THEN RAISE EXCEPTION 'site_scope_frozen' USING ERRCODE = 'P0001'; END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE FUNCTION enforce_document_storage_limit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE s record; _recent bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text, 51));
  SELECT * INTO s FROM tenant_storage_state(NEW.tenant_id);
  IF s.limit_mb IS NULL THEN RETURN NEW; END IF;
  SELECT coalesce(sum(size_bytes), 0) INTO _recent FROM document_revisions
   WHERE tenant_id = NEW.tenant_id AND (s.measured_at IS NULL OR created_at > s.measured_at);
  IF s.used_bytes + _recent + NEW.size_bytes > s.limit_mb::bigint * 1048576 THEN
    RAISE EXCEPTION 'plan_limit_reached:storage' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER document_revisions_storage_limit ON document_revisions;
CREATE TRIGGER document_revisions_storage_limit BEFORE INSERT ON document_revisions FOR EACH ROW EXECUTE FUNCTION enforce_document_storage_limit();
