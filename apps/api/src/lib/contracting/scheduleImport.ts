// Reading a programme exported from Primavera P6 (XER) or Microsoft Project (MSPDI XML), pure. Only what the
// platform uses is read: each activity's code, name, baseline start and finish, progress and actual dates, and its
// outline position (summary rows become the tree's parents and are not activities themselves).

export interface ImportedActivity { code: string; name: string; start: string; finish: string; pctComplete: number; actualStart: string | null; actualFinish: string | null;
  parentCode: string | null; isSummary: boolean }

const date = (v: string | undefined | null) => {
  const m = /(\d{4}-\d{2}-\d{2})/.exec(v ?? "");
  return m ? m[1]! : null;
};

/** P6 XER: tab-separated tables, %T table name, %F field names, %R rows. Activities are the TASK table (WBS in PROJWBS). */
export function parseXer(text: string): ImportedActivity[] {
  const tables = new Map<string, Record<string, string>[]>();
  let table = "";
  let fields: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const cols = raw.split("\t");
    if (cols[0] === "%T") { table = cols[1] ?? ""; fields = []; tables.set(table, []); }
    else if (cols[0] === "%F") fields = cols.slice(1);
    else if (cols[0] === "%R" && table) tables.get(table)!.push(Object.fromEntries(fields.map((f, i) => [f, cols[i + 1] ?? ""])));
  }
  const tasks = tables.get("TASK") ?? [];
  if (!tasks.length) throw new Error("xer_no_tasks");
  const wbs = new Map((tables.get("PROJWBS") ?? []).map((w) => [w.wbs_id, w]));
  const out: ImportedActivity[] = [];
  const seenWbs = new Set<string>();
  // WBS elements become summary rows (parents) so the activities keep their place in the tree.
  const addWbs = (id: string | undefined): string | null => {
    const w = id ? wbs.get(id) : undefined;
    if (!w || w.proj_node_flag === "Y") return null;
    const code = `WBS-${w.wbs_short_name || w.wbs_id}`;
    if (!seenWbs.has(code)) {
      seenWbs.add(code);
      out.push({ code, name: w.wbs_name || code, start: "", finish: "", pctComplete: 0, actualStart: null, actualFinish: null, parentCode: addWbs(w.parent_wbs_id), isSummary: true });
    }
    return code;
  };
  for (const t of tasks) {
    const start = date(t.target_start_date) ?? date(t.early_start_date);
    const finish = date(t.target_end_date) ?? date(t.early_end_date);
    if (!t.task_code || !start || !finish) continue;
    out.push({ code: t.task_code, name: t.task_name || t.task_code, start, finish, pctComplete: Math.max(0, Math.min(100, Number(t.phys_complete_pct) || 0)),
      actualStart: date(t.act_start_date), actualFinish: date(t.act_end_date), parentCode: addWbs(t.wbs_id), isSummary: false });
  }
  return out;
}

/**
 * The text between `<name>` and the next `</name>` from `from`, by plain index search: linear in the input, so a
 * hostile file (thousands of unclosed tags) cannot stall the server the way a lazy regex scan would.
 */
function between(s: string, name: string, from = 0): { text: string; end: number } | null {
  const open = `<${name}>`, close = `</${name}>`;
  const a = s.indexOf(open, from);
  if (a < 0) return null;
  const b = s.indexOf(close, a + open.length);
  if (b < 0) return null;
  return { text: s.slice(a + open.length, b), end: b + close.length };
}
const unescape = (v: string) => v.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim();

/** MS Project XML (MSPDI): <Task> elements with UID, Name, WBS/OutlineNumber, Start, Finish, PercentComplete, Summary. */
export function parseMspdi(xml: string, maxTasks = 20_000): ImportedActivity[] {
  const tasksBlock = between(xml, "Tasks")?.text;
  if (tasksBlock === undefined) throw new Error("mspdi_no_tasks");
  const tag = (block: string, name: string) => { const t = between(block, name); return t ? unescape(t.text) : undefined; };
  const rows: (ImportedActivity & { outline: string })[] = [];
  let at = 0;
  for (let t = between(tasksBlock, "Task", at); t; t = between(tasksBlock, "Task", at)) {
    at = t.end;
    if (rows.length >= maxTasks) throw new Error("mspdi_too_many");
    const b = t.text;
    const outline = tag(b, "OutlineNumber") ?? "";
    if (tag(b, "IsNull") === "1" || outline === "0" || !outline) continue;
    const start = date(tag(b, "Start"));
    const finish = date(tag(b, "Finish"));
    if (!start || !finish) continue;
    rows.push({ outline, code: tag(b, "WBS") || outline, name: tag(b, "Name") || outline, start, finish,
      pctComplete: Math.max(0, Math.min(100, Number(tag(b, "PercentComplete")) || 0)), actualStart: date(tag(b, "ActualStart")), actualFinish: date(tag(b, "ActualFinish")),
      parentCode: null, isSummary: tag(b, "Summary") === "1" });
  }
  const byOutline = new Map(rows.map((r) => [r.outline, r]));
  return rows.map(({ outline, ...r }) => ({ ...r, parentCode: outline.includes(".") ? byOutline.get(outline.slice(0, outline.lastIndexOf(".")))?.code ?? null : null }));
}
