import { Fragment, type ReactNode } from "react";

/**
 * The small Markdown subset the assistant writes: headings, paragraphs, bullet and numbered lists,
 * tables, **bold** and `code`. Rendered to React elements, never to HTML, so a reply can't inject markup.
 */
export function Markdown({ text }: { text: string }) {
  return <>{blocks(text)}</>;
}

type Block =
  | { kind: "h"; level: number; text: string }
  | { kind: "p"; text: string }
  | { kind: "ul" | "ol"; items: string[] }
  | { kind: "table"; head: string[]; rows: string[][] };

const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
const isRule = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

export function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let para: string[] = [];
  const flush = () => { if (para.length) out.push({ kind: "p", text: para.join("\n") }); para = []; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (!line.trim()) { flush(); continue; }
    if (h) { flush(); out.push({ kind: "h", level: h[1]!.length, text: h[2]! }); continue; }
    if (line.trim().startsWith("|") && i + 1 < lines.length && isRule(lines[i + 1]!)) {
      flush();
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.trim().startsWith("|")) rows.push(cells(lines[i++]!));
      i--;
      out.push({ kind: "table", head, rows });
      continue;
    }
    const li = /^\s*(?:([-*•])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (li) {
      flush();
      const kind = li[1] ? "ul" : "ol";
      const prev = out[out.length - 1];
      if (prev && prev.kind === kind) prev.items.push(li[3]!);
      else out.push({ kind, items: [li[3]!] });
      continue;
    }
    const prev = out[out.length - 1];
    // A wrapped line right after a list item continues it.
    if (!para.length && prev && (prev.kind === "ul" || prev.kind === "ol") && /^\s{2,}/.test(line)) { prev.items[prev.items.length - 1] += ` ${line.trim()}`; continue; }
    para.push(line);
  }
  flush();
  return out;
}

function blocks(text: string): ReactNode[] {
  return parseBlocks(text).map((b, i) => {
    switch (b.kind) {
      case "h": return b.level <= 2 ? <h3 key={i}>{inline(b.text)}</h3> : <h4 key={i}>{inline(b.text)}</h4>;
      case "p": return <p key={i}>{b.text.split("\n").map((l, j) => <Fragment key={j}>{j > 0 && <br />}{inline(l)}</Fragment>)}</p>;
      case "ul": return <ul key={i}>{b.items.map((t, j) => <li key={j}>{inline(t)}</li>)}</ul>;
      case "ol": return <ol key={i}>{b.items.map((t, j) => <li key={j}>{inline(t)}</li>)}</ol>;
      case "table": return (
        <div key={i} className="md-table" tabIndex={0}>
          <table>
            <thead><tr>{b.head.map((c, j) => <th key={j} scope="col">{inline(c)}</th>)}</tr></thead>
            <tbody>{b.rows.map((r, j) => <tr key={j}>{b.head.map((_, k) => <td key={k}>{inline(r[k] ?? "")}</td>)}</tr>)}</tbody>
          </table>
        </div>
      );
    }
  });
}

export function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(m[1] !== undefined ? <strong key={m.index}>{m[1]}</strong> : <code key={m.index}>{m[2]}</code>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
