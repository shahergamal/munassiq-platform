-- 0052_telecom_sites: the telecom rollout template (docs/contracting/ARCHITECTURE.md, C11).
--   * A TELECOM_SITE project rolls out many sites under one main contract whose BOQ is the rate card. Each site has
--     its scope (rate-card items × quantities) and moves through a state machine:
--       planned → survey → permitting → civil → installation → on_air → pac → fac   (cancelled before on air)
--     Every move is an event (append-only) with its date; PAC and FAC carry the acceptance certificate.
--   * The contract's milestone terms say what share of a site's value is billable at installation, on air, PAC and
--     FAC (summing to 100%). An IPC's quantities are filled from the sites: Σ site quantity × share reached.

CREATE TABLE telecom_sites (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id     uuid NOT NULL,
  contract_id    uuid,
  code           text NOT NULL CHECK (code ~ '^[A-Za-z0-9._-]{1,40}$'),
  name           text NOT NULL CHECK (char_length(trim(name)) BETWEEN 2 AND 120),
  region         text CHECK (region IS NULL OR char_length(region) <= 80),
  site_type      text NOT NULL CHECK (site_type IN ('greenfield', 'rooftop', 'indoor', 'small_cell', 'fiber', 'upgrade')),
  latitude       numeric(9,6) CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  longitude      numeric(9,6) CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
  status         text NOT NULL DEFAULT 'planned'
                 CHECK (status IN ('planned', 'survey', 'permitting', 'civil', 'installation', 'on_air', 'pac', 'fac', 'cancelled')),
  status_date    date NOT NULL DEFAULT current_date,
  hold_reason    text CHECK (hold_reason IS NULL OR char_length(hold_reason) BETWEEN 3 AND 300),
  pac_ref        text CHECK (pac_ref IS NULL OR char_length(pac_ref) <= 80),
  pac_date       date,
  fac_ref        text CHECK (fac_ref IS NULL OR char_length(fac_ref) <= 80),
  fac_date       date,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, project_id, code),
  CHECK (status NOT IN ('pac', 'fac') OR (pac_ref IS NOT NULL AND pac_date IS NOT NULL)),
  CHECK (status <> 'fac' OR (fac_ref IS NOT NULL AND fac_date IS NOT NULL AND fac_date >= pac_date)),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id),
  FOREIGN KEY (tenant_id, contract_id) REFERENCES contracts (tenant_id, id)
);
CREATE INDEX telecom_sites_project ON telecom_sites (tenant_id, project_id, status);

CREATE TABLE telecom_site_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id      uuid NOT NULL,
  from_status  text,
  to_status    text NOT NULL,
  event_date   date NOT NULL,
  reference    text CHECK (reference IS NULL OR char_length(reference) <= 80),
  note         text CHECK (note IS NULL OR char_length(note) <= 500),
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, site_id) REFERENCES telecom_sites (tenant_id, id)
);
CREATE INDEX telecom_site_events_site ON telecom_site_events (tenant_id, site_id, created_at);
CREATE TRIGGER telecom_site_events_append_only BEFORE UPDATE OR DELETE ON telecom_site_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- The site's scope: items of its contract's rate card (BOQ) and quantities.
CREATE TABLE telecom_site_items (
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id      uuid NOT NULL,
  boq_item_id  uuid NOT NULL,
  quantity     numeric(18,4) NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (tenant_id, site_id, boq_item_id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES telecom_sites (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, boq_item_id) REFERENCES boq_items (tenant_id, id)
);

-- A billed site does not change its scope (the IPCs certified it).
CREATE FUNCTION telecom_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE _s text;
BEGIN
  SELECT status INTO _s FROM telecom_sites WHERE id = COALESCE(NEW.site_id, OLD.site_id) FOR SHARE;
  IF _s IN ('on_air', 'pac', 'fac') THEN RAISE EXCEPTION 'site_scope_frozen' USING ERRCODE = 'P0001'; END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER telecom_site_items_guard BEFORE INSERT OR UPDATE OR DELETE ON telecom_site_items FOR EACH ROW EXECUTE FUNCTION telecom_scope_guard();

CREATE TABLE contract_milestone_terms (
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contract_id  uuid NOT NULL,
  milestone    text NOT NULL CHECK (milestone IN ('installation', 'on_air', 'pac', 'fac')),
  pct          numeric(5,2) NOT NULL CHECK (pct > 0 AND pct <= 100),
  PRIMARY KEY (tenant_id, contract_id, milestone),
  FOREIGN KEY (tenant_id, contract_id) REFERENCES contracts (tenant_id, id)
);

DO $$
DECLARE _t text;
BEGIN
  FOREACH _t IN ARRAY ARRAY['telecom_sites', 'telecom_site_events', 'telecom_site_items', 'contract_milestone_terms'] LOOP
    PERFORM enable_tenant_rls(_t::regclass);
  END LOOP;
  PERFORM grant_app('telecom_sites', 'SELECT, INSERT, UPDATE');
  PERFORM grant_app('telecom_site_events', 'SELECT, INSERT');
  PERFORM grant_app('telecom_site_items', 'SELECT, INSERT, UPDATE, DELETE');
  PERFORM grant_app('contract_milestone_terms', 'SELECT, INSERT, UPDATE, DELETE');
END $$;
