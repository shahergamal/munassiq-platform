-- 0034_hr_payroll: human resources and payroll, for every sector (docs/manufacturing/ARCHITECTURE.md, M7).
--   * Employees with their identity, IBAN and pay sealed at field level (AES-256-GCM in the server, like ZATCA
--     secrets): the database never holds a salary, an ID number or an IBAN in clear text.
--   * GOSI rates are a dated table read by the payroll (old / new system / non-Saudi), never constants in code.
--   * Attendance (hours, overtime, absence) per day; leave types with the Labour Law's 2025 values; leave requests.
--   * Payroll runs: draft → approved (posted) → paid, one line per employee (amounts sealed), and final
--     settlements (end of service, Articles 84/85/87) when an employee leaves.

-- ── GOSI rates (all workspaces) ───────────────────────────────────────────────────────────────
-- Percent of the contribution base (basic + housing, in-kind housing = two months' basic a year), capped monthly.
-- Sources: Social Insurance Law (Royal Decree M/273), Council of Ministers decision 1022, GOSI awareness platform.
CREATE TABLE gosi_rates (
  scheme            text NOT NULL CHECK (scheme IN ('old', 'new', 'non_saudi')),
  valid_from        date NOT NULL,
  employee_pension  numeric(5,2) NOT NULL,
  employer_pension  numeric(5,2) NOT NULL,
  employee_saned    numeric(5,2) NOT NULL,
  employer_saned    numeric(5,2) NOT NULL,
  employer_hazard   numeric(5,2) NOT NULL,
  wage_ceiling      numeric(12,2) NOT NULL,
  source            text NOT NULL,
  PRIMARY KEY (scheme, valid_from)
);
INSERT INTO gosi_rates VALUES
  ('old',       '2000-01-01', 9,    9,    0.75, 0.75, 2, 45000, 'نظام التأمينات الاجتماعية: المشتركون قبل 3 يوليو 2024'),
  ('new',       '2024-07-03', 9,    9,    0.75, 0.75, 2, 45000, 'نظام التأمينات الجديد م/273'),
  ('new',       '2025-07-01', 9.5,  9.5,  0.75, 0.75, 2, 45000, 'قرار مجلس الوزراء 1022: زيادة 0.5% سنوياً'),
  ('new',       '2026-07-01', 10,   10,   0.75, 0.75, 2, 45000, 'قرار مجلس الوزراء 1022: زيادة 0.5% سنوياً'),
  ('new',       '2027-07-01', 10.5, 10.5, 0.75, 0.75, 2, 45000, 'قرار مجلس الوزراء 1022: زيادة 0.5% سنوياً'),
  ('new',       '2028-07-01', 11,   11,   0.75, 0.75, 2, 45000, 'قرار مجلس الوزراء 1022: الحد النهائي 11%'),
  ('non_saudi', '2000-01-01', 0,    0,    0,    0,    2, 45000, 'غير السعودي: فرع الأخطار المهنية على صاحب العمل فقط');
GRANT SELECT ON gosi_rates TO munassiq_app;

-- ── Employees ─────────────────────────────────────────────────────────────────────────────────
CREATE TABLE employees (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code                text NOT NULL CHECK (code ~ '^[A-Za-z0-9-]{1,20}$'),
  name                text NOT NULL CHECK (char_length(trim(name)) BETWEEN 2 AND 120),
  name_en             text CHECK (name_en IS NULL OR char_length(name_en) <= 120),
  gender              text NOT NULL CHECK (gender IN ('male', 'female')),
  -- ISO country code; 'SA' = Saudi (GOSI pension and SANED, Saudization).
  nationality         text NOT NULL CHECK (nationality ~ '^[A-Z]{2}$'),
  id_type             text NOT NULL CHECK (id_type IN ('national_id', 'iqama', 'border_number', 'passport')),
  id_number_enc       text NOT NULL,
  -- Last 4 digits, to find someone without opening the sealed number.
  id_last4            text NOT NULL CHECK (id_last4 ~ '^[0-9A-Za-z]{1,4}$'),
  id_expiry           date,
  passport_expiry     date,
  birth_date          date,
  job_title           text NOT NULL CHECK (char_length(trim(job_title)) BETWEEN 2 AND 120),
  occupation_code     text CHECK (occupation_code IS NULL OR char_length(occupation_code) <= 20),
  branch_id           uuid,
  cost_center_id      uuid,
  -- Production staff: their attendance loads this work center; payroll posts to its cost center.
  work_center_id      uuid,
  hire_date           date NOT NULL,
  -- First GOSI registration: on or after 2024-07-03 = the new system's rates (Saudis only).
  gosi_first_registered date,
  gosi_number         text CHECK (gosi_number IS NULL OR char_length(gosi_number) <= 20),
  -- Pay, sealed: { basic, housing, housingInKind, transport, other[], gosiRegisteredWage }.
  pay_enc             text NOT NULL,
  iban_enc            text,
  -- The bank code (digits 5-6 of a Saudi IBAN) chooses the bank file; not sensitive on its own.
  bank_code           text CHECK (bank_code IS NULL OR bank_code ~ '^[0-9]{2}$'),
  qiwa_contract_no    text CHECK (qiwa_contract_no IS NULL OR char_length(qiwa_contract_no) <= 40),
  contract_type       text NOT NULL DEFAULT 'unlimited' CHECK (contract_type IN ('fixed', 'unlimited')),
  contract_end        date,
  medical_class       text CHECK (medical_class IS NULL OR char_length(medical_class) <= 20),
  medical_dependents  integer NOT NULL DEFAULT 0 CHECK (medical_dependents BETWEEN 0 AND 20),
  medical_expiry      date,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'terminated')),
  terminated_on       date,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  CHECK (contract_type = 'unlimited' OR contract_end IS NOT NULL),
  CHECK (status = 'active' OR terminated_on IS NOT NULL),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, cost_center_id) REFERENCES cost_centers (tenant_id, id),
  FOREIGN KEY (tenant_id, work_center_id) REFERENCES work_centers (tenant_id, id)
);

-- ── Attendance ────────────────────────────────────────────────────────────────────────────────
CREATE TABLE attendance (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id     uuid NOT NULL,
  work_date       date NOT NULL,
  status          text NOT NULL CHECK (status IN ('present', 'absent', 'leave', 'weekend', 'holiday')),
  hours           numeric(5,2) NOT NULL DEFAULT 0 CHECK (hours BETWEEN 0 AND 24),
  overtime_hours  numeric(5,2) NOT NULL DEFAULT 0 CHECK (overtime_hours BETWEEN 0 AND 12),
  -- Article 107 as amended: overtime may be compensated with leave instead of pay, with the worker's consent.
  overtime_as_leave boolean NOT NULL DEFAULT false,
  work_center_id  uuid,
  note            text CHECK (note IS NULL OR char_length(note) <= 200),
  recorded_by     uuid NOT NULL,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, employee_id, work_date),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  FOREIGN KEY (tenant_id, work_center_id) REFERENCES work_centers (tenant_id, id)
);

-- ── Leaves ────────────────────────────────────────────────────────────────────────────────────
-- A workspace's leave types (seeded with the Labour Law's; days and pay can be adjusted for better terms).
CREATE TABLE leave_types (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code           text NOT NULL CHECK (code ~ '^[a-z_]{2,30}$'),
  name           text NOT NULL CHECK (char_length(trim(name)) BETWEEN 2 AND 80),
  -- annual: accrues with service; sick: tiered pay (Article 117); fixed: up to max_days per occurrence; unpaid.
  kind           text NOT NULL CHECK (kind IN ('annual', 'sick', 'fixed', 'unpaid', 'compensatory')),
  max_days       integer CHECK (max_days IS NULL OR max_days BETWEEN 1 AND 366),
  paid           boolean NOT NULL DEFAULT true,
  gender         text CHECK (gender IS NULL OR gender IN ('male', 'female')),
  is_active      boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE leave_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id     uuid NOT NULL,
  leave_type_id   uuid NOT NULL,
  start_date      date NOT NULL,
  end_date        date NOT NULL,
  days            integer NOT NULL CHECK (days BETWEEN 1 AND 366),
  status          text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'rejected', 'cancelled')),
  note            text CHECK (note IS NULL OR char_length(note) <= 500),
  decided_by      uuid,
  decided_at      timestamptz,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  FOREIGN KEY (tenant_id, leave_type_id) REFERENCES leave_types (tenant_id, id)
);
CREATE INDEX leave_requests_employee_idx ON leave_requests (tenant_id, employee_id, start_date);

CREATE FUNCTION seed_leave_types(_t uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO leave_types (tenant_id, code, name, kind, max_days, paid, gender) VALUES
    (_t, 'annual',       'الإجازة السنوية (م109)', 'annual', NULL, true, NULL),
    (_t, 'sick',         'الإجازة المرضية (م117)', 'sick', 120, true, NULL),
    (_t, 'maternity',    'إجازة الوضع (12 أسبوعاً)', 'fixed', 84, true, 'female'),
    (_t, 'paternity',    'إجازة الأبوة (3 أيام)', 'fixed', 3, true, 'male'),
    (_t, 'marriage',     'إجازة الزواج (5 أيام)', 'fixed', 5, true, NULL),
    (_t, 'bereavement',  'وفاة الزوج أو أحد الأصول أو الفروع (5 أيام)', 'fixed', 5, true, NULL),
    (_t, 'sibling_death', 'وفاة الأخ أو الأخت (3 أيام)', 'fixed', 3, true, NULL),
    (_t, 'hajj',         'إجازة الحج (مرة في الخدمة)', 'fixed', 15, true, NULL),
    (_t, 'exam',         'إجازة الامتحان', 'fixed', 30, true, NULL),
    (_t, 'compensatory', 'إجازة تعويضية عن العمل الإضافي', 'compensatory', NULL, true, NULL),
    (_t, 'unpaid',       'إجازة بدون أجر', 'unpaid', NULL, false, NULL)
  ON CONFLICT (tenant_id, code) DO NOTHING $$;
DO $$ DECLARE _t uuid; BEGIN FOR _t IN SELECT id FROM tenants LOOP PERFORM seed_leave_types(_t); END LOOP; END $$;
REVOKE ALL ON FUNCTION seed_leave_types(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION seed_leave_types(uuid) TO munassiq_system, munassiq_app;

-- ── Payroll ───────────────────────────────────────────────────────────────────────────────────
CREATE TABLE payroll_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period          text NOT NULL CHECK (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'paid')),
  employees       integer NOT NULL DEFAULT 0,
  -- Totals of the run (per-employee amounts are sealed in the lines).
  gross           numeric(14,2) NOT NULL DEFAULT 0,
  deductions      numeric(14,2) NOT NULL DEFAULT 0,
  net             numeric(14,2) NOT NULL DEFAULT 0,
  employer_gosi   numeric(14,2) NOT NULL DEFAULT 0,
  eos_accrual     numeric(14,2) NOT NULL DEFAULT 0,
  payment_method  text CHECK (payment_method IS NULL OR payment_method IN ('bank_transfer', 'cash')),
  paid_on         date,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  approved_by     uuid,
  approved_at     timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, period)
);
-- Approved and paid runs are history: only the status moves forward.
CREATE FUNCTION payroll_run_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'paid' THEN RAISE EXCEPTION 'payroll_final' USING ERRCODE = 'P0001'; END IF;
  IF OLD.status = 'approved' AND (NEW.status <> 'paid' OR NEW.gross <> OLD.gross OR NEW.net <> OLD.net) THEN RAISE EXCEPTION 'payroll_final' USING ERRCODE = 'P0001'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payroll_runs_guard BEFORE UPDATE ON payroll_runs FOR EACH ROW EXECUTE FUNCTION payroll_run_guard();

CREATE TABLE payroll_lines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id          uuid NOT NULL,
  employee_id     uuid NOT NULL,
  cost_center_id  uuid,
  branch_id       uuid,
  -- Sealed: earnings, deductions, GOSI (both parties), net, end-of-service accrual, and how each was computed.
  amounts_enc     text NOT NULL,
  UNIQUE (tenant_id, run_id, employee_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES payroll_runs (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);

-- One-off earnings and deductions for a period (bonus, advance recovery...), entered before the run.
CREATE TABLE payroll_adjustments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id     uuid NOT NULL,
  period          text NOT NULL CHECK (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  kind            text NOT NULL CHECK (kind IN ('bonus', 'advance_recovery', 'penalty')),
  amount_enc      text NOT NULL,
  note            text NOT NULL CHECK (char_length(trim(note)) BETWEEN 2 AND 200),
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);

-- End of service when someone leaves (append-only).
CREATE TABLE final_settlements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id     uuid NOT NULL,
  last_day        date NOT NULL,
  reason          text NOT NULL CHECK (reason IN ('resignation', 'termination', 'contract_end', 'article_87', 'article_80')),
  -- Sealed: service, wage, end-of-service award, leave encashment, provision released, total.
  amounts_enc     text NOT NULL,
  total           numeric(14,2) NOT NULL CHECK (total >= 0),
  idempotency_key uuid NOT NULL,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, employee_id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);
CREATE TRIGGER final_settlements_immutable BEFORE UPDATE OR DELETE ON final_settlements FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

DO $$
DECLARE _t text;
BEGIN
  FOREACH _t IN ARRAY ARRAY['employees', 'attendance', 'leave_types', 'leave_requests', 'payroll_runs', 'payroll_lines', 'payroll_adjustments', 'final_settlements'] LOOP
    PERFORM enable_tenant_rls(_t::regclass);
  END LOOP;
  PERFORM grant_app('employees', 'SELECT, INSERT, UPDATE');
  PERFORM grant_app('attendance', 'SELECT, INSERT, UPDATE, DELETE');
  PERFORM grant_app('leave_types', 'SELECT, INSERT, UPDATE');
  PERFORM grant_app('leave_requests', 'SELECT, INSERT, UPDATE');
  PERFORM grant_app('payroll_runs', 'SELECT, INSERT, UPDATE, DELETE');
  PERFORM grant_app('payroll_lines', 'SELECT, INSERT, DELETE');
  PERFORM grant_app('payroll_adjustments', 'SELECT, INSERT, DELETE');
  PERFORM grant_app('final_settlements', 'SELECT, INSERT');
END $$;
