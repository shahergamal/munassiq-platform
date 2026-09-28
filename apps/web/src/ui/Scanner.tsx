import { Camera, ScanBarcode, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button, IconButton } from "./Button";

/**
 * Barcode input for counting and receiving.
 *   - A USB / Bluetooth scanner acts as a keyboard: it types the code and presses Enter into the focused field.
 *   - A phone reads codes with its camera (BarcodeDetector: Chrome on Android, recent Safari).
 * Every read gives a beep (and a vibration on phones): high for a known code, low for an unknown one.
 */

let audio: AudioContext | null = null;
export function beep(ok: boolean) {
  try {
    audio ??= new AudioContext();
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = ok ? 1320 : 220;
    g.gain.value = 0.08;
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + (ok ? 0.08 : 0.25));
  } catch { /* no audio: the on-screen line still shows the result */ }
  try { navigator.vibrate?.(ok ? 40 : [80, 60, 80]); } catch { /* not a phone */ }
}

type Detector = { detect: (src: CanvasImageSource) => Promise<{ rawValue: string }[]> };
const detectorCtor = () => (globalThis as unknown as { BarcodeDetector?: new (o?: object) => Detector }).BarcodeDetector;

export function ScanField({ onCode, label = "امسح الباركود", hint, disabled }: { onCode: (code: string) => void; label?: string; hint?: string; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [camera, setCamera] = useState(false);
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!disabled) input.current?.focus(); }, [disabled]);
  const submit = () => { const v = value.trim(); if (v) onCode(v); setValue(""); };
  return (
    <div className="scan-field">
      <label className="field-label" htmlFor="scan-input">{label}</label>
      <div className={`scan-box${focused ? " is-ready" : ""}`}>
        <ScanBarcode aria-hidden="true" />
        <input id="scan-input" ref={input} className="scan-input" inputMode="none" autoComplete="off" spellCheck={false} dir="ltr" disabled={disabled}
          placeholder={focused ? "جاهز: وجّه الماسح إلى الباركود" : "اضغط هنا ثم امسح"} value={value}
          onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
          onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }} />
        {detectorCtor() && <Button size="sm" variant="ghost" icon={<Camera />} onClick={() => setCamera(true)} disabled={disabled}>الكاميرا</Button>}
      </div>
      {hint && <span className="field-hint">{hint}</span>}
      {camera && <CameraScanner onCode={onCode} onClose={() => { setCamera(false); input.current?.focus(); }} />}
    </div>
  );
}

/** Full-screen camera reader. The same code is ignored for 1.5 s so one carton is not counted three times. */
function CameraScanner({ onCode, onClose }: { onCode: (code: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<string | null>(null);
  useEffect(() => {
    const Ctor = detectorCtor();
    if (!Ctor) { setError("متصفحك لا يقرأ الباركود بالكاميرا. استخدم جهاز الباركود أو Chrome على أندرويد."); return; }
    const detector = new Ctor({ formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "itf", "qr_code"] });
    let stream: MediaStream | null = null, timer = 0, stopped = false;
    const seen = new Map<string, number>();
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (stopped) return stream.getTracks().forEach((t) => t.stop());
        video.current!.srcObject = stream;
        await video.current!.play();
        timer = window.setInterval(async () => {
          if (!video.current || video.current.readyState < 2) return;
          try {
            for (const c of await detector.detect(video.current)) {
              const now = Date.now();
              if ((seen.get(c.rawValue) ?? 0) > now - 1500) continue;
              seen.set(c.rawValue, now);
              setLast(c.rawValue);
              onCode(c.rawValue);
            }
          } catch { /* a frame that could not be read */ }
        }, 250);
      } catch { setError("تعذر فتح الكاميرا. اسمح للمتصفح باستخدامها ثم أعد المحاولة."); }
    })();
    return () => { stopped = true; clearInterval(timer); stream?.getTracks().forEach((t) => t.stop()); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="scan-camera" role="dialog" aria-modal="true" aria-label="قراءة الباركود بالكاميرا">
      <video ref={video} playsInline muted className="scan-video" />
      <div className="scan-frame" aria-hidden="true" />
      <div className="scan-camera-bar">
        <span aria-live="polite">{error ?? (last ? <>آخر قراءة: <bdi dir="ltr">{last}</bdi></> : "وجّه الكاميرا إلى الباركود")}</span>
        <IconButton label="إغلاق الكاميرا" icon={<X />} onClick={onClose} />
      </div>
    </div>
  );
}
