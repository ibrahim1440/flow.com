"use client";

// «الإضافات» (Qoyod z3/10.32.08: «+ إضافة جديدة»): the capital improvements that raised an asset's cost (and maybe
// its life) — from a purchase-invoice line in one step, or manual. «+ إضافة جديدة» picks the asset, whose page opens
// the addition dialog; the remaining depreciation is recomputed from the addition's date.
import Link from "next/link";
import { Suspense, useMemo } from "react";
import { OpsLoading } from "@/components/ops/ui";
import { DateRange, FilterCard, Section, TablePager, useFilters, usePaging } from "@/components/chrome";
import { Msg, useApi, useLang } from "../../_ui/shell";
import { FaShell, Crumb, Tag, Money, FA_STATUS, GL_STATE, KIND, FA_PAGE_SIZES, type Can } from "../_ui/fa";

type Row = { id: string; number: string; additionDate: string; amount: string; kind: string; description: string; newUsefulLifeMonths: number | null; status: string; glState: string; journalEntryId: string | null; asset: { id: string; code: string; nameAr: string; nameEn: string | null } };

function Additions() {
  const { L, ar } = useLang();
  const f = useFilters({ from: "", to: "" });
  const qs = useMemo(() => new URLSearchParams(Object.entries(f.applied).filter(([, v]) => v) as [string, string][]).toString(), [f.applied]);
  const r = useApi<{ rows: Row[]; can: Can }>(`/api/accounting/fixed-assets/additions?${qs}`);
  const { pageRows, pager } = usePaging(r.data?.rows ?? [], 15);
  return (
    <FaShell title={L("الإضافات", "Additions")} actions={r.data?.can.post ? <Link className="hr-btn is-primary" href="/dashboard/accounting/fixed-assets?status=ACTIVE" data-testid="add-new">{L("+ إضافة جديدة", "+ New addition")}</Link> : undefined}>
      <Crumb items={[{ label: L("الإضافات", "Additions") }]} />
      <Msg error={r.error} />
      <FilterCard onApply={f.apply} onReset={f.reset} busy={r.loading} applyLabel={L("بحث", "Search")}>
        <DateRange from={f.draft.from} to={f.draft.to} onChange={({ from, to }) => f.setDraft({ from, to })} />
      </FilterCard>
      <Section title={L("الإضافات", "Additions")} className="is-flush" testId="add-list">
        {!r.data ? <OpsLoading /> : r.data.rows.length === 0 ? (
          <div className="fa-empty" data-testid="add-empty"><h3>{L("لا توجد إضافات", "No additions")}</h3><p className="acct-hint">{L("الإضافة الرأسمالية ترفع تكلفة أصل قائم (تحسين أو قطعة تطيل عمره)، مباشرة من سطر فاتورة مشتريات أو يدويًا، ويُعاد حساب الإهلاك المتبقي. ابدأ من صفحة الأصل «إضافة رأسمالية».", "A capital addition raises an existing asset's cost (an improvement or a part that extends its life), straight from a purchase-invoice line or by hand; the remaining depreciation is recomputed. Start from the asset's page, «Capital addition».")}</p></div>
        ) : (
          <>
            <div className="hr-tablewrap"><table className="hr-table" data-testid="add-table">
              <thead><tr><th>{L("المرجع", "Ref")}</th><th>{L("الأصل", "Asset")}</th><th>{L("التاريخ", "Date")}</th><th>{L("الوصف", "Description")}</th><th className="acct-hide-m">{L("المصدر", "Source")}</th><th className="num">{L("المبلغ", "Amount")}</th><th>{L("الحالة", "Status")}</th><th>{L("الخيارات", "Options")}</th></tr></thead>
              <tbody>{pageRows.map((x) => <tr key={x.id}><td className="acct-code">{x.number}</td><td><Link href={`/dashboard/accounting/fixed-assets/${x.asset.id}`}><span className="acct-code">{x.asset.code}</span> {ar ? x.asset.nameAr : x.asset.nameEn || x.asset.nameAr}</Link></td><td><bdi>{x.additionDate}</bdi></td>
                <td>{x.description}{x.newUsefulLifeMonths ? <span className="acct-th-sub">{L(`عمر جديد ${x.newUsefulLifeMonths} شهرًا`, `new life ${x.newUsefulLifeMonths} months`)}</span> : null}</td><td className="acct-hide-m">{L(KIND[x.kind]?.[0] ?? x.kind, KIND[x.kind]?.[1] ?? x.kind)}</td>
                <td className="num">{x.kind === "REVISION" ? "—" : <Money v={x.amount} strong />}</td><td><Tag map={FA_STATUS} value={x.status} /> {x.glState !== "NONE" ? <Tag map={GL_STATE} value={x.glState} /> : null}</td>
                <td>{x.journalEntryId ? <Link className="hr-btn is-sm" href={`/dashboard/accounting/journals/${x.journalEntryId}`}>{L("القيد", "Entry")}</Link> : null}</td></tr>)}</tbody>
            </table></div>
            <TablePager {...pager} sizes={FA_PAGE_SIZES} noun={L("الإضافات", "additions")} />
          </>
        )}
      </Section>
    </FaShell>
  );
}
export default function Page() { return <Suspense fallback={<OpsLoading />}><Additions /></Suspense>; }
