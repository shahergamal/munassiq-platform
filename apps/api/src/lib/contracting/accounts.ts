import type { Db } from "../../db/pool.ts";

// The accounts contracting posts to. A new contracting workspace gets them from seed_contracting_accounts at
// provisioning; this fills any gap on first use, inside the tenant's transaction (the seed function is for the
// system role only): the chart's existing account is adopted when it is there, otherwise one is added under its group.
const ACCOUNTS: [key: string, code: string, name: string, type: string, parent: string][] = [
  ["retention_receivable", "1118", "محتجزات لدى العملاء", "asset", "11"],
  ["contract_revenue", "4104", "إيرادات عقود المقاولات", "revenue", "4"],
  ["customer_advances", "2108", "دفعات مقدمة من العملاء", "liability", "21"],
  ["bank_fees", "6110", "عمولات ومصروفات بنكية", "expense", "6"],
  ["retention_payable", "2118", "محتجزات مقاولي الباطن", "liability", "21"],
  ["subcontractor_advances", "1119", "دفعات مقدمة لمقاولي الباطن", "asset", "11"],
  ["subcontract_cost", "5110", "تكاليف مقاولي الباطن", "expense", "5"],
  ["contract_asset", "1120", "أصول العقود (أعمال منفذة لم تُفوتر)", "asset", "11"],
  ["contract_liability", "2119", "التزامات العقود (فواتير تزيد عن المنفذ)", "liability", "21"],
  ["onerous_provision", "2120", "مخصص العقود المثقلة", "liability", "21"],
  ["onerous_loss", "5111", "خسائر العقود المثقلة", "expense", "5"],
  ["contract_materials", "5112", "مواد مصروفة للمشاريع", "expense", "5"],
  ["contract_equipment", "5113", "تكلفة المعدات المحمّلة على المشاريع", "expense", "5"],
  ["equipment_recovery", "6120", "استرداد تكلفة المعدات الداخلية", "expense", "6"],
  ["contract_labor", "5114", "أجور العمالة المحمّلة على المشاريع", "expense", "5"],
  ["labor_allocated", "6121", "رواتب محمّلة على المشاريع (مقابل)", "expense", "6"],
];

export async function ensureContractingAccounts(db: Db) {
  const have = new Set((await db.query<{ k: string }>("SELECT system_key AS k FROM accounts WHERE system_key IS NOT NULL")).rows.map((r) => r.k));
  for (const [key, code, name, type, parent] of ACCOUNTS) {
    if (have.has(key)) continue;
    const adopted = await db.query("UPDATE accounts SET system_key = $1 WHERE code = $2 AND system_key IS NULL AND NOT is_group AND type = $3", [key, code, type]);
    if (adopted.rowCount) continue;
    const p = (await db.query<{ id: string }>("SELECT id FROM accounts WHERE code = $1 AND is_group", [parent])).rows[0];
    if (!p) continue;
    const taken = (await db.query("SELECT 1 FROM accounts WHERE code = $1", [code])).rowCount;
    await db.query("INSERT INTO accounts (tenant_id, code, name, type, parent_id, is_group, system_key) VALUES (app_tenant_id(), $1, $2, $3, $4, false, $5)",
      [taken ? `${code}9` : code, name, type, p.id, key]);
  }
}

export const accountIdOf = async (db: Db, key: string) => (await db.query<{ id: string }>("SELECT id FROM accounts WHERE system_key = $1", [key])).rows[0]?.id ?? null;
