import { expect, test } from "@playwright/test";
import { AUTH, tenantId } from "./state";

test.use({ storageState: AUTH });

test("the factory workspace shows its sectors' menus and no horizontal scroll", async ({ page }) => {
  await page.goto(`/w/${tenantId()}`);
  // On a phone the menu is collapsed: the entry exists, it is not shown until opened.
  await expect(page.getByText("التصنيع").first()).toBeAttached();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("an employee is added with sealed pay and appears in the list", async ({ page }) => {
  await page.goto(`/w/${tenantId()}/hr/employees`);
  await expect(page.getByRole("heading", { name: "الموظفون" })).toBeVisible();
  await page.getByRole("button", { name: "إضافة موظف" }).first().click();
  const dialog = page.getByRole("dialog");
  const code = `E-${Date.now() % 100000}`;
  await dialog.getByLabel("الرقم الوظيفي").fill(code);
  await dialog.getByRole("textbox", { name: "الاسم (مطلوب)" }).fill("سارة الاختبار");
  await dialog.getByLabel("رقم الهوية أو الإقامة").fill("1012345678");
  await dialog.getByLabel("المسمى الوظيفي").fill("مشرفة جودة");
  await dialog.getByRole("textbox", { name: "الأساسي (مطلوب)" }).fill("7000");
  await dialog.getByLabel("بدل السكن").fill("1750");
  await dialog.getByRole("button", { name: "حفظ الموظف" }).click();
  await expect(dialog).toBeHidden();
  // A table on desktop, cards on a phone: the new employee number shows in both.
  await expect(page.getByText(code, { exact: true })).toBeVisible();
});

test("reports open with their empty states", async ({ page }) => {
  await page.goto(`/w/${tenantId()}/reports/production`);
  await expect(page.getByText("لا إنتاج في هذه الفترة")).toBeVisible();
  await page.goto(`/w/${tenantId()}/reports/oee`);
  await expect(page.getByRole("heading", { name: "كفاءة المعدات (OEE)" })).toBeVisible();
});
