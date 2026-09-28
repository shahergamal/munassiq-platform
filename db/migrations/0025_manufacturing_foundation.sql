-- 0025_manufacturing_foundation: the base a factory workspace needs before production itself (docs/manufacturing).
--   * manufacturing plans (the sector stays unavailable until production orders ship: sectors.is_available)
--   * item types on the item master (ingredients) with one inventory account per type for factories
--   * a factory chart of accounts (WIP, finished goods, applied overhead, production variances, abnormal scrap)
--   * cost centers on journal lines and expenses
--   * a fiscal year that may start in any month

-- ── Plans ─────────────────────────────────────────────────────────────────────────────────────
INSERT INTO plans (sector, code, name_ar, monthly_price, branches_limit, users_limit) VALUES
  ('manufacturing', 'manufacturing-trial',   'التجربة المجانية', 0,   1, 3),
  ('manufacturing', 'manufacturing-starter', 'الأساسية',       299, 2, 5),
  ('manufacturing', 'manufacturing-pro',     'الاحترافية',     799, 10, 25)
ON CONFLICT (code) DO NOTHING;

-- ── Item master: type and English name ────────────────────────────────────────────────────────
-- The type decides the inventory account an item is valued in (factories) and what production may do with it.
ALTER TABLE ingredients
  ADD COLUMN item_type text NOT NULL DEFAULT 'raw'
    CHECK (item_type IN ('raw', 'semi_finished', 'finished', 'packaging', 'consumable', 'spare_part')),
  ADD COLUMN name_en text CHECK (name_en IS NULL OR char_length(trim(name_en)) BETWEEN 2 AND 160);
UPDATE ingredients SET item_type = 'semi_finished' WHERE is_prepared;
CREATE INDEX ingredients_type_idx ON ingredients (tenant_id, item_type);

-- ── Units a factory counts in ─────────────────────────────────────────────────────────────────
CREATE FUNCTION seed_units(_t uuid, _sector text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO units (tenant_id, code, name, dimension, to_base)
  SELECT _t, v.code, v.name, v.dimension, v.to_base FROM (VALUES
    ('kg', 'كيلوجرام', 'mass', 1000), ('g', 'جرام', 'mass', 1), ('ton', 'طن', 'mass', 1000000),
    ('l', 'لتر', 'volume', 1000), ('ml', 'مل', 'volume', 1), ('m3', 'متر مكعب', 'volume', 1000000),
    ('pcs', 'حبة', 'count', 1), ('dozen', 'دزينة', 'count', 12), ('carton', 'كرتون', 'count', 1), ('pack', 'عبوة', 'count', 1),
    ('bag', 'كيس', 'count', 1), ('box', 'علبة', 'count', 1), ('bottle', 'زجاجة', 'count', 1),
    ('drum', 'برميل', 'count', 1), ('pallet', 'طبلية', 'count', 1), ('roll', 'لفة', 'count', 1), ('sheet', 'لوح', 'count', 1), ('set', 'طقم', 'count', 1)
  ) AS v(code, name, dimension, to_base)
  WHERE _sector = 'manufacturing' OR v.code NOT IN ('ton', 'm3', 'drum', 'pallet', 'roll', 'sheet', 'set')
  ON CONFLICT (tenant_id, code) DO NOTHING;
END $$;
REVOKE ALL ON FUNCTION seed_units(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION seed_units(uuid, text) TO munassiq_system;

-- ── Factory chart of accounts ─────────────────────────────────────────────────────────────────
-- Runs after seed_chart_of_accounts for a manufacturing workspace: renames the restaurant wording and adds the
-- production accounts. Idempotent per system key, so later production migrations can extend it.
CREATE FUNCTION seed_manufacturing_accounts(_t uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r record; _parent uuid;
BEGIN
  UPDATE accounts SET name = v.name FROM (VALUES
    ('1106', 'مخزون المواد الخام'), ('1201', 'الآلات والمعدات'), ('1202', 'الأثاث والتجهيزات المكتبية'),
    ('4101', 'المبيعات'), ('5', 'تكلفة المبيعات والإنتاج'), ('5101', 'تكلفة البضاعة المباعة'), ('5102', 'الهالك والتالف')
  ) AS v(code, name) WHERE accounts.tenant_id = _t AND accounts.code = v.code;
  FOR r IN SELECT * FROM (VALUES
    ('1111', '11', 'مخزون الإنتاج تحت التشغيل', 'asset', 'wip'),
    ('1112', '11', 'مخزون المنتجات نصف المصنعة', 'asset', 'inventory_semi'),
    ('1113', '11', 'مخزون الإنتاج التام', 'asset', 'inventory_finished'),
    ('1114', '11', 'مخزون مواد التعبئة والتغليف', 'asset', 'inventory_packaging'),
    ('1115', '11', 'مخزون المواد المستهلكة', 'asset', 'inventory_consumable'),
    ('1116', '11', 'مخزون قطع الغيار', 'asset', 'inventory_spare'),
    ('5105', '5',  'الأعباء الصناعية المحمّلة', 'expense', 'applied_overhead'),
    ('5106', '5',  'العمالة المباشرة المحمّلة', 'expense', 'applied_labor'),
    ('5107', '5',  'انحرافات الإنتاج', 'expense', 'production_variance'),
    ('5108', '5',  'الهالك غير العادي', 'expense', 'abnormal_scrap')
  ) AS v(code, parent, name, type, system_key) LOOP
    CONTINUE WHEN EXISTS (SELECT 1 FROM accounts WHERE tenant_id = _t AND system_key = r.system_key);
    CONTINUE WHEN EXISTS (SELECT 1 FROM accounts WHERE tenant_id = _t AND code = r.code);
    SELECT id INTO _parent FROM accounts WHERE tenant_id = _t AND code = r.parent;
    CONTINUE WHEN _parent IS NULL;
    INSERT INTO accounts (tenant_id, code, name, type, parent_id, is_group, system_key)
    VALUES (_t, r.code, r.name, r.type, _parent, false, r.system_key);
  END LOOP;
  -- Factory expense categories post to their natural account.
  UPDATE expense_categories c SET account_id = a.id FROM accounts a
   WHERE c.tenant_id = _t AND a.tenant_id = _t AND c.name IN ('صيانة الآلات', 'الوقود والطاقة', 'النقل والشحن', 'التأمين') AND a.code = CASE c.name
     WHEN 'صيانة الآلات' THEN '6107' WHEN 'الوقود والطاقة' THEN '6104' WHEN 'النقل والشحن' THEN '6199' WHEN 'التأمين' THEN '6199' ELSE NULL END;
END $$;
REVOKE ALL ON FUNCTION seed_manufacturing_accounts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION seed_manufacturing_accounts(uuid) TO munassiq_system;

DO $$
DECLARE _t uuid;
BEGIN
  FOR _t IN SELECT id FROM tenants WHERE sector = 'manufacturing' LOOP PERFORM seed_manufacturing_accounts(_t); END LOOP;
END $$;

-- ── Cost centers ──────────────────────────────────────────────────────────────────────────────
-- A second analysis axis next to the branch: a production line, a department, a project.
CREATE TABLE cost_centers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code       text NOT NULL CHECK (code ~ '^[A-Za-z0-9-]{1,20}$'),
  name       text NOT NULL CHECK (char_length(trim(name)) BETWEEN 2 AND 120),
  kind       text NOT NULL DEFAULT 'department' CHECK (kind IN ('production', 'service', 'department', 'project')),
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);
ALTER TABLE journal_lines ADD COLUMN cost_center_id uuid;
ALTER TABLE journal_lines ADD CONSTRAINT journal_lines_cost_center_fk FOREIGN KEY (tenant_id, cost_center_id) REFERENCES cost_centers (tenant_id, id);
CREATE INDEX journal_lines_cost_center_idx ON journal_lines (tenant_id, cost_center_id) WHERE cost_center_id IS NOT NULL;
ALTER TABLE expenses ADD COLUMN cost_center_id uuid;
ALTER TABLE expenses ADD CONSTRAINT expenses_cost_center_fk FOREIGN KEY (tenant_id, cost_center_id) REFERENCES cost_centers (tenant_id, id);

-- ── Fiscal year ───────────────────────────────────────────────────────────────────────────────
-- The month the fiscal year starts in (1 = January). A fiscal year is named by the calendar year it ends in.
ALTER TABLE accounting_settings ADD COLUMN fiscal_year_start_month smallint NOT NULL DEFAULT 1 CHECK (fiscal_year_start_month BETWEEN 1 AND 12);

DO $$
BEGIN
  PERFORM enable_tenant_rls('cost_centers'::regclass);
  PERFORM grant_app('cost_centers', 'SELECT, INSERT, UPDATE');
END $$;
