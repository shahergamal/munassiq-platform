/**
 * Arabic text handling for the built-in assistant engine: spelling-tolerant normalisation (hamza, taa marbuta,
 * alef maqsura, diacritics, Eastern digits), keyword matching that survives the article and common prefixes,
 * and period parsing in Modern Standard Arabic, Gulf and Egyptian phrasing.
 */

export function normalize(s: string): string {
  return s
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/ؤ/g, "و").replace(/ئ/g, "ي")
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s\-/%]/gu, " ")
    .replace(/(\p{L})\1{2,}/gu, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

const PREFIXES = ["وبال", "وال", "بال", "فال", "كال", "لل", "ال", "و", "ب", "ل", "ف", "ك"];

/** A word and the forms it takes without its article or attached conjunction/preposition. */
export function variants(token: string): string[] {
  const out = [token];
  for (const p of PREFIXES) {
    if (token.startsWith(p) && token.length - p.length >= (p.length === 1 ? 3 : 2)) out.push(token.slice(p.length));
  }
  return out;
}

export interface Text { raw: string; norm: string; tokens: string[] }

/**
 * How people actually ask (Egyptian, Gulf, Levantine, shop-floor words) → the words the intents know. The canonical
 * word is added next to the original, so nothing the member wrote is lost.
 */
const CANON: Record<string, string> = {
  // sales
  "غله": "مبيعات", "الغله": "مبيعات", "غلة": "مبيعات", "البيعه": "مبيعات", "بيعه": "مبيعات", "بعناه": "مبيعات", "بعتوا": "مبيعات", "بعت": "مبيعات", "البيع": "مبيعات", "الكاش": "مبيعات",
  "الايراد": "ايرادات", "المدخول": "ايرادات", "مدخول": "ايرادات", "الشغل": "مبيعات", "الحركه": "مبيعات", "المكسب": "ارباح", "مكسب": "ارباح", "كسب": "ارباح", "الفايده": "ارباح",
  // waste
  "بايظ": "هدر", "بايظه": "هدر", "باظ": "هدر", "باظت": "هدر", "خربان": "هدر", "خربانه": "هدر", "خرب": "هدر", "فسد": "هدر", "فاسد": "هدر", "فاسده": "هدر", "اترمي": "هدر", "اترمت": "هدر",
  "الرمي": "هدر", "رمي": "هدر", "انرمي": "هدر", "انضرب": "هدر", "عفن": "هدر", "معفن": "هدر", "خسران": "هدر",
  // stock
  "البضاعه": "مخزون", "بضاعه": "مخزون", "ستوك": "مخزون", "الستوك": "مخزون", "المخزن": "مخزون", "مخزن": "مخزون", "الخامات": "مخزون",
  // expiry
  "اكسباير": "صلاحيه", "اكسبير": "صلاحيه", "اكسبايري": "صلاحيه", "انتهاء": "صلاحيه",
  // suppliers & payables
  "التجار": "موردين", "تاجر": "مورد", "الموزع": "مورد", "موزع": "مورد", "الموزعين": "موردين", "البياعين": "موردين", "المديونيات": "مستحقات", "الديون": "مستحقات", "الفلوس اللي علينا": "مستحقات",
  // purchases
  "المشتروات": "مشتريات", "اشترينا": "مشتريات", "جبنا": "مشتريات", "طلبيه": "امر شراء", "الطلبيه": "امر شراء", "طلبيات": "اوامر الشراء",
  // menu & recipes
  "القايمه": "منيو", "المنيو": "منيو", "الاكلات": "اصناف", "اكلات": "اصناف", "الاطباق": "اصناف", "الوجبات": "اصناف", "الساندوتشات": "اصناف", "السندوتشات": "اصناف", "الريسيبي": "وصفه", "ريسبي": "وصفه",
  "بتتكلف": "تكلفه", "بيتكلف": "تكلفه", "تتكلف": "تكلفه", "كلفه": "تكلفه", "كلفتها": "تكلفه",
  // sales operations
  "الشيفت": "شفت", "شيفت": "شفت", "الشيفتات": "شفتات", "الورديه": "ورديه", "الخزنه": "تسويه الكاشير", "الدرج": "تسويه الكاشير", "الكاشيرات": "تسويه الكاشير",
  "الاوردرات": "طلبات", "اوردرات": "طلبات", "الاوردر": "طلب", "الزباين": "عملاء", "زباين": "عملاء", "الزبون": "عميل", "زبون": "عميل",
  // expenses
  "المصروف": "مصروفات", "الصرف": "مصروفات", "صرف": "مصروفات", "الصرفيات": "مصروفات", "صرفيات": "مصروفات", "صرفنا": "مصروفات", "المصاريف": "مصروفات", "فواتير الكهرباء": "مصروفات",
  // diagnosis
  "تحليل": "حلل", "حللي": "حلل", "افحص": "تشخيص", "راجع": "تشخيص", "الخلل": "خلل", "مشكله": "مشاكل", "المشكله": "مشاكل",
};
/** Phrases that mean one thing as a whole ("علينا كام" = what we owe suppliers). */
const CANON_PHRASES: [RegExp, string][] = [
  [/علينا (كام|كم|قد ايه|فلوس)|اللي علينا|الي علينا|بنستلف|مديونين/, "مستحقات"],
  [/قرب (يخلص|يخلصو|تخلص)|قربت تخلص|هيخلص|خلصان|مش موجود في المخزن|ناقصنا/, "نواقص"],
  [/بعنا (كام|بكام|قد ايه)|عملنا (كام|قد ايه)|دخلنا (كام|قد ايه)|الغله (كام|قد ايه)/, "مبيعات"],
  [/(هتخلص|هتنتهي|هيبوظ|هتبوظ|قربت تبوظ|قرب يبوظ) صلاحيت?ه?ا?/, "صلاحيه"],
  [/اكتر (حاجه|صنف|اكله) (بتتباع|بتبيع|اتباعت|مبيعا)|ايه اللي بيتباع|اكتر حاجه بتبيع/, "الاكثر مبيعا"],
];

export const text = (raw: string): Text => {
  const norm = normalize(raw);
  const tokens = norm ? norm.split(" ") : [];
  const extra = new Set<string>();
  // Look the word up as written, without its prefixes ("للتجار" → "تجار"), and with the article ("تجار" → "التجار").
  for (const w of tokens) for (const v of new Set([...variants(w), ...variants(w).map((x) => `ال${x}`)])) { const c = CANON[v]; if (c) for (const x of c.split(" ")) extra.add(x); }
  for (const [re, c] of CANON_PHRASES) if (re.test(norm)) for (const x of c.split(" ")) extra.add(x);
  for (const x of tokens) extra.delete(x);
  return { raw, norm: extra.size ? `${norm} ${[...extra].join(" ")}` : norm, tokens: [...tokens, ...extra] };
};

// ── Typos ────────────────────────────────────────────────────────────────────────────────────
/** Letters people swap in writing (Egyptian and Gulf pronunciation): compared as one. */
const fold = (s: string) => s.replace(/ث/g, "ت").replace(/ذ/g, "ز").replace(/ظ/g, "ض").replace(/ض/g, "د").replace(/ص/g, "س").replace(/ق/g, "ك");

/** Edit distance with transpositions, stopping early once it is past `max`. */
function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length]![b.length]!;
}

/**
 * A one-letter slip on a long enough keyword ("المبيغات", "مخزوم", "تلاجه"). Words the engine already knows are never
 * bent into another keyword ("تحليل" stays analysis, not "تحويل").
 */
export function hasFuzzy(t: Text, keyword: string, known: (w: string) => boolean): boolean {
  const kw = fold(normalize(keyword));
  if (kw.length < 5 || kw.includes(" ")) return false;
  return t.tokens.some((w) => {
    if (known(w)) return false;
    return variants(w).some((v0) => {
      const v = fold(v0);
      if (v.length < 4) return false;
      return [v, v.slice(0, kw.length), v.slice(0, kw.length + 1)].some((c) => c.length >= kw.length - 1 && distance(c, kw, 1) <= 1);
    });
  });
}

/**
 * Does the text contain this keyword? Multi-word keywords match as a phrase at a word start; single words match
 * a word (or its prefix-stripped form) that starts with the keyword, so plurals and suffixes still match.
 */
export function has(t: Text, keyword: string): boolean {
  const kw = normalize(keyword);
  if (!kw) return false;
  if (kw.includes(" ")) return ` ${t.norm} `.includes(` ${kw}`) || ` ${t.tokens.map(bare).join(" ")} `.includes(` ${kw}`);
  return t.tokens.some((w) => variants(w).some((v) => (kw.length >= 3 ? v.startsWith(kw) : v === kw)));
}
/** The word without its article ("والمخزون" → "مخزون"). */
export const bare = (w: string) => { for (const p of ["وبال", "وال", "بال", "فال", "كال", "لل", "ال"]) if (w.startsWith(p) && w.length - p.length >= 2) return w.slice(p.length); return w; };
export const hasAny = (t: Text, words: readonly string[]) => words.some((w) => has(t, w));

/** True when one of the words is present as a whole word (or with only an article/prefix attached). */
export const hasWord = (t: Text, words: readonly string[]) => {
  const set = new Set(words.map(normalize));
  return t.tokens.some((w) => variants(w).some((v) => set.has(v)));
};

// ── Periods ───────────────────────────────────────────────────────────────────────────────────
export interface Period { from: string; to: string; label: string }

const iso = (d: Date) => d.toISOString().slice(0, 10);
const parse = (s: string) => new Date(`${s}T00:00:00Z`);
const addDays = (s: string, n: number) => { const d = parse(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const monthStart = (s: string) => `${s.slice(0, 7)}-01`;
const monthEnd = (y: number, m: number) => iso(new Date(Date.UTC(y, m + 1, 0)));
const clampToday = (s: string, today: string) => (s > today ? today : s);

const MONTHS: [string[], number][] = [
  [["يناير", "كانون الثاني", "january", "jan"], 0], [["فبراير", "شباط", "february", "feb"], 1], [["مارس", "اذار", "march"], 2],
  [["ابريل", "نيسان", "april"], 3], [["مايو", "ايار", "may"], 4], [["يونيو", "يونيه", "حزيران", "june"], 5],
  [["يوليو", "يوليه", "تموز", "july"], 6], [["اغسطس", "اب", "august"], 7], [["سبتمبر", "ايلول", "september"], 8],
  [["اكتوبر", "تشرين الاول", "october"], 9], [["نوفمبر", "تشرين الثاني", "november"], 10], [["ديسمبر", "كانون الاول", "december"], 11],
];
const NUM_WORDS: Record<string, number> = { "واحد": 1, "اثنين": 2, "اتنين": 2, "ثلاث": 3, "ثلاثه": 3, "تلات": 3, "تلاته": 3, "اربع": 4, "اربعه": 4, "خمس": 5, "خمسه": 5, "ست": 6, "سته": 6, "سبع": 7, "سبعه": 7,
  "تمن": 8, "تمانيه": 8, "ثمانيه": 8, "تسع": 9, "تسعه": 9, "عشر": 10, "عشره": 10, "خمستاشر": 15, "خمسطاشر": 15, "خمسه عشر": 15, "عشرين": 20, "تلاتين": 30, "ثلاثين": 30, "ستين": 60, "تسعين": 90 };

/** The period a question talks about, relative to today (Riyadh), or null when it names none. */
export function parsePeriod(t: Text, today: string): Period | null {
  const n = t.norm;
  const dates = [...n.matchAll(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})|(\d{1,2})[-/](\d{1,2})[-/](\d{4})/g)].map((m) =>
    m[1] ? `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}` : `${m[6]}-${m[5]!.padStart(2, "0")}-${m[4]!.padStart(2, "0")}`,
  ).filter((d) => !Number.isNaN(parse(d).getTime()));
  if (dates.length >= 2) { const [a, b] = [dates[0]!, dates[1]!].sort(); return { from: a!, to: b!, label: `من ${a} إلى ${b}` }; }
  if (dates.length === 1) return { from: dates[0]!, to: dates[0]!, label: `يوم ${dates[0]}` };

  if (hasWord(t, ["اليوم", "النهارده", "انهارده", "النهاردا", "today"])) return { from: today, to: today, label: "اليوم" };
  if (hasWord(t, ["امس", "امبارح", "البارحه", "yesterday"])) { const y = addDays(today, -1); return { from: y, to: y, label: "أمس" }; }
  if (hasWord(t, ["اول امس", "اول امبارح"]) || n.includes("اول امس") || n.includes("اول امبارح")) { const y = addDays(today, -2); return { from: y, to: y, label: "أول أمس" }; }

  const dow = parse(today).getUTCDay(); // 0 = Sunday, the first working day in Saudi Arabia
  const weekStart = addDays(today, -dow);
  if (/(الاسبوع|اسبوع) (الماضي|اللي فات|الي فات|السابق|الفايت)|last week/.test(n)) return { from: addDays(weekStart, -7), to: addDays(weekStart, -1), label: "الأسبوع الماضي" };
  if (/(هذا الاسبوع|الاسبوع ده|الاسبوع دا|الاسبوع الحالي|الاسبوع هذا|this week)/.test(n)) return { from: weekStart, to: today, label: "هذا الأسبوع" };

  const [y, m] = [Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1];
  if (/(الشهر|شهر) (الماضي|اللي فات|الي فات|السابق|الفايت)|last month/.test(n)) {
    const py = m === 0 ? y - 1 : y; const pm = m === 0 ? 11 : m - 1;
    return { from: `${py}-${String(pm + 1).padStart(2, "0")}-01`, to: monthEnd(py, pm), label: "الشهر الماضي" };
  }
  if (/(هذا الشهر|الشهر ده|الشهر دا|الشهر الحالي|الشهر هذا|this month)/.test(n)) return { from: monthStart(today), to: today, label: "هذا الشهر" };
  if (/((السنه|العام) (الماضي|الماضيه|اللي فاتت|الي فاتت|السابقه|اللي فات))|last year/.test(n)) return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31`, label: "السنة الماضية" };
  if (/(هذه السنه|هذا العام|السنه دي|السنه الحاليه|العام الحالي|السنه ديه|this year)/.test(n)) return { from: `${y}-01-01`, to: today, label: "هذه السنة" };

  // "من 1 لـ 15" / "من يوم 3 لحد يوم 10": days of the current month.
  const span = /من (?:يوم )?(\d{1,2}) (?:الي|لحد|لغايه|لغايت|حتي|ل|لل|و) ?(?:يوم )?(\d{1,2})(?!\d)/.exec(n);
  if (span) {
    const [a, b] = [Number(span[1]), Number(span[2])].sort((x, z) => x - z) as [number, number];
    if (a >= 1 && b <= 31) {
      const ym = today.slice(0, 7);
      const from = `${ym}-${String(a).padStart(2, "0")}`, to = clampToday(`${ym}-${String(Math.min(b, Number(monthEnd(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1).slice(8)))).padStart(2, "0")}`, today);
      return { from, to, label: `من ${a} إلى ${b} هذا الشهر` };
    }
  }
  if (/(من اول|من بدايه|من بدايت|من اوائل) (الشهر|شهر)/.test(n)) return { from: monthStart(today), to: today, label: "هذا الشهر" };
  if (/(من اول|من بدايه|من بدايت) (السنه|العام|سنه)/.test(n)) return { from: `${today.slice(0, 4)}-01-01`, to: today, label: "هذه السنة" };
  if (/(اخر|خلال|في) (اسبوع|الاسبوع)( |$)/.test(n) && !/(الاسبوع|اسبوع) (الماضي|اللي فات|الي فات|السابق|الفايت)/.test(n)) return { from: addDays(today, -6), to: today, label: "آخر 7 أيام" };
  if (/(اخر|خلال) (شهر|الشهر)( |$)/.test(n)) return { from: addDays(today, -29), to: today, label: "آخر 30 يوماً" };
  if (/يومين/.test(n)) return { from: addDays(today, -1), to: today, label: "آخر يومين" };
  if (/اسبوعين/.test(n)) return { from: addDays(today, -13), to: today, label: "آخر أسبوعين" };
  if (/شهرين/.test(n)) return { from: addDays(today, -59), to: today, label: "آخر شهرين" };
  const rel = /(\d+|[ء-ي]+)\s*(يوم|ايام|اسبوع|اسابيع|شهر|شهور|اشهر)/.exec(n);
  if (rel && /(اخر|خلال|الماضي|الماضيه|اللي فات|الي فات|السابق|السابقه)/.test(n)) {
    const count = Number(rel[1]) || NUM_WORDS[rel[1]!] || 0;
    if (count > 0 && count <= 3660) {
      const unit = rel[2]!;
      const days = unit === "يوم" || unit === "ايام" ? count : unit === "اسبوع" || unit === "اسابيع" ? count * 7 : count * 30;
      const word = days === count ? (count <= 10 ? "أيام" : "يوماً") : days === count * 7 ? (count <= 10 ? "أسابيع" : "أسبوعاً") : count <= 10 ? "أشهر" : "شهراً";
      return { from: addDays(today, -(days - 1)), to: today, label: count === 1 ? `آخر ${unit === "يوم" ? "يوم" : unit === "اسبوع" ? "أسبوع" : "شهر"}` : `آخر ${count} ${word}` };
    }
  }
  for (const [names, mi] of MONTHS) {
    if (!names.some((name) => (name.includes(" ") ? n.includes(name) : hasWord(t, [name])))) continue;
    const yearMatch = /(20\d\d)/.exec(n);
    const yy = yearMatch ? Number(yearMatch[1]) : mi > m ? y - 1 : y;
    const from = `${yy}-${String(mi + 1).padStart(2, "0")}-01`;
    return { from, to: clampToday(monthEnd(yy, mi), today), label: `شهر ${names[0]} ${yy}` };
  }
  return null;
}

export const defaultPeriod = (today: string): Period => ({ from: addDays(today, -29), to: today, label: "آخر 30 يوماً" });
export const shiftDays = addDays;

// ── Output formatting (Latin digits, as the UI does) ──────────────────────────────────────────
const nf = (v: number, max = 2, min = 0) => v.toLocaleString("en-US", { maximumFractionDigits: max, minimumFractionDigits: min });
export const fmt = {
  num: (v: unknown) => (typeof v === "number" ? nf(v) : "—"),
  money: (v: unknown) => (typeof v === "number" ? `\u2066\u20C1\u00A0${nf(v, 2, 2)}\u2069` : "—"),
  pct: (v: unknown) => (typeof v === "number" ? `${nf(v, 1)}%` : "—"),
  /** Base units are grams and millilitres; people think in kilos and litres. */
  qty: (v: unknown, unit?: unknown) => {
    if (typeof v !== "number") return "—";
    const u = String(unit ?? "");
    if (/^(جرام|جم|غرام|g)$/i.test(u) && Math.abs(v) >= 1000) return `${nf(v / 1000, 3)} كجم`;
    if (/^(مل|ملليلتر|مليلتر|ml)$/i.test(u) && Math.abs(v) >= 1000) return `${nf(v / 1000, 3)} لتر`;
    return `${nf(v, 3)}${u ? ` ${u}` : ""}`;
  },
  unitCost: (v: unknown, unit?: unknown) => {
    if (typeof v !== "number") return "—";
    const u = String(unit ?? "");
    if (/^(جرام|جم|غرام|g)$/i.test(u)) return `\u2066\u20C1\u00A0${nf(v * 1000, 2, 2)}\u2069/كجم`;
    if (/^(مل|ملليلتر|مليلتر|ml)$/i.test(u)) return `\u2066\u20C1\u00A0${nf(v * 1000, 2, 2)}\u2069/لتر`;
    return `\u2066\u20C1\u00A0${nf(v, 2, 2)}\u2069/${u || "وحدة"}`;
  },
  date: (v: unknown) => (typeof v === "string" ? (v.length > 10 ? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Riyadh", dateStyle: "short" }).format(new Date(v)) : v) : "—"),
};

/** A Markdown table; cells are escaped so data can never break the layout. */
export function table(head: string[], rows: string[][]): string {
  const cell = (s: string) => s.replace(/\|/g, "／").replace(/\n/g, " ");
  return [`| ${head.map(cell).join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n");
}
