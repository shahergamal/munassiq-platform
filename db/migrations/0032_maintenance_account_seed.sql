-- 0032_maintenance_account_seed: factories created after 0031 also get the maintenance expense key on account 6107
-- (0031 only marked the accounts that existed then).
CREATE OR REPLACE FUNCTION seed_manufacturing_accounts(_t uuid) RETURNS void LANGUAGE plpgsql AS $$
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
  -- Spare parts used by maintenance orders post to the existing maintenance account.
  UPDATE accounts SET system_key = 'maintenance_expense'
   WHERE tenant_id = _t AND code = '6107' AND system_key IS NULL AND NOT EXISTS (SELECT 1 FROM accounts WHERE tenant_id = _t AND system_key = 'maintenance_expense');
  -- Factory expense categories post to their natural account.
  UPDATE expense_categories c SET account_id = a.id FROM accounts a
   WHERE c.tenant_id = _t AND a.tenant_id = _t AND c.name IN ('صيانة الآلات', 'الوقود والطاقة', 'النقل والشحن', 'التأمين') AND a.code = CASE c.name
     WHEN 'صيانة الآلات' THEN '6107' WHEN 'الوقود والطاقة' THEN '6104' WHEN 'النقل والشحن' THEN '6199' WHEN 'التأمين' THEN '6199' ELSE NULL END;
END $$;

DO $$
DECLARE _t uuid;
BEGIN
  FOR _t IN SELECT id FROM tenants WHERE sector = 'manufacturing' LOOP PERFORM seed_manufacturing_accounts(_t); END LOOP;
END $$;
