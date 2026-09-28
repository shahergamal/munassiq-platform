import { X } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { IconButton } from "./Button";

interface ToastItem { id: number; message: string; tone: "success" | "error" }
interface ToastApi { success: (m: string) => void; error: (m: string) => void }

const Ctx = createContext<ToastApi | null>(null);

/** Non-critical confirmations only. Errors that block a task are shown inline, next to the task. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const push = useCallback((message: string, tone: ToastItem["tone"]) => {
    const id = ++seq.current;
    setItems((xs) => [...xs.slice(-3), { id, message, tone }]);
    setTimeout(() => dismiss(id), tone === "error" ? 7000 : 4000);
  }, [dismiss]);
  const api = useMemo<ToastApi>(() => ({ success: (m) => push(m, "success"), error: (m) => push(m, "error") }), [push]);

  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toasts" aria-live="polite" role="status">
        {items.filter((t) => t.tone === "success").map((t) => (
          <div key={t.id} className="toast"><span className="spacer">{t.message}</span><IconButton size="sm" label="إخفاء الإشعار" icon={<X />} onClick={() => dismiss(t.id)} /></div>
        ))}
      </div>
      <div className="toasts" aria-live="assertive" role="alert" style={{ insetBlockEnd: "calc(var(--sp-4) + 64px)" }}>
        {items.filter((t) => t.tone === "error").map((t) => (
          <div key={t.id} className="toast is-error"><span className="spacer">{t.message}</span><IconButton size="sm" label="إخفاء الإشعار" icon={<X />} onClick={() => dismiss(t.id)} /></div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("ToastProvider missing");
  return v;
}
