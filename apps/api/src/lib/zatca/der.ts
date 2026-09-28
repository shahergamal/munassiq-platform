/** A minimal DER (ASN.1) encoder: enough to build a PKCS#10 certificate request and read back an X.509 certificate. */

const length = (n: number) => {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};

export const tlv = (tag: number, content: Buffer) => Buffer.concat([Buffer.from([tag]), length(content.length), content]);
export const seq = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items));
export const set = (...items: Buffer[]) => tlv(0x31, Buffer.concat(items));
export const int = (n: number) => tlv(0x02, Buffer.from([n]));
export const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, "utf8"));
export const printable = (s: string) => tlv(0x13, Buffer.from(s, "ascii"));
export const octets = (b: Buffer) => tlv(0x04, b);
export const bits = (b: Buffer) => tlv(0x03, Buffer.concat([Buffer.from([0]), b]));
/** Context-specific constructed tag [n] (explicit / constructed implicit). */
export const ctx = (n: number, content: Buffer) => tlv(0xa0 | n, content);

export function oid(dotted: string) {
  const parts = dotted.split(".").map(Number);
  const out: number[] = [40 * parts[0]! + parts[1]!];
  for (const p of parts.slice(2)) {
    const stack = [p & 0x7f];
    for (let v = p >> 7; v > 0; v >>= 7) stack.unshift((v & 0x7f) | 0x80);
    out.push(...stack);
  }
  return tlv(0x06, Buffer.from(out));
}

/** Reads one TLV at `offset`: its tag, where its content starts, and where it ends. */
export function read(buf: Buffer, offset = 0) {
  const tag = buf[offset]!;
  let len = buf[offset + 1]!;
  let start = offset + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | buf[start + i]!;
    start += n;
  }
  return { tag, start, end: start + len };
}

/** The direct children of a constructed TLV. */
export function children(buf: Buffer, node: { start: number; end: number }) {
  const out: ReturnType<typeof read>[] = [];
  for (let p = node.start; p < node.end; ) { const c = read(buf, p); out.push(c); p = c.end; }
  return out;
}
