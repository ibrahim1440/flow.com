"use client";

// «المعاملات المتكررة» (Qoyod parity, phase 4 item 2): the recurring transactions — tabs الكل / القيود / فواتير المبيعات /
// فواتير المشتريات / فواتير بسيطة (the last two phase 2), the columns of Qoyod's «تفاصيل المعاملات المتكررة» (المرجع،
// الإسم، تاريخ الإنشاء، تاريخ التكرار التالي، الحالة، الخيارات) and «تشغيل المستحق الآن». The API re-checks every duty.
import Link from "next/link";
import { useMemo, useState } from "react";
import { OpsLoading } from "@/components/ops/ui";
import { FREQ_LABEL, KIND_LABEL, PHASE_2_REASON, STATUS_LABEL, type RecurringKind, type RecurringStatus } from "@/lib/accounting/recurring/shared";
import { AcctShell, Msg, money, useApi, useLang, useWrite, type Setup } from "../_ui/shell";

type Row = { id: string; ref: string; name: string; kind: RecurringKind; amount: string; frequency: string; interval: number; createdAt: string; nextRunDate: string | null; status: RecurringStatus; autoPost: boolean; failedRuns: number; pauseReason: string | null };
type List = { items: Row[]; total: number; take: number; skip: number; byKind: Record<string, number>; dueNow: number; failedRuns: number; schedulerConfigured: boolean };
type MonthlyRun = { status: "SKIPPED" | "RAN" | "REFUSED"; reason?: string; month?: string; result?: string; recorded?: number; posted?: number; stoppedAt?: { month: string; code: string } | null; code?: string };
type Summary = { schedules: number; created: number; posted: number; skipped: number; failed: number; already: number; busy: number; capped: boolean; deferrals?: MonthlyRun; depreciation?: MonthlyRun };

const TONE: Record<RecurringStatus, string> = { ACTIVE: "success", PAUSED: "warning", COMPLETED: "neutral", CANCELLED: "cancelled" };
const TABS = [
  { key: "", ar: "الكل", en: "All", supported: true },
  { key: "JOURNAL", ar: "القيود", en: "Journals", supported: true },
  { key: "SALES_INVOICE", ar: "فواتير المبيعات", en: "Sales invoices", supported: true },
  { key: "PURCHASE_INVOICE", ar: "فواتير المشتريات", en: "Purchase invoices", supported: false },
  { key: "SIMPLE_BILL", ar: "فواتير بسيطة", en: "Simple bills", supported: false },
];

export default function RecurringPage() {
  const { L } = useLang();
  const setup = useApi<Setup>("/api/accounting/setup");
  const [tab, setTab] = useState("");
  const [status, setStatus] = useState("");
  const [skip, setSkip] = useState(0);
  const [take, setTake] = useState(25);
  const supported = TABS.find((t) => t.key === tab)?.supported ?? true;
  const url = useMemo(() => {
    const p = new URLSearchParams({ take: String(take), skip: String(skip) });
    if (tab) p.set("kind", tab);
    if (status) p.set("status", status);
    return `/api/accounting/recurring?${p}`;
  }, [tab, status, skip, take]);
  const list = useApi<List>(supported ? url : null);
  const w = useWrite();
  const d = list.data;
  const can = setup.data?.can;
  // The Riyadh day as YYYY-MM-DD (an Arabic-locale date string reorders its parts inside an RTL cell).
  const fmtDay = (iso: string) => new Date(new Date(iso).getTime() + 3 * 3600_000).toISOString().slice(0, 10);

  // The monthly GL runs that ride on «تشغيل المستحق الآن» (deferral recognition, depreciation): one short clause each.
  function monthly(x: MonthlyRun | undefined, name: string): string {
    if (!x || (x.status === "SKIPPED" && (x.reason === "NOT_ALLOWED" || x.reason === "NOT_SCHEDULED"))) return "";
    if (x.status === "SKIPPED") return ` · ${name}: ${x.reason === "PERIOD_NOT_OPEN" ? L("الفترة غير مفتوحة", "period not open") : L("قبل بدء الدفاتر", "before go-live")}`;
    if (x.status === "REFUSED") return ` · ${name}: ${L("مرفوض", "refused")} (${x.code})`;
    if (x.stoppedAt) return ` · ${name}: ${L(`توقف عند ${x.stoppedAt.month}`, `stopped at ${x.stoppedAt.month}`)} (${x.stoppedAt.code})`;
    if (x.recorded !== undefined) return ` · ${name}: ${x.recorded ? L(`${x.recorded} شهر`, `${x.recorded} month(s)`) : L("لا مستحق", "nothing due")}`;
    return ` · ${name}: ${x.result === "posted" ? L(`سُجّل ${x.month}`, `recorded ${x.month}`) : L("لا مستحق", "nothing due")}`;
  }

  async function runDue() {
    const r = await w.run<Summary>("run", "/api/accounting/recurring/run-due", "POST", {});
    if (r) {
      w.setDone(L(`شُغّلت ${r.schedules} معاملة: ${r.created} مسودة · ${r.posted} مرحّل · ${r.skipped} متخطّى · ${r.failed} فشل${r.capped ? " · بقي مستحق، أعد التشغيل" : ""}`,
        `Ran ${r.schedules}: ${r.created} drafts · ${r.posted} posted · ${r.skipped} skipped · ${r.failed} failed${r.capped ? " · more due, run again" : ""}`)
        + monthly(r.deferrals, L("الاعتراف بالمؤجلات", "Deferral recognition")) + monthly(r.depreciation, L("الإهلاك", "Depreciation")));
      list.reload();
    }
  }

  return (
    <AcctShell setup={setup.data} title={L("المعاملات المتكررة", "Recurring transactions")}
      meta={<span className="acct-meta" data-testid="rec-scheduler">{d ? (d.schedulerConfigured
        ? L("المجدول يعمل يوميًا الساعة 04:10 بتوقيت الرياض.", "The scheduler runs daily at 04:10 Riyadh time.")
        : L("المجدول غير مُعدّ (CRON_SECRET): شغّل المستحق يدويًا بزر «تشغيل المستحق الآن».", "The scheduler is not set up (CRON_SECRET): run what is due with «Run due now».")) : null}</span>}
      actions={can?.recurring ? (
        <span className="acct-actions">
          <button type="button" className="hr-btn" disabled={w.busy === "run"} onClick={runDue} data-testid="rec-run-due">{L("تشغيل المستحق الآن", "Run due now")}{d?.dueNow ? <span className="hr-count">{d.dueNow}</span> : null}</button>
          {can.journalCreate ? <Link className="hr-btn is-primary" href="/dashboard/accounting/recurring/new" data-testid="rec-new">+ {L("معاملة متكررة", "Recurring transaction")}</Link> : null}
        </span>
      ) : undefined}>
      <Msg error={w.error} done={w.done} onClose={() => { w.setError(null); w.setDone(null); }} />
      {d?.failedRuns ? (
        <p role="status" className="acct-hint" data-testid="rec-failed-badge"><span className="hr-dot tone-danger"><span>{L(`${d.failedRuns} تشغيل فاشل ينتظر «إعادة المحاولة»`, `${d.failedRuns} failed run(s) waiting for «Retry»`)}</span></span></p>
      ) : null}
      <div className="hr-tabs is-underline" role="tablist" aria-label={L("أنواع المعاملات", "Transaction types")}>
        {TABS.map((t) => (
          <button key={t.key || "all"} type="button" role="tab" className="hr-tab" aria-selected={tab === t.key} onClick={() => { setTab(t.key); setSkip(0); }} data-testid={`rec-tab-${t.key || "ALL"}`}>
            {L(t.ar, t.en)}{!t.supported ? <span className="hr-caption"> · {L("قريبًا", "soon")}</span> : t.key && d?.byKind[t.key] ? <span className="hr-count">{d.byKind[t.key]}</span> : null}
          </button>
        ))}
      </div>
      {!supported ? (
        <div className="acct-card" data-testid="rec-phase2"><p><strong>{L("قريبًا — المرحلة الثانية", "Coming in phase 2")}</strong></p><p className="acct-hint">{L(PHASE_2_REASON.ar, PHASE_2_REASON.en)}</p></div>
      ) : (
        <>
          <div className="acct-row">
            <label className="hr-field"><span className="hr-label">{L("الحالة", "Status")}</span>
              <select className="hr-input" value={status} onChange={(e) => { setStatus(e.target.value); setSkip(0); }} data-testid="rec-status">
                <option value="">{L("الكل", "All")}</option>
                {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{L(v[0], v[1])}</option>)}
              </select></label>
          </div>
          {list.error ? <p role="alert" className="hr-err">{list.error}</p> : null}
          {!d ? <OpsLoading /> : d.items.length === 0 ? (
            <div className="acct-card" data-testid="rec-empty">
              <p><strong>{status || tab ? L("لا معاملات تطابق الاختيار.", "No transaction matches.") : L("لا توجد معاملات متكررة بعد.", "No recurring transactions yet.")}</strong></p>
              <p className="acct-hint">{L("كرّر قيد الإيجار الشهري أو الاستهلاك أو فاتورة اشتراك عميل: تُنشأ مسودة في كل موعد.", "Repeat the monthly rent journal, depreciation or a customer's subscription invoice: a draft is made on each date.")}</p>
            </div>
          ) : (
            <div className="hr-tablewrap">
              <table className="hr-table is-dense is-mrow" data-testid="rec-table">
                <thead><tr><th>{L("المرجع", "Reference")}</th><th>{L("الإسم", "Name")}</th><th>{L("النوع", "Type")}</th><th className="num">{L("المبلغ", "Amount")}</th><th>{L("تاريخ الإنشاء", "Created")}</th><th>{L("تاريخ التكرار التالي", "Next date")}</th><th>{L("الحالة", "Status")}</th><th>{L("الخيارات", "Options")}</th></tr></thead>
                <tbody>
                  {d.items.map((r) => (
                    <tr key={r.id} data-testid={`rec-row-${r.ref}`}>
                      <td><Link href={`/dashboard/accounting/recurring/${r.id}`} className="acct-code">{r.ref}</Link></td>
                      <td className="m-title"><Link href={`/dashboard/accounting/recurring/${r.id}`}><strong>{r.name}</strong></Link><span className="hr-msub"><span className="acct-show-m">{r.ref} · {L("التالي", "next")} <span className="hr-num">{r.nextRunDate ?? "—"}</span> · </span>{L(FREQ_LABEL[r.frequency]?.[0] ?? r.frequency, FREQ_LABEL[r.frequency]?.[1] ?? r.frequency)}{r.interval > 1 ? ` × ${r.interval}` : ""}{r.autoPost ? ` · ${L("ترحيل تلقائي", "auto-post")}` : ""}</span></td>
                      <td>{L(KIND_LABEL[r.kind][0], KIND_LABEL[r.kind][1])}</td>
                      <td className="num hr-num">{money(r.amount)}</td>
                      <td className="hr-num">{fmtDay(r.createdAt)}</td>
                      <td className="hr-num">{r.nextRunDate ?? "—"}</td>
                      <td className="m-end"><span className={`hr-dot tone-${TONE[r.status]}`} title={r.pauseReason ?? undefined}><span>{L(STATUS_LABEL[r.status][0], STATUS_LABEL[r.status][1])}</span></span>
                        {r.failedRuns ? <span className="hr-count" data-testid={`rec-row-failed-${r.ref}`} title={L("تشغيل فاشل", "Failed runs")}>{r.failedRuns}</span> : null}</td>
                      <td className="ops-actions"><span className="acct-actions"><Link className="hr-btn is-sm" href={`/dashboard/accounting/recurring/${r.id}`}>{L("عرض", "View")}</Link><Link className="hr-btn is-sm is-ghost" href={`/dashboard/accounting/recurring/${r.id}#runs`}>{L("السجل", "History")}</Link></span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {d && d.total > 0 ? (
            <div className="hr-tablefoot">
              <span className="hr-caption">{L(`${d.skip + 1}–${Math.min(d.skip + d.take, d.total)} من ${d.total}`, `${d.skip + 1}–${Math.min(d.skip + d.take, d.total)} of ${d.total}`)}</span>
              <span className="acct-actions">
                <select className="hr-input" aria-label={L("عدد الصفوف", "Rows per page")} value={take} onChange={(e) => { setTake(Number(e.target.value)); setSkip(0); }}>{[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}</select>
                <button type="button" className="hr-btn is-sm" disabled={d.skip === 0} onClick={() => setSkip(Math.max(0, d.skip - d.take))}>{L("السابق", "Previous")}</button>
                <button type="button" className="hr-btn is-sm" disabled={d.skip + d.take >= d.total} onClick={() => setSkip(d.skip + d.take)}>{L("التالي", "Next")}</button>
              </span>
            </div>
          ) : null}
        </>
      )}
    </AcctShell>
  );
}
