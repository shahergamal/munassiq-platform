import test from "node:test";
import assert from "node:assert/strict";
import { fmt, has, normalize, parsePeriod, table, text } from "../src/lib/assistant/arabic.ts";

const TODAY = "2026-09-25"; // a Friday

test("normalises spelling variants, diacritics and Eastern digits", () => {
  assert.equal(normalize("أمْرُ الشّراءِ رقم ١٢"), "امر الشراء رقم 12");
  assert.equal(normalize("الكمية المتبقّية؟"), "الكميه المتبقيه");
  assert.equal(normalize("مستشفى"), "مستشفي");
});

test("keywords match through the article, conjunctions and plural endings", () => {
  const t = text("والمبيعات بتاعة الموردين");
  assert.ok(has(t, "مبيعات"));
  assert.ok(has(t, "مورد"));
  assert.ok(has(text("كم رصيد مورد الخضار"), "رصيد مورد"));
  assert.ok(has(text("أوامر الشراء"), "اوامر الشراء"));
  assert.ok(!has(text("المواد الخام"), "مورد"));
});

test("periods in standard Arabic, Gulf and Egyptian phrasing", () => {
  const p = (s: string) => parsePeriod(text(s), TODAY);
  assert.deepEqual(p("مبيعات اليوم"), { from: TODAY, to: TODAY, label: "اليوم" });
  assert.equal(p("مبيعات النهارده")?.from, TODAY);
  assert.equal(p("امبارح")?.from, "2026-09-24");
  assert.deepEqual([p("الشهر اللي فات")?.from, p("الشهر اللي فات")?.to], ["2026-08-01", "2026-08-31"]);
  assert.deepEqual([p("هذا الشهر")?.from, p("هذا الشهر")?.to], ["2026-09-01", TODAY]);
  assert.equal(p("آخر ٧ أيام")?.from, "2026-09-19");
  assert.equal(p("خلال آخر 3 شهور")?.from, "2026-06-28");
  assert.deepEqual([p("الأسبوع الماضي")?.from, p("الأسبوع الماضي")?.to], ["2026-09-13", "2026-09-19"]);
  assert.deepEqual([p("من 2026-09-01 إلى 2026-09-10")?.from, p("من 2026-09-01 إلى 2026-09-10")?.to], ["2026-09-01", "2026-09-10"]);
  assert.deepEqual([p("مبيعات شهر أغسطس")?.from, p("مبيعات شهر أغسطس")?.to], ["2026-08-01", "2026-08-31"]);
  assert.equal(p("مبيعات ديسمبر")?.from, "2025-12-01", "a month still ahead means last year's");
  assert.equal(p("كم رصيد الطماطم"), null);
});

test("formats quantities in kilos and litres, money with the riyal and Latin digits", () => {
  assert.equal(fmt.qty(4500, "جرام"), "4.5 كجم");
  assert.equal(fmt.qty(250, "جرام"), "250 جرام");
  assert.equal(fmt.qty(1500, "مل"), "1.5 لتر");
  assert.equal(fmt.money(1234.5), "\u2066\u20C1\u00A01,234.50\u2069", "the riyal sign, LTR-isolated, as the UI writes it");
  assert.equal(fmt.unitCost(0.008, "جرام"), "\u2066\u20C1\u00A08.00\u2069/كجم");
  assert.ok(!table(["أ"], [["x|y"]]).includes("x|y"), "cell pipes cannot break the table");
});
