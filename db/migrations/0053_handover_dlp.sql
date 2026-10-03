-- 0053_handover_dlp: handover, the defects liability period and closing a contract (docs/contracting/ARCHITECTURE.md, C12).
--   * Taking over (provisional acceptance) starts the defects liability period (the contract's DLP months) and the
--     decennial liability for buildings and fixed structures (its length is a regulatory value the platform admin
--     verifies; until then it is not computed).
--   * Snags (the punch list at handover) and defects (reported during the DLP) are tracked to fixed and verified,
--     with the party responsible.
--   * Final acceptance needs every item verified and no IPC in progress; the contract is then completed (only its
--     final IPC may follow). It is closed once its retention is released and its guarantees returned.

CREATE TABLE contract_handovers (
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contract_id       uuid NOT NULL,
  taking_over_on    date NOT NULL,
  taking_over_ref   text NOT NULL CHECK (char_length(trim(taking_over_ref)) BETWEEN 1 AND 80),
  dlp_months        integer NOT NULL CHECK (dlp_months BETWEEN 0 AND 120),
  dlp_ends_on       date NOT NULL,
  final_on          date,
  final_ref         text CHECK (final_ref IS NULL OR char_length(final_ref) <= 80),
  early_final_reason text CHECK (early_final_reason IS NULL OR char_length(early_final_reason) BETWEEN 5 AND 500),
  decennial_months  integer CHECK (decennial_months IS NULL OR decennial_months > 0),
  decennial_until   date,
  decennial_basis   text,
  insurer           text CHECK (insurer IS NULL OR char_length(insurer) <= 120),
  policy_no         text CHECK (policy_no IS NULL OR char_length(policy_no) <= 80),
  policy_until      date,
  notes             text CHECK (notes IS NULL OR char_length(notes) <= 1000),
  created_by        uuid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, contract_id),
  CHECK (dlp_ends_on >= taking_over_on),
  CHECK (final_on IS NULL OR (final_ref IS NOT NULL AND final_on >= taking_over_on)),
  CHECK (final_on IS NULL OR final_on >= dlp_ends_on OR early_final_reason IS NOT NULL),
  FOREIGN KEY (tenant_id, contract_id) REFERENCES contracts (tenant_id, id)
);

CREATE TABLE handover_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contract_id   uuid NOT NULL,
  number        integer NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('snag', 'defect')),
  description   text NOT NULL CHECK (char_length(trim(description)) BETWEEN 3 AND 1000),
  location      text CHECK (location IS NULL OR char_length(location) <= 200),
  reported_on   date NOT NULL,
  due_on        date,
  supplier_id   uuid,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'fixed', 'verified')),
  fixed_on      date,
  verified_on   date,
  verified_by   uuid,
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, contract_id, number),
  CHECK (status = 'open' OR fixed_on >= reported_on),
  CHECK (status <> 'verified' OR (verified_on >= fixed_on AND verified_by IS NOT NULL)),
  FOREIGN KEY (tenant_id, contract_id) REFERENCES contracts (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id)
);
CREATE INDEX handover_items_contract ON handover_items (tenant_id, contract_id, status);

-- The decennial liability's length: a regulatory value, a draft until the platform admin verifies it.
INSERT INTO regulatory_parameters (key, regime, value, unit, label, legal_basis, source_title, confidence, effective_from, effective_to, notes) VALUES
  ('decennial_liability_months', 'ALL', 120, 'months', 'مدة المسؤولية العشرية للمقاول والمهندس عن تهدّم المباني والمنشآت الثابتة وعيوبها الخطيرة',
   'نظام المعاملات المدنية (المسؤولية العشرية)', 'نظام المعاملات المدنية 1444هـ', 'secondary', '2023-12-16', NULL,
   'تحقق من رقم المادة ونطاقها (المباني والمنشآت الثابتة) وتاريخ بدء النفاذ من النص الرسمي قبل التوثيق');

DO $$
BEGIN
  PERFORM enable_tenant_rls('contract_handovers'::regclass);
  PERFORM enable_tenant_rls('handover_items'::regclass);
  PERFORM grant_app('contract_handovers', 'SELECT, INSERT, UPDATE');
  PERFORM grant_app('handover_items', 'SELECT, INSERT, UPDATE');
END $$;
