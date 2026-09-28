-- Accounting: chart of accounts, double-entry journal, period lock, tax profile, B2B customers,
-- sales tax invoices / credit & debit notes, customer receipts.
--
-- Rules enforced here, not only in code:
--   * A journal entry balances (debits = credits, at least two lines) — checked at COMMIT.
--   * Nothing is posted on or before the lock date.
--   * Entries, lines, issued tax documents and receipts are append-only; a correction is a reversing
--     entry or a credit/debit note, never an edit (VAT law: issued invoices cannot be altered or deleted).

-- ── Permissions ───────────────────────────────────────────────────────────────────────────────
ALTER TABLE tenant_roles DROP CONSTRAINT tenant_roles_permissions_check;
ALTER TABLE tenant_roles ADD CONSTRAINT tenant_roles_permissions_check CHECK (
  cardinality(permissions) >= 1 AND permissions <@ ARRAY[
    'catalog:read','catalog:write','stock:read','stock:adjust','stock:post_count',
    'purchases:read','purchases:write','purchases:approve','purchases:receive','recipes:read','recipes:write',
    'pos:read','pos:operate','pos:refund','pos:discount_override','pos:kitchen','reports:read',
    'expenses:read','expenses:write','expenses:approve','payables:write','members:manage','settings:manage',
    'assistant:use','accounting:read','accounting:write','accounting:manage'
  ]::text[]);

-- ── Chart of accounts ─────────────────────────────────────────────────────────────────────────
CREATE TABLE accounts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code        text NOT NULL CHECK (code ~ '^[0-9]{1,10}$'),
  name        text NOT NULL CHECK (char_length(trim(name)) BETWEEN 2 AND 120),
  type        text NOT NULL CHECK (type IN ('asset', 'liability', 'equity', 'revenue', 'expense')),
  parent_id   uuid,
  is_group    boolean NOT NULL DEFAULT false,
  -- Accounts the automatic postings use (cash, sales, vat_output...). One per key; they can be renamed, not removed.
  system_key  text CHECK (system_key IS NULL OR system_key ~ '^[a-z_]{2,40}$'),
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES accounts (tenant_id, id)
);
CREATE UNIQUE INDEX accounts_system_key_uq ON accounts (tenant_id, system_key) WHERE system_key IS NOT NULL;
CREATE TRIGGER accounts_updated BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Read by the posting trigger below: nothing may be posted on or before lock_date.
CREATE TABLE accounting_settings (
  tenant_id  uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  lock_date  date,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER accounting_settings_updated BEFORE UPDATE ON accounting_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Journal ───────────────────────────────────────────────────────────────────────────────────
CREATE TABLE journal_entries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entry_number bigint NOT NULL,
  entry_date   date NOT NULL,
  description  text NOT NULL CHECK (char_length(trim(description)) BETWEEN 2 AND 300),
  -- What produced it: 'manual', or the operation (pos_order, purchase_receipt, expense...), and its id.
  source_type  text NOT NULL CHECK (source_type ~ '^[a-z_]{2,40}$'),
  source_id    uuid,
  -- One automatic entry per operation event, so posting twice is impossible (e.g. "pos_order:<id>").
  source_key   text,
  reversal_of  uuid,
  idempotency_key uuid,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, entry_number),
  UNIQUE (tenant_id, source_key),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, reversal_of) REFERENCES journal_entries (tenant_id, id)
);
CREATE UNIQUE INDEX journal_entries_one_reversal_uq ON journal_entries (tenant_id, reversal_of) WHERE reversal_of IS NOT NULL;
CREATE INDEX journal_entries_date_idx ON journal_entries (tenant_id, entry_date, entry_number);

CREATE TABLE journal_lines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entry_id     uuid NOT NULL,
  account_id   uuid NOT NULL,
  debit        numeric(14,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit       numeric(14,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  memo         text CHECK (memo IS NULL OR char_length(memo) <= 300),
  -- Sub-ledger: which customer or supplier a receivable/payable line belongs to.
  partner_type text CHECK (partner_type IS NULL OR partner_type IN ('customer', 'supplier')),
  partner_id   uuid,
  branch_id    uuid,
  CHECK ((debit > 0) <> (credit > 0)),
  CHECK ((partner_type IS NULL) = (partner_id IS NULL)),
  FOREIGN KEY (tenant_id, entry_id) REFERENCES journal_entries (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id)
);
CREATE INDEX journal_lines_entry_idx ON journal_lines (tenant_id, entry_id);
CREATE INDEX journal_lines_account_idx ON journal_lines (tenant_id, account_id);
CREATE INDEX journal_lines_partner_idx ON journal_lines (tenant_id, partner_type, partner_id) WHERE partner_id IS NOT NULL;

CREATE TRIGGER journal_entries_immutable BEFORE UPDATE OR DELETE ON journal_entries FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER journal_lines_immutable BEFORE UPDATE OR DELETE ON journal_lines FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Balanced at commit: every entry has >= 2 lines and equal debits and credits.
CREATE FUNCTION journal_check_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE _id uuid := CASE WHEN TG_TABLE_NAME = 'journal_entries' THEN NEW.id ELSE NEW.entry_id END;
        _d numeric; _c numeric; _n int;
BEGIN
  SELECT coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*) INTO _d, _c, _n FROM journal_lines WHERE entry_id = _id;
  IF _n < 2 OR _d <> _c OR _d = 0 THEN RAISE EXCEPTION 'journal_unbalanced' USING ERRCODE = 'P0001'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER journal_entries_balanced AFTER INSERT ON journal_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION journal_check_balanced();
CREATE CONSTRAINT TRIGGER journal_lines_balanced AFTER INSERT ON journal_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION journal_check_balanced();

-- Closed periods stay closed; group accounts and inactive accounts take no postings.
CREATE FUNCTION journal_check_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE _lock date;
BEGIN
  SELECT lock_date INTO _lock FROM accounting_settings WHERE tenant_id = NEW.tenant_id;
  IF _lock IS NOT NULL AND NEW.entry_date <= _lock THEN RAISE EXCEPTION 'period_locked:%', _lock USING ERRCODE = 'P0001'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_entries_lock BEFORE INSERT ON journal_entries FOR EACH ROW EXECUTE FUNCTION journal_check_entry();

CREATE FUNCTION journal_check_line() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM accounts WHERE id = NEW.account_id AND (is_group OR NOT is_active)) THEN
    RAISE EXCEPTION 'account_not_postable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_lines_account BEFORE INSERT ON journal_lines FOR EACH ROW EXECUTE FUNCTION journal_check_line();

-- ── Expense categories post to an account ─────────────────────────────────────────────────────
ALTER TABLE expense_categories ADD COLUMN account_id uuid,
  ADD CONSTRAINT expense_categories_account_fk FOREIGN KEY (tenant_id, account_id) REFERENCES accounts (tenant_id, id);

-- ── Tax profile: the seller block of every tax invoice (and the ZATCA device registration) ────
CREATE TABLE tax_profiles (
  tenant_id     uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  legal_name    text NOT NULL CHECK (char_length(trim(legal_name)) BETWEEN 2 AND 200),
  cr_number     text CHECK (cr_number IS NULL OR cr_number ~ '^[0-9]{10}$'),
  street        text NOT NULL CHECK (char_length(trim(street)) BETWEEN 2 AND 120),
  building_no   text NOT NULL CHECK (building_no ~ '^[0-9]{4}$'),
  additional_no text CHECK (additional_no IS NULL OR additional_no ~ '^[0-9]{4}$'),
  district      text NOT NULL CHECK (char_length(trim(district)) BETWEEN 2 AND 120),
  city          text NOT NULL CHECK (char_length(trim(city)) BETWEEN 2 AND 80),
  postal_code   text NOT NULL CHECK (postal_code ~ '^[0-9]{5}$'),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER tax_profiles_updated BEFORE UPDATE ON tax_profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Customers: business buyers for standard tax invoices ──────────────────────────────────────
ALTER TABLE customers
  ADD COLUMN customer_type   text NOT NULL DEFAULT 'individual' CHECK (customer_type IN ('individual', 'business')),
  ADD COLUMN vat_number      text CHECK (vat_number IS NULL OR vat_number ~ '^3[0-9]{13}3$'),
  -- Buyer id when there is no VAT number: CRN (commercial registration), NAT (national id), IQA (iqama), PAS, OTH...
  ADD COLUMN other_id_scheme text CHECK (other_id_scheme IS NULL OR other_id_scheme IN ('CRN', 'MOM', 'MLS', '700', 'SAG', 'NAT', 'GCC', 'IQA', 'PAS', 'OTH', 'TIN')),
  ADD COLUMN other_id        text CHECK (other_id IS NULL OR char_length(other_id) BETWEEN 2 AND 40),
  ADD COLUMN street          text CHECK (street IS NULL OR char_length(street) <= 120),
  ADD COLUMN building_no     text CHECK (building_no IS NULL OR building_no ~ '^[0-9]{4}$'),
  ADD COLUMN additional_no   text CHECK (additional_no IS NULL OR additional_no ~ '^[0-9]{4}$'),
  ADD COLUMN district        text CHECK (district IS NULL OR char_length(district) <= 120),
  ADD COLUMN city            text CHECK (city IS NULL OR char_length(city) <= 80),
  ADD COLUMN postal_code     text CHECK (postal_code IS NULL OR postal_code ~ '^[0-9]{5}$'),
  ADD COLUMN country_code    text NOT NULL DEFAULT 'SA' CHECK (country_code ~ '^[A-Z]{2}$'),
  ADD COLUMN payment_terms_days integer NOT NULL DEFAULT 0 CHECK (payment_terms_days BETWEEN 0 AND 365),
  ADD CONSTRAINT customers_other_id_pair CHECK ((other_id_scheme IS NULL) = (other_id IS NULL));

-- ── Sales tax documents ───────────────────────────────────────────────────────────────────────
CREATE TABLE sales_documents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('invoice', 'credit_note', 'debit_note')),
  -- standard = tax invoice to a business (B2B/B2G, cleared by ZATCA in phase 2); simplified = to a consumer (reported).
  invoice_type     text NOT NULL CHECK (invoice_type IN ('standard', 'simplified')),
  doc_number       text NOT NULL,
  uuid             uuid NOT NULL DEFAULT gen_random_uuid(),
  customer_id      uuid,
  branch_id        uuid,
  issue_date       date NOT NULL,
  issued_at        timestamptz NOT NULL DEFAULT now(),
  supply_date      date,
  due_date         date,
  original_id      uuid,
  reason           text CHECK (reason IS NULL OR char_length(trim(reason)) BETWEEN 3 AND 300),
  payment_means    text NOT NULL DEFAULT 'credit' CHECK (payment_means IN ('cash', 'card', 'bank_transfer', 'credit')),
  notes            text CHECK (notes IS NULL OR char_length(notes) <= 1000),
  subtotal         numeric(14,2) NOT NULL CHECK (subtotal >= 0),
  discount         numeric(14,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  taxable          numeric(14,2) NOT NULL CHECK (taxable >= 0),
  vat              numeric(14,2) NOT NULL CHECK (vat >= 0),
  total            numeric(14,2) NOT NULL CHECK (total >= 0),
  -- Snapshots, so a later change to the seller or buyer never changes an issued document.
  seller           jsonb NOT NULL,
  buyer            jsonb,
  qr_base64        text NOT NULL,
  idempotency_key  uuid NOT NULL,
  created_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, doc_number),
  UNIQUE (tenant_id, uuid),
  UNIQUE (tenant_id, idempotency_key),
  CHECK (total = taxable + vat),
  CHECK (kind = 'invoice' OR (original_id IS NOT NULL AND reason IS NOT NULL)),
  CHECK (invoice_type = 'simplified' OR customer_id IS NOT NULL),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, original_id) REFERENCES sales_documents (tenant_id, id)
);
CREATE INDEX sales_documents_list_idx ON sales_documents (tenant_id, issue_date DESC, created_at DESC);
CREATE INDEX sales_documents_customer_idx ON sales_documents (tenant_id, customer_id);
CREATE TRIGGER sales_documents_immutable BEFORE UPDATE OR DELETE ON sales_documents FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE sales_document_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_id       uuid NOT NULL,
  line_no           integer NOT NULL CHECK (line_no >= 1),
  description       text NOT NULL CHECK (char_length(trim(description)) BETWEEN 1 AND 300),
  quantity          numeric(14,3) NOT NULL CHECK (quantity > 0),
  unit_price        numeric(14,2) NOT NULL CHECK (unit_price >= 0),
  discount          numeric(14,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  net               numeric(14,2) NOT NULL CHECK (net >= 0),
  -- ZATCA categories: S standard, Z zero-rated, E exempt, O out of scope (the last three need a reason code).
  vat_category      text NOT NULL CHECK (vat_category IN ('S', 'Z', 'E', 'O')),
  vat_rate          numeric(5,2) NOT NULL CHECK (vat_rate BETWEEN 0 AND 100),
  exemption_code    text,
  exemption_reason  text,
  vat               numeric(14,2) NOT NULL CHECK (vat >= 0),
  total             numeric(14,2) NOT NULL CHECK (total >= 0),
  account_id        uuid NOT NULL,
  UNIQUE (document_id, line_no),
  CHECK (vat_category = 'S' OR (vat_rate = 0 AND exemption_code IS NOT NULL)),
  FOREIGN KEY (tenant_id, document_id) REFERENCES sales_documents (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts (tenant_id, id)
);
CREATE TRIGGER sales_document_lines_immutable BEFORE UPDATE OR DELETE ON sales_document_lines FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE customer_receipts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  receipt_number  bigint NOT NULL,
  customer_id     uuid NOT NULL,
  document_id     uuid,
  received_on     date NOT NULL,
  amount          numeric(14,2) NOT NULL CHECK (amount > 0),
  method          text NOT NULL CHECK (method IN ('cash', 'bank_transfer', 'cheque', 'card')),
  reference       text CHECK (reference IS NULL OR char_length(reference) <= 80),
  notes           text CHECK (notes IS NULL OR char_length(notes) <= 500),
  idempotency_key uuid NOT NULL,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, receipt_number),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES sales_documents (tenant_id, id)
);
CREATE INDEX customer_receipts_customer_idx ON customer_receipts (tenant_id, customer_id, received_on DESC);
CREATE TRIGGER customer_receipts_immutable BEFORE UPDATE OR DELETE ON customer_receipts FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ── RLS and grants ────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE _t text;
BEGIN
  FOREACH _t IN ARRAY ARRAY['accounts', 'accounting_settings', 'journal_entries', 'journal_lines', 'tax_profiles',
                            'sales_documents', 'sales_document_lines', 'customer_receipts'] LOOP
    PERFORM enable_tenant_rls(_t::regclass);
  END LOOP;
  PERFORM grant_app('accounts', 'SELECT, INSERT, UPDATE');
  PERFORM grant_app('accounting_settings', 'SELECT, INSERT, UPDATE');
  PERFORM grant_app('journal_entries', 'SELECT, INSERT');
  PERFORM grant_app('journal_lines', 'SELECT, INSERT');
  PERFORM grant_app('tax_profiles', 'SELECT, INSERT, UPDATE');
  PERFORM grant_app('sales_documents', 'SELECT, INSERT');
  PERFORM grant_app('sales_document_lines', 'SELECT, INSERT');
  PERFORM grant_app('customer_receipts', 'SELECT, INSERT');
END $$;

-- ── Default chart of accounts (Saudi restaurant) ──────────────────────────────────────────────
-- Seeded for every workspace (existing ones below, new ones by lib/tenancy.ts). Owners extend it.
CREATE FUNCTION seed_chart_of_accounts(_t uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r record; _parent uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM accounts WHERE tenant_id = _t) THEN RETURN; END IF;
  FOR r IN SELECT * FROM (VALUES
    -- code, parent, name, type, group, system key
    ('1',    NULL,  'الأصول', 'asset', true, NULL),
    ('11',   '1',   'الأصول المتداولة', 'asset', true, NULL),
    ('1101', '11',  'النقدية في الصندوق', 'asset', false, 'cash'),
    ('1102', '11',  'النقدية في البنك', 'asset', false, 'bank'),
    ('1103', '11',  'مستحقات الشبكة (مدى والبطاقات)', 'asset', false, 'card_clearing'),
    ('1104', '11',  'مستحقات تطبيقات التوصيل', 'asset', false, 'platform_receivable'),
    ('1105', '11',  'العملاء (ذمم مدينة)', 'asset', false, 'ar'),
    ('1106', '11',  'المخزون', 'asset', false, 'inventory'),
    ('1107', '11',  'ضريبة القيمة المضافة - المدخلات', 'asset', false, 'vat_input'),
    ('1108', '11',  'مصروفات مدفوعة مقدماً', 'asset', false, NULL),
    ('1109', '11',  'سلف وعُهد الموظفين', 'asset', false, NULL),
    ('12',   '1',   'الأصول غير المتداولة', 'asset', true, NULL),
    ('1201', '12',  'المعدات وأجهزة المطبخ', 'asset', false, NULL),
    ('1202', '12',  'الأثاث والتجهيزات', 'asset', false, NULL),
    ('1203', '12',  'السيارات', 'asset', false, NULL),
    ('1204', '12',  'تحسينات المباني المستأجرة', 'asset', false, NULL),
    ('1209', '12',  'مجمع الإهلاك', 'asset', false, NULL),
    ('2',    NULL,  'الخصوم', 'liability', true, NULL),
    ('21',   '2',   'الخصوم المتداولة', 'liability', true, NULL),
    ('2101', '21',  'الموردون (ذمم دائنة)', 'liability', false, 'ap'),
    ('2102', '21',  'مصروفات مستحقة', 'liability', false, 'accrued_expenses'),
    ('2103', '21',  'ضريبة القيمة المضافة - المخرجات', 'liability', false, 'vat_output'),
    ('2104', '21',  'ضريبة القيمة المضافة المستحقة السداد', 'liability', false, 'vat_payable'),
    ('2105', '21',  'رواتب مستحقة', 'liability', false, NULL),
    ('2106', '21',  'التأمينات الاجتماعية المستحقة', 'liability', false, NULL),
    ('2107', '21',  'مخصص الزكاة', 'liability', false, 'zakat_provision'),
    ('2108', '21',  'دفعات مقدمة من العملاء', 'liability', false, NULL),
    ('22',   '2',   'الخصوم غير المتداولة', 'liability', true, NULL),
    ('2201', '22',  'مخصص مكافأة نهاية الخدمة', 'liability', false, NULL),
    ('2202', '22',  'قروض طويلة الأجل', 'liability', false, NULL),
    ('3',    NULL,  'حقوق الملكية', 'equity', true, NULL),
    ('3101', '3',   'رأس المال', 'equity', false, 'capital'),
    ('3102', '3',   'جاري المالك / الشركاء', 'equity', false, NULL),
    ('3103', '3',   'الاحتياطي النظامي', 'equity', false, NULL),
    ('3104', '3',   'الأرباح المبقاة', 'equity', false, 'retained_earnings'),
    ('3105', '3',   'أرصدة افتتاحية', 'equity', false, 'opening_balance'),
    ('4',    NULL,  'الإيرادات', 'revenue', true, NULL),
    ('4101', '4',   'مبيعات الطعام والمشروبات', 'revenue', false, 'sales'),
    ('4102', '4',   'مبيعات بالفواتير (آجلة)', 'revenue', false, 'sales_invoiced'),
    ('4103', '4',   'مردودات المبيعات', 'revenue', false, 'sales_returns'),
    ('4201', '4',   'إيرادات أخرى', 'revenue', false, 'other_income'),
    ('4202', '4',   'زيادة الصندوق', 'revenue', false, 'cash_over'),
    ('5',    NULL,  'تكلفة المبيعات', 'expense', true, NULL),
    ('5101', '5',   'تكلفة المواد المستهلكة', 'expense', false, 'cogs'),
    ('5102', '5',   'الهدر والتالف', 'expense', false, 'waste'),
    ('5103', '5',   'فروقات الجرد', 'expense', false, 'inventory_adjustment'),
    ('5104', '5',   'عمولات تطبيقات التوصيل', 'expense', false, 'delivery_commission'),
    ('6',    NULL,  'المصروفات التشغيلية', 'expense', true, NULL),
    ('6101', '6',   'الرواتب والأجور', 'expense', false, NULL),
    ('6102', '6',   'التأمينات الاجتماعية', 'expense', false, NULL),
    ('6103', '6',   'الإيجار', 'expense', false, NULL),
    ('6104', '6',   'الكهرباء والماء', 'expense', false, NULL),
    ('6105', '6',   'الغاز', 'expense', false, NULL),
    ('6106', '6',   'الاتصالات والإنترنت', 'expense', false, NULL),
    ('6107', '6',   'الصيانة والإصلاح', 'expense', false, NULL),
    ('6108', '6',   'الرسوم الحكومية والبلدية', 'expense', false, NULL),
    ('6109', '6',   'التسويق والإعلان', 'expense', false, NULL),
    ('6110', '6',   'الرسوم البنكية وعمولات الشبكة', 'expense', false, NULL),
    ('6111', '6',   'النظافة والمستهلكات', 'expense', false, NULL),
    ('6112', '6',   'الإهلاك', 'expense', false, NULL),
    ('6113', '6',   'مكافأة نهاية الخدمة', 'expense', false, NULL),
    ('6114', '6',   'عجز الصندوق', 'expense', false, 'cash_short'),
    ('6115', '6',   'الزكاة', 'expense', false, 'zakat_expense'),
    ('6199', '6',   'مصروفات عمومية أخرى', 'expense', false, 'general_expense')
  ) AS v(code, parent, name, type, is_group, system_key) LOOP
    SELECT id INTO _parent FROM accounts WHERE tenant_id = _t AND code = r.parent;
    INSERT INTO accounts (tenant_id, code, name, type, parent_id, is_group, system_key)
    VALUES (_t, r.code, r.name, r.type, _parent, r.is_group, r.system_key);
  END LOOP;
  -- The default expense categories post to their natural account.
  UPDATE expense_categories c SET account_id = a.id FROM accounts a
   WHERE c.tenant_id = _t AND a.tenant_id = _t AND c.account_id IS NULL AND a.code = CASE c.name
     WHEN 'الإيجار' THEN '6103' WHEN 'الرواتب والأجور' THEN '6101' WHEN 'الكهرباء والماء' THEN '6104' WHEN 'الغاز' THEN '6105'
     WHEN 'الصيانة' THEN '6107' WHEN 'التسويق' THEN '6109' WHEN 'النظافة والمستهلكات' THEN '6111' WHEN 'رسوم حكومية' THEN '6108'
     WHEN 'عمولات التوصيل' THEN '5104' ELSE '6199' END;
  INSERT INTO accounting_settings (tenant_id) VALUES (_t) ON CONFLICT DO NOTHING;
END $$;
REVOKE ALL ON FUNCTION seed_chart_of_accounts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION seed_chart_of_accounts(uuid) TO munassiq_system;

-- Existing workspaces get the chart now (the migration runs as the owner, outside RLS).
DO $$
DECLARE _t uuid;
BEGIN
  FOR _t IN SELECT id FROM tenants LOOP PERFORM seed_chart_of_accounts(_t); END LOOP;
END $$;
