import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CustomerForm } from "../routes/workspace/PosSetup";
import { closeUnder, moduleCoverage, permissionLabels, type CatalogModule } from "../ui/permissions";
import { status } from "../ui/status";

describe("permission catalog helpers", () => {
  const catalog: CatalogModule[] = [{ key: "accounting", label: "الحسابات", pages: [
    { key: "acc_journal", label: "القيود اليومية", actions: [{ key: "view", label: "عرض" }, { key: "create", label: "قيد يدوي", sensitive: true }, { key: "reverse", label: "عكس قيد", sensitive: true }] },
  ] }];
  it("labels each permission as page · action", () => {
    expect(permissionLabels(catalog)["acc_journal.reverse"]).toBe("القيود اليومية · عكس قيد");
  });
  it("an action brings the page it needs, and coverage counts per module", () => {
    const set = closeUnder(["acc_journal.reverse"], { "acc_journal.reverse": ["acc_journal.view"] });
    expect([...set].sort()).toEqual(["acc_journal.reverse", "acc_journal.view"]);
    expect(moduleCoverage(catalog, set)).toEqual([{ key: "accounting", label: "الحسابات", count: 2, total: 3 }]);
  });
});

describe("statuses", () => {
  it("translates document kinds", () => {
    expect(status("docKind", "credit_note")).toEqual({ label: "إشعار دائن", tone: "warning" });
  });
});

describe("customer dialog: business (B2B) data", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows the tax block only for a business customer", () => {
    render(<CustomerForm tenantId="t1" customer={null} onClose={() => undefined} onSaved={() => undefined} />);
    expect(screen.queryByText("البيانات الضريبية للعميل (للفواتير بين المنشآت)")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "منشأة" }));
    expect(screen.getByText("البيانات الضريبية للعميل (للفواتير بين المنشآت)")).toBeTruthy();
  });

  it("checks the VAT number format before sending anything", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<CustomerForm tenantId="t1" customer={null} business onClose={() => undefined} onSaved={() => undefined} />);
    fireEvent.change(screen.getByLabelText(/^الاسم/), { target: { value: "شركة الأمل" } });
    fireEvent.change(screen.getByLabelText(/^الجوال/), { target: { value: "0501234567" } });
    fireEvent.change(screen.getByLabelText(/^الرقم الضريبي/), { target: { value: "123" } });
    fireEvent.click(screen.getByRole("button", { name: "حفظ العميل" }));
    expect(screen.getByText("الرقم الضريبي 15 رقماً يبدأ وينتهي بـ 3")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the business fields, with empty ones as null", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "c1" }), { status: 201, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const onSaved = vi.fn();
    render(<CustomerForm tenantId="t1" customer={null} business onClose={() => undefined} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText(/^الاسم/), { target: { value: "شركة الأمل" } });
    fireEvent.change(screen.getByLabelText(/^الجوال/), { target: { value: "0501234567" } });
    fireEvent.change(screen.getByLabelText(/^الرقم الضريبي/), { target: { value: "300000000000003" } });
    fireEvent.click(screen.getByRole("button", { name: "حفظ العميل" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith("شركة الأمل"));
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body).toMatchObject({ customerType: "business", vatNumber: "300000000000003", street: null, postalCode: null, countryCode: "SA", paymentTermsDays: 0 });
  });
});
