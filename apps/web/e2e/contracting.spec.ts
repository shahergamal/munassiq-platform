import { expect, test, type APIRequestContext } from "@playwright/test";
import { AUTH, contractingTenantId, csrf } from "./state";

test.use({ storageState: AUTH });

// The contracting screens (C1-C13) on a fresh contracting workspace: each opens on its title with no error state,
// no script error and no horizontal scroll on a phone; then the site's daily routine through the UI.
const PAGES: [string, string][] = [
  ["/contracting/portfolio", "محفظة المشاريع"], ["/contracting/tenders", "العطاءات والتسعير"], ["/contracting/projects", "المشاريع"],
  ["/contracting/subcontractors", "مقاولو الباطن"], ["/contracting/site", "مواد المواقع والمعدات"], ["/contracting/labor", "العمالة على المشاريع"],
  ["/contracting/telecom-sites", "مواقع الاتصالات"], ["/contracting/daily-reports", "التقارير اليومية للموقع"], ["/contracting/quality", "الجودة في الموقع"],
  ["/contracting/safety", "السلامة والصحة المهنية"], ["/contracting/documents", "ضبط الوثائق"], ["/contracting/handovers", "الاستلام وفترة الضمان"],
  ["/contracting/retention", "أعمار المحتجزات"], ["/contracting/revenue", "الإيراد والأعمال تحت التنفيذ"],
];

for (const [path, title] of PAGES) {
  test(`${title} opens cleanly`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`/w/${contractingTenantId()}${path}`);
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("تعذر تحميل")).toHaveCount(0);
    expect(errors, errors.join("\n")).toEqual([]);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, "no horizontal scroll").toBeLessThanOrEqual(1);
  });
}

/** Seeds through the API as the same session (cookie from the storage state, CSRF from the setup). */
async function seed(request: APIRequestContext, path: string, body: object) {
  const r = await request.post(`/api/v1/t${path}`, { headers: { "x-tenant-id": contractingTenantId(), "x-csrf-token": csrf(), "idempotency-key": crypto.randomUUID(), origin: "http://localhost:5173" }, data: body });
  expect(r.status(), `${path}: ${await r.text()}`).toBeLessThan(300);
  return (await r.json()) as { id: string };
}

test.describe.serial("the site's day", () => {
  let project: string;
  test.beforeAll(async ({ request }) => {
    project = (await seed(request, "/projects", { code: `E${Date.now() % 100_000}`, name: "مشروع الاختبار الآلي", specialty: "BUILDING" })).id;
  });

  test("a daily report is drafted, then submitted and final", async ({ page }) => {
    await page.goto(`/w/${contractingTenantId()}/contracting/daily-reports`);
    await page.getByLabel("المشروع").selectOption(project);
    await page.getByRole("button", { name: /تقرير اليوم/ }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("الأعمال المنفذة").fill("صب قواعد المحور A");
    await dialog.getByLabel("المهنة").first().fill("نجارون");
    await dialog.getByLabel("العدد").first().fill("12");
    await dialog.getByRole("button", { name: "حفظ المسودة" }).click();
    // A table on a desktop, cards on a phone: find the status by its text in the list, and open the report from it.
    const list = page.getByRole("region", { name: "التقارير اليومية" });
    await expect(list.getByText("مسودة", { exact: true })).toBeVisible();
    await list.getByText("مسودة", { exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "تقديم التقرير" }).click();
    await page.getByRole("dialog").last().getByRole("button", { name: "تقديم التقرير" }).click();
    await expect(list.getByText("مقدَّم", { exact: true })).toBeVisible();
  });

  test("an RFI is raised from the quality screen", async ({ page }) => {
    await page.goto(`/w/${contractingTenantId()}/contracting/quality`);
    await page.getByLabel("المشروع").selectOption(project);
    await page.getByRole("button", { name: "الاستفسارات الفنية" }).click();
    await page.getByRole("button", { name: "استفسار فني" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("الموضوع").fill("منسوب بلاطة المدخل");
    await dialog.getByLabel("السؤال").fill("المخطط المعماري والإنشائي مختلفان في المنسوب");
    await dialog.getByRole("button", { name: "تسجيل الاستفسار" }).click();
    await expect(page.getByText("منسوب بلاطة المدخل")).toBeVisible();
  });
});
