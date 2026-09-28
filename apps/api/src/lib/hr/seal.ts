import { config } from "../../config.ts";
import type { Db } from "../../db/pool.ts";
import { open, seal } from "../zatca/vault.ts";

/**
 * Field-level encryption for personal data (PDPL): ID and passport numbers, IBANs and every salary amount are
 * stored sealed (AES-256-GCM, a key of their own derived from the server secret) and opened only in the server,
 * for users with the permission to see them.
 */
const PURPOSE = "hr/personal-fields/v1";
const secret = () => config.ZATCA_KEY_SECRET ?? config.SESSION_SECRET;
export const sealHr = (v: unknown) => seal(JSON.stringify(v), secret(), PURPOSE);
export const openHr = <T>(s: string): T => JSON.parse(open(s, secret(), PURPOSE)) as T;

/**
 * The accounts payroll posts to. The standard chart has most of them without a system key (salaries 6101, GOSI
 * 6102, salaries payable 2105, GOSI payable 2106, end-of-service provision 2201, staff advances 1109): they are
 * adopted on first use; missing ones are created under their group.
 */
const PAYROLL_ACCOUNTS = [
  ["salaries_expense", "6101", "الرواتب والأجور", "expense", "6"],
  ["gosi_expense", "6102", "التأمينات الاجتماعية", "expense", "6"],
  ["eos_expense", "6113", "مصروف مكافأة نهاية الخدمة", "expense", "6"],
  ["salaries_payable", "2105", "رواتب مستحقة", "liability", "21"],
  ["gosi_payable", "2106", "التأمينات الاجتماعية المستحقة", "liability", "21"],
  ["eos_provision", "2201", "مخصص مكافأة نهاية الخدمة", "liability", "22"],
  ["employee_advances", "1109", "سلف وعُهد الموظفين", "asset", "11"],
] as const;

export async function ensurePayrollAccounts(db: Db) {
  const have = new Set((await db.query<{ k: string }>("SELECT system_key AS k FROM accounts WHERE system_key IS NOT NULL")).rows.map((r) => r.k));
  for (const [key, code, name, type, parent] of PAYROLL_ACCOUNTS) {
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
