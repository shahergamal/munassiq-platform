-- 0039_contracting_plans: the contracting sector opened for sign-up in 0038 without its plans, so a new workspace had
-- no trial to start on. Same shape as the other sectors (limits enforced by the existing triggers).
INSERT INTO plans (sector, code, name_ar, monthly_price, branches_limit, users_limit) VALUES
  ('contracting', 'contracting-trial',   'التجربة المجانية', 0,   1, 3),
  ('contracting', 'contracting-starter', 'الأساسية',       399, 3, 8),
  ('contracting', 'contracting-pro',     'الاحترافية',     999, 15, 40)
ON CONFLICT (code) DO NOTHING;
