import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ArrowUp, BadgeCheck, Boxes, Building2, Check, ChefHat, ChevronLeft, DatabaseZap, Factory, Gauge, History, Camera, Briefcase,
  LockKeyhole, Mail, MapPin, Menu, MessageCircle, Network, Phone, Receipt, ShieldCheck, Sparkles, TrendingUp, UtensilsCrossed, X, type LucideIcon,
  House, LayoutGrid, Search, ShoppingCart, Store, TabletSmartphone, Warehouse,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Logo } from "../ui/Logo";
import { api, ApiError } from "../api/client";
import { useMe } from "../app/session";
import { integer, money } from "../lib/format";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { TextField } from "../ui/Field";
import { FormError } from "../ui/States";

// Mirrors apps/api/src/lib/landing.ts (the server validates and merges defaults; the page only renders).
interface Item { title: string; description: string }
interface LinkItem { label: string; url: string }
export interface LandingContent {
  announcement: { title: string; text: string; action: string; url: string };
  integrations: { title: string; items: string[] };
  navigation: { features: string; why: string; useCases: string; pricing: string; faq: string; signIn: string; trial: string };
  hero: { badge: string; title: string; highlight: string; description: string; primaryAction: string; secondaryAction: string; trustItems: string[]; note: string };
  sectors: { eyebrow: string; title: string; description: string; availableLabel: string; comingSoonLabel: string; waitlistAction: string; items: { id: string; label: string; description: string }[] };
  preview: { title: string; note: string; metrics: { label: string; value: string }[]; listTitle: string; list: { label: string; meta: string; tag: string }[] };
  features: { eyebrow: string; title: string; description: string; items: Item[] };
  mobileApp: { eyebrow: string; title: string; description: string; points: string[] };
  why: { eyebrow: string; title: string; description: string; items: Item[] };
  useCases: { eyebrow: string; title: string; items: Item[] };
  pricing: { eyebrow: string; title: string; description: string; note: string; monthly: string; yearly: string; empty: string };
  faq: { eyebrow: string; title: string; description: string; items: { question: string; answer: string }[] };
  cta: { eyebrow: string; title: string; description: string };
  footer: {
    description: string; exploreTitle: string; exploreLinks: LinkItem[]; sectorsTitle: string; sectorLinks: LinkItem[]; contactTitle: string;
    phone: string; email: string; address: string; linkedin: string; instagram: string; whatsapp: string; copyright: string;
  };
  policies: Record<"privacy" | "terms" | "security", { title: string; summary: string; body: string }>;
}
interface Plan { code: string; sector: string; nameAr: string; description: string | null; features: string[]; badge: string | null; isFeatured: boolean; monthlyPrice: number; annualPrice: number | null; branchesLimit: number; usersLimit: number }
interface Sector { key: string; nameAr: string; isAvailable: boolean }
export interface LandingData { content: LandingContent; sectors: Sector[]; plans: Plan[] }

export const landingKey = ["public", "landing"] as const;
export const useLanding = () => useQuery({ queryKey: landingKey, queryFn: () => api<LandingData>("GET", "/public/landing"), staleTime: 60_000 });

const SECTOR_ICON: Record<string, LucideIcon> = { restaurants: UtensilsCrossed, manufacturing: Factory, contracting: Building2 };
const FEATURE_ICONS: LucideIcon[] = [DatabaseZap, LockKeyhole, Boxes, History, Gauge, ShieldCheck, Network, BadgeCheck];
const WHY_ICONS: LucideIcon[] = [Gauge, Network, ShieldCheck, TrendingUp, Boxes, BadgeCheck];
const USE_ICONS: LucideIcon[] = [ChefHat, Receipt, TrendingUp, Boxes, Network, Gauge];
const TRUST_ICONS: LucideIcon[] = [BadgeCheck, LockKeyhole, ShieldCheck, Check, Gauge, Network];

/** Internal paths use the router; anchors, mail and phone links stay plain. The server already rejected anything else. */
function SmartLink({ url, children, className }: { url: string; children: React.ReactNode; className?: string }) {
  if (url.startsWith("/")) return <Link to={url} className={className}>{children}</Link>;
  const external = url.startsWith("https://");
  return <a href={url} className={className} {...(external ? { target: "_blank", rel: "noreferrer" } : {})}>{children}</a>;
}

/**
 * Scroll animations: elements marked data-reveal rise into place once they enter the viewport (staggered by
 * data-reveal-i); the product showcase opens up as it scrolls in. Off for prefers-reduced-motion.
 */
function useScrollMotion(ready: boolean) {
  useEffect(() => {
    if (!ready) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const els = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]"));
    els.forEach((el) => el.style.setProperty("--reveal-delay", `${Number(el.dataset.revealI ?? 0) * 90}ms`));
    if (reduced || typeof IntersectionObserver === "undefined") { els.forEach((el) => el.classList.add("is-in")); return; }
    const io = new IntersectionObserver((entries) => {
      // Also what is already above the screen (a jump through a menu link skips past it).
      for (const e of entries) if (e.isIntersecting || e.boundingClientRect.bottom < 0) { e.target.classList.add("is-in"); io.unobserve(e.target); }
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.12 });
    els.forEach((el) => io.observe(el));

    const show = document.querySelector<HTMLElement>(".lp-show");
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        document.documentElement.classList.toggle("lp-scrolled", window.scrollY > 8);
        if (!show) return;
        const r = show.getBoundingClientRect();
        // 0 when the showcase top reaches the bottom of the screen, 1 when it is a third of the way up.
        const p = Math.min(1, Math.max(0, (window.innerHeight - r.top) / (window.innerHeight * 0.66)));
        show.style.setProperty("--p", p.toFixed(3));
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => { io.disconnect(); window.removeEventListener("scroll", onScroll); cancelAnimationFrame(raf); document.documentElement.classList.remove("lp-scrolled"); };
  }, [ready]);
}

const ANNOUNCE_KEY = "mn.lp.announcement";

export function LandingPage() {
  const q = useLanding();
  const me = useMe();
  const [menu, setMenu] = useState(false);
  const [top, setTop] = useState(false);
  const [waitlist, setWaitlist] = useState<Sector | null>(null);
  const [hideBar, setHideBar] = useState(() => { try { return sessionStorage.getItem(ANNOUNCE_KEY) === "closed"; } catch { return false; } });
  useEffect(() => {
    const on = () => setTop(window.scrollY > 480);
    on(); window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  useEffect(() => { document.title = "مُنَسِّق | تكاليف ومحاسبة وفوترة المطاعم والمصانع والمقاولات"; }, []);
  useScrollMotion(q.isSuccess);

  if (q.isPending) return <div className="lp-loading" role="status" aria-busy="true"><Logo height={48} /><span className="sr-only">جارٍ تحميل الصفحة…</span></div>;
  if (q.isError) {
    return (
      <div className="lp-loading">
        <div className="state is-error" role="alert"><h2>تعذر تحميل الصفحة</h2><p>تحقق من الاتصال ثم أعد المحاولة، أو ادخل مباشرة إلى حسابك.</p>
          <div className="row"><Button onClick={() => q.refetch()}>إعادة المحاولة</Button><Link to="/login" className="btn btn-primary">تسجيل الدخول</Link></div></div>
      </div>
    );
  }
  const { content: c, sectors, plans } = q.data;
  const loggedIn = Boolean(me.data);
  const nav = [["#features", c.navigation.features], ["#why", c.navigation.why], ["#use-cases", c.navigation.useCases], ["#pricing", c.navigation.pricing], ["#faq", c.navigation.faq]] as const;
  const start = loggedIn
    ? <Link to="/app" className="btn lp-btn-primary">افتح منشآتي</Link>
    : <Link to="/register" className="btn lp-btn-primary">{c.hero.primaryAction}</Link>;
  const closeBar = () => { setHideBar(true); try { sessionStorage.setItem(ANNOUNCE_KEY, "closed"); } catch { /* storage blocked */ } };

  return (
    <div className="lp">
      <a href="#lp-main" className="btn btn-primary skip-link">تخطَّ إلى المحتوى</a>

      {c.announcement.title && !hideBar && (
        <div className="lp-announce" role="region" aria-label="إعلان">
          <div className="lp-wrap lp-announce-row">
            <div className="lp-announce-text"><strong>{c.announcement.title}</strong>{c.announcement.text && <span>{c.announcement.text}</span>}</div>
            {c.announcement.action && c.announcement.url && <SmartLink url={c.announcement.url} className="btn btn-sm lp-announce-btn">{c.announcement.action}</SmartLink>}
            <button type="button" className="lp-announce-close" aria-label="إغلاق الإعلان" onClick={closeBar}><X aria-hidden="true" /></button>
          </div>
        </div>
      )}

      <header className="lp-header">
        {(c.footer.phone || c.footer.email) && (
          <div className="lp-utility only-wide">
            <div className="lp-wrap lp-utility-row">
              {c.footer.phone && <a href={`tel:${c.footer.phone.replace(/\s/g, "")}`}><Phone aria-hidden="true" />المبيعات: <span dir="ltr">{c.footer.phone}</span></a>}
              {c.footer.email && <a href={`mailto:${c.footer.email}`}><Mail aria-hidden="true" /><span dir="ltr">{c.footer.email}</span></a>}
              <span className="spacer" />
              <span className="lp-utility-flag">المملكة العربية السعودية</span>
            </div>
          </div>
        )}
        <div className="lp-wrap lp-header-row">
          <Link to="/" className="wordmark" aria-label="مُنَسِّق: الرئيسية"><Logo height={38} /></Link>
          <nav className="lp-nav only-wide" aria-label="أقسام الصفحة">{nav.map(([href, label]) => <a key={href} href={href}>{label}</a>)}</nav>
          <span className="spacer" />
          {!loggedIn && <Link to="/login" className="lp-signin only-wide">{c.navigation.signIn}</Link>}
          <span className="only-wide">{start}</span>
          <button type="button" className="btn btn-ghost btn-icon only-narrow" aria-expanded={menu} aria-controls="lp-menu" aria-label={menu ? "إغلاق القائمة" : "فتح القائمة"} onClick={() => setMenu((m) => !m)}>
            {menu ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
          </button>
        </div>
        {menu && (
          <nav id="lp-menu" className="lp-wrap lp-mobile-nav" aria-label="أقسام الصفحة">
            {nav.map(([href, label]) => <a key={href} href={href} onClick={() => setMenu(false)}>{label}</a>)}
            {!loggedIn && <Link to="/login">{c.navigation.signIn}</Link>}
            {start}
          </nav>
        )}
      </header>

      <main id="lp-main">
        <section className="lp-hero">
          <div className="lp-wrap lp-hero-inner">
            {c.hero.badge && <a href="#features" className="lp-badge lp-rise" style={{ "--rise": 0 } as React.CSSProperties}>{c.hero.badge}</a>}
            <h1 className="lp-rise" style={{ "--rise": 1 } as React.CSSProperties}>{c.hero.title} <span className="lp-mark">{c.hero.highlight}</span></h1>
            <p className="lp-lead lp-rise" style={{ "--rise": 2 } as React.CSSProperties}>{c.hero.description}</p>
            <div className="lp-actions lp-rise" style={{ "--rise": 3 } as React.CSSProperties}>
              {loggedIn ? <Link to="/app" className="btn btn-lg lp-btn-primary">افتح منشآتي</Link>
                : <Link to="/register" className="btn btn-lg lp-btn-primary">{c.hero.primaryAction}</Link>}
              <a href="#pricing" className="btn btn-lg lp-btn-outline">{c.hero.secondaryAction}</a>
            </div>
            {c.hero.note && <p className="lp-note-hero lp-rise" style={{ "--rise": 4 } as React.CSSProperties}><span className="lp-marker">{c.hero.note}</span></p>}
            {c.hero.trustItems.length > 0 && (
              <ul className="lp-trustcard lp-rise" style={{ "--rise": 5 } as React.CSSProperties}>
                {c.hero.trustItems.map((t, i) => { const Icon = TRUST_ICONS[i % TRUST_ICONS.length]!; return <li key={t}><Icon aria-hidden="true" />{t}</li>; })}
              </ul>
            )}
          </div>

          {c.integrations.items.length > 0 && (
            <div className="lp-logos" data-reveal>
              <p className="lp-logos-title">{c.integrations.title}</p>
              <Marquee items={c.integrations.items} />
              <Marquee items={[...c.integrations.items].reverse()} reverse />
            </div>
          )}

          <Showcase c={c} />
        </section>

        <section id="features" className="lp-section lp-lav">
          <div className="lp-wrap">
            <SectionHead eyebrow={c.features.eyebrow} title={c.features.title} description={c.features.description} center />
            <div className="lp-feats">
              {c.features.items.map((f, i) => {
                const Icon = FEATURE_ICONS[i % FEATURE_ICONS.length]!;
                return (
                  <div key={f.title} className="lp-feat" data-reveal data-reveal-i={i % 3}>
                    <span className="lp-gicon" aria-hidden="true"><Icon /></span>
                    <h3>{f.title}</h3>
                    <p>{f.description}</p>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        <PhoneSection c={c} />

        <section id="why" className="lp-section lp-dark">
          <div className="lp-wrap">
            <div className="lp-head is-center" data-reveal>
              <span className="lp-glass-pill">{c.why.eyebrow}<Sparkles aria-hidden="true" /></span>
              <h2>{c.why.title}</h2>
              <p className="lp-sub">{c.why.description}</p>
            </div>
            <div className="lp-grid-3">
              {c.why.items.map((f, i) => {
                const Icon = WHY_ICONS[i % WHY_ICONS.length]!;
                return <article key={f.title} className="lp-glass" data-reveal data-reveal-i={i}><span className="lp-gicon" aria-hidden="true"><Icon /></span><h3>{f.title}</h3><p>{f.description}</p></article>;
              })}
            </div>
          </div>
        </section>

        <section id="sectors" className="lp-section">
          <div className="lp-wrap">
            <SectionHead eyebrow={c.sectors.eyebrow} title={c.sectors.title} description={c.sectors.description} center />
            <div className="lp-grid-3">
              {c.sectors.items.map((it, i) => {
                const s = sectors.find((x) => x.key === it.id);
                const Icon = SECTOR_ICON[it.id] ?? Building2;
                const live = Boolean(s?.isAvailable);
                return (
                  <article key={it.id} className={`lp-card lp-sector${live ? " is-live" : ""}`} data-reveal data-reveal-i={i}>
                    <div className="row" style={{ justifyContent: "space-between" }}>
                      <span className="lp-gicon" aria-hidden="true"><Icon /></span>
                      <span className={`badge ${live ? "badge-success" : "badge-neutral"}`}>{live ? c.sectors.availableLabel : c.sectors.comingSoonLabel}</span>
                    </div>
                    <h3>{it.label}</h3>
                    <p>{it.description}</p>
                    {live
                      ? <Link to={loggedIn ? "/app" : "/register"} className="btn btn-secondary btn-sm lp-card-action">{loggedIn ? "افتح منشآتي" : c.hero.primaryAction}<ChevronLeft aria-hidden="true" /></Link>
                      : s && <button type="button" className="btn btn-ghost btn-sm lp-card-action" onClick={() => setWaitlist(s)}>{c.sectors.waitlistAction}</button>}
                  </article>
                );
              })}
            </div>
          </div>
        </section>

        <section id="use-cases" className="lp-section lp-lav">
          <div className="lp-wrap">
            <SectionHead eyebrow={c.useCases.eyebrow} title={c.useCases.title} center />
            <div className="lp-grid-3">
              {c.useCases.items.map((f, i) => {
                const Icon = USE_ICONS[i % USE_ICONS.length]!;
                return <article key={f.title} className="lp-card lp-usecase" data-reveal data-reveal-i={i}><span className="lp-gicon" aria-hidden="true"><Icon /></span><h3>{f.title}</h3><p>{f.description}</p></article>;
              })}
            </div>
          </div>
        </section>

        <Pricing c={c} plans={plans} sectors={sectors} loggedIn={loggedIn} />

        <section id="faq" className="lp-section lp-lav">
          <div className="lp-wrap lp-faq-wrap">
            <SectionHead eyebrow={c.faq.eyebrow} title={c.faq.title} description={c.faq.description} center />
            <div className="lp-faq">
              {c.faq.items.map((f, i) => (
                <details key={f.question} data-reveal data-reveal-i={Math.min(i, 4)}>
                  <summary>{f.question}</summary>
                  <p>{f.answer}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section className="lp-section">
          <div className="lp-wrap">
            <div className="lp-cta" data-reveal>
              <div>
                <p className="lp-eyebrow on-dark">{c.cta.eyebrow}</p>
                <h2>{c.cta.title}</h2>
                <p>{c.cta.description}</p>
              </div>
              {loggedIn ? <Link to="/app" className="btn btn-lg lp-cta-btn">افتح منشآتي<ChevronLeft aria-hidden="true" /></Link>
                : <Link to="/register" className="btn btn-lg lp-cta-btn">{c.hero.primaryAction}<ChevronLeft aria-hidden="true" /></Link>}
            </div>
          </div>
        </section>
      </main>

      <LandingFooter c={c} />

      {c.footer.whatsapp && <a href={c.footer.whatsapp} target="_blank" rel="noreferrer" className="lp-whatsapp" aria-label="تواصل معنا على واتساب"><MessageCircle aria-hidden="true" /></a>}
      {top && <button type="button" className="btn btn-icon lp-top" aria-label="العودة إلى أعلى الصفحة" title="العودة إلى أعلى الصفحة" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}><ArrowUp aria-hidden="true" /></button>}
      {waitlist && <WaitlistDialog sector={waitlist} onClose={() => setWaitlist(null)} />}
    </div>
  );
}

function SectionHead({ eyebrow, title, description, center }: { eyebrow: string; title: string; description?: string; center?: boolean }) {
  return (
    <div className={`lp-head${center ? " is-center" : ""}`} data-reveal>
      {eyebrow && <p className="lp-eyebrow">{eyebrow}</p>}
      <h2>{title}</h2>
      {description && <p className="lp-sub">{description}</p>}
    </div>
  );
}

/**
 * The app on a phone, drawn from the real mobile shell (blue header, quick actions, today's figure, cards, bottom
 * tabs with the assistant pill). Figures come from the illustrative preview content.
 */
function PhoneSection({ c }: { c: LandingContent }) {
  const m = c.preview.metrics;
  return (
    <section id="mobile" className="lp-section lp-phone-sec">
      <div className="lp-wrap lp-phone-grid">
        <div className="lp-phone-copy" data-reveal>
          <p className="lp-eyebrow">{c.mobileApp.eyebrow}</p>
          <h2>{c.mobileApp.title}</h2>
          <p className="lp-sub">{c.mobileApp.description}</p>
          <ul className="lp-phone-points">
            {c.mobileApp.points.map((t, i) => <li key={t} data-reveal data-reveal-i={i + 1}><span className="lp-gicon sm" aria-hidden="true"><Check /></span>{t}</li>)}
          </ul>
        </div>
        <figure className="lp-phone-stage" data-reveal aria-label={`شكل مُنَسِّق على الجوال: ${c.preview.note}`}>
          <div className="lp-phone-glow" aria-hidden="true" />
          <div className="lp-phone" aria-hidden="true">
            <div className="lp-phone-notch" />
            <div className="lp-phone-screen">
              <div className="lp-ph-status"><span className="num">9:41</span><span className="lp-ph-bars"><i /><i /><i /></span></div>
              <div className="lp-ph-hero">
                <div className="lp-ph-row">
                  <Logo white height={20} />
                  <span className="spacer" />
                  <span className="lp-ph-pill"><Store />مطعمي</span>
                  <span className="lp-ph-round"><Search /></span>
                  <span className="lp-ph-avatar">م</span>
                </div>
                <div className="lp-ph-quick">
                  {[[TabletSmartphone, "الكاشير"], [ShoppingCart, "المشتريات"], [Warehouse, "المخزون"], [LayoutGrid, "كل الصفحات"]].map(([Icon, label]) => {
                    const I = Icon as LucideIcon;
                    return <span key={label as string}><I />{label as string}</span>;
                  })}
                </div>
                <div className="lp-ph-next">
                  <span className="lp-ph-ring"><TrendingUp /></span>
                  <span><b>مبيعات اليوم <span className="num">{m[0]?.value ?? ""}</span></b><small>42 طلب · مجمل الربح {m[1]?.value ?? ""}</small></span>
                </div>
                <span className="lp-ph-handle" />
              </div>
              <div className="lp-ph-body">
                <p className="lp-ph-greet">صباح الخير 👋</p>
                {m.slice(0, 3).map((x, i) => (
                  <div key={x.label} className="lp-ph-card" style={{ "--i": i } as React.CSSProperties}>
                    <span className="lp-gicon sm">{[<Receipt key="r" />, <TrendingUp key="t" />, <Gauge key="g" />][i]}</span>
                    <span><small>{x.label}</small><b className="num">{x.value}</b></span>
                  </div>
                ))}
              </div>
              <div className="lp-ph-tabs">
                <span className="is-on"><House />الرئيسية</span>
                <span><TabletSmartphone />الكاشير</span>
                <span><Warehouse />المخزون</span>
                <span className="lp-ph-ai"><i /><i /><i />مُنَسِّق AI</span>
              </div>
            </div>
          </div>
          <div className="lp-phone-toast is-a" aria-hidden="true"><BadgeCheck />أُرسلت الفاتورة INV-1042 للهيئة</div>
          <div className="lp-phone-toast is-b" aria-hidden="true"><Boxes />3 مواد تحت الحد الأدنى</div>
        </figure>
      </div>
    </section>
  );
}

/** An endless strip of chips; duplicated once so the loop has no seam. Decorative copy is hidden from screen readers. */
function Marquee({ items, reverse }: { items: string[]; reverse?: boolean }) {
  return (
    <div className={`lp-marquee${reverse ? " is-reverse" : ""}`}>
      <ul className="lp-marquee-track">
        {[...items, ...items].map((t, i) => (
          <li key={`${t}-${i}`} aria-hidden={i >= items.length || undefined}><BadgeCheck aria-hidden="true" />{t}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Three screens of the product, the middle one in front (as in the reference): a tax invoice being written, the
 * printed simplified invoice with its QR, and the dashboard. Built from the design system; figures are illustrative.
 */
function Showcase({ c }: { c: LandingContent }) {
  return (
    <figure className="lp-show" aria-label={`${c.preview.title}: ${c.preview.note}`}>
      <div className="lp-show-glow" aria-hidden="true" />
      <div className="lp-show-card lp-show-side is-start" aria-hidden="true">
        <div className="lp-mock-head"><strong>فاتورة ضريبية مبسطة</strong><span className="lp-stamp">مدفوعة</span></div>
        <div className="lp-mock-dl"><span>رقم الفاتورة</span><b className="num">INV-001042</b><span>التاريخ</span><b className="num">2026-09-26</b></div>
        <div className="lp-mock-rows">{c.preview.list.slice(0, 3).map((x) => <div key={x.label}><span>{x.label}</span><b className="num">{x.tag}</b></div>)}</div>
        <div className="lp-mock-qr" />
      </div>
      <div className="lp-show-card lp-show-side is-end" aria-hidden="true">
        <div className="lp-mock-head"><Logo height={18} /><span className="lp-stamp is-live">مباشر</span></div>
        {c.preview.metrics.slice(0, 3).map((m) => <div key={m.label} className="lp-mock-kpi"><span>{m.label}</span><b className="num">{m.value}</b></div>)}
      </div>
      <div className="lp-show-card lp-show-main">
        <div className="lp-mock-top"><strong>{c.preview.title}</strong><span className="spacer" /><span className="lp-preview-note">{c.preview.note}</span></div>
        <div className="lp-preview-kpis">
          {c.preview.metrics.map((m, i) => {
            const Icon = [Receipt, TrendingUp, Gauge, Boxes][i % 4]!;
            return <div key={m.label} className="lp-preview-kpi"><span className="lp-gicon sm" aria-hidden="true"><Icon /></span><span className="label">{m.label}</span><span className="value num">{m.value}</span></div>;
          })}
        </div>
        <div className="lp-mock-table">
          <div className="lp-mock-tr is-head"><span>{c.preview.listTitle}</span><span>التفاصيل</span><span>القناة</span></div>
          {c.preview.list.map((x) => <div key={x.label} className="lp-mock-tr"><b>{x.label}</b><span>{x.meta}</span><span className="lp-chip">{x.tag}</span></div>)}
        </div>
      </div>
    </figure>
  );
}

function Pricing({ c, plans, sectors, loggedIn }: { c: LandingContent; plans: Plan[]; sectors: Sector[]; loggedIn: boolean }) {
  const live = sectors.filter((s) => s.isAvailable);
  const [sector, setSector] = useState(live[0]?.key ?? "restaurants");
  const [yearly, setYearly] = useState(false);
  const list = plans.filter((p) => p.sector === sector);
  const anyYearly = list.some((p) => p.annualPrice !== null);
  return (
    <section id="pricing" className="lp-section">
      <div className="lp-wrap">
        <SectionHead eyebrow={c.pricing.eyebrow} title={c.pricing.title} description={c.pricing.description} center />
        <div className="row lp-pricing-controls">
          {live.length > 1 && (
            <div className="segmented" role="group" aria-label="القطاع">
              {live.map((s) => <button key={s.key} type="button" aria-pressed={sector === s.key} onClick={() => setSector(s.key)}>{s.nameAr}</button>)}
            </div>
          )}
          {anyYearly && (
            <div className="segmented" role="group" aria-label="مدة الدفع">
              <button type="button" aria-pressed={!yearly} onClick={() => setYearly(false)}>{c.pricing.monthly}</button>
              <button type="button" aria-pressed={yearly} onClick={() => setYearly(true)}>{c.pricing.yearly}</button>
            </div>
          )}
        </div>
        {list.length === 0 ? <div className="lp-card lp-empty">{c.pricing.empty}</div> : (
          <div className="lp-grid-3 lp-plans">
            {list.map((p) => {
              const showYear = yearly && p.annualPrice !== null;
              return (
                <article key={p.code} className={`lp-card lp-plan${p.isFeatured ? " is-featured" : ""}`}>
                  {p.badge && <span className="lp-plan-badge">{p.badge}</span>}
                  <h3>{p.nameAr}</h3>
                  {p.description && <p className="lp-plan-desc">{p.description}</p>}
                  <div className="lp-price">
                    <strong className="num">{p.monthlyPrice === 0 ? "مجاناً" : money(showYear ? p.annualPrice : p.monthlyPrice)}</strong>
                    {p.monthlyPrice > 0 && <span className="muted">/ {showYear ? c.pricing.yearly : c.pricing.monthly}</span>}
                  </div>
                  <p className="muted lp-limits">حتى {integer(p.branchesLimit)} {p.branchesLimit === 1 ? "فرع" : "فروع"} و{integer(p.usersLimit)} مستخدم</p>
                  <ul className="lp-plan-features">{p.features.map((f) => <li key={f}><Check aria-hidden="true" />{f}</li>)}</ul>
                  <Link to={loggedIn ? "/app" : "/register"} className={`btn ${p.isFeatured ? "btn-primary" : "btn-secondary"} lp-plan-action`}>{loggedIn ? "افتح منشآتي" : c.hero.primaryAction}</Link>
                </article>
              );
            })}
          </div>
        )}
        <p className="muted lp-note">{c.pricing.note}</p>
      </div>
    </section>
  );
}

export function LandingFooter({ c }: { c: LandingContent }) {
  const socials = [[c.footer.linkedin, Briefcase, "لينكدإن"], [c.footer.instagram, Camera, "إنستغرام"], [c.footer.whatsapp, MessageCircle, "واتساب"]] as const;
  return (
    <footer className="lp-footer">
      <div className="lp-wrap lp-footer-grid">
        <div>
          <Link to="/" className="wordmark on-dark" aria-label="مُنَسِّق: الرئيسية"><Logo white height={48} /></Link>
          <p className="lp-footer-desc">{c.footer.description}</p>
          <div className="row">
            {socials.filter(([u]) => u).map(([u, Icon, name]) => <a key={name} href={u} target="_blank" rel="noreferrer" className="lp-social" aria-label={`مُنَسِّق على ${name}`}><Icon aria-hidden="true" /></a>)}
          </div>
        </div>
        <FooterCol title={c.footer.exploreTitle} links={c.footer.exploreLinks} />
        <FooterCol title={c.footer.sectorsTitle} links={c.footer.sectorLinks} />
        <div>
          <h3>{c.footer.contactTitle}</h3>
          <ul className="lp-footer-links">
            {c.footer.phone && <li><a href={`tel:${c.footer.phone.replace(/\s/g, "")}`}><Phone aria-hidden="true" /><span dir="ltr">{c.footer.phone}</span></a></li>}
            {c.footer.email && <li><a href={`mailto:${c.footer.email}`}><Mail aria-hidden="true" /><span dir="ltr">{c.footer.email}</span></a></li>}
            {c.footer.address && <li><span><MapPin aria-hidden="true" />{c.footer.address}</span></li>}
          </ul>
        </div>
      </div>
      <div className="lp-wrap lp-footer-bottom">
        <p>{c.footer.copyright}</p>
        <span className="spacer" />
        <Link to="/privacy">{c.policies.privacy.title}</Link>
        <Link to="/terms">{c.policies.terms.title}</Link>
        <Link to="/security">{c.policies.security.title}</Link>
      </div>
    </footer>
  );
}

function FooterCol({ title, links }: { title: string; links: LinkItem[] }) {
  return <div><h3>{title}</h3><ul className="lp-footer-links">{links.map((l) => <li key={`${l.label}-${l.url}`}><SmartLink url={l.url}>{l.label}</SmartLink></li>)}</ul></div>;
}

function WaitlistDialog({ sector, onClose }: { sector: Sector; onClose: () => void }) {
  const [v, setV] = useState({ email: "", companyName: "", phone: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  async function submit() {
    const e: Record<string, string> = {};
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email.trim())) e.email = "أدخل بريداً صحيحاً، مثل name@company.sa";
    if (v.companyName.trim().length < 2) e.companyName = "أدخل اسم المنشأة";
    if (v.phone.trim() && !/^\+?[0-9]{9,15}$/.test(v.phone.trim())) e.phone = "رقم الجوال أرقام فقط، مثل +9665XXXXXXXX";
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true); setError(null);
    try {
      await api("POST", "/waitlist", { body: { email: v.email.trim(), companyName: v.companyName.trim(), sector: sector.key, ...(v.phone.trim() ? { phone: v.phone.trim() } : {}) } });
      setDone(true);
    } catch (err) { setError(err instanceof ApiError ? err : "تعذر التسجيل الآن. حاول بعد قليل."); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} busy={busy} title={`سجّل اهتمامك بقطاع ${sector.nameAr}`} onSubmit={done ? undefined : () => void submit()}
      footer={done ? <Button onClick={onClose}>إغلاق</Button> : <><Button type="submit" variant="primary" loading={busy} loadingText="جارٍ التسجيل…">سجّل اهتمامي</Button><Button onClick={onClose} disabled={busy}>إلغاء</Button></>}>
      {done ? (
        <div className="state"><BadgeCheck aria-hidden="true" /><h2>تم تسجيل اهتمامك</h2><p>سنراسلك على <span dir="ltr">{v.email.trim()}</span> فور إطلاق قطاع {sector.nameAr}.</p></div>
      ) : <>
        <p className="muted">القطاع قيد التجهيز. اترك بياناتك لنخبرك فور إطلاقه. لا نستخدمها لغير ذلك.</p>
        <TextField label="البريد الإلكتروني" type="email" dir="ltr" required autoFocus value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} error={errors.email} autoComplete="email" />
        <TextField label="اسم المنشأة" required value={v.companyName} onChange={(e) => setV({ ...v, companyName: e.target.value })} error={errors.companyName} autoComplete="organization" />
        <TextField label="رقم الجوال" optional dir="ltr" inputMode="tel" value={v.phone} onChange={(e) => setV({ ...v, phone: e.target.value })} error={errors.phone} autoComplete="tel" />
        <FormError error={error} />
      </>}
    </Dialog>
  );
}

/** /privacy, /terms, /security: text managed from the admin panel. */
export function PolicyPage({ which }: { which: "privacy" | "terms" | "security" }) {
  const q = useLanding();
  useEffect(() => { if (q.data) document.title = `${q.data.content.policies[which].title} | مُنَسِّق`; }, [q.data, which]);
  if (q.isPending) return <div className="lp-loading" role="status" aria-busy="true"><Logo height={48} /></div>;
  if (q.isError) return <div className="lp-loading"><div className="state is-error" role="alert"><h2>تعذر تحميل الصفحة</h2><Button onClick={() => q.refetch()}>إعادة المحاولة</Button></div></div>;
  const c = q.data.content;
  const p = c.policies[which];
  return (
    <div className="lp">
      <header className="lp-header"><div className="lp-wrap lp-header-row">
        <Link to="/" className="wordmark" aria-label="مُنَسِّق: الرئيسية"><Logo height={40} /></Link>
        <span className="spacer" />
        <Link to="/" className="btn btn-ghost">الصفحة الرئيسية</Link>
      </div></header>
      <main className="lp-wrap lp-policy">
        <p className="lp-eyebrow">{p.summary}</p>
        <h1>{p.title}</h1>
        <div className="lp-card lp-policy-body">{p.body.split(/\n{2,}/).map((para, i) => <p key={i}>{para}</p>)}</div>
      </main>
      <LandingFooter c={c} />
    </div>
  );
}
