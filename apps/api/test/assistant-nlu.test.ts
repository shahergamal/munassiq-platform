import test from "node:test";
import assert from "node:assert/strict";
import { has, hasFuzzy, normalize, parsePeriod, text } from "../src/lib/assistant/arabic.ts";

const today = "2026-09-28";
const known = (w: string) => ["تحليل", "حلل"].includes(w);

test("stretched letters and Eastern digits normalise", () => {
  assert.equal(normalize("كتييييير"), "كتير");
  assert.equal(normalize("آخر ١٠ أيام"), "اخر 10 ايام");
});

test("dialect words carry their meaning to the intents", () => {
  assert.ok(has(text("الغلة النهاردة كام؟"), "مبيعات"), "الغلة = sales");
  assert.ok(has(text("ايه اللي باظ الاسبوع ده"), "هدر"), "باظ = waste");
  assert.ok(has(text("علينا كام للتجار"), "مستحقات"), "علينا كام = payables");
  assert.ok(has(text("علينا كام للتجار"), "موردين"), "التجار = suppliers");
  assert.ok(has(text("الشيفت بتاع امبارح"), "شفت"));
  assert.ok(has(text("ايه اكتر حاجة بتتباع"), "الاكثر مبيعا"));
  assert.ok(has(text("البضاعة اللي في المخزن"), "مخزون"));
});

test("a one-letter slip still finds the subject, a real word is never bent into another", () => {
  assert.ok(hasFuzzy(text("المبيغات امبارح"), "مبيعات", known));
  assert.ok(hasFuzzy(text("كام رصيد التلاجه"), "الثلاجه", known), "ث/ت written as heard");
  assert.ok(!hasFuzzy(text("تحليل الاداء"), "تحويل", known), "تحليل is analysis, not a transfer");
  assert.ok(!hasFuzzy(text("كم"), "مبيعات", known));
});

test("more ways to name a period", () => {
  assert.deepEqual(parsePeriod(text("المبيعات من 1 لـ 15"), today), { from: "2026-09-01", to: "2026-09-15", label: "من 1 إلى 15 هذا الشهر" });
  assert.deepEqual(parsePeriod(text("من اول الشهر"), today), { from: "2026-09-01", to: today, label: "هذا الشهر" });
  assert.deepEqual(parsePeriod(text("اخر اسبوع"), today), { from: "2026-09-22", to: today, label: "آخر 7 أيام" });
  assert.equal(parsePeriod(text("اخر عشرين يوم"), today)?.from, "2026-09-09");
  assert.equal(parsePeriod(text("الاسبوع اللي فات"), today)?.label, "الأسبوع الماضي", "the old phrasing still wins");
});
