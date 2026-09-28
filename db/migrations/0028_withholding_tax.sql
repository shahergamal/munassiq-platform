-- 0028_withholding_tax: tax withheld on payments to non-resident suppliers (docs/manufacturing/ARCHITECTURE.md, M3).
-- The payment settles the full amount owed; the payer keeps the tax and pays it to ZATCA by the 10th of the next month.

-- Rates by payment type, with the date each applies from (a change is a new row, never an edit).
-- Source: Income Tax Law art. 68 and its Implementing Regulations art. 63 (ZATCA). TODO: re-check against the
-- regulation text before each filing season; the rates below are the ones in force since 2004.
CREATE TABLE withholding_rates (
  code        text NOT NULL CHECK (code ~ '^[a-z_]{2,40}$'),
  name_ar     text NOT NULL,
  rate        numeric(5,2) NOT NULL CHECK (rate > 0 AND rate < 100),
  valid_from  date NOT NULL,
  PRIMARY KEY (code, valid_from)
);
INSERT INTO withholding_rates (code, name_ar, rate, valid_from) VALUES
  ('management_fees',  'أتعاب إدارة', 20, '2004-07-30'),
  ('royalties',        'إتاوات أو ريع', 15, '2004-07-30'),
  ('related_services', 'خدمات مدفوعة للمركز الرئيسي أو شركة مرتبطة', 15, '2004-07-30'),
  ('other_payments',   'أي دفعات أخرى', 15, '2004-07-30'),
  ('technical_services', 'خدمات فنية أو استشارية', 5, '2004-07-30'),
  ('rent',             'إيجار', 5, '2004-07-30'),
  ('dividends',        'أرباح موزعة', 5, '2004-07-30'),
  ('interest',         'عوائد قروض', 5, '2004-07-30'),
  ('air_tickets_freight', 'تذاكر طيران أو شحن جوي أو بحري', 5, '2004-07-30'),
  ('international_telecom', 'خدمات اتصالات هاتفية دولية', 5, '2004-07-30'),
  ('insurance',        'أقساط تأمين أو إعادة تأمين', 5, '2004-07-30');
GRANT SELECT ON withholding_rates TO munassiq_app;

ALTER TABLE suppliers ADD COLUMN residency text NOT NULL DEFAULT 'resident' CHECK (residency IN ('resident', 'non_resident'));

-- A payment settles `amount` of the supplier's balance; the bank pays amount − withholding_amount.
ALTER TABLE supplier_payments
  ADD COLUMN withholding_code   text,
  ADD COLUMN withholding_rate   numeric(5,2) NOT NULL DEFAULT 0 CHECK (withholding_rate >= 0),
  ADD COLUMN withholding_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (withholding_amount >= 0),
  ADD CONSTRAINT supplier_payments_withholding_ck CHECK (withholding_amount < amount AND (withholding_amount = 0) = (withholding_code IS NULL));

-- The liability account, for every workspace (new ones get it from lib/tenancy.ts).
CREATE FUNCTION seed_withholding_account(_t uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE _parent uuid; _code text;
BEGIN
  IF EXISTS (SELECT 1 FROM accounts WHERE tenant_id = _t AND system_key = 'withholding_payable') THEN RETURN; END IF;
  SELECT id INTO _parent FROM accounts WHERE tenant_id = _t AND code = '21';
  IF _parent IS NULL THEN RETURN; END IF;
  SELECT c INTO _code FROM generate_series(2109, 2199) g, LATERAL (SELECT g::text AS c) x
   WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE tenant_id = _t AND code = x.c) ORDER BY g LIMIT 1;
  INSERT INTO accounts (tenant_id, code, name, type, parent_id, is_group, system_key)
  VALUES (_t, _code, 'ضريبة الاستقطاع المستحقة', 'liability', _parent, false, 'withholding_payable');
END $$;
REVOKE ALL ON FUNCTION seed_withholding_account(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION seed_withholding_account(uuid) TO munassiq_system;

DO $$
DECLARE _t uuid;
BEGIN
  FOR _t IN SELECT id FROM tenants LOOP PERFORM seed_withholding_account(_t); END LOOP;
END $$;
