-- Public landing page: platform-wide content edited by the platform admin, and what each plan shows on it.
-- Platform-owned (not a tenant's data): only munassiq_system reads or writes it; munassiq_app gets no grant.
CREATE TABLE platform_settings (
  key        text PRIMARY KEY CHECK (key IN ('landing_content')),
  value      jsonb NOT NULL CHECK (jsonb_typeof(value) = 'object' AND octet_length(value::text) <= 200000),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE plans
  ADD COLUMN description   text CHECK (description IS NULL OR char_length(description) <= 300),
  ADD COLUMN features      text[] NOT NULL DEFAULT '{}' CHECK (cardinality(features) <= 12),
  ADD COLUMN badge         text CHECK (badge IS NULL OR char_length(badge) <= 30),
  ADD COLUMN is_featured   boolean NOT NULL DEFAULT false,
  ADD COLUMN is_public     boolean NOT NULL DEFAULT true,
  ADD COLUMN annual_price  numeric(12,2) CHECK (annual_price IS NULL OR annual_price >= 0),
  ADD COLUMN sort_order    integer NOT NULL DEFAULT 0;

UPDATE plans SET description = 'جرّب كل مزايا المطاعم مجاناً قبل الاشتراك.', features = ARRAY['فرع واحد و3 مستخدمين', 'الوصفات وتكلفتها الحية', 'المشتريات والمخزون', 'الكاشير وشاشة المطبخ'], sort_order = 1
 WHERE code = 'restaurants-trial';
UPDATE plans SET description = 'لمطعم أو مطعمين يريدان ضبط التكلفة من أول يوم.', features = ARRAY['فرعان و5 مستخدمين', 'كل تقارير التكلفة والربحية', 'الموردون والمستحقات', 'الجرد والهدر والتحويلات'], sort_order = 2
 WHERE code = 'restaurants-starter';
UPDATE plans SET description = 'للمجموعات متعددة الفروع وفرق التشغيل الكبيرة.', features = ARRAY['حتى 10 فروع و25 مستخدماً', 'أدوار وصلاحيات مخصصة', 'تطبيقات التوصيل وعمولاتها', 'دعم أولوية'], badge = 'الأكثر طلباً', is_featured = true, sort_order = 3
 WHERE code = 'restaurants-pro';
