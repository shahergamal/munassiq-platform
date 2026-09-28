import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { meKey } from "../app/session";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useIdempotencyKey } from "../app/session";
import { cost, day, integer, money, percent, quantity } from "../lib/format";
import { safeNext } from "../routes/auth/AuthPages";
import { DataTable } from "../ui/DataTable";
import { ConfirmDialog } from "../ui/Dialog";
import { TextField } from "../ui/Field";
import { status } from "../ui/status";

describe("safeNext (open-redirect guard)", () => {
  it.each([["/w/abc/pos", "/w/abc/pos"], ["//evil.com", "/app"], ["/\\evil.com", "/app"], ["https://evil.com", "/app"], [undefined, "/app"], ["/a\\b", "/app"]])("%s → %s", (input, out) => {
    expect(safeNext(input)).toBe(out);
  });
});

describe("status dictionary", () => {
  it("translates enums by key, never shows raw English", () => {
    expect(status("purchase", "received")).toEqual({ label: "مستلم", tone: "success" });
    expect(status("active", false).label).toBe("موقوف");
    expect(status("order", null).label).toBe("—");
  });
});

describe("formatters", () => {
  it("formats SAR with the riyal sign, Latin digits and two decimals, and shows — for missing values", () => {
    // Left-to-right isolate keeps the sign on the left of the amount inside Arabic text.
    expect(money(1234.5)).toBe("⁦⃁ 1,234.50⁩");
    expect(money(-3)).toBe("⁦⃁ -3.00⁩");
    expect(money(null)).toBe("—");
    expect(money(12.5)).not.toMatch(/ر\.س|[٠-٩]/);
  });

  it("uses Latin digits everywhere: two decimals for quantities and percentages, up to four for unit costs", () => {
    expect(quantity(2.5)).toBe("2.50");
    expect(quantity(0.125)).toBe("0.125");
    expect(percent(15)).toBe("⁦15.00%⁩");
    expect(cost(0.0115)).toBe("⁦⃁ 0.0115⁩");
    expect(integer(1500)).toBe("1,500");
    expect(day("2026-09-24")).toMatch(/2026/);
  });
});

describe("useIdempotencyKey", () => {
  it("keeps the same key across re-renders (retries) and changes only when renewed", () => {
    const { result, rerender } = renderHook(() => useIdempotencyKey());
    const first = result.current[0];
    rerender();
    expect(result.current[0]).toBe(first);
    act(() => result.current[1]());
    expect(result.current[0]).not.toBe(first);
  });
});

describe("ConfirmDialog", () => {
  it("names the action on the confirm button and focuses Cancel first", () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog open onClose={() => undefined} onConfirm={onConfirm} title="حذف مورد" message="سيُحذف المورد «الأمل»" confirmLabel="حذف المورد نهائياً" />);
    expect(document.activeElement?.textContent).toBe("إلغاء");
    fireEvent.click(screen.getByRole("button", { name: "حذف المورد نهائياً" }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});

/** Tables read the signed-in user to keep each person's layout apart. */
function withUser(userId: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(meKey, { user: { id: userId }, tenants: [], csrfToken: "x" });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("DataTable states", () => {
  const cols = [{ key: "n", header: "الاسم", cell: (r: { id: string }) => r.id }];
  const base = { isPending: false, isError: false, error: null, refetch: vi.fn() };

  it("first use vs filtered empty are different", () => {
    const { rerender } = render(<DataTable caption="c" columns={cols} rowKey={(r) => r.id} query={{ ...base, data: { items: [] } }} empty={{ title: "لا يوجد موردون بعد" }} />, { wrapper: withUser("u1") });
    expect(screen.getByText("لا يوجد موردون بعد")).toBeTruthy();
    rerender(<DataTable caption="c" columns={cols} rowKey={(r) => r.id} query={{ ...base, data: { items: [] } }} empty={{ title: "لا يوجد موردون بعد" }} filtered onClearFilters={() => undefined} />);
    expect(screen.getByText("لا توجد نتائج مطابقة")).toBeTruthy();
    expect(screen.getByRole("button", { name: "مسح البحث والفلاتر" })).toBeTruthy();
  });

  it("errors offer a retry and never a blank table", () => {
    const refetch = vi.fn();
    render(<DataTable caption="c" columns={cols} rowKey={(r) => r.id} query={{ ...base, isError: true, error: new Error("x"), refetch }} empty={{ title: "e" }} />, { wrapper: withUser("u1") });
    fireEvent.click(screen.getByRole("button", { name: "إعادة المحاولة" }));
    expect(refetch).toHaveBeenCalledOnce();
  });
});

describe("TextField", () => {
  it("links the error to the input and hides it once the user edits, until the next submit", () => {
    render(<form data-testid="f" onSubmit={(e) => e.preventDefault()}><TextField label="الاسم" error="أدخل الاسم" value="" onChange={() => undefined} /></form>);
    const input = screen.getByLabelText("الاسم");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toContain(screen.getByRole("alert").id);
    fireEvent.change(input, { target: { value: "س" } });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.submit(screen.getByTestId("f"));
    expect(screen.getByRole("alert").textContent).toBe("أدخل الاسم");
  });
});

describe("DataTable sort and columns", () => {
  type Row = { id: string; name: string; total: number; city: string | null; note: string };
  const rows: Row[] = [
    { id: "1", name: "ب", total: 10, city: "جدة", note: "x" },
    { id: "2", name: "أ", total: 30, city: null, note: "y" },
    { id: "3", name: "ج", total: 10, city: "الرياض", note: "z" },
  ];
  const cols = [
    { key: "name", header: "الاسم", cell: (r: Row) => r.name },
    { key: "total", header: "الإجمالي", numeric: true, cell: (r: Row) => String(r.total) },
    { key: "city", header: "المدينة", cell: (r: Row) => r.city ?? "—" },
    { key: "note", header: "ملاحظة", cell: (r: Row) => r.note },
  ];
  const query = { isPending: false, isError: false, error: null, refetch: vi.fn(), data: { items: rows } };
  const names = () => screen.getAllByRole("row").slice(1).map((tr) => within(tr).getAllByRole("cell")[0]!.textContent);
  const table = (user = "u1") => render(<DataTable caption="مدن" columns={cols} rowKey={(r) => r.id} query={query} empty={{ title: "e" }} />, { wrapper: withUser(user) });
  beforeEach(() => localStorage.clear());

  it("sorts by one column on click, and adds a second level with Shift+click", () => {
    table();
    fireEvent.click(screen.getByRole("button", { name: /^الإجمالي/ }));
    expect(names()).toEqual(["أ", "ب", "ج"]); // numbers start with the largest
    fireEvent.click(screen.getByRole("button", { name: /^المدينة/ }), { shiftKey: true });
    expect(names()).toEqual(["أ", "ج", "ب"]); // equal totals, then الرياض before جدة
    expect(screen.getByRole("columnheader", { name: /الإجمالي/ }).getAttribute("aria-sort")).toBe("descending");
  });

  it("keeps empty values last in both directions", () => {
    table();
    const city = () => screen.getByRole("button", { name: /^المدينة/ });
    fireEvent.click(city());
    expect(names()[2]).toBe("أ");
    fireEvent.click(city());
    expect(names()[2]).toBe("أ");
  });

  it("hides columns per user, never the first one, and remembers it", () => {
    const { unmount } = table("u1");
    fireEvent.click(screen.getByRole("button", { name: /الأعمدة/ }));
    const dialog = screen.getByRole("dialog", { name: "الأعمدة الظاهرة" });
    expect((within(dialog).getByRole("checkbox", { name: /الاسم/ }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "ملاحظة" }));
    expect(screen.queryByRole("columnheader", { name: "ملاحظة" })).toBeNull();
    unmount();
    const again = table("u1");
    expect(screen.queryByRole("columnheader", { name: "ملاحظة" })).toBeNull();
    again.unmount();
    table("u2");
    expect(screen.getByRole("columnheader", { name: "ملاحظة" })).toBeTruthy();
  });

  it("puts the sort and column buttons in the filter bar, or in the header row when there is none — never on a row of their own", () => {
    const { container, unmount } = render(<DataTable caption="مع شريط" columns={cols} rowKey={(r) => r.id} query={query} empty={{ title: "e" }} toolbar={<input aria-label="بحث" />} />, { wrapper: withUser("u1") });
    const bar = container.querySelector(".toolbar")!;
    expect(within(bar as HTMLElement).getByLabelText("بحث")).toBeTruthy();
    expect(within(bar as HTMLElement).getByRole("button", { name: /الأعمدة/ })).toBeTruthy();
    expect(container.querySelectorAll(".toolbar")).toHaveLength(1);
    unmount();
    const bare = render(<DataTable caption="بلا شريط" columns={cols} rowKey={(r) => r.id} query={query} empty={{ title: "e" }} />, { wrapper: withUser("u1") });
    expect(bare.container.querySelector(".toolbar")).toBeNull();
    const head = bare.container.querySelector("thead")!;
    expect(within(head as HTMLElement).getByRole("button", { name: "الأعمدة الظاهرة" })).toBeTruthy();
    expect(within(head as HTMLElement).getByRole("button", { name: "ترتيب الجدول" })).toBeTruthy();
  });

  it("builds up to three sort levels from the sort panel", () => {
    table();
    fireEvent.click(screen.getByRole("button", { name: /^ترتيب/ }));
    const panel = screen.getByRole("dialog", { name: "ترتيب الجدول" });
    fireEvent.click(within(panel).getByRole("button", { name: /ترتيب حسب عمود/ }));
    fireEvent.click(within(panel).getByRole("button", { name: /إضافة مستوى/ }));
    fireEvent.click(within(panel).getByRole("button", { name: /إضافة مستوى/ }));
    expect(within(panel).getAllByRole("combobox")).toHaveLength(3);
    expect(within(panel).queryByRole("button", { name: /إضافة مستوى/ })).toBeNull();
    fireEvent.click(within(panel).getByRole("button", { name: "مسح الترتيب" }));
    expect(within(panel).queryAllByRole("combobox")).toHaveLength(0);
  });
});

describe("table layout follows the user across devices", () => {
  type Row = { id: string; name: string; total: number; city: string; note: string };
  const cols = ["name", "total", "city", "note"].map((k) => ({ key: k, header: k, cell: (r: Row) => String(r[k as keyof Row]) }));
  const query = { isPending: false, isError: false, error: null, refetch: vi.fn(), data: { items: [{ id: "1", name: "a", total: 1, city: "c", note: "n" }] } };
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  it("applies the layout saved on the server, and saves changes back to it", async () => {
    localStorage.clear();
    const calls: { method: string; url: string; body?: string }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", url: String(url), body: init?.body as string | undefined });
      return String(url).includes("/auth/prefs") && (init?.method ?? "GET") === "GET"
        ? ok({ items: { "table.جهاز": { sort: [], hidden: ["note"] } } })
        : ok({ ok: true });
    }));
    try {
      render(<DataTable caption="جهاز" columns={cols} rowKey={(r) => r.id} query={query} empty={{ title: "e" }} />, { wrapper: withUser("u9") });
      await waitFor(() => expect(screen.queryByRole("columnheader", { name: "note" })).toBeNull());
      fireEvent.click(screen.getByRole("button", { name: "الأعمدة الظاهرة" }));
      fireEvent.click(within(screen.getByRole("dialog", { name: "الأعمدة الظاهرة" })).getByRole("checkbox", { name: "city" }));
      await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true), { timeout: 2000 });
      const put = calls.find((c) => c.method === "PUT")!;
      expect(decodeURIComponent(put.url)).toContain("/auth/prefs/table.جهاز");
      expect(JSON.parse(put.body!)).toEqual({ sort: [], hidden: ["note", "city"] });
    } finally { vi.unstubAllGlobals(); }
  });
});
