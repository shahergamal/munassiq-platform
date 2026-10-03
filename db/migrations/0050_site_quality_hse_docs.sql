-- 0050_site_quality_hse_docs: the digital site (docs/contracting/ARCHITECTURE.md, C10).
--   * Quality: the project's inspection and test plan (ITP, hold / witness / review points), inspection requests for
--     work (WIR) and materials (MIR) with the consultant's result, non-conformance reports (NCR) with a responsible
--     subcontractor and a disposition, and requests for information (RFI) that may lead to a variation or a claim.
--   * Safety: incidents by severity (lost-time and recordable cases drive LTIFR / TRIR), and permits to work.
--   * Documents: the register (drawings, specifications, submittals) with revisions as files (append-only; a file
--     never changes, a new revision supersedes), the consultant's review code, and transmittals that record what was
--     sent to whom.
--   * Daily site reports: weather, work done, manpower by trade and company, equipment hours; final once submitted.
--     The manpower hours are the man-hours the safety rates are measured on.

-- ── Quality ─────────────────────────────────────────────────────────────────────────────────
CREATE TABLE itp_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id   uuid NOT NULL,
  activity     text NOT NULL CHECK (char_length(trim(activity)) BETWEEN 2 AND 200),
  -- H: work stops until the consultant inspects; W: notified, may attend; R: documents reviewed.
  point        text NOT NULL CHECK (point IN ('H', 'W', 'R')),
  reference    text CHECK (reference IS NULL OR char_length(reference) <= 200),
  criteria     text CHECK (criteria IS NULL OR char_length(criteria) <= 500),
  frequency    text CHECK (frequency IS NULL OR char_length(frequency) <= 120),
  is_active    boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id)
);

CREATE TABLE inspection_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id      uuid NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('WIR', 'MIR')),
  number          bigint NOT NULL,
  itp_item_id     uuid,
  wbs_id          uuid,
  boq_item_id     uuid,
  ingredient_id   uuid,
  supplier_id     uuid,
  quantity        numeric(18,4) CHECK (quantity IS NULL OR quantity > 0),
  location        text CHECK (location IS NULL OR char_length(location) <= 200),
  description     text NOT NULL CHECK (char_length(trim(description)) BETWEEN 3 AND 1000),
  requested_for   date NOT NULL,
  reinspection_of uuid,
  status          text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'approved', 'approved_as_noted', 'rejected', 'cancelled')),
  inspector       text CHECK (inspector IS NULL OR char_length(inspector) <= 120),
  inspected_on    date,
  comments        text CHECK (comments IS NULL OR char_length(comments) <= 1000),
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  result_by       uuid,
  result_at       timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, kind, number),
  CHECK (kind = 'WIR' OR ingredient_id IS NOT NULL),
  CHECK (status IN ('submitted', 'cancelled') OR (inspected_on IS NOT NULL AND result_at IS NOT NULL)),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id),
  FOREIGN KEY (tenant_id, itp_item_id) REFERENCES itp_items (tenant_id, id),
  FOREIGN KEY (tenant_id, wbs_id) REFERENCES wbs_nodes (tenant_id, id),
  FOREIGN KEY (tenant_id, boq_item_id) REFERENCES boq_items (tenant_id, id),
  FOREIGN KEY (tenant_id, ingredient_id) REFERENCES ingredients (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id),
  FOREIGN KEY (tenant_id, reinspection_of) REFERENCES inspection_requests (tenant_id, id)
);
CREATE INDEX inspection_requests_project ON inspection_requests (tenant_id, project_id, status);

CREATE TABLE site_ncrs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id         uuid NOT NULL,
  number             bigint NOT NULL,
  source             text NOT NULL CHECK (source IN ('inspection', 'internal_audit', 'client', 'consultant')),
  inspection_id      uuid,
  supplier_id        uuid,
  severity           text NOT NULL CHECK (severity IN ('minor', 'major')),
  description        text NOT NULL CHECK (char_length(trim(description)) BETWEEN 5 AND 1000),
  disposition        text CHECK (disposition IS NULL OR disposition IN ('rework', 'repair', 'use_as_is', 'reject')),
  root_cause         text CHECK (root_cause IS NULL OR char_length(root_cause) <= 1000),
  corrective_action  text CHECK (corrective_action IS NULL OR char_length(corrective_action) <= 1000),
  cost_estimate      numeric(14,2) CHECK (cost_estimate IS NULL OR cost_estimate >= 0),
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_by         uuid NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  closed_by          uuid,
  closed_at          timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, number),
  CHECK (status = 'open' OR (disposition IS NOT NULL AND corrective_action IS NOT NULL AND closed_at IS NOT NULL)),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id),
  FOREIGN KEY (tenant_id, inspection_id) REFERENCES inspection_requests (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id)
);

CREATE TABLE rfis (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id     uuid NOT NULL,
  number         bigint NOT NULL,
  subject        text NOT NULL CHECK (char_length(trim(subject)) BETWEEN 3 AND 200),
  question       text NOT NULL CHECK (char_length(trim(question)) BETWEEN 5 AND 2000),
  discipline     text NOT NULL CHECK (discipline IN ('architectural', 'structural', 'mep', 'civil', 'general')),
  required_by    date,
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'closed')),
  answer         text CHECK (answer IS NULL OR char_length(answer) <= 2000),
  answered_on    date,
  -- What the answer changes: nothing, the price, the time, or both. Cost or time leads to a variation or a claim.
  impact         text CHECK (impact IS NULL OR impact IN ('none', 'cost', 'time', 'cost_time')),
  variation_id   uuid,
  claim_id       uuid,
  created_by     uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, number),
  CHECK (status = 'open' OR (answer IS NOT NULL AND answered_on IS NOT NULL AND impact IS NOT NULL)),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id),
  FOREIGN KEY (tenant_id, variation_id) REFERENCES variations (tenant_id, id),
  FOREIGN KEY (tenant_id, claim_id) REFERENCES claims (tenant_id, id)
);

-- ── Safety ──────────────────────────────────────────────────────────────────────────────────
CREATE TABLE hse_incidents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id      uuid NOT NULL,
  number          bigint NOT NULL,
  occurred_at     timestamptz NOT NULL,
  -- Recordable = medical treatment, lost time, fatality. Lost time = away from work beyond the day of the injury.
  kind            text NOT NULL CHECK (kind IN ('near_miss', 'first_aid', 'medical_treatment', 'lost_time', 'fatality', 'property_damage', 'environmental')),
  description     text NOT NULL CHECK (char_length(trim(description)) BETWEEN 5 AND 2000),
  location        text CHECK (location IS NULL OR char_length(location) <= 200),
  employee_id     uuid,
  supplier_id     uuid,
  lost_days       integer NOT NULL DEFAULT 0 CHECK (lost_days >= 0),
  immediate_action text CHECK (immediate_action IS NULL OR char_length(immediate_action) <= 1000),
  root_cause      text CHECK (root_cause IS NULL OR char_length(root_cause) <= 1000),
  reported_to_authority_on date,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, number),
  CHECK (kind = 'lost_time' OR lost_days = 0),
  CHECK (status = 'open' OR (root_cause IS NOT NULL AND closed_at IS NOT NULL)),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id)
);
CREATE INDEX hse_incidents_project ON hse_incidents (tenant_id, project_id, occurred_at);

CREATE TABLE work_permits (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id    uuid NOT NULL,
  number        bigint NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('hot_work', 'confined_space', 'work_at_height', 'excavation', 'electrical', 'lifting')),
  location      text NOT NULL CHECK (char_length(trim(location)) BETWEEN 2 AND 200),
  description   text NOT NULL CHECK (char_length(trim(description)) BETWEEN 3 AND 1000),
  precautions   text CHECK (precautions IS NULL OR char_length(precautions) <= 1000),
  supplier_id   uuid,
  valid_from    timestamptz NOT NULL,
  valid_to      timestamptz NOT NULL,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed', 'cancelled')),
  issued_by     uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  closed_by     uuid,
  closed_at     timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, number),
  CHECK (valid_to > valid_from AND valid_to <= valid_from + interval '7 days'),
  CHECK (status = 'active' OR closed_at IS NOT NULL),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id)
);

-- ── Documents ───────────────────────────────────────────────────────────────────────────────
CREATE TABLE project_documents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id   uuid NOT NULL,
  number       text NOT NULL CHECK (number ~ '^[A-Za-z0-9._/-]{1,60}$'),
  title        text NOT NULL CHECK (char_length(trim(title)) BETWEEN 2 AND 200),
  doc_type     text NOT NULL CHECK (doc_type IN ('drawing', 'shop_drawing', 'specification', 'method_statement', 'material_submittal', 'report', 'correspondence', 'other')),
  discipline   text NOT NULL CHECK (discipline IN ('architectural', 'structural', 'mep', 'civil', 'general')),
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, project_id, number),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id)
);

CREATE TABLE document_revisions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_id  uuid NOT NULL,
  revision     text NOT NULL CHECK (revision ~ '^[A-Z0-9]{1,4}$'),
  filename     text NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 200),
  mime         text NOT NULL CHECK (mime IN ('application/pdf', 'image/png', 'image/jpeg', 'image/vnd.dwg')),
  size_bytes   integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 15728640),
  sha256       text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  content      bytea NOT NULL,
  notes        text CHECK (notes IS NULL OR char_length(notes) <= 500),
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, document_id, revision),
  FOREIGN KEY (tenant_id, document_id) REFERENCES project_documents (tenant_id, id)
);
CREATE TRIGGER document_revisions_append_only BEFORE UPDATE OR DELETE ON document_revisions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- The consultant's review of a revision submitted for approval (one review a revision; a new review = a new revision).
-- A: approved, B: approved as noted, C: revise and resubmit, D: rejected.
CREATE TABLE document_reviews (
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  revision_id  uuid NOT NULL,
  code         text NOT NULL CHECK (code IN ('A', 'B', 'C', 'D')),
  reviewed_on  date NOT NULL,
  reviewer     text CHECK (reviewer IS NULL OR char_length(reviewer) <= 120),
  comments     text CHECK (comments IS NULL OR char_length(comments) <= 1000),
  recorded_by  uuid NOT NULL,
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, revision_id),
  FOREIGN KEY (tenant_id, revision_id) REFERENCES document_revisions (tenant_id, id)
);
CREATE TRIGGER document_reviews_append_only BEFORE UPDATE OR DELETE ON document_reviews FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE transmittals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id   uuid NOT NULL,
  number       bigint NOT NULL,
  recipient    text NOT NULL CHECK (char_length(trim(recipient)) BETWEEN 2 AND 200),
  purpose      text NOT NULL CHECK (purpose IN ('for_approval', 'for_information', 'for_construction', 'as_built')),
  sent_on      date NOT NULL,
  notes        text CHECK (notes IS NULL OR char_length(notes) <= 500),
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, number),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id)
);
CREATE TABLE transmittal_items (
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  transmittal_id  uuid NOT NULL,
  revision_id     uuid NOT NULL,
  PRIMARY KEY (tenant_id, transmittal_id, revision_id),
  FOREIGN KEY (tenant_id, transmittal_id) REFERENCES transmittals (tenant_id, id),
  FOREIGN KEY (tenant_id, revision_id) REFERENCES document_revisions (tenant_id, id)
);
CREATE TRIGGER transmittals_append_only BEFORE UPDATE OR DELETE ON transmittals FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER transmittal_items_append_only BEFORE UPDATE OR DELETE ON transmittal_items FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ── Daily site reports ──────────────────────────────────────────────────────────────────────
CREATE TABLE daily_reports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id    uuid NOT NULL,
  report_date   date NOT NULL,
  weather       text CHECK (weather IS NULL OR weather IN ('clear', 'hot', 'windy', 'dust', 'rain')),
  temperature   numeric(4,1) CHECK (temperature IS NULL OR temperature BETWEEN -10 AND 60),
  work_done     text CHECK (work_done IS NULL OR char_length(work_done) <= 4000),
  issues        text CHECK (issues IS NULL OR char_length(issues) <= 2000),
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted')),
  created_by    uuid NOT NULL,
  submitted_by  uuid,
  submitted_at  timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, project_id, report_date),
  CHECK (status = 'draft' OR submitted_at IS NOT NULL),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id)
);
CREATE TABLE daily_report_manpower (
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id    uuid NOT NULL,
  trade        text NOT NULL CHECK (char_length(trim(trade)) BETWEEN 2 AND 80),
  supplier_id  uuid,
  headcount    integer NOT NULL CHECK (headcount BETWEEN 1 AND 5000),
  hours        numeric(4,1) NOT NULL CHECK (hours > 0 AND hours <= 16),
  FOREIGN KEY (tenant_id, report_id) REFERENCES daily_reports (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id)
);
CREATE TABLE daily_report_equipment (
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id    uuid NOT NULL,
  machine_id   uuid,
  description  text NOT NULL CHECK (char_length(trim(description)) BETWEEN 2 AND 120),
  working_hours numeric(4,1) NOT NULL DEFAULT 0 CHECK (working_hours BETWEEN 0 AND 24),
  idle_hours   numeric(4,1) NOT NULL DEFAULT 0 CHECK (idle_hours BETWEEN 0 AND 24),
  CHECK (working_hours + idle_hours <= 24),
  FOREIGN KEY (tenant_id, report_id) REFERENCES daily_reports (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, machine_id) REFERENCES machines (tenant_id, id)
);

-- A submitted report is final: no change to it or its lines.
CREATE FUNCTION daily_report_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE _r uuid; _s text;
BEGIN
  IF TG_TABLE_NAME = 'daily_reports' THEN
    IF OLD.status = 'submitted' THEN RAISE EXCEPTION 'daily_report_final' USING ERRCODE = 'P0001'; END IF;
    RETURN COALESCE(NEW, OLD);
  END IF;
  _r := COALESCE(NEW.report_id, OLD.report_id);
  SELECT status INTO _s FROM daily_reports WHERE id = _r FOR SHARE;
  IF _s = 'submitted' THEN RAISE EXCEPTION 'daily_report_final' USING ERRCODE = 'P0001'; END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER daily_reports_guard BEFORE UPDATE OR DELETE ON daily_reports FOR EACH ROW EXECUTE FUNCTION daily_report_guard();
CREATE TRIGGER daily_report_manpower_guard BEFORE INSERT OR UPDATE OR DELETE ON daily_report_manpower FOR EACH ROW EXECUTE FUNCTION daily_report_guard();
CREATE TRIGGER daily_report_equipment_guard BEFORE INSERT OR UPDATE OR DELETE ON daily_report_equipment FOR EACH ROW EXECUTE FUNCTION daily_report_guard();

DO $$
DECLARE _t text;
BEGIN
  FOREACH _t IN ARRAY ARRAY['itp_items', 'inspection_requests', 'site_ncrs', 'rfis', 'hse_incidents', 'work_permits', 'project_documents', 'document_revisions',
                            'document_reviews', 'transmittals', 'transmittal_items', 'daily_reports', 'daily_report_manpower', 'daily_report_equipment'] LOOP
    PERFORM enable_tenant_rls(_t::regclass);
  END LOOP;
  PERFORM grant_app('itp_items', 'SELECT, INSERT, UPDATE');
  PERFORM grant_app('inspection_requests', 'SELECT, INSERT, UPDATE');
  PERFORM grant_app('site_ncrs', 'SELECT, INSERT, UPDATE');
  PERFORM grant_app('rfis', 'SELECT, INSERT, UPDATE');
  PERFORM grant_app('hse_incidents', 'SELECT, INSERT, UPDATE');
  PERFORM grant_app('work_permits', 'SELECT, INSERT, UPDATE');
  PERFORM grant_app('project_documents', 'SELECT, INSERT, UPDATE');
  PERFORM grant_app('document_revisions', 'SELECT, INSERT');
  PERFORM grant_app('document_reviews', 'SELECT, INSERT');
  PERFORM grant_app('transmittals', 'SELECT, INSERT');
  PERFORM grant_app('transmittal_items', 'SELECT, INSERT');
  PERFORM grant_app('daily_reports', 'SELECT, INSERT, UPDATE');
  PERFORM grant_app('daily_report_manpower', 'SELECT, INSERT, UPDATE, DELETE');
  PERFORM grant_app('daily_report_equipment', 'SELECT, INSERT, UPDATE, DELETE');
END $$;
