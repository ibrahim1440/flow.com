"use client";

// «الإهلاك» (Qoyod z3/10.31.56: «+ إضافة إهلاك»). Easier than Qoyod: one monthly run — choose the month, see every
// asset's charge (daily pro-rata from the in-service date) and the entry it will post, then post ONE combined entry.
// Below, the runs: each reversed only as a whole (the latest of its assets, its period open).
import Link from "next/link";
import { Suspense, useState } from "react";
import { OpsLoading, Btn, Field } from "@/components/ops/ui";
import { Dialog } from "@/components/hr/ui";
import { Section, TablePager, usePaging } from "@/components/chrome";
import { Select } from "@/components/ui/Select";
import { Msg, money, todayRiyadh, useApi, useLang, useWrite } from "../../_ui/shell";
import { FaShell, Crumb, Tag, Money, FA_STATUS, GL_STATE, FA_PAGE_SIZES, MONTHS_AR, MONTHS_EN, type Can } from "../_ui/fa";

type Preview = { year: number; month: number; periodEnd: string; periodStatus: string | null; periodOpen: boolean; gl: string; openingFinal: boolean; goLiveFirstOfMonth: boolean; unmapped: boolean; total: string; count: number; catchUp: number;
  lines: { assetId: string; code: string; nameAr: string; nameEn: string | null; category: string; fromDate: string; toDate: string; amount: string; catchUp: boolean; fullyDepreciated: boolean }[];
  byCategory: { categoryId: string; category: string; count: number; amount: string }[]; runs: { id: string; number: string; status: string; totalAmount: string; assetCount: number; glState: string }[]; can: Can };
type Run = { id: string; number: string; year: number; month: number; periodEnd: string; status: string; totalAmount: string; assetCount: number; glState: string; journalEntryId: string | null; reverseReason: string | null; createdAt: string };

function Depreciation() {
  const { L, ar } = useLang();
  const today = todayRiyadh();
  const [ym, setYm] = useState({ y: Number(today.slice(0, 4)), m: Number(today.slice(5, 7)) });
  const pv = useApi<Preview>(`/api/accounting/fixed-assets/depreciation/preview?year=${ym.y}&month=${ym.m}`);
  const runs = useApi<{ rows: Run[]; can: Can }>("/api/accounting/fixed-assets/depreciation");
  const w = useWrite();
  const [rev, setRev] = useState<Run | null>(null);
  const [reason, setReason] = useState("");
  const { pageRows, pager } = usePaging(runs.data?.rows ?? [], 15);
  const p = pv.data;
  const label = (y: number, m: number) => L(`${MONTHS_AR[m - 1]} ${y}`, `${MONTHS_EN[m - 1]} ${y}`);
  async function post() {
    if (await w.run("post", "/api/accounting/fixed-assets/depreciation", "POST", { year: ym.y, month: ym.m }, L(`رُحّل إهلاك ${label(ym.y, ym.m)}.`, `${label(ym.y, ym.m)} depreciation posted.`))) { pv.reload(); runs.reload(); }
  }
  async function reverse() {
    if (!rev) return;
    if (await w.run("rev", `/api/accounting/fixed-assets/depreciation/${rev.id}/reverse`, "POST", { reason }, L("عُكس قيد الإهلاك.", "The run is reversed."))) { setRev(null); setReason(""); pv.reload(); runs.reload(); }
  }
  const years = Array.from({ length: 6 }, (_, i) => Number(today.slice(0, 4)) - i);
  const blocked = !p || !p.count || !p.periodOpen || p.openingFinal || !p.goLiveFirstOfMonth || (p.gl === "POST" && p.unmapped);
  return (
    <FaShell title={L("الإهلاك", "Depreciation")} actions={p?.can.post ? <Btn variant="primary" disabled={blocked} busy={w.busy === "post"} onClick={post} data-testid="dep-post">{L(`+ إضافة إهلاك ${label(ym.y, ym.m)}`, `+ Post ${label(ym.y, ym.m)} depreciation`)}</Btn> : p?.can.write ? <span className="acct-hint" data-testid="dep-needs-post">{L("يتطلب صلاحية الترحيل (journal_post)", "Needs the posting duty (journal_post)")}</span> : undefined}>
      <Crumb items={[{ label: L("الإهلاك", "Depreciation") }]} />
      <Msg error={w.error ?? pv.error ?? runs.error} done={w.done} onClose={() => { w.setError(null); w.setDone(null); }} />
      <div className="fa-filter">
        <Field label={L("السنة", "Year")}><Select value={String(ym.y)} onChange={(e) => setYm({ ...ym, y: Number(e.target.value) })} data-testid="dep-year">{years.map((y) => <option key={y} value={y}>{y}</option>)}</Select></Field>
        <Field label={L("الشهر", "Month")}><Select value={String(ym.m)} onChange={(e) => setYm({ ...ym, m: Number(e.target.value) })} data-testid="dep-month">{MONTHS_AR.map((m, i) => <option key={i} value={i + 1}>{L(m, MONTHS_EN[i])}</option>)}</Select></Field>
        {p ? <span className="acct-hint">{!p.goLiveFirstOfMonth ? <span className="acct-bad" data-testid="dep-golive">{L("تاريخ بدء المحاسبة ليس أول الشهر: سجل الأصول الثابتة يحتاجه أول يوم في الشهر.", "The go-live date is not the 1st of a month: the fixed-asset register needs it on the 1st.")}</span> : !p.periodOpen ? <span className="acct-bad">{L("الفترة مقفلة: لا يُسجَّل فيها إهلاك.", "The period is closed: no depreciation is recorded in it.")}</span> : p.gl === "POST" ? L(`يُرحَّل قيد واحد بتاريخ ${p.periodEnd}.`, `One entry posts, dated ${p.periodEnd}.`) : L("قبل بدء المحاسبة: يُسجَّل الإهلاك في السجل دون قيد، وتحمله الأرصدة الافتتاحية.", "Before go-live: recorded in the register without an entry; the opening carries it.")}</span> : null}
      </div>
      <Section title={L(`معاينة إهلاك ${label(ym.y, ym.m)}`, `${label(ym.y, ym.m)} preview`)} className="is-flush" testId="dep-preview"
        actions={p ? <span className="acct-hint" style={{ color: "inherit" }}>{L(`${p.count} أصل · ${money(p.total)} ر.س`, `${p.count} assets · SAR ${money(p.total)}`)}</span> : undefined}>
        {!p ? <OpsLoading /> : p.count === 0 ? (
          <div className="fa-empty" data-testid="dep-empty"><h3>{p.runs.length ? L("لا إهلاك متبقٍ لهذا الشهر", "Nothing left to depreciate this month") : L("لا إهلاك لهذا الشهر", "No depreciation for this month")}</h3>
            <p className="acct-hint">{L("الإهلاك يوزّع تكلفة الأصل على عمره الإنتاجي لتخفيض قيمته الدفترية. يظهر هنا كل أصل نشط بدأ استخدامه ولم يُهلك عن الشهر بعد.", "Depreciation spreads an asset's cost over its useful life to reduce its book value. Every active asset in service and not yet depreciated for the month shows here.")}</p></div>
        ) : (
          <div className="hr-tablewrap"><table className="hr-table is-dense" data-testid="dep-lines">
            <thead><tr><th>{L("الأصل", "Asset")}</th><th className="acct-hide-m">{L("التصنيف", "Category")}</th><th className="acct-hide-m">{L("الفترة", "Span")}</th><th className="num">{L("الإهلاك", "Depreciation")}</th></tr></thead>
            <tbody>
              {p.lines.map((l) => <tr key={l.assetId}><td><Link href={`/dashboard/accounting/fixed-assets/${l.assetId}`} className="acct-code">{l.code}</Link> {ar ? l.nameAr : l.nameEn || l.nameAr}{l.fullyDepreciated ? <span className="acct-th-sub">{L("آخر قسط", "Last charge")}</span> : null}{l.catchUp ? <span className="acct-th-sub acct-warn">{L("يشمل أشهرًا سابقة", "includes earlier months")}</span> : null}</td>
                <td className="acct-hide-m">{l.category}</td><td className="acct-hide-m fa-nowrap"><bdi>{l.fromDate} → {l.toDate}</bdi></td><td className="num"><Money v={l.amount} /></td></tr>)}
              {p.byCategory.map((c) => <tr key={c.categoryId} className="is-sub"><td colSpan={3}>{c.category} ({c.count})</td><td className="num"><Money v={c.amount} /></td></tr>)}
              <tr className="is-total"><td colSpan={3}>{L("الإجمالي: مدين مصروف الإهلاك / دائن مجمع الإهلاك", "Total: Dr depreciation expense / Cr accumulated depreciation")}</td><td className="num"><Money v={p.total} strong /></td></tr>
            </tbody>
          </table></div>
        )}
      </Section>
      <Section title={L("قيود الإهلاك", "Depreciation runs")} className="is-flush" testId="dep-runs">
        {!runs.data ? <OpsLoading /> : runs.data.rows.length === 0 ? <p className="acct-hint fa-body">{L("لم يُشغَّل إهلاك بعد.", "No depreciation run yet.")}</p> : (
          <>
            <div className="hr-tablewrap"><table className="hr-table is-dense">
              <thead><tr><th>{L("المرجع", "Ref")}</th><th>{L("الشهر", "Month")}</th><th className="num">{L("الأصول", "Assets")}</th><th className="num">{L("المبلغ", "Amount")}</th><th>{L("الدفاتر", "Books")}</th><th>{L("الحالة", "Status")}</th><th>{L("الخيارات", "Options")}</th></tr></thead>
              <tbody>{pageRows.map((r) => <tr key={r.id} data-testid="dep-run"><td className="acct-code">{r.number}</td><td>{label(r.year, r.month)}</td><td className="num">{r.assetCount}</td><td className="num"><Money v={r.totalAmount} /></td><td><Tag map={GL_STATE} value={r.glState} /></td>
                <td><Tag map={FA_STATUS} value={r.status} />{r.reverseReason ? <span className="acct-th-sub">«{r.reverseReason}»</span> : null}</td>
                <td><span className="acct-actions">{r.journalEntryId ? <Link className="hr-btn is-sm" href={`/dashboard/accounting/journals/${r.journalEntryId}`}>{L("القيد", "Entry")}</Link> : null}
                  {r.status === "POSTED" && runs.data!.can.reverse ? <button type="button" className="hr-btn is-sm" onClick={() => setRev(r)} data-testid="dep-reverse">{L("عكس", "Reverse")}</button> : null}</span></td></tr>)}</tbody>
            </table></div>
            <TablePager {...pager} sizes={FA_PAGE_SIZES} noun={L("القيود", "runs")} />
          </>
        )}
      </Section>
      <Dialog open={!!rev} title={L("عكس قيد الإهلاك", "Reverse the run")} sub={rev?.number} onClose={() => setRev(null)}
        actions={<><Btn variant="danger" disabled={reason.trim().length < 3} busy={w.busy === "rev"} onClick={reverse} data-testid="dep-reverse-confirm">{L("عكس القيد", "Reverse")}</Btn><Btn onClick={() => setRev(null)}>{L("رجوع", "Back")}</Btn></>}>
        <p>{L("يُعكس القيد كاملًا بتاريخه، وتعود الأصول إلى ما كانت عليه. يُرفض إن سُجّل على أحد أصوله شيء بعده أو كانت فترته مقفلة.", "The whole entry is reversed on its date and the assets go back. Refused if anything was recorded on one of its assets after it, or its period is closed.")}</p>
        <Field label={L("السبب (يُسجَّل)", "Reason (recorded)")}><textarea className="hr-input hr-textarea" value={reason} onChange={(e) => setReason(e.target.value)} data-testid="dep-reason" /></Field>
      </Dialog>
    </FaShell>
  );
}
export default function Page() { return <Suspense fallback={<OpsLoading />}><Depreciation /></Suspense>; }
