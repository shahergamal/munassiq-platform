-- 0046_labor_projects: labour on projects (docs/contracting/ARCHITECTURE.md, C8).
--   * Daily hours of an employee on a project (and its WBS element); a day's hours across projects stay within 24.
--   * Allocating an approved payroll run to projects by those hours: per-project totals only (salaries stay sealed),
--     one allocation per run, append-only, posted to the projects' labour cost against a contra account.

CREATE TABLE labor_timesheets (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id    uuid NOT NULL,
  project_id     uuid NOT NULL,
  work_date      date NOT NULL,
  hours          numeric(5,2) NOT NULL CHECK (hours > 0 AND hours <= 24),
  wbs_id         uuid,
  recorded_by    uuid NOT NULL,
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, employee_id, project_id, work_date),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id),
  FOREIGN KEY (tenant_id, wbs_id) REFERENCES wbs_nodes (tenant_id, id)
);
CREATE FUNCTION labor_timesheets_day_cap() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT sum(hours) FROM labor_timesheets WHERE employee_id = NEW.employee_id AND work_date = NEW.work_date) > 24 THEN
    RAISE EXCEPTION 'labor_day_over_24' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER labor_timesheets_day_cap AFTER INSERT OR UPDATE ON labor_timesheets DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION labor_timesheets_day_cap();

CREATE TABLE labor_allocations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id        uuid NOT NULL,
  allocated     numeric(14,2) NOT NULL CHECK (allocated >= 0),
  unallocated   numeric(14,2) NOT NULL CHECK (unallocated >= 0),
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, run_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES payroll_runs (tenant_id, id)
);
CREATE TABLE labor_allocation_lines (
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  allocation_id uuid NOT NULL,
  project_id    uuid NOT NULL,
  hours         numeric(10,2) NOT NULL,
  amount        numeric(14,2) NOT NULL CHECK (amount >= 0),
  PRIMARY KEY (tenant_id, allocation_id, project_id),
  FOREIGN KEY (tenant_id, allocation_id) REFERENCES labor_allocations (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id)
);
CREATE TRIGGER labor_allocations_append_only BEFORE UPDATE OR DELETE ON labor_allocations FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER labor_allocation_lines_append_only BEFORE UPDATE OR DELETE ON labor_allocation_lines FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

DO $$
DECLARE _t text;
BEGIN
  FOREACH _t IN ARRAY ARRAY['labor_timesheets', 'labor_allocations', 'labor_allocation_lines'] LOOP
    PERFORM enable_tenant_rls(_t::regclass);
  END LOOP;
  PERFORM grant_app('labor_timesheets', 'SELECT, INSERT, UPDATE, DELETE');
  PERFORM grant_app('labor_allocations', 'SELECT, INSERT');
  PERFORM grant_app('labor_allocation_lines', 'SELECT, INSERT');
END $$;
