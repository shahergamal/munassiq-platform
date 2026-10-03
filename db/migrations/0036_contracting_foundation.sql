-- 0036_contracting_foundation: the contracting sector's foundation (docs/contracting/ARCHITECTURE.md, C1).
--   * regulatory_parameters: every statutory value (penalty caps, variation caps, guarantees, deadlines…) as a dated
--     row with its legal basis and source, for all workspaces. Seeded as DRAFT: nothing applies a value until the
--     platform admin verifies it against the official source.
--   * specialty_templates and contract_profiles: the specialties and standard contract forms as versioned data (one
--     configurable module, no module per specialty). Only fields the code reads are stored.
--   * Journal lines gain optional WBS and cost-code dimensions (the project itself is a cost center of kind project).

CREATE TABLE regulatory_parameters (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key            text NOT NULL CHECK (key ~ '^[a-z0-9_]{2,60}$'),
  -- Which law the value belongs to: the old and new Government Tenders and Procurement Law, private contracts, or all.
  regime         text NOT NULL CHECK (regime IN ('GTPL_1440', 'GTPL_1448', 'PRIVATE', 'ALL')),
  value          numeric(18,4) NOT NULL,
  unit           text NOT NULL CHECK (unit IN ('percent', 'sar', 'days', 'working_days', 'months')),
  label          text NOT NULL CHECK (char_length(trim(label)) BETWEEN 3 AND 200),
  legal_basis    text NOT NULL CHECK (char_length(trim(legal_basis)) BETWEEN 2 AND 300),
  source_title   text NOT NULL CHECK (char_length(trim(source_title)) BETWEEN 2 AND 300),
  source_url     text CHECK (source_url IS NULL OR source_url ~ '^https?://'),
  -- How sure the research was: an official text, a professional secondary source, or a commercial one.
  confidence     text NOT NULL CHECK (confidence IN ('official', 'secondary', 'commercial')),
  effective_from date NOT NULL,
  effective_to   date,
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'verified', 'retired')),
  verified_by    uuid REFERENCES users(id),
  verified_at    timestamptz,
  notes          text CHECK (notes IS NULL OR char_length(notes) <= 1000),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CHECK (status <> 'verified' OR (verified_by IS NOT NULL AND verified_at IS NOT NULL))
);
-- One value per key and regime on any date: periods of the same key never overlap.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE regulatory_parameters ADD CONSTRAINT regulatory_parameters_no_overlap
  EXCLUDE USING gist (key WITH =, regime WITH =, daterange(effective_from, coalesce(effective_to, 'infinity'::date), '[]') WITH &&) WHERE (status <> 'retired');
-- A verified value is evidence: it is not edited, only retired or closed by a later period.
CREATE FUNCTION regulatory_parameters_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'verified' THEN RAISE EXCEPTION 'regulatory_parameter_verified' USING ERRCODE = 'P0001'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'verified' AND (NEW.value <> OLD.value OR NEW.unit <> OLD.unit OR NEW.key <> OLD.key OR NEW.regime <> OLD.regime OR NEW.effective_from <> OLD.effective_from
      OR NEW.legal_basis <> OLD.legal_basis OR NEW.source_title <> OLD.source_title) THEN
    RAISE EXCEPTION 'regulatory_parameter_verified' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER regulatory_parameters_guard BEFORE UPDATE OR DELETE ON regulatory_parameters FOR EACH ROW EXECUTE FUNCTION regulatory_parameters_guard();
GRANT SELECT ON regulatory_parameters TO munassiq_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON regulatory_parameters TO munassiq_system;

-- The baseline from the research (docs/contracting, source file of September 2026). All DRAFT.
-- GTPL_1440 = Royal Decree M/128 (1440H), in force until the new law; GTPL_1448 = CoM Resolution 199 (21/02/1448H),
-- published in Umm Al-Qura 4 Sep 2026, in force 120 days later (Art. 101) ≈ 2027-01-02.
INSERT INTO regulatory_parameters (key, regime, value, unit, label, legal_basis, source_title, confidence, effective_from, effective_to, notes) VALUES
  ('delay_penalty_cap_supply', 'GTPL_1440', 6, 'percent', 'سقف غرامة التأخير في عقود التوريد', 'نظام المنافسات والمشتريات الحكومية م/128', 'نظام المنافسات والمشتريات الحكومية 1440هـ', 'official', '2019-12-11', '2027-01-01', NULL),
  ('delay_penalty_cap_other', 'GTPL_1440', 20, 'percent', 'سقف غرامة التأخير في غير التوريد', 'نظام المنافسات والمشتريات الحكومية م/128', 'نظام المنافسات والمشتريات الحكومية 1440هـ', 'official', '2019-12-11', '2027-01-01', 'العقد المطروح قبل النظام الجديد يبقى عليه حتى نهايته'),
  ('service_default_penalty_cap', 'GTPL_1440', 20, 'percent', 'سقف غرامة التقصير في الخدمات المستمرة', 'نظام المنافسات والمشتريات الحكومية م/128', 'نظام المنافسات والمشتريات الحكومية 1440هـ', 'official', '2019-12-11', '2027-01-01', NULL),
  ('final_guarantee_pct', 'GTPL_1440', 5, 'percent', 'الضمان النهائي', 'نظام المنافسات م/128 واللائحة', 'نظام المنافسات والمشتريات الحكومية 1440هـ', 'official', '2019-12-11', '2027-01-01', 'يقدم خلال 15 يوماً من الإبلاغ بالترسية'),
  ('final_guarantee_exemption_sar', 'GTPL_1440', 100000, 'sar', 'حد الإعفاء من الضمان النهائي', 'نظام المنافسات م/128 واللائحة', 'نظام المنافسات والمشتريات الحكومية 1440هـ', 'secondary', '2019-12-11', '2027-01-01', NULL),
  ('final_ipc_min_pct_public_works', 'GTPL_1440', 10, 'percent', 'الحد الأدنى للمستخلص الختامي (إنشاءات عامة)', 'اللائحة التنفيذية لنظام المنافسات', 'ملخص مكتب محاماة', 'secondary', '2019-12-11', '2027-01-01', 'يُراجع مع نص اللائحة'),
  ('delay_penalty_cap_supply', 'GTPL_1448', 6, 'percent', 'سقف غرامة التأخير في عقود التوريد', 'المادة 70', 'نظام المنافسات والمشتريات الحكومية 1448هـ (أم القرى 4/9/2026)', 'official', '2027-01-02', NULL, NULL),
  ('delay_penalty_cap_other', 'GTPL_1448', 15, 'percent', 'سقف غرامة التأخير في غير التوريد', 'المادة 70', 'نظام المنافسات والمشتريات الحكومية 1448هـ (أم القرى 4/9/2026)', 'official', '2027-01-02', NULL, NULL),
  ('service_default_penalty_cap', 'GTPL_1448', 15, 'percent', 'سقف غرامة التقصير في الخدمات المستمرة', 'المادة 71', 'نظام المنافسات والمشتريات الحكومية 1448هـ (أم القرى 4/9/2026)', 'official', '2027-01-02', NULL, NULL),
  ('final_guarantee_pct', 'GTPL_1448', 5, 'percent', 'الضمان النهائي', 'المادة 59', 'نظام المنافسات والمشتريات الحكومية 1448هـ (أم القرى 4/9/2026)', 'official', '2027-01-02', NULL, 'يقدم خلال 15 يوم عمل'),
  ('final_guarantee_exemption_sar', 'GTPL_1448', 300000, 'sar', 'حد الإعفاء من الضمان النهائي', 'المادة 59', 'نظام المنافسات والمشتريات الحكومية 1448هـ (أم القرى 4/9/2026)', 'official', '2027-01-02', NULL, NULL),
  ('bid_bond_min_pct', 'GTPL_1448', 1, 'percent', 'الضمان الابتدائي (الحد الأدنى)', 'المادة 41', 'نظام المنافسات والمشتريات الحكومية 1448هـ (أم القرى 4/9/2026)', 'official', '2027-01-02', NULL, NULL),
  ('bid_bond_max_pct', 'GTPL_1448', 2, 'percent', 'الضمان الابتدائي (الحد الأعلى)', 'المادة 41', 'نظام المنافسات والمشتريات الحكومية 1448هـ (أم القرى 4/9/2026)', 'official', '2027-01-02', NULL, NULL),
  ('vo_new_items_cap_pct', 'GTPL_1448', 10, 'percent', 'أوامر التغيير: بنود جديدة (بموافقة المتعاقد)', 'المادة 67', 'نظام المنافسات والمشتريات الحكومية 1448هـ (أم القرى 4/9/2026)', 'official', '2027-01-02', NULL, NULL),
  ('vo_increase_consent_pct', 'GTPL_1448', 10, 'percent', 'أوامر التغيير: زيادة البنود القائمة دون موافقة المتعاقد حتى', 'المادة 67', 'نظام المنافسات والمشتريات الحكومية 1448هـ (أم القرى 4/9/2026)', 'official', '2027-01-02', NULL, NULL),
  ('vo_total_increase_cap_pct', 'GTPL_1448', 20, 'percent', 'أوامر التغيير: سقف الزيادة الكلية', 'المادة 67', 'نظام المنافسات والمشتريات الحكومية 1448هـ (أم القرى 4/9/2026)', 'official', '2027-01-02', NULL, NULL),
  ('vo_decrease_cap_pct', 'GTPL_1448', 20, 'percent', 'أوامر التغيير: التخفيض دون موافقة المتعاقد حتى', 'المادة 67', 'نظام المنافسات والمشتريات الحكومية 1448هـ (أم القرى 4/9/2026)', 'official', '2027-01-02', NULL, NULL),
  ('local_content_price_preference_pct', 'ALL', 10, 'percent', 'تفضيل سعري للمنتج الوطني', 'لائحة تفضيل المحتوى المحلي (قرار 245 لعام 1441هـ)', 'هيئة المحتوى المحلي والمشتريات الحكومية', 'official', '2020-01-01', NULL, NULL),
  ('tax_invoice_days_after_month_end', 'ALL', 15, 'days', 'مهلة الفاتورة الضريبية بعد نهاية شهر التوريد (التوريد المستمر)', 'دليل ضريبة القيمة المضافة لقطاع المقاولات', 'زاتكا: دليل قطاع المقاولات، الإصدار الثاني (مايو 2026)', 'official', '2026-05-01', NULL, NULL);

-- ── Specialties and standard contract forms (reference data, all workspaces) ─────────────────────
CREATE TABLE specialty_templates (
  code        text PRIMARY KEY CHECK (code ~ '^[A-Z_]{2,30}$'),
  version     integer NOT NULL DEFAULT 1,
  name        text NOT NULL,
  -- { wbsLevels: [level names], units: [{code, name}] } — the project's WBS skeleton and the BOQ unit dictionary.
  definition  jsonb NOT NULL
);
INSERT INTO specialty_templates (code, name, definition) VALUES
  ('BUILDING', 'مباني وإنشاءات عامة', '{"wbsLevels":["المبنى","الدور","النظام"],"units":[{"code":"m3","name":"م³"},{"code":"m2","name":"م²"},{"code":"m","name":"م.ط"},{"code":"ton","name":"طن"},{"code":"kg","name":"كجم"},{"code":"no","name":"عدد"},{"code":"ls","name":"مقطوعية"}]}'),
  ('LINEAR', 'طرق وبنية تحتية وشبكات', '{"wbsLevels":["القطاع","من كم - إلى كم","الطبقة"],"units":[{"code":"m","name":"م.ط"},{"code":"km","name":"كم"},{"code":"m2","name":"م²"},{"code":"m3","name":"م³"},{"code":"ton","name":"طن"},{"code":"no","name":"عدد"},{"code":"ls","name":"مقطوعية"}]}'),
  ('MEP', 'كهروميكانيكا وتكييف', '{"wbsLevels":["المبنى","النظام","المنطقة"],"units":[{"code":"m","name":"م.ط"},{"code":"no","name":"عدد"},{"code":"set","name":"طقم"},{"code":"ton","name":"طن تبريد"},{"code":"ls","name":"مقطوعية"}]}'),
  ('FITOUT', 'تشطيبات وديكور', '{"wbsLevels":["الدور","الغرفة","العنصر"],"units":[{"code":"m2","name":"م²"},{"code":"m","name":"م.ط"},{"code":"no","name":"عدد"},{"code":"ls","name":"مقطوعية"}]}'),
  ('EPC', 'EPC وطاقة', '{"wbsLevels":["الحزمة","الميلستون","المكوّن"],"units":[{"code":"ls","name":"مقطوعية"},{"code":"mw","name":"ميجاواط"},{"code":"km","name":"كم"},{"code":"no","name":"عدد"}]}'),
  ('TELECOM_SITE', 'اتصالات (بالموقع)', '{"wbsLevels":["المنطقة","الموقع","الميلستون"],"units":[{"code":"site","name":"موقع"},{"code":"m","name":"م.ط"},{"code":"no","name":"عدد"},{"code":"ls","name":"مقطوعية"}]}'),
  ('OIL_GAS', 'نفط وغاز', '{"wbsLevels":["المنطقة","الوحدة","الحزمة"],"units":[{"code":"ls","name":"مقطوعية"},{"code":"hr","name":"ساعة"},{"code":"m","name":"م.ط"},{"code":"ton","name":"طن"},{"code":"no","name":"عدد"}]}'),
  ('OM', 'تشغيل وصيانة', '{"wbsLevels":["الموقع","النظام"],"units":[{"code":"month","name":"شهر"},{"code":"visit","name":"زيارة"},{"code":"no","name":"عدد"},{"code":"ls","name":"مقطوعية"}]}');
GRANT SELECT ON specialty_templates TO munassiq_app;

CREATE TABLE contract_profiles (
  code        text PRIMARY KEY CHECK (code ~ '^[A-Z0-9_]{2,30}$'),
  version     integer NOT NULL DEFAULT 1,
  name        text NOT NULL,
  -- Defaults a new contract starts from (editable on the contract): { retentionPct, retentionCapPct, advancePct,
  -- dlpMonths, claimNoticeDays }. Percentages here are the forms' usual values, not law.
  defaults    jsonb NOT NULL
);
INSERT INTO contract_profiles (code, name, defaults) VALUES
  ('ETIMAD_GC_2020', 'اعتماد: نموذج عقد الإنشاءات العامة (2020)', '{"retentionPct":0,"retentionCapPct":0,"advancePct":0,"dlpMonths":12,"claimNoticeDays":30}'),
  ('MUQAWIL_FULL_2024', 'منصة مقاول: عقد الإنشاء الكامل (2024)', '{"retentionPct":5,"retentionCapPct":5,"advancePct":10,"dlpMonths":12,"claimNoticeDays":30}'),
  ('FIDIC_RED_1999', 'FIDIC الأحمر 1999', '{"retentionPct":10,"retentionCapPct":5,"advancePct":10,"dlpMonths":12,"claimNoticeDays":28}'),
  ('FIDIC_RED_2017', 'FIDIC الأحمر 2017', '{"retentionPct":10,"retentionCapPct":5,"advancePct":10,"dlpMonths":12,"claimNoticeDays":28}'),
  ('FIDIC_YELLOW_2017', 'FIDIC الأصفر 2017', '{"retentionPct":10,"retentionCapPct":5,"advancePct":10,"dlpMonths":12,"claimNoticeDays":28}'),
  ('FIDIC_SILVER_2017', 'FIDIC الفضي 2017', '{"retentionPct":5,"retentionCapPct":5,"advancePct":10,"dlpMonths":12,"claimNoticeDays":28}'),
  ('NEC4_ECC', 'NEC4 ECC', '{"retentionPct":3,"retentionCapPct":3,"advancePct":0,"dlpMonths":12,"claimNoticeDays":56}'),
  ('CUSTOM', 'عقد مخصص', '{"retentionPct":0,"retentionCapPct":0,"advancePct":0,"dlpMonths":12,"claimNoticeDays":30}');
GRANT SELECT ON contract_profiles TO munassiq_app;

-- ── Contracting accounts and dimensions ───────────────────────────────────────────────────────
CREATE FUNCTION seed_contracting_accounts(_t uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r record; _parent uuid;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('1118', '11', 'محتجزات لدى العملاء', 'asset', 'retention_receivable'),
    ('4103', '4',  'إيرادات عقود المقاولات', 'revenue', 'contract_revenue')
  ) AS v(code, parent, name, type, system_key) LOOP
    CONTINUE WHEN EXISTS (SELECT 1 FROM accounts WHERE tenant_id = _t AND system_key = r.system_key);
    CONTINUE WHEN EXISTS (SELECT 1 FROM accounts WHERE tenant_id = _t AND code = r.code);
    SELECT id INTO _parent FROM accounts WHERE tenant_id = _t AND code = r.parent;
    CONTINUE WHEN _parent IS NULL;
    INSERT INTO accounts (tenant_id, code, name, type, parent_id, is_group, system_key) VALUES (_t, r.code, r.name, r.type, _parent, false, r.system_key);
  END LOOP;
  -- The advance from a client sits in the chart's customer advances (2108).
  UPDATE accounts SET system_key = 'customer_advances' WHERE tenant_id = _t AND code = '2108' AND system_key IS NULL
     AND NOT EXISTS (SELECT 1 FROM accounts WHERE tenant_id = _t AND system_key = 'customer_advances');
END $$;
REVOKE ALL ON FUNCTION seed_contracting_accounts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION seed_contracting_accounts(uuid) TO munassiq_system;
DO $$ DECLARE _t uuid; BEGIN FOR _t IN SELECT id FROM tenants WHERE sector = 'contracting' LOOP PERFORM seed_contracting_accounts(_t); END LOOP; END $$;

-- Analysis dimensions below the project (the project is its cost center): the WBS node and the cost code.
ALTER TABLE journal_lines ADD COLUMN wbs_id uuid;
ALTER TABLE journal_lines ADD COLUMN cost_code_id uuid;
CREATE INDEX journal_lines_wbs_idx ON journal_lines (tenant_id, wbs_id) WHERE wbs_id IS NOT NULL;
