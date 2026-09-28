import { expect, test } from "@playwright/test";

test("the landing page is Arabic, right to left, and leads to sign-in", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await page.getByRole("link", { name: /تسجيل الدخول/ }).first().click();
  await expect(page).toHaveURL(/\/login/);
});

test("sign-in explains what is missing instead of submitting an empty form", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "تسجيل الدخول" }).click();
  await expect(page.getByText("أدخل بريداً إلكترونياً صحيحاً", { exact: false })).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});

test("a workspace page without a session goes to sign-in and remembers where it was going", async ({ page }) => {
  await page.goto("/w/00000000-0000-0000-0000-000000000000/hr/employees");
  await expect(page).toHaveURL(/\/login\?next=/);
});
