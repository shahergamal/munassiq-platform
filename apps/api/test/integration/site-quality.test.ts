import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { addMember, call, createUser, expectStatus, ownerPool, raiseLimits, startApp, stopApp, type Actor, type App } from "./helpers.ts";

function multipart(content: Buffer, filename: string) {
  const boundary = `----munassiq${randomUUID()}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`), content, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  return { payload, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}
const pdf = (text: string) => Buffer.from(`%PDF-1.4\n% ${text}\n%%EOF\n`);

// Contracting C10: inspections with the consultant's result and the NCR they raise, RFIs that lead to a claim,
// incidents and permits with the safety rates on the daily reports' man-hours, and document control.
describe("contracting: the digital site", () => {
  let app: App;
  let owner: Actor;
  let t: string;
  let p: string;
  let other: string;
  let sub: string;
  const day = (back: number) => { const d = new Date(Date.now() + 3 * 3_600_000); d.setUTCDate(d.getUTCDate() - back); return d.toISOString().slice(0, 10); };

  const post = async (url: string, body: object = {}, status = 201) => { const r = await call(app, owner, "POST", url, { tenant: t, idem: true, body }); expectStatus(r, status, url); return r.body; };
  const put = async (url: string, body: object, status = 200) => { const r = await call(app, owner, "PUT", url, { tenant: t, body }); expectStatus(r, status, url); return r.body; };
  const get = async (url: string) => { const r = await call(app, owner, "GET", url, { tenant: t }); expectStatus(r, 200, url); return r.body; };
  const code = async (method: string, url: string, body: object = {}) => (await call(app, owner, method, url, { tenant: t, idem: true, body })).body.error?.code;

  before(async () => {
    app = await startApp();
    owner = await createUser();
    const r = await call(app, owner, "POST", "/tenants", { body: { companyName: "مقاولات الموقع الرقمي", sector: "contracting", taxId: `3${randomInt(10_000_000, 99_999_999)}${randomInt(100_000, 999_999)}`, city: "الرياض" } });
    expectStatus(r, 201, "tenant");
    t = r.body.id;
    await raiseLimits(t);
    p = (await post("/t/projects", { code: `Q${randomInt(1000, 9999)}`, name: "مجمع سكني", specialty: "BUILDING" })).id;
    other = (await post("/t/projects", { code: `O${randomInt(1000, 9999)}`, name: "مشروع آخر", specialty: "BUILDING" })).id;
    sub = (await post("/t/suppliers", { code: `SB${randomInt(100, 999)}`, name: "مؤسسة الخرسانة", phone: "0501112233" })).id;
  });
  after(() => stopApp(app));

  it("an inspection rejected by the consultant raises an NCR; the re-inspection passes; the NCR closes with its corrective action", async () => {
    const itp = (await post(`/t/projects/${p}/itp`, { activity: "صب الخرسانة للأسقف", point: "H", reference: "SBC 304", criteria: "الهبوط 75–100 مم" })).id;
    const wir = await post("/t/inspections", { projectId: p, kind: "WIR", itpItemId: itp, location: "الدور الثاني", description: "فحص حديد التسليح قبل الصب", requestedFor: day(2) });
    assert.equal(await code("POST", "/t/inspections", { projectId: p, kind: "MIR", description: "توريد بلوك", requestedFor: day(0) }), "validation_failed", "an MIR needs the material");
    assert.equal(await code("POST", `/t/inspections/${wir.id}/result`, { status: "rejected", inspectedOn: day(1) }), "validation_failed", "a rejection says why");
    const res = await post(`/t/inspections/${wir.id}/result`, { status: "rejected", inspector: "م. خالد", inspectedOn: day(1), comments: "غطاء خرساني ناقص في الكمرات", raiseNcr: { severity: "major", supplierId: sub } }, 200);
    assert.ok(res.ncrId);
    assert.equal(await code("POST", `/t/inspections/${wir.id}/result`, { status: "approved", inspectedOn: day(1) }), "invalid_state", "one result per request");
    const again = await post("/t/inspections", { projectId: p, kind: "WIR", itpItemId: itp, description: "إعادة فحص التسليح", requestedFor: day(0), reinspectionOf: wir.id });
    await post(`/t/inspections/${again.id}/result`, { status: "approved", inspectedOn: day(0) }, 200);
    const s = await get(`/t/projects/${p}/quality-summary`);
    assert.deepEqual([s.firstPassRate, s.openNcrs, s.majorNcrs, s.pendingInspections], [0, 1, 1, 0], "the re-inspection does not count as a first pass");
    assert.equal(await code("POST", `/t/site-ncrs/${res.ncrId}/close`), "validation_failed", "no disposition yet");
    await put(`/t/site-ncrs/${res.ncrId}`, { disposition: "rework", rootCause: "عدم تثبيت البسكويت", correctiveAction: "تدريب الحدادين وفحص قبل الطلب", costEstimate: 4_500, supplierId: sub });
    await post(`/t/site-ncrs/${res.ncrId}/close`, {}, 200);
    const ncr = (await get(`/t/site-ncrs?projectId=${p}`)).items[0];
    assert.deepEqual([ncr.status, ncr.supplier, ncr.inspection], ["closed", "مؤسسة الخرسانة", `WIR-${wir.number}`]);
    const items = (await get(`/t/projects/${p}/itp`)).items;
    assert.equal(items[0].passed, 1);
  });

  it("an RFI is answered and, when it changes cost or time, linked to a claim of the same project only", async () => {
    const cust = (await post("/t/customers", { name: "المالك", phone: `05${randomInt(10_000_000, 99_999_999)}`, customerType: "business" })).id;
    const contract = (await post("/t/contracts", { projectId: p, number: `C-${randomInt(1000, 9999)}`, title: "العقد", customerId: cust, profile: "CUSTOM", pricingModel: "LUMP_SUM",
      governingRegime: "PRIVATE", value: 1_000_000 })).id;
    const claim = (await post(`/t/contracts/${contract}/claims`, { title: "تعديل تفاصيل الواجهة", kind: "time_cost", eventDate: day(1), description: "رد الاستشاري غيّر تفاصيل الواجهة" })).id;
    const rfi = (await post("/t/rfis", { projectId: p, subject: "تفصيلة الواجهة الحجرية", question: "المخطط لا يبين طريقة التثبيت للحجر", discipline: "architectural", requiredBy: day(3) })).id;
    const listed = (await get(`/t/rfis?projectId=${p}`)).items[0];
    assert.equal(listed.daysLate, 3);
    assert.equal(await code("POST", `/t/rfis/${rfi}/link`, { claimId: claim }), "invalid_state", "not answered yet");
    await post(`/t/rfis/${rfi}/answer`, { answer: "تثبيت ميكانيكي بزوايا ستانلس", answeredOn: day(0), impact: "cost_time" }, 200);
    const otherContract = (await post("/t/contracts", { projectId: other, number: `C-${randomInt(1000, 9999)}`, title: "آخر", customerId: cust, profile: "CUSTOM", pricingModel: "LUMP_SUM",
      governingRegime: "PRIVATE", value: 1_000 })).id;
    const foreign = (await post(`/t/contracts/${otherContract}/claims`, { title: "مطالبة أخرى", kind: "cost", eventDate: day(1), description: "لا علاقة لها بالمشروع" })).id;
    assert.equal(await code("POST", `/t/rfis/${rfi}/link`, { claimId: foreign }), "validation_failed");
    await post(`/t/rfis/${rfi}/link`, { claimId: claim }, 200);
    await post(`/t/rfis/${rfi}/close`, {}, 200);
    const done = (await get(`/t/rfis?projectId=${p}`)).items[0];
    assert.deepEqual([done.status, done.claimNumber, done.daysLate], ["closed", 1, 0]);
  });

  it("daily reports give the man-hours; incidents and permits give the safety rates; a submitted report is final", async () => {
    const report = { weather: "hot", temperature: 44, workDone: "صب سقف الدور الثاني", issues: null,
      manpower: [{ trade: "نجارون", headcount: 40, hours: 10 }, { trade: "حدادون", supplierId: sub, headcount: 60, hours: 10 }],
      equipment: [{ description: "مضخة خرسانة", workingHours: 8, idleHours: 2 }] };
    const r1 = (await put(`/t/projects/${p}/daily-reports/${day(1)}`, report)).id;
    await put(`/t/projects/${p}/daily-reports/${day(1)}`, { ...report, equipment: [{ description: "رافعة", workingHours: 20, idleHours: 6 }] }, 422);
    await put(`/t/projects/${p}/daily-reports/${day(-1)}`, report, 422);
    const draft = (await put(`/t/projects/${p}/daily-reports/${day(0)}`, { ...report, workDone: null })).id;
    assert.equal(await code("POST", `/t/daily-reports/${draft}/submit`), "validation_failed", "no work recorded");
    await post(`/t/daily-reports/${r1}/submit`, {}, 200);
    assert.equal(await code("PUT", `/t/projects/${p}/daily-reports/${day(1)}`, report), "daily_report_final");
    await assert.rejects(ownerPool.query("UPDATE daily_report_manpower SET headcount = 1 WHERE report_id = $1", [r1]), /daily_report_final/);
    const one = (await get(`/t/projects/${p}/daily-reports/${day(1)}`)).report;
    assert.deepEqual([one.status, one.manpower.length, one.equipment[0].workingHours], ["submitted", 2, 8]);

    await post("/t/hse/incidents", { projectId: p, occurredAt: `${day(1)}T09:30:00+03:00`, kind: "lost_time", description: "سقوط أداة على قدم عامل", lostDays: 3 });
    await post("/t/hse/incidents", { projectId: p, occurredAt: `${day(1)}T11:00:00+03:00`, kind: "near_miss", description: "سقوط لوح من السقالة دون إصابة" });
    assert.equal(await code("POST", "/t/hse/incidents", { projectId: p, occurredAt: `${day(1)}T11:00:00+03:00`, kind: "first_aid", description: "جرح بسيط في اليد", lostDays: 2 }), "validation_failed");
    const permit = await post("/t/work-permits", { projectId: p, kind: "hot_work", location: "السطح", description: "لحام الحديد", precautions: "طفاية ومراقب حريق",
      validFrom: new Date(Date.now() - 3_600_000).toISOString(), validTo: new Date(Date.now() + 8 * 3_600_000).toISOString() });
    assert.equal(await code("POST", "/t/work-permits", { projectId: p, kind: "hot_work", location: "السطح", description: "لحام",
      validFrom: new Date().toISOString(), validTo: new Date(Date.now() + 3_600_000).toISOString() }), "validation_failed", "hot work needs its precautions");
    const s = await get(`/t/hse/summary?projectId=${p}&from=${day(30)}&to=${day(0)}`);
    assert.equal(s.manhours, 1_000, "only the submitted report counts");
    assert.deepEqual([s.lostTime, s.recordable, s.lostDays, s.ltifr, s.trir, s.activePermits], [1, 1, 3, 1000, 200, 1]);
    assert.equal(s.daysSinceLastLti, 1);
    await post(`/t/work-permits/${permit.id}/close`, {}, 200);
    assert.equal(await code("POST", `/t/work-permits/${permit.id}/close`), "invalid_state");
  });

  it("documents: revisions are files kept as uploaded; the consultant reviews once; only approved submittals go for construction", async () => {
    const doc = (await post(`/t/projects/${p}/documents`, { number: "SD-STR-001", title: "تفاصيل تسليح الأسقف", docType: "shop_drawing", discipline: "structural" })).id;
    const up = async (content: Buffer, name: string, query = "") => { const m = multipart(content, name); return call(app, owner, "POST", `/t/documents/${doc}/revisions${query}`, { tenant: t, body: m.payload, headers: m.headers }); };
    const exe = await up(Buffer.from("MZ\x90\0this is a program"), "drawing.pdf");
    assert.equal(exe.status, 422, "the type is read from the bytes, not the name");
    const a = await up(pdf("rev A"), "slab.pdf");
    expectStatus(a, 201, "rev A");
    assert.equal(a.body.revision, "A");
    const b = await up(pdf("rev B"), "slab-b");
    assert.equal(b.body.revision, "B");
    assert.equal((await up(pdf("again"), "x.pdf", "?revision=B")).body.error?.code, "duplicate", "a revision's file is never replaced");
    const file = await call(app, owner, "GET", `/t/document-revisions/${a.body.id}/file`, { tenant: t });
    assert.equal(file.status, 200);
    assert.equal(file.headers["content-type"], "application/pdf");
    await assert.rejects(ownerPool.query("UPDATE document_revisions SET filename = 'x.pdf' WHERE id = $1", [a.body.id]));

    const t1 = await call(app, owner, "POST", `/t/projects/${p}/transmittals`, { tenant: t, body: { recipient: "الاستشاري", purpose: "for_construction", sentOn: day(0), revisionIds: [b.body.id] } });
    assert.equal(t1.body.error?.code, "not_approved");
    await post(`/t/document-revisions/${b.body.id}/review`, { code: "B", reviewedOn: day(0), reviewer: "م. سارة", comments: "تعديل المسافات عند الأعمدة" }, 200);
    assert.equal(await code("POST", `/t/document-revisions/${b.body.id}/review`, { code: "A", reviewedOn: day(0) }), "duplicate");
    await post(`/t/projects/${p}/transmittals`, { recipient: "مؤسسة الخرسانة", purpose: "for_construction", sentOn: day(0), revisionIds: [b.body.id] });
    const d = await get(`/t/documents/${doc}`);
    assert.deepEqual([d.revisions.length, d.revisions[0].reviewCode, d.revisions[0].transmittals.length, d.suggestedRevision], [2, "B", 1, "C"]);
    const reg = (await get(`/t/projects/${p}/documents`)).items[0];
    assert.deepEqual([reg.latestRevision, reg.reviewCode, reg.revisions], ["B", "B", 2]);
  });

  it("the accountant reads the safety figures but writes nothing on site; the storekeeper requests inspections", async () => {
    const accountant = await addMember(app, owner, t, "accountant");
    expectStatus(await call(app, accountant, "GET", `/t/hse/summary?projectId=${p}`, { tenant: t }), 200, "accountant reads safety");
    expectStatus(await call(app, accountant, "POST", "/t/rfis", { tenant: t, body: { projectId: p, subject: "سؤال", question: "سؤال تجريبي", discipline: "general" } }), 403, "accountant writes");
    expectStatus(await call(app, accountant, "GET", `/t/projects/${p}/documents`, { tenant: t }), 403, "documents are not the accountant's");
    const clerk = await addMember(app, owner, t, "inventory_clerk");
    expectStatus(await call(app, clerk, "POST", "/t/inspections", { tenant: t, body: { projectId: p, kind: "WIR", description: "فحص بلوك", requestedFor: day(0) } }), 201, "clerk requests");
    const pending = (await get(`/t/inspections?projectId=${p}&status=submitted`)).items[0].id;
    expectStatus(await call(app, clerk, "POST", `/t/inspections/${pending}/result`, { tenant: t, body: { status: "approved", inspectedOn: day(0) } }), 403, "clerk does not record the consultant's result");
  });
});
