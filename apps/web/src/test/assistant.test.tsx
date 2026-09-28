import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { takeEvents } from "../app/Assistant";
import { Markdown, parseBlocks } from "../lib/markdown";

describe("assistant stream parsing", () => {
  it("returns complete events and keeps a split event for the next chunk", () => {
    const a = takeEvents('data: {"type":"text","delta":"مرح"}\n\ndata: {"type":"te');
    expect(a.events).toEqual([{ type: "text", delta: "مرح" }]);
    const b = takeEvents(`${a.rest}xt","delta":"باً"}\n\ndata: {"type":"done","conversationId":"c1","title":"t"}\n\n`);
    expect(b.events.map((e) => e.type)).toEqual(["text", "done"]);
    expect(b.rest).toBe("");
  });
  it("skips a malformed event instead of breaking the stream", () => {
    expect(takeEvents('data: {oops\n\ndata: {"type":"text","delta":"x"}\n\n').events).toEqual([{ type: "text", delta: "x" }]);
  });
});

describe("assistant markdown", () => {
  it("parses headings, lists and tables", () => {
    const b = parseBlocks("## المخزون\n- طماطم\n- بصل\n\n| المادة | الرصيد |\n|---|---|\n| طماطم | 5 |\n\n1. أولاً\n2. ثانياً");
    expect(b.map((x) => x.kind)).toEqual(["h", "ul", "table", "ol"]);
    expect(b[2]).toEqual({ kind: "table", head: ["المادة", "الرصيد"], rows: [["طماطم", "5"]] });
  });
  it("renders text, never HTML, so a reply cannot inject markup", () => {
    const { container } = render(<Markdown text={'**مهم** <img src=x onerror="alert(1)"> `x`'} />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("مهم").tagName).toBe("STRONG");
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
  });
});
