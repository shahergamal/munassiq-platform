import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Bot, Check, Download, FileSpreadsheet, FileText, History, Loader2, MessageSquarePlus, Printer, ShieldCheck, Sparkles, Square, Trash2, TriangleAlert, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ApiError, api, download, errorMessage, request } from "../api/client";
import { Markdown } from "../lib/markdown";
import { Button, IconButton } from "../ui/Button";
import { ConfirmDialog } from "../ui/Dialog";
import { ErrorState, Skeleton } from "../ui/States";

interface Status { configured: boolean; usedToday: number; dailyLimit: number | null; scope: string[]; suggestions: string[] }
/** Whose assistant: a workspace member's (tenant header, /t) or the platform administrator's (/admin). */
export type AssistantScope = { kind: "tenant"; tenantId: string } | { kind: "platform" };
const apiOf = (s: AssistantScope) => (s.kind === "tenant" ? { base: "/t/assistant", tenant: s.tenantId, key: s.tenantId } : { base: "/admin/assistant", tenant: undefined, key: "platform" });
interface ConversationRow { id: string; title: string; updatedAt: string }
interface FileRef { id: string; filename: string; format: string; rows: number }
interface Step { name: string; label: string; status: "start" | "done" | "error" }
interface Msg { role: "user" | "assistant"; text: string; files: FileRef[]; steps?: Step[]; error?: string; stopped?: boolean; retry?: string }
type ServerEvent =
  | { type: "text"; delta: string }
  | { type: "tool"; name: string; label: string; status: Step["status"] }
  | ({ type: "export" } & FileRef)
  | { type: "done"; conversationId: string; title: string }
  | { type: "error"; message: string };

/** Splits a server-sent-events buffer into complete events, returning what is left for the next chunk. */
export function takeEvents(buffer: string): { events: ServerEvent[]; rest: string } {
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  const events: ServerEvent[] = [];
  for (const p of parts) {
    const line = p.split("\n").find((l) => l.startsWith("data: "));
    if (!line) continue;
    try { events.push(JSON.parse(line.slice(6)) as ServerEvent); } catch { /* malformed event: skip it */ }
  }
  return { events, rest };
}

const keyOf = (scopeKey: string, ...k: string[]) => ["assistant", scopeKey, ...k];

/**
 * The workspace assistant. It sees exactly what the signed-in member sees: the server offers the model only
 * the reads this member's role allows and runs each one as this member, so the panel holds no data rules.
 */
/** Opens the workspace assistant from anywhere (the phone tab bar's AI pill). */
export const openAssistant = () => window.dispatchEvent(new Event("mn:assistant-open"));

export function AssistantLauncher({ scope, companyName, firstName }: { scope: AssistantScope; companyName: string; firstName: string }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const on = () => setOpen(true);
    window.addEventListener("mn:assistant-open", on);
    return () => window.removeEventListener("mn:assistant-open", on);
  }, []);
  return (
    <>
      {/* Floating at the bottom inline-end corner (left in Arabic), clear of the toasts on the other side. */}
      <button type="button" className="assistant-fab" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open} aria-label="المساعد الذكي">
        <span className="fab-core" aria-hidden="true">
          <Bot className="fab-bot" />
          <Sparkles className="fab-spark" />
        </span>
        <span className="fab-tip" aria-hidden="true">اسأل المساعد الذكي</span>
      </button>
      <AssistantSheet open={open} onClose={() => setOpen(false)} scope={scope} companyName={companyName} firstName={firstName} />
    </>
  );
}

function AssistantSheet({ open, onClose, scope, companyName, firstName }: { open: boolean; onClose: () => void; scope: AssistantScope; companyName: string; firstName: string }) {
  const { base, tenant, key: tenantId } = apiOf(scope);
  const ref = useRef<HTMLDialogElement>(null);
  const qc = useQueryClient();
  const [view, setView] = useState<"chat" | "history">("chat");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [loadingConv, setLoadingConv] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const status = useQuery({ queryKey: keyOf(tenantId, "status"), queryFn: () => api<Status>("GET", `${base}/status`, { tenant }), enabled: open, staleTime: 30_000 });

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) { d.showModal(); setTimeout(() => input.current?.focus(), 0); }
    else if (!open && d.open) d.close();
  }, [open]);

  // Follow the answer as it streams, unless the reader scrolled up to read something earlier.
  useEffect(() => {
    const el = scroller.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => () => abort.current?.abort(), []);

  const patchLast = (fn: (m: Msg) => Msg) => setMessages((ms) => ms.map((m, i) => (i === ms.length - 1 ? fn(m) : m)));

  async function ask(text: string) {
    const message = text.trim();
    if (!message || streaming) return;
    setDraft("");
    setView("chat");
    setMessages((ms) => [...ms.map((m) => ({ ...m, retry: undefined })), { role: "user", text: message, files: [] }, { role: "assistant", text: "", files: [], steps: [] }]);
    setStreaming(true);
    const ctrl = new AbortController();
    abort.current = ctrl;
    try {
      const res = await request("POST", `${base}/chat`, { tenant, body: { message, conversationId }, signal: ctrl.signal });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const { events, rest } = takeEvents(buffer + decoder.decode(value, { stream: true }));
        buffer = rest;
        for (const e of events) {
          if (e.type === "text") patchLast((m) => ({ ...m, text: m.text + e.delta }));
          else if (e.type === "tool") patchLast((m) => {
            const steps = [...(m.steps ?? [])];
            const i = steps.findIndex((s) => s.name === e.name && s.status === "start");
            if (e.status !== "start" && i >= 0) steps[i] = { ...steps[i]!, status: e.status };
            else steps.push({ name: e.name, label: e.label, status: e.status });
            return { ...m, steps };
          });
          else if (e.type === "export") patchLast((m) => ({ ...m, files: [...m.files, { id: e.id, filename: e.filename, format: e.format, rows: e.rows }] }));
          else if (e.type === "done") { setConversationId(e.conversationId); void qc.invalidateQueries({ queryKey: keyOf(tenantId) }); }
          else if (e.type === "error") patchLast((m) => ({ ...m, error: e.message, retry: message }));
        }
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") patchLast((m) => ({ ...m, stopped: true }));
      else {
        patchLast((m) => ({ ...m, error: errorMessage(err), retry: message }));
        if (err instanceof ApiError && (err.code === "assistant_quota" || err.code === "assistant_not_configured" || err.code === "assistant_disabled")) void qc.invalidateQueries({ queryKey: keyOf(tenantId, "status") });
      }
    } finally {
      abort.current = null;
      setStreaming(false);
      setTimeout(() => input.current?.focus(), 0);
    }
  }

  function newChat() {
    abort.current?.abort();
    setMessages([]);
    setConversationId(null);
    setView("chat");
    setTimeout(() => input.current?.focus(), 0);
  }

  async function openConversation(id: string) {
    abort.current?.abort();
    setView("chat");
    setLoadingConv(true);
    setMessages([]);
    try {
      const c = await api<{ id: string; messages: Msg[] }>("GET", `${base}/conversations/${id}`, { tenant });
      setMessages(c.messages);
      setConversationId(c.id);
    } catch (err) {
      setMessages([{ role: "assistant", text: "", files: [], error: errorMessage(err) }]);
    } finally {
      setLoadingConv(false);
    }
  }

  const onSubmit = (e: FormEvent) => { e.preventDefault(); void ask(draft); };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void ask(draft); }
  };

  const s = status.data;
  const disabled = s?.dailyLimit === 0;
  const exhausted = Boolean(s && s.dailyLimit !== null && s.usedToday >= s.dailyLimit);
  const canAsk = Boolean(s?.configured) && !exhausted;

  return (
    <dialog ref={ref} className="assistant-sheet" aria-labelledby="assistant-title" onCancel={(e) => { e.preventDefault(); onClose(); }}>
      {open && (
        <div className="assistant">
          <header className="assistant-head">
            <span className="assistant-mark" aria-hidden="true"><Bot /></span>
            <div className="assistant-title">
              <h2 id="assistant-title">المساعد الذكي</h2>
              <span>{companyName}</span>
            </div>
            <span className="spacer" />
            <IconButton label={view === "history" ? "العودة للمحادثة" : "المحادثات السابقة"} icon={<History />} size="sm" onClick={() => setView(view === "history" ? "chat" : "history")} aria-pressed={view === "history"} />
            <IconButton label="محادثة جديدة" icon={<MessageSquarePlus />} size="sm" onClick={newChat} />
            <IconButton label="إغلاق المساعد" icon={<X />} size="sm" onClick={onClose} />
          </header>

          <div className="assistant-body" ref={scroller} aria-live="polite" aria-busy={streaming || loadingConv}>
            {status.isPending ? (
              <div className="assistant-pad" aria-busy="true"><Skeleton height={20} width="60%" /><Skeleton height={56} /><Skeleton height={56} /></div>
            ) : status.isError ? (
              <div className="assistant-pad"><ErrorState error={status.error} title="تعذر تحميل المساعد" onRetry={() => status.refetch()} /></div>
            ) : view === "history" ? (
              <HistoryList base={base} tenant={tenant} scopeKey={tenantId} currentId={conversationId} onOpen={openConversation} onDeleted={(id) => { if (id === conversationId) newChat(); }} />
            ) : loadingConv ? (
              <div className="assistant-pad" aria-busy="true"><span className="sr-only" role="status">جارٍ فتح المحادثة…</span><Skeleton height={40} width="70%" /><Skeleton height={96} /></div>
            ) : messages.length === 0 ? (
              <Welcome status={s!} firstName={firstName} companyName={companyName} platform={scope.kind === "platform"} onPick={(q) => void ask(q)} />
            ) : (
              <ol className="chat" aria-label="المحادثة">
                {messages.map((m, i) => (
                  <MessageView key={i} m={m} base={base} tenant={tenant} live={streaming && i === messages.length - 1} onRetry={(q) => { setMessages((ms) => ms.slice(0, -2)); void ask(q); }} />
                ))}
              </ol>
            )}
          </div>

          <form className="assistant-compose" onSubmit={onSubmit}>
            {s && !s.configured ? (
              <p className="compose-note"><TriangleAlert aria-hidden="true" />المساعد غير مفعّل على المنصة بعد. تواصل مع إدارة المنصة لتفعيله.</p>
            ) : disabled ? (
              <p className="compose-note"><TriangleAlert aria-hidden="true" />المساعد موقوف لهذه المنشأة من إدارة المنصة.</p>
            ) : exhausted ? (
              <p className="compose-note"><TriangleAlert aria-hidden="true" />استخدمت أسئلة اليوم كلها ({s!.dailyLimit}). يتجدد الرصيد غداً.</p>
            ) : null}
            <div className="compose-box">
              <label htmlFor="assistant-input" className="sr-only">سؤالك للمساعد</label>
              <textarea
                id="assistant-input"
                ref={input}
                rows={1}
                value={draft}
                maxLength={4000}
                disabled={!canAsk}
                placeholder="اسأل عن منشأتك أو اطلب تقريراً…"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onKeyDown}
              />
              {streaming ? (
                <IconButton label="إيقاف الإجابة" icon={<Square />} variant="secondary" onClick={() => abort.current?.abort()} />
              ) : (
                <IconButton label="إرسال" icon={<ArrowUp />} variant="primary" type="submit" disabled={!canAsk || !draft.trim()} />
              )}
            </div>
            <p className="compose-meta">
              <ShieldCheck aria-hidden="true" />
              <span>{scope.kind === "platform" ? "يجيب من بيانات المنصة فقط، دون بيانات المنشآت الداخلية" : "يجيب من بيانات منشأتك ضمن صلاحياتك فقط"}</span>
              {s?.configured && s.dailyLimit !== null && !disabled && <span className="compose-count">{s.usedToday}/{s.dailyLimit} اليوم</span>}
            </p>
          </form>
        </div>
      )}
    </dialog>
  );
}

function Welcome({ status, firstName, companyName, platform, onPick }: { status: Status; firstName: string; companyName: string; platform: boolean; onPick: (q: string) => void }) {
  return (
    <div className="assistant-pad assistant-welcome">
      <h3>أهلاً {firstName}</h3>
      {platform
        ? <p>أجيب عن المنشآت والاشتراكات والباقات والمستخدمين والإيرادات واستهلاك الحدود، وأجهّز أي تقرير Excel أو CSV أو PDF أو Word، وأحلل وضع المنصة. لا أطّلع على بيانات المنشآت الداخلية: ذلك عبر جلسة دعم فقط.</p>
        : <p>أجيب عن أسئلتك من بيانات «{companyName}» مباشرة، وأجهّز لك التقارير Excel أو CSV أو PDF أو Word، وأشير لك إلى المشاكل وفرص التحسين. لا أجيب عن أسئلة عامة خارج منشأتك.</p>}
      {status.scope.length > 0 && (
        <section aria-labelledby="scope-h">
          <h4 id="scope-h">ما يمكنني الاطلاع عليه بصلاحياتك</h4>
          <ul className="scope-chips">{status.scope.map((x) => <li key={x}>{x}</li>)}</ul>
        </section>
      )}
      {status.configured && status.suggestions.length > 0 && (
        <section aria-labelledby="sugg-h">
          <h4 id="sugg-h">جرّب أن تسأل</h4>
          <div className="suggestions">
            {status.suggestions.map((q) => <button key={q} type="button" className="suggestion" onClick={() => onPick(q)}>{q}</button>)}
          </div>
        </section>
      )}
    </div>
  );
}

function MessageView({ m, base, tenant, live, onRetry }: { m: Msg; base: string; tenant: string | undefined; live: boolean; onRetry: (q: string) => void }) {
  if (m.role === "user") return <li className="bubble is-user"><p>{m.text}</p></li>;
  const thinking = live && !m.text && !m.error;
  return (
    <li className="bubble is-assistant">
      {m.steps && m.steps.length > 0 && (
        <ul className="steps" aria-label="ما قرأه المساعد">
          {m.steps.map((st, i) => (
            <li key={i} className={`step is-${st.status}`}>
              {st.status === "start" ? <Loader2 className="spin" aria-hidden="true" /> : st.status === "done" ? <Check aria-hidden="true" /> : <TriangleAlert aria-hidden="true" />}
              {st.status === "start" ? `يقرأ: ${st.label}…` : st.status === "done" ? st.label : `${st.label}: تعذّر`}
            </li>
          ))}
        </ul>
      )}
      {thinking && <p className="typing"><span className="sr-only">المساعد يكتب…</span><span aria-hidden="true" /><span aria-hidden="true" /><span aria-hidden="true" /></p>}
      {m.text && <div className="md"><Markdown text={m.text} /></div>}
      {m.files.map((f) => <FileCard key={f.id} f={f} base={base} tenant={tenant} />)}
      {m.stopped && <p className="bubble-note">أوقفت الإجابة.</p>}
      {m.error && (
        <div className="bubble-error" role="alert">
          <span>{m.error}</span>
          {m.retry && <Button size="sm" onClick={() => onRetry(m.retry!)}>أعد المحاولة</Button>}
        </div>
      )}
    </li>
  );
}

const FORMAT_LABEL: Record<string, string> = { pdf: "PDF (عبر الطباعة)", xlsx: "Excel", csv: "CSV", doc: "Word" };

/**
 * Prints a server-made report page without a popup (popups opened after a request are blocked by browsers):
 * the page loads in a hidden frame and the browser's print dialog opens, where "Save as PDF" makes the file.
 */
export function printHtml(html: string) {
  const frame = document.createElement("iframe");
  frame.title = "طباعة التقرير";
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;inset-inline-start:0;inset-block-end:0;width:0;height:0;border:0;visibility:hidden";
  // The page's own auto-print script is for opening the file directly; here the parent prints once.
  frame.srcdoc = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  frame.onload = () => {
    const w = frame.contentWindow;
    if (!w) return;
    w.addEventListener("afterprint", () => setTimeout(() => frame.remove(), 0));
    w.focus();
    w.print();
    setTimeout(() => frame.remove(), 120_000);
  };
  document.body.append(frame);
}

function FileCard({ f, base, tenant }: { f: FileRef; base: string; tenant: string | undefined }) {
  const [busy, setBusy] = useState<"print" | "download" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const printable = f.format === "pdf";
  const path = `${base}/exports/${f.id}`;
  async function run(kind: "print" | "download") {
    setBusy(kind);
    setError(null);
    try {
      if (kind === "print") printHtml(await (await request("GET", path, { tenant })).text());
      else await download(path, tenant, f.filename);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }
  const Icon = f.format === "xlsx" ? FileSpreadsheet : FileText;
  return (
    <div className="file-card">
      <span className={`file-icon is-${f.format}`} aria-hidden="true"><Icon /></span>
      <span className="file-meta"><strong dir="auto">{f.filename}</strong><span>{FORMAT_LABEL[f.format] ?? f.format.toUpperCase()}{f.rows ? ` · ${f.rows} صف` : ""}</span></span>
      {printable ? (
        <>
          <Button size="sm" icon={<Printer />} loading={busy === "print"} loadingText="جارٍ التجهيز…" disabled={busy !== null} onClick={() => void run("print")}>طباعة / حفظ PDF</Button>
          <IconButton label="تنزيل الملف" icon={<Download />} size="sm" loading={busy === "download"} disabled={busy !== null} onClick={() => void run("download")} />
        </>
      ) : (
        <Button size="sm" icon={<Download />} loading={busy === "download"} loadingText="جارٍ التنزيل…" onClick={() => void run("download")}>تنزيل</Button>
      )}
      {error && <p className="file-error" role="alert">{error}</p>}
    </div>
  );
}

function HistoryList({ base, tenant, scopeKey, currentId, onOpen, onDeleted }: { base: string; tenant: string | undefined; scopeKey: string; currentId: string | null; onOpen: (id: string) => void; onDeleted: (id: string) => void }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: keyOf(scopeKey, "conversations"), queryFn: () => api<{ items: ConversationRow[] }>("GET", `${base}/conversations`, { tenant }) });
  const [pending, setPending] = useState<ConversationRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (list.isPending) return <div className="assistant-pad" aria-busy="true"><Skeleton height={44} /><Skeleton height={44} /><Skeleton height={44} /></div>;
  if (list.isError) return <div className="assistant-pad"><ErrorState error={list.error} title="تعذر تحميل المحادثات" onRetry={() => list.refetch()} /></div>;
  const items = list.data.items;
  return (
    <div className="assistant-pad">
      <h3 className="history-h">محادثاتك السابقة</h3>
      {items.length === 0 ? (
        <p className="muted">لا توجد محادثات بعد. محادثاتك تظهر هنا ولا يراها غيرك.</p>
      ) : (
        <ul className="history">
          {items.map((c) => (
            <li key={c.id} className={c.id === currentId ? "is-current" : undefined}>
              <button type="button" className="history-open" onClick={() => onOpen(c.id)}>
                <strong>{c.title}</strong>
                <span>{new Date(c.updatedAt).toLocaleString("ar-SA-u-nu-latn", { dateStyle: "medium", timeStyle: "short" })}</span>
              </button>
              <IconButton label={`حذف المحادثة «${c.title}»`} icon={<Trash2 />} size="sm" destructive onClick={() => { setError(null); setPending(c); }} />
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        title="حذف المحادثة؟"
        message={`ستُحذف محادثة «${pending?.title ?? ""}» نهائياً. الملفات التي نزّلتها منها تبقى عندك.`}
        confirmLabel="حذف المحادثة"
        busy={busy}
        error={error}
        onConfirm={async () => {
          if (!pending) return;
          setBusy(true);
          try {
            await api("DELETE", `${base}/conversations/${pending.id}`, { tenant });
            onDeleted(pending.id);
            setPending(null);
            await qc.invalidateQueries({ queryKey: keyOf(scopeKey, "conversations") });
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      />
    </div>
  );
}
