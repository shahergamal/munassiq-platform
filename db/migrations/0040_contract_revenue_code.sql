-- 0040_contract_revenue_code: 0036 seeded contract revenue as 4103, which the standard chart already uses for sales
-- returns, so the seed skipped it and a contracting workspace had no contract revenue account. It is 4104 now; the
-- seed also adopts the chart's bank fees account (6110) that guarantee fees post to.
CREATE OR REPLACE FUNCTION seed_contracting_accounts(_t uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r record; _parent uuid;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('1118', '11', 'محتجزات لدى العملاء', 'asset', 'retention_receivable'),
    ('4104', '4',  'إيرادات عقود المقاولات', 'revenue', 'contract_revenue')
  ) AS v(code, parent, name, type, system_key) LOOP
    CONTINUE WHEN EXISTS (SELECT 1 FROM accounts WHERE tenant_id = _t AND system_key = r.system_key);
    CONTINUE WHEN EXISTS (SELECT 1 FROM accounts WHERE tenant_id = _t AND code = r.code);
    SELECT id INTO _parent FROM accounts WHERE tenant_id = _t AND code = r.parent;
    CONTINUE WHEN _parent IS NULL;
    INSERT INTO accounts (tenant_id, code, name, type, parent_id, is_group, system_key) VALUES (_t, r.code, r.name, r.type, _parent, false, r.system_key);
  END LOOP;
  UPDATE accounts SET system_key = 'customer_advances' WHERE tenant_id = _t AND code = '2108' AND system_key IS NULL
     AND NOT EXISTS (SELECT 1 FROM accounts WHERE tenant_id = _t AND system_key = 'customer_advances');
  UPDATE accounts SET system_key = 'bank_fees' WHERE tenant_id = _t AND code = '6110' AND system_key IS NULL AND NOT is_group
     AND NOT EXISTS (SELECT 1 FROM accounts WHERE tenant_id = _t AND system_key = 'bank_fees');
END $$;
DO $$ DECLARE _t uuid; BEGIN FOR _t IN SELECT id FROM tenants WHERE sector = 'contracting' LOOP PERFORM seed_contracting_accounts(_t); END LOOP; END $$;
