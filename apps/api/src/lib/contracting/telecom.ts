// The telecom rollout, pure: the site state machine and milestone billing.

export const SITE_FLOW = ["planned", "survey", "permitting", "civil", "installation", "on_air", "pac", "fac"] as const;
export type SiteStatus = (typeof SITE_FLOW)[number] | "cancelled";
export const MILESTONES = ["installation", "on_air", "pac", "fac"] as const;
export type Milestone = (typeof MILESTONES)[number];

const rank = (s: SiteStatus) => (s === "cancelled" ? -1 : SITE_FLOW.indexOf(s));

/**
 * Whether a site may move from one state to another. Forward only: steps that do not apply to a site (a rooftop has
 * no civil works) may be skipped up to on air, but acceptance is in order: PAC after on air, FAC after PAC. A site is
 * cancelled only before it is on air; a cancelled or finally accepted site does not move.
 */
export function canMove(from: SiteStatus, to: SiteStatus): { ok: true } | { ok: false; reason: string } {
  if (from === "cancelled" || from === "fac") return { ok: false, reason: "الموقع في حالة نهائية" };
  if (to === "cancelled") return rank(from) < rank("on_air") ? { ok: true } : { ok: false, reason: "لا يُلغى موقع بعد تشغيله: الإلغاء بعده تسوية في العقد" };
  if (rank(to) <= rank(from)) return { ok: false, reason: "الحالة تتقدم ولا ترجع" };
  if (to === "pac" && from !== "on_air") return { ok: false, reason: "الاستلام الابتدائي بعد التشغيل" };
  if (to === "fac" && from !== "pac") return { ok: false, reason: "الاستلام النهائي بعد الابتدائي" };
  return { ok: true };
}

/** The share of a site's value billable in its state: the milestones it has reached (terms sum to 100). */
export function billableShare(status: SiteStatus, terms: Partial<Record<Milestone, number>>) {
  if (status === "cancelled") return 0;
  const reached = MILESTONES.filter((m) => rank(status) >= rank(m));
  return Math.round(reached.reduce((a, m) => a + (terms[m] ?? 0), 0) * 100) / 10_000;
}

export function checkTerms(terms: { milestone: Milestone; pct: number }[]) {
  const total = Math.round(terms.reduce((a, t) => a + t.pct, 0) * 100) / 100;
  if (new Set(terms.map((t) => t.milestone)).size !== terms.length) return "مرحلة مكررة";
  if (total !== 100) return `مجموع النسب ${total}% ويجب أن يكون 100%`;
  return null;
}

/**
 * The cumulative quantity to bill per rate-card item: Σ over sites of quantity × the share reached. Rounded to the
 * line's precision (4 places), so an IPC filled twice from unchanged sites does not move.
 */
export function quantitiesToDate(sites: { status: SiteStatus; items: { code: string; quantity: number }[] }[], terms: Partial<Record<Milestone, number>>) {
  const out = new Map<string, number>();
  for (const s of sites) {
    const share = billableShare(s.status, terms);
    if (!share) continue;
    for (const i of s.items) out.set(i.code, (out.get(i.code) ?? 0) + i.quantity * share);
  }
  for (const [k, v] of out) out.set(k, Math.round(v * 10_000) / 10_000);
  return out;
}
