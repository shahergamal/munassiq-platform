import { createHmac } from "node:crypto";
import { expect, test } from "@playwright/test";
import { AUTH } from "./state";

test.use({ storageState: AUTH });
// Turning two-step sign-in on and off changes the shared test user: one browser, in order.
test.describe.configure({ mode: "serial" });

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function totp(secret: string) {
  let bits = 0, value = 0; const bytes: number[] = [];
  for (const ch of secret.replace(/\s+/g, "")) { value = (value << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const mac = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const o = mac[mac.length - 1]! & 0xf;
  return String((((mac[o]! & 0x7f) << 24) | (mac[o + 1]! << 16) | (mac[o + 2]! << 8) | mac[o + 3]!) % 1_000_000).padStart(6, "0");
}

test("two-step sign-in is turned on from the account page and shows recovery codes once", async ({ page, browserName }, info) => {
  test.skip(info.project.name !== "desktop", "one run is enough: it changes the account");
  void browserName;
  await page.goto("/account");
  await page.getByRole("button", { name: "تفعيل التحقق بخطوتين" }).click();
  const secret = (await page.locator("code").innerText()).replace(/\s+/g, "");
  await page.getByLabel("الرمز من التطبيق").fill(totp(secret));
  await page.getByRole("button", { name: "تفعيل", exact: true }).click();
  await expect(page.getByText("احفظ رموز الاسترداد الآن")).toBeVisible();
  await expect(page.locator(".mfa-codes li")).toHaveCount(10);
  await page.getByRole("button", { name: "حفظتها" }).click();
  await expect(page.getByText("مفعّل")).toBeVisible();
});
