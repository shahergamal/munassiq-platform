import { useQuery } from "@tanstack/react-query";
import { api, type Page } from "../../api/client";
import type { Branch, Location, Supplier } from "../../api/types";
import { useTenant } from "../../app/tenant";
import { integer, text } from "../../lib/format";
import { Badge, StatusBadge, type Hue } from "../../ui/Layout";
import { LOCATION_TYPE_LABELS } from "../../ui/status";
import { ResourcePage, type ResourceConfig } from "./ResourcePage";

const codeRule = (v: { code: string }) => (/^[A-Za-z0-9_-]{1,30}$/.test(v.code.trim()) ? null : "الرمز حروف إنجليزية وأرقام فقط، حتى 30 حرفاً (مثل SUP-01)");
/** Location kinds are categories, drawn as solid tags like sales channels (kitchen, warehouse, sub-store). */
const LOCATION_HUE: Record<string, Hue> = { kitchen: "orange", warehouse: "sky", store: "violet", quarantine: "red", site: "amber" };
const nullable = (s: string) => (s.trim() ? s.trim() : null);

type SupplierForm = { code: string; name: string; taxId: string; phone: string; email: string; paymentTermsDays: string; residency: string; isActive: boolean };

const suppliers: ResourceConfig<Supplier, SupplierForm> = {
  path: "/t/suppliers", queryKey: "suppliers", read: "suppliers.view", create: "suppliers.create", edit: "suppliers.edit", remove: "suppliers.delete",
  eyebrow: "البيانات الأساسية", title: "الموردون", noun: "المورد", addLabel: "إضافة مورد",
  description: "الموردون الذين تصدر لهم أوامر الشراء. الموقوف لا يظهر عند إنشاء أمر جديد.",
  searchPlaceholder: "ابحث بالاسم أو الرمز أو الجوال",
  nameOf: (r) => r.name,
  empty: { title: "لا يوجد موردون بعد", body: "أضف أول مورد لتتمكن من إنشاء أوامر الشراء واستلام البضاعة." },
  columns: [
    { key: "name", sortKey: "name", header: "المورد", cell: (r) => <strong>{r.name}</strong> },
    { key: "code", sortKey: "code", header: "الرمز", cell: (r) => <span className="num">{r.code}</span> },
    { key: "phone", sortKey: "phone", header: "الجوال", cell: (r) => <span className="num">{text(r.phone)}</span> },
    { key: "taxId", sortKey: "taxId", header: "الرقم الضريبي", cell: (r) => <span className="num">{text(r.taxId)}</span> },
    { key: "terms", sortKey: "paymentTermsDays", header: "مدة السداد", numeric: true, cell: (r) => (r.paymentTermsDays ? `${integer(r.paymentTermsDays)} يوم` : "نقدي") },
    { key: "residency", sortKey: false, header: "الإقامة", cell: (r) => (r.residency === "non_resident" ? <Badge tone="info">غير مقيم</Badge> : "مقيم") },
    { key: "status", sortKey: "isActive", header: "الحالة", cell: (r) => <StatusBadge kind="active" value={r.isActive} /> },
  ],
  fields: [
    { name: "name", label: "اسم المورد", required: true },
    { name: "code", label: "الرمز", required: true, ltr: true, validate: codeRule, hint: "مختصر فريد تستخدمه في البحث." },
    { name: "phone", label: "الجوال", kind: "tel", ltr: true, validate: (v) => (!v.phone.trim() || /^\+?[0-9]{9,15}$/.test(v.phone.trim()) ? null : "أرقام فقط، مثل 0501234567") },
    { name: "email", label: "البريد الإلكتروني", kind: "email", ltr: true, validate: (v) => (!v.email.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email.trim()) ? null : "صيغة البريد غير صحيحة") },
    { name: "taxId", label: "الرقم الضريبي", ltr: true },
    { name: "paymentTermsDays", label: "مدة السداد (أيام)", kind: "number", hint: "0 = نقدي عند الاستلام.", validate: (v) => (/^\d{1,3}$/.test(v.paymentTermsDays.trim() || "0") && Number(v.paymentTermsDays || 0) <= 365 ? null : "عدد أيام من 0 إلى 365") },
    { name: "residency", label: "الإقامة الضريبية", kind: "select", required: true, options: [{ value: "resident", label: "مقيم في المملكة" }, { value: "non_resident", label: "غير مقيم (خارج المملكة)" }],
      hint: "الدفع لغير المقيم يُستقطع منه ضريبة حسب نوع الدفعة (5٪ أو 15٪ أو 20٪)." },
  ],
  blank: () => ({ code: "", name: "", taxId: "", phone: "", email: "", paymentTermsDays: "0", residency: "resident", isActive: true }),
  fromRow: (r) => ({ code: r.code, name: r.name, taxId: r.taxId ?? "", phone: r.phone ?? "", email: r.email ?? "", paymentTermsDays: String(r.paymentTermsDays), residency: r.residency ?? "resident", isActive: r.isActive }),
  toBody: (v) => ({ code: v.code.trim(), name: v.name.trim(), taxId: nullable(v.taxId), phone: nullable(v.phone), email: nullable(v.email), paymentTermsDays: Number(v.paymentTermsDays || 0), residency: v.residency }),
};

export function SuppliersPage() {
  return <ResourcePage cfg={suppliers} />;
}

type BranchForm = { code: string; name: string; city: string; isActive: boolean };

export function BranchesPage() {
  const { ctx } = useTenant();
  const lim = ctx?.limits.branches;
  const cfg: ResourceConfig<Branch, BranchForm> = {
    path: "/t/branches", queryKey: "branches", read: "branches.view", create: "branches.create", edit: "branches.edit", remove: "branches.delete",
    eyebrow: "البيانات الأساسية", title: "الفروع", noun: "الفرع", addLabel: "إضافة فرع",
    description: lim?.limit ? `تستخدم ${integer(lim.used)} من ${integer(lim.limit)} فروع نشطة في باقتك.` : "فروع المنشأة التي تتبعها مواقعها ومستودعاتها.",
    searchPlaceholder: "ابحث بالاسم أو الرمز أو المدينة",
    nameOf: (r) => r.name,
    empty: { title: "لا توجد فروع بعد", body: "أضف فرعك الأول ثم اربط به المطابخ والمستودعات." },
    columns: [
      { key: "name", sortKey: "name", header: "الفرع", cell: (r) => <strong>{r.name}</strong> },
      { key: "code", sortKey: "code", header: "الرمز", cell: (r) => <span className="num">{r.code}</span> },
      { key: "city", sortKey: "city", header: "المدينة", cell: (r) => text(r.city) },
      { key: "status", sortKey: "isActive", header: "الحالة", cell: (r) => <StatusBadge kind="active" value={r.isActive} /> },
    ],
    fields: [
      { name: "name", label: "اسم الفرع", required: true },
      { name: "code", label: "الرمز", required: true, ltr: true, validate: codeRule },
      { name: "city", label: "المدينة" },
    ],
    blank: () => ({ code: "", name: "", city: "", isActive: true }),
    fromRow: (r) => ({ code: r.code, name: r.name, city: r.city ?? "", isActive: r.isActive }),
    toBody: (v) => ({ code: v.code.trim(), name: v.name.trim(), city: nullable(v.city) }),
  };
  return <ResourcePage cfg={cfg} />;
}

type LocationForm = { code: string; name: string; branchId: string; locationType: string; projectId: string; isActive: boolean };

export function LocationsPage() {
  const { tenantId, factory, sector } = useTenant();
  const contracting = sector === "contracting";
  // A factory's "kitchen" is its production floor.
  // Stock in a quarantine location is on quality hold: nothing issues or delivers from it until released.
  // A contractor's site store belongs to a project: what it issues is charged to that project.
  const types: Record<string, string> = factory ? { ...LOCATION_TYPE_LABELS, kitchen: "صالة إنتاج", quarantine: "حجر الجودة" }
    : contracting ? { warehouse: "مستودع مركزي", site: "مخزن موقع (لمشروع)", quarantine: "حجر الجودة" } : LOCATION_TYPE_LABELS;
  const projects = useQuery({ enabled: contracting, queryKey: ["t", tenantId, "contracting", "projects"],
    queryFn: () => api<{ items: { id: string; code: string; name: string }[] }>("GET", "/t/projects", { tenant: tenantId }) });
  const branches = useQuery({
    queryKey: ["t", tenantId, "branches", "options"],
    queryFn: () => api<Page<Branch>>("GET", "/t/branches", { tenant: tenantId, query: { pageSize: 100, isActive: "true" } }),
  });
  const branchName = new Map((branches.data?.items ?? []).map((b) => [b.id, b.name]));
  const cfg: ResourceConfig<Location, LocationForm> = {
    path: "/t/locations", queryKey: "locations", read: "locations.view", create: "locations.create", edit: "locations.edit", remove: "locations.delete",
    eyebrow: "البيانات الأساسية", title: factory ? "المستودعات ومواقع الإنتاج" : contracting ? "المستودعات ومخازن المواقع" : "المطابخ والمستودعات", noun: "الموقع", addLabel: "إضافة موقع",
    description: contracting ? "المستودع المركزي ومخزن كل موقع. ما يُصرف من مخزن الموقع يُحمَّل على مشروعه؛ والتحويل بين المستودعات لا يحمّل تكلفة."
      : factory ? "كل موقع له رصيد مخزون خاص به: مستودع الخامات، صالة الإنتاج، مستودع المنتج التام. الاستلام يضيف إلى موقع أمر الشراء."
      : "كل موقع له رصيد مخزون خاص به. البيع يخصم من موقع الكاشير، والاستلام يضيف إلى موقع أمر الشراء.",
    searchPlaceholder: "ابحث بالاسم أو الرمز",
    nameOf: (r) => r.name,
    empty: { title: "لا توجد مواقع بعد", body: contracting ? "أضف المستودع المركزي ومخزناً لكل موقع مشروع." : factory ? "أضف مستودع الخامات وصالة الإنتاج لتستلم فيهما المشتريات." : "أضف المطبخ الرئيسي أو المستودع لتستلم فيه المشتريات وتبيع منه." },
    columns: [
      { key: "name", sortKey: "name", header: "الموقع", cell: (r) => <strong>{r.name}</strong> },
      { key: "code", sortKey: "code", header: "الرمز", cell: (r) => <span className="num">{r.code}</span> },
      { key: "type", sortKey: "locationType", header: "النوع", cell: (r) => <span className={`tag tag-${LOCATION_HUE[r.locationType] ?? "sky"}`}>{types[r.locationType] ?? r.locationType}</span> },
      contracting
        ? { key: "project", sortKey: false, header: "المشروع", cell: (r) => text((projects.data?.items ?? []).find((p) => p.id === (r as Location & { projectId?: string | null }).projectId)?.code) }
        : { key: "branch", sortKey: false, header: "الفرع", cell: (r) => text(r.branchId ? branchName.get(r.branchId) : null) },
      { key: "status", sortKey: "isActive", header: "الحالة", cell: (r) => <StatusBadge kind="active" value={r.isActive} /> },
    ],
    fields: [
      { name: "name", label: "اسم الموقع", required: true },
      { name: "code", label: "الرمز", required: true, ltr: true, validate: codeRule },
      { name: "locationType", label: "النوع", kind: "select", required: true, options: Object.entries(types).map(([value, label]) => ({ value, label })) },
      { name: "branchId", label: "الفرع", kind: "select", options: (branches.data?.items ?? []).map((b) => ({ value: b.id, label: b.name })) },
      ...(contracting ? [{ name: "projectId" as const, label: "المشروع (لمخزن الموقع)", kind: "select" as const, options: (projects.data?.items ?? []).map((p) => ({ value: p.id, label: `${p.code} · ${p.name}` })),
        validate: (v: LocationForm) => (v.locationType === "site" && !v.projectId ? "مخزن الموقع يتبع مشروعاً: اختره" : null) }] : []),
    ],
    blank: () => ({ code: "", name: "", branchId: "", locationType: contracting ? "site" : "kitchen", projectId: "", isActive: true }),
    fromRow: (r) => ({ code: r.code, name: r.name, branchId: r.branchId ?? "", locationType: r.locationType, projectId: (r as Location & { projectId?: string | null }).projectId ?? "", isActive: r.isActive }),
    toBody: (v) => ({ code: v.code.trim(), name: v.name.trim(), branchId: v.branchId || null, locationType: v.locationType, projectId: v.locationType === "site" ? v.projectId || null : null }),
  };
  return <ResourcePage cfg={cfg} />;
}
