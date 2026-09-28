import { expect, test } from "@playwright/test";
import { AUTH, tenantId } from "./state";

test.use({ storageState: AUTH });

// Every screen added in M2-M8 opens on a fresh factory: its title, no error state, no script error, and no
// horizontal scroll on a phone.
const PAGES: [string, string][] = [
  ["/manufacturing/work-centers", "مراكز العمل"], ["/manufacturing/boms", "قوائم المواد"], ["/manufacturing/orders", "أوامر التشغيل"],
  ["/manufacturing/mrp", "تخطيط الاحتياجات"], ["/manufacturing/schedule", "جدولة الإنتاج"],
  ["/manufacturing/quality", "فحوصات الجودة"], ["/manufacturing/qc-plans", "خطط الفحص"], ["/manufacturing/ncrs", "تقارير عدم المطابقة"],
  ["/manufacturing/trace", "تتبع التشغيلات"], ["/manufacturing/maintenance", "أوامر الصيانة"], ["/manufacturing/machines", "الآلات وخطط الصيانة"],
  ["/sales/orders", "عروض الأسعار وأوامر البيع"], ["/accounting/zatca", "الربط مع هيئة الزكاة والضريبة (فاتورة)"],
  ["/hr/employees", "الموظفون"], ["/hr/attendance", "الحضور والعمل الإضافي"], ["/hr/leaves", "الإجازات"], ["/hr/payroll", "مسير الرواتب"],
  ["/reports/production", "الإنتاج والتكاليف"], ["/reports/oee", "كفاءة المعدات (OEE)"], ["/reports/payroll", "الرواتب والتأمينات"],
];

for (const [path, title] of PAGES) {
  test(`${title} opens cleanly`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`/w/${tenantId()}${path}`);
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("تعذر تحميل")).toHaveCount(0);
    expect(errors, errors.join("\n")).toEqual([]);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, "no horizontal scroll").toBeLessThanOrEqual(1);
  });
}
