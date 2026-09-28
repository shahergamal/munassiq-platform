import { expect, test } from "@playwright/test";
import { AUTH, tenantId } from "./state";

test.use({ storageState: AUTH });
// Whole journeys through the screens, once (desktop), in order: they build on each other's data.
test.describe.configure({ mode: "serial" });
test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "journeys run once"));

const stamp = String(Date.now() % 100000);

test("maintenance: a machine, a breakdown, and its repair", async ({ page }) => {
  await page.goto(`/w/${tenantId()}/manufacturing/machines`);
  await page.getByRole("button", { name: "إضافة آلة" }).first().click();
  let dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "الرمز (مطلوب)" }).fill(`M-${stamp}`);
  await dialog.getByRole("textbox", { name: "الاسم (مطلوب)" }).fill(`خلاط ${stamp}`);
  await dialog.getByRole("button", { name: "حفظ الآلة" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(`M-${stamp}`, { exact: true })).toBeVisible();

  await page.goto(`/w/${tenantId()}/manufacturing/maintenance`);
  await page.getByRole("button", { name: "تسجيل عطل" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox", { name: /الآلة/ }).selectOption({ label: `خلاط ${stamp} (M-${stamp})` });
  await dialog.getByRole("textbox", { name: /العطل/ }).fill("توقف المحرك");
  await dialog.getByRole("button", { name: "فتح أمر الإصلاح" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("إصلاح عطل").first()).toBeVisible();

  await page.getByRole("button", { name: /^إجراءات WO-/ }).first().click();
  await page.getByRole("menuitem", { name: "إنجاز الأمر" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: /ما وُجد وما عُمل/ }).fill("استبدال الفحمات");
  await dialog.getByRole("button", { name: "إنجاز الأمر" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("لا أوامر صيانة مفتوحة")).toBeVisible();
});

test("payroll: an employee, last month's run approved and posted, and the Mudad check", async ({ page }) => {
  await page.goto(`/w/${tenantId()}/hr/employees`);
  await page.getByRole("button", { name: "إضافة موظف" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "الرقم الوظيفي (مطلوب)" }).fill(`P-${stamp}`);
  await dialog.getByRole("textbox", { name: "الاسم (مطلوب)" }).fill(`خالد ${stamp}`);
  await dialog.getByRole("textbox", { name: /رقم الهوية أو الإقامة/ }).fill("1098765432");
  await dialog.getByRole("textbox", { name: "المسمى الوظيفي (مطلوب)" }).fill("فني");
  await dialog.getByLabel(/تاريخ الالتحاق/).fill("2025-01-01");
  await dialog.getByRole("textbox", { name: "الأساسي (مطلوب)" }).fill("6000");
  await dialog.getByRole("textbox", { name: /بدل السكن/ }).fill("1500");
  await dialog.getByRole("button", { name: "حفظ الموظف" }).click();
  await expect(dialog).toBeHidden();

  await page.goto(`/w/${tenantId()}/hr/payroll`);
  await page.getByRole("button", { name: "إعداد المسير" }).click();
  await expect(page).toHaveURL(/\/hr\/payroll\/[0-9a-f-]{36}$/);
  await expect(page.getByText(`خالد ${stamp}`)).toBeVisible();
  await page.getByRole("button", { name: "اعتماد المسير" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "اعتماد وقيد المسير" }).click();
  await expect(page.getByText("معتمد ومقيد").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "حماية الأجور (مُدد)" })).toBeVisible();
  await expect(page.getByText("لا يوجد آيبان").first()).toBeVisible();
});
