-- 0049_schedule_cost_control: scheduling, cost control and earned value (docs/contracting/ARCHITECTURE.md, C9).
--   * A project's programme: activities (imported from P6 XER / MS Project XML or entered), with the baseline dates,
--     progress and actual dates; summary rows keep the tree. Progress updates are the site's; the baseline is the plan.
--   * The project budget per WBS element and cost code (the control baseline, BAC).
--   * Monthly earned-value snapshots (PV, EV, AC as they stood), append-only, for the S-curve's actual lines.

CREATE TABLE schedule_activities (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id     uuid NOT NULL,
  parent_id      uuid,
  code           text NOT NULL CHECK (char_length(trim(code)) BETWEEN 1 AND 60),
  name           text NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 300),
  is_summary     boolean NOT NULL DEFAULT false,
  start_date     date,
  finish_date    date,
  budget         numeric(16,2) NOT NULL DEFAULT 0 CHECK (budget >= 0),
  pct_complete   numeric(5,2) NOT NULL DEFAULT 0 CHECK (pct_complete BETWEEN 0 AND 100),
  actual_start   date,
  actual_finish  date,
  wbs_id         uuid,
  sort           integer NOT NULL DEFAULT 0,
  progress_at    timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, project_id, code),
  CHECK (is_summary OR (start_date IS NOT NULL AND finish_date IS NOT NULL AND finish_date >= start_date)),
  CHECK (actual_finish IS NULL OR (actual_start IS NOT NULL AND actual_finish >= actual_start)),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES schedule_activities (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, wbs_id) REFERENCES wbs_nodes (tenant_id, id)
);

CREATE TABLE project_budgets (
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL,
  wbs_id        uuid,
  cost_code_id  uuid NOT NULL,
  amount        numeric(16,2) NOT NULL CHECK (amount >= 0),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id),
  FOREIGN KEY (tenant_id, wbs_id) REFERENCES wbs_nodes (tenant_id, id),
  FOREIGN KEY (tenant_id, cost_code_id) REFERENCES cost_codes (tenant_id, id)
);
CREATE UNIQUE INDEX project_budgets_line ON project_budgets (tenant_id, project_id, coalesce(wbs_id, '00000000-0000-0000-0000-000000000000'::uuid), cost_code_id);

CREATE TABLE evm_snapshots (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id  uuid NOT NULL,
  period      text NOT NULL CHECK (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  bac         numeric(16,2) NOT NULL,
  pv          numeric(16,2) NOT NULL,
  ev          numeric(16,2) NOT NULL,
  ac          numeric(16,2) NOT NULL,
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, project_id, period),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id)
);
CREATE TRIGGER evm_snapshots_append_only BEFORE UPDATE OR DELETE ON evm_snapshots FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

DO $$
DECLARE _t text;
BEGIN
  FOREACH _t IN ARRAY ARRAY['schedule_activities', 'project_budgets', 'evm_snapshots'] LOOP
    PERFORM enable_tenant_rls(_t::regclass);
  END LOOP;
  PERFORM grant_app('schedule_activities', 'SELECT, INSERT, UPDATE, DELETE');
  PERFORM grant_app('project_budgets', 'SELECT, INSERT, UPDATE, DELETE');
  PERFORM grant_app('evm_snapshots', 'SELECT, INSERT');
END $$;
