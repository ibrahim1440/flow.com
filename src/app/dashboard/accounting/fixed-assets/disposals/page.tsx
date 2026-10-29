"use client";

// «الاستبعادات» (Qoyod z3/10.32.01: «+ إبعاد أصل»): the sales and scraps, with their gain / loss; filter by date.
// «+ إبعاد أصل» picks the asset, whose page opens the disposal dialog (the gain / loss shown before posting).
import Link from "next/link";
import { Suspense, useMemo } from "react";
import { OpsLoading } from "@/components/ops/ui";
import { DateRange, FilterCard, Section, TablePager, useFilters, usePaging } from "@/components/chrome";
import { Msg, useApi, useLang } from "../../_ui/shell";
import { FaShell, Crumb, Tag, Money, FA_STATUS, GL_STATE, FA_PAGE_SIZES, type Can } from "../_ui/fa";

type Row = { id: string; number: string; disposalDate: string; kind: string; proceedsNet: string; netBookValue: string; gainLoss: string; status: string; glState: string; journalEntryId: string | null; asset: { id: string; code: string; nameAr: string; nameEn: string | null } };

function Disposals() {
  const { L, ar } = useLang();
  const f = useFilters({ from: "", to: "" });
  const qs = useMemo(() => new URLSearchParams(Object.entries(f.applied).filter(([, v]) => v) as [string, string][]).toString(), [f.applied]);
  const r = useApi<{ rows: Row[]; can: Can }>(`/api/accounting/fixed-assets/disposals?${qs}`);
  const { pageRows, pager } = usePaging(r.data?.rows ?? [], 15);
  return (
    <FaShell title={L("الاستبعادات", "Disposals")} actions={r.data?.can.post ? <Link className="hr-btn is-primary" href="/dashboard/accounting/fixed-assets?status=ACTIVE" data-testid="disp-new">{L("+ إبعاد أصل", "+ Dispose of an asset")}</Link> : undefined}>
      <Crumb items={[{ label: L("الاستبعادات", "Disposals") }]} />
      <Msg error={r.error} />
      <FilterCard onApply={f.apply} onReset={f.reset} busy={r.loading} applyLabel={L("بحث", "Search")}>
        <DateRange from={f.draft.from} to={f.draft.to} onChange={({ from, to }) => f.setDraft({ from, to })} />
      </FilterCard>
      <Section title={L("الاستبعادات", "Disposals")} className="is-flush" testId="disp-list">
        {!r.data ? <OpsLoading /> : r.data.rows.length === 0 ? (
          <div className="fa-empty" data-testid="disp-empty"><h3>{L("لا توجد استبعادات", "No disposals")}</h3><p className="acct-hint">{L("استبعاد الأصل هو بيعه أو إتلافه بقرار من الشركة: يُهلك حتى تاريخ الاستبعاد، وتُلغى تكلفته ومجمع إهلاكه، ويُسجَّل الربح أو الخسارة. ابدأ من صفحة الأصل «إبعاد الأصل».", "Disposing of an asset is selling or scrapping it by company decision: it is depreciated to the day, its cost and accumulated depreciation removed, and the gain or loss recorded. Start from the asset's page, «Dispose of».")}</p></div>
        ) : (
          <>
            <div className="hr-tablewrap"><table className="hr-table" data-testid="disp-table">
              <thead><tr><th>{L("المرجع", "Ref")}</th><th>{L("الأصل", "Asset")}</th><th>{L("التاريخ", "Date")}</th><th>{L("النوع", "Kind")}</th><th className="num">{L("صافي القيمة", "NBV")}</th><th className="num">{L("المتحصلات", "Proceeds")}</th><th className="num">{L("ربح / (خسارة)", "Gain / (loss)")}</th><th>{L("الحالة", "Status")}</th><th>{L("الخيارات", "Options")}</th></tr></thead>
              <tbody>{pageRows.map((x) => <tr key={x.id}><td className="acct-code">{x.number}</td><td><Link href={`/dashboard/accounting/fixed-assets/${x.asset.id}`}><span className="acct-code">{x.asset.code}</span> {ar ? x.asset.nameAr : x.asset.nameEn || x.asset.nameAr}</Link></td><td><bdi>{x.disposalDate}</bdi></td>
                <td>{x.kind === "SALE" ? L("بيع", "Sale") : L("إتلاف", "Scrap")}</td><td className="num"><Money v={x.netBookValue} /></td><td className="num"><Money v={x.proceedsNet} /></td>
                <td className={`num ${Number(x.gainLoss) < 0 ? "acct-bad" : "acct-good"}`}><Money v={x.gainLoss} strong /></td><td><Tag map={FA_STATUS} value={x.status} /> <Tag map={GL_STATE} value={x.glState} /></td>
                <td>{x.journalEntryId ? <Link className="hr-btn is-sm" href={`/dashboard/accounting/journals/${x.journalEntryId}`}>{L("القيد", "Entry")}</Link> : null}</td></tr>)}</tbody>
            </table></div>
            <TablePager {...pager} sizes={FA_PAGE_SIZES} noun={L("الاستبعادات", "disposals")} />
          </>
        )}
      </Section>
    </FaShell>
  );
}
export default function Page() { return <Suspense fallback={<OpsLoading />}><Disposals /></Suspense>; }
