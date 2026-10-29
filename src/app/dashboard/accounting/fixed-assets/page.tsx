"use client";

// «الأصول الثابتة» — the register (Qoyod z3/10.31.49: «+ إضافة أصل» · «تصنيفات الأصول» · «تصدير»; empty «ليس لديك أي
// أصول ثابتة»). ?view=categories | reports | opening open the section's other panels on the same page. Easier than
// Qoyod: the categories are seeded (and created inline from the asset form), so the register never blocks on them.
import Link from "next/link";
import { Suspense, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { OpsLoading } from "@/components/ops/ui";
import { FilterCard, MultiPick, Section, TablePager, useFilters } from "@/components/chrome";
import { Select } from "@/components/ui/Select";
import { Msg, money, useApi, useLang } from "../_ui/shell";
import { FaShell, Crumb, Tag, Money, nameOf, FA_STATUS, FA_PAGE_SIZES, type Asset, type Can } from "./_ui/fa";
import { Categories } from "./_ui/categories";
import { Reports } from "./_ui/reports";
import { Opening } from "./_ui/opening";
import { Import } from "./_ui/import";

type List = { total: number; rows: Asset[]; page: number; size: number; can: Can; summary: { byStatus: Record<string, number>; cost: string; accumulated: string; netBookValue: string } };
type Options = { categories: { id: string; nameAr: string; nameEn: string | null }[]; branches: { id: string; nameAr: string | null; nameEn: string }[] };

function Register() {
  const { L, ar } = useLang();
  const opts = useApi<Options>("/api/accounting/fixed-assets/options");
  const initialStatus = useSearchParams()?.get("status") ?? "";
  const f = useFilters({ q: "", status: initialStatus, categories: [] as string[], branches: [] as string[] });
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(15);
  const qs = useMemo(() => {
    const p = new URLSearchParams({ page: String(page), size: String(size) });
    if (f.applied.q) p.set("q", f.applied.q);
    if (f.applied.status) p.set("status", f.applied.status);
    if (f.applied.categories.length) p.set("categoryId", f.applied.categories.join(","));
    if (f.applied.branches.length) p.set("branchId", f.applied.branches.join(","));
    return p.toString();
  }, [f.applied, page, size]);
  const list = useApi<List>(`/api/accounting/fixed-assets?${qs}`);
  const d = list.data;
  const filtered = !!(f.applied.q || f.applied.status || f.applied.categories.length || f.applied.branches.length);
  return (
    <FaShell title={L("الأصول الثابتة", "Fixed assets")} actions={
      <span className="acct-actions">
        {d?.can.write ? <Link className="hr-btn is-primary" href="/dashboard/accounting/fixed-assets/new" data-testid="fa-new">{L("+ إضافة أصل", "+ Add asset")}</Link> : null}
        {d?.can.write ? <Link className="hr-btn" href="/dashboard/accounting/fixed-assets?view=import" data-testid="fa-import-link">{L("استيراد من قيود", "Import from Qoyod")}</Link> : null}
        <Link className="hr-btn" href="/dashboard/accounting/fixed-assets?view=categories" data-testid="fa-categories-link">{L("تصنيفات الأصول", "Asset categories")}</Link>
        <a className="hr-btn" href={`/api/accounting/fixed-assets/reports?report=register&format=csv`} data-testid="fa-export">{L("تصدير", "Export")}</a>
      </span>
    }>
      <Crumb items={[]} />
      <Msg error={list.error} />
      <FilterCard onApply={() => { setPage(1); f.apply(); }} onReset={() => { setPage(1); f.reset(); }} busy={list.loading} applyLabel={L("بحث", "Search")}>
        <label className="qc-field"><span className="qc-label">{L("بحث", "Search")}</span>
          <input className="hr-input" value={f.draft.q} onChange={(e) => f.set("q", e.target.value)} placeholder={L("الرمز أو الاسم أو الرقم التسلسلي", "Code, name or serial")} data-testid="fa-search" /></label>
        <label className="qc-field"><span className="qc-label">{L("الحالة", "Status")}</span>
          <Select value={f.draft.status} onChange={(e) => f.set("status", e.target.value)} data-testid="fa-status">
            <option value="">{L("الكل", "All")}</option>
            {["DRAFT", "ACTIVE", "FULLY_DEPRECIATED", "DISPOSED"].map((s) => <option key={s} value={s}>{L(FA_STATUS[s][0], FA_STATUS[s][1])}</option>)}
          </Select></label>
        <MultiPick label={L("التصنيف", "Category")} options={(opts.data?.categories ?? []).map((c) => ({ value: c.id, label: nameOf(c, ar) }))} value={f.draft.categories} onChange={(v) => f.set("categories", v)} testId="fa-cat-pick" />
        <MultiPick label={L("الفرع", "Branch")} options={(opts.data?.branches ?? []).map((b) => ({ value: b.id, label: nameOf(b, ar) }))} value={f.draft.branches} onChange={(v) => f.set("branches", v)} testId="fa-branch-pick" />
      </FilterCard>
      {d ? (
        <div className="acct-metrics" data-testid="fa-summary">
          <div className="acct-metric"><span className="k">{L("التكلفة (أصول قائمة)", "Cost (assets held)")}</span><span className="v">{money(d.summary.cost)}</span></div>
          <div className="acct-metric"><span className="k">{L("مجمع الإهلاك", "Accumulated depreciation")}</span><span className="v">{money(d.summary.accumulated)}</span></div>
          <div className="acct-metric"><span className="k">{L("صافي القيمة الدفترية", "Net book value")}</span><span className="v">{money(d.summary.netBookValue)}</span><span className="s">{L("ر.س", "SAR")}</span></div>
          <div className="acct-metric"><span className="k">{L("الأصول", "Assets")}</span><span className="v">{Object.values(d.summary.byStatus).reduce((a, b) => a + b, 0)}</span><span className="s">{L(`${d.summary.byStatus.DRAFT ?? 0} مسودة · ${d.summary.byStatus.DISPOSED ?? 0} مستبعد`, `${d.summary.byStatus.DRAFT ?? 0} draft · ${d.summary.byStatus.DISPOSED ?? 0} disposed`)}</span></div>
        </div>
      ) : null}
      <Section title={L("الأصول الثابتة", "Fixed assets")} testId="fa-list" className="is-flush">
        {!d ? <OpsLoading /> : d.rows.length === 0 ? (
          <div className="fa-empty" data-testid="fa-empty">
            {filtered ? <p>{L("لا أصول تطابق البحث.", "No assets match the search.")} <button type="button" className="hr-btn is-sm" onClick={() => f.reset()}>{L("إعادة تعيين", "Reset")}</button></p> : (
              <>
                <h3>{L("ليس لديك أي أصول ثابتة", "You have no fixed assets")}</h3>
                <p className="acct-hint">{L("سجّل المعدات والسيارات والأثاث وأجهزة الحاسب التي تملكها الشركة؛ يُحسب إهلاكها شهريًا. التصنيفات جاهزة (مكائن التحميص، المطاحن، معدات المقهى، السيارات، الأثاث، أجهزة الحاسب، تحسينات المباني المستأجرة) ويمكن إضافة غيرها من نموذج الأصل.", "Record the equipment, vehicles, furniture and computers the company owns; they are depreciated monthly. Categories are ready (roasters, grinders, café equipment, vehicles, furniture, IT, leasehold improvements) and more can be added from the asset form.")}</p>
                {d.can.write ? <Link className="hr-btn is-primary" href="/dashboard/accounting/fixed-assets/new">{L("+ إضافة أصل", "+ Add asset")}</Link> : null}
              </>
            )}
          </div>
        ) : (
          <>
            <div className="hr-tablewrap">
              <table className="hr-table" data-testid="fa-table">
                <thead><tr>
                  <th>{L("الرمز", "Code")}</th><th>{L("الاسم", "Name")}</th><th className="acct-hide-m">{L("التصنيف", "Category")}</th><th className="acct-hide-m">{L("الفرع", "Branch")}</th>
                  <th className="acct-hide-m">{L("بدء الاستخدام", "In service")}</th><th className="num">{L("التكلفة", "Cost")}</th><th className="num acct-hide-m">{L("مجمع الإهلاك", "Accumulated")}</th>
                  <th className="num">{L("صافي القيمة الدفترية", "Net book value")}</th><th>{L("الحالة", "Status")}</th><th>{L("الخيارات", "Options")}</th>
                </tr></thead>
                <tbody>
                  {d.rows.map((a) => (
                    <tr key={a.id} data-testid="fa-row">
                      <td><Link href={`/dashboard/accounting/fixed-assets/${a.id}`} className="acct-code">{a.code}</Link></td>
                      <td>{ar ? a.nameAr : a.nameEn || a.nameAr}{a.serialNumber ? <span className="acct-th-sub"><bdi>{a.serialNumber}</bdi></span> : null}</td>
                      <td className="acct-hide-m">{nameOf(a.category, ar)}</td><td className="acct-hide-m">{nameOf(a.branch, ar) || "—"}</td>
                      <td className="acct-hide-m"><bdi>{a.inServiceDate ?? "—"}</bdi></td>
                      <td className="num"><Money v={a.cost} /></td><td className="num acct-hide-m"><Money v={a.accumulatedDepreciation} /></td><td className="num"><Money v={a.netBookValue} strong /></td>
                      <td><Tag map={FA_STATUS} value={a.status} /></td>
                      <td><Link className="hr-btn is-sm" href={`/dashboard/accounting/fixed-assets/${a.id}`}>{L("عرض", "View")}</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <TablePager page={page} pageSize={size} total={d.total} onPage={setPage} onPageSize={(n) => { setSize(n); setPage(1); }} sizes={FA_PAGE_SIZES} noun={L("الأصول", "assets")} />
          </>
        )}
      </Section>
    </FaShell>
  );
}

function Router() {
  const view = useSearchParams()?.get("view");
  const { L } = useLang();
  if (view === "categories") return <FaShell title={L("تصنيفات الأصول", "Asset categories")}><Crumb items={[{ label: L("تصنيفات الأصول", "Asset categories") }]} /><Categories /></FaShell>;
  if (view === "reports") return <FaShell title={L("تقارير الأصول الثابتة", "Fixed-asset reports")}><Crumb items={[{ label: L("التقارير", "Reports") }]} /><Reports /></FaShell>;
  if (view === "import") return <FaShell title={L("استيراد الأصول من قيود", "Import assets from Qoyod")}><Crumb items={[{ label: L("استيراد من قيود", "Import from Qoyod") }]} /><Import /></FaShell>;
  if (view === "opening") return <FaShell title={L("الأصول عند بدء المحاسبة", "Assets at go-live")}><Crumb items={[{ label: L("الافتتاحي", "Opening") }]} /><Opening /></FaShell>;
  return <Register />;
}

export default function FixedAssetsPage() {
  return <Suspense fallback={<OpsLoading />}><Router /></Suspense>;
}
