// The digital site, pure: safety rates, what a document file really is, and the next revision code.

/**
 * LTIFR = lost-time injuries × 1,000,000 ÷ man-hours; TRIR = recordable cases (medical treatment, lost time,
 * fatality) × 200,000 ÷ man-hours. No man-hours, no rate (null), never a division by zero dressed as 0.
 */
export function safetyRates(p: { manhours: number; lostTime: number; recordable: number }) {
  if (!(p.manhours > 0)) return { ltifr: null, trir: null };
  const round = (v: number) => Math.round(v * 100) / 100;
  return { ltifr: round((p.lostTime * 1_000_000) / p.manhours), trir: round((p.recordable * 200_000) / p.manhours) };
}

export const RECORDABLE = ["medical_treatment", "lost_time", "fatality"] as const;

export type DocMime = "application/pdf" | "image/png" | "image/jpeg" | "image/vnd.dwg";

/** The file's type from its first bytes, not from its name or the browser's word for it. */
export function sniffMime(buf: Uint8Array): DocMime | null {
  const at = (i: number, bytes: number[]) => bytes.every((b, j) => buf[i + j] === b);
  if (at(0, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"; // %PDF-
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (at(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  // AutoCAD: "AC10" followed by two digits (AC1015 … AC1032).
  if (at(0, [0x41, 0x43, 0x31, 0x30]) && buf[4]! >= 0x30 && buf[4]! <= 0x39 && buf[5]! >= 0x30 && buf[5]! <= 0x39) return "image/vnd.dwg";
  return null;
}

/**
 * The revision after the latest: letters before construction (A, B, … Z, AA), numbers once issued for construction
 * (0, 1, 2 …). The first revision is A. A user may type another code; this is the suggestion.
 */
export function nextRevision(latest: string | null): string {
  if (!latest) return "A";
  if (/^\d+$/.test(latest)) return String(Number(latest) + 1);
  if (/^[A-Z]+$/.test(latest)) {
    const chars = latest.split("");
    let i = chars.length - 1;
    while (i >= 0 && chars[i] === "Z") { chars[i] = "A"; i--; }
    if (i < 0) return "A".repeat(chars.length + 1);
    chars[i] = String.fromCharCode(chars[i]!.charCodeAt(0) + 1);
    return chars.join("");
  }
  return latest;
}

/** Days a request has been waiting past the date it was asked for (0 when not late). */
export function daysLate(requiredBy: string | null, today: string) {
  if (!requiredBy || requiredBy >= today) return 0;
  return Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${requiredBy}T00:00:00Z`)) / 86_400_000);
}
