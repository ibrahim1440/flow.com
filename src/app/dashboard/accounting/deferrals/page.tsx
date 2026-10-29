"use client";

// «قوالب التأجيل» (feat/budgets-deferrals): prepaid expenses and deferred revenue recognised over N months.
//   «الجداول»   the schedules (template + amount + start date), each month's line and the run that recognised it;
//   «القوالب»   kind, months, start rule, the balance-sheet account (default: the role's) and the P&L account;
//   «التشغيلات» the monthly recognition runs — one balanced entry per run, a month recognised once; «عكس» restates it.
// The months due and the balance-sheet reconciliation head the page. Every write is re-checked by the API.
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { OpsLoading, OpsEmpty, Btn, Field } from "@/components/ops/ui";
import { Dialog } from "@/components/hr/ui";
import { Select } from "@/components/ui/Select";
import { AcctShell, Msg, StatusTag, acctFetch, money, todayRiyadh, useApi, useLang, useWrite, type Setup } from "../_ui/shell";
import { DEFERRED_SCOPE, KIND_LABEL, LINE_STATUS, PRORATA_HELP, RULE_LABEL, RUN_STATUS, SCHEDULE_STATUS, accName, type AccountRef, type Branch } from "../_ui/plan";

type Overview = {
  due: { month: string; lines: number; amount: string }[];
  reconciliation: { accountId: string; code: string; name: string; nameEn: string; kind: string; unrecognised: string; glBalance: string; difference: string; openingPending: string; status: string; schedules: number }[];
  backlog: { dueCount: number; overdueCount: number; overdueAmount: string; stoppedAt: { month: string; reason: string } | null };
  branches: Branch[]; costCenters: Branch[]; accounting: { active: boolean; goLiveDate: string | null };
  can: { manage: boolean; run: boolean; reverse: boolean; post: boolean };
};
// A purchase-invoice EXPENSE line with its ONE capacity, shared with «الأصول الثابتة» (council F1).
type SourceLine = { lineId: string; lineNo: number; description: string; capacity: string; remaining: string; usedIn: { fixedAssets: string; deferrals: string }; invoice: { number: string | null; supplierRef: string | null; invoiceDate: string; supplier: { name: string } } };
/** In place of a GL action the viewer may not take (council ruling 5: no 403-only buttons). */
const NEEDS_POST: [string, string] = ["يتطلب صلاحية الترحيل (journal_post)", "Needs the posting duty (journal_post)"];
type Template = { id: string; nameAr: string; nameEn: string | null; kind: string; months: number; startRule: string; isActive: boolean; schedules: number; balanceAccount: AccountRef | null; balanceFromRole: boolean; plAccount: AccountRef };
type Templates = { templates: Template[]; roles: Record<string, AccountRef | null>; accounts: (AccountRef & { type: string })[] };
type Line = { id: string; seq: number; month: string; amount: string; status: string; runId: string | null; runStatus: string | null; journalEntryId: string | null };
type Schedule = {
  id: string; number: string; kind: string; months: number; startRule: string; startDate: string; totalAmount: string; recognised: string; remaining: string; description: string;
  sourceType: string; sourceId: string | null; status: string; cancelReason: string | null; template: { id: string; nameAr: string; nameEn: string | null };
  initialMode: string; reclassAccount: AccountRef | null; reclassStatus: string | null; reclassEntryId: string | null;
  plDiffersFromLine: boolean;
  cancelMode: string | null; cancelDate: string | null; cancelAccount: AccountRef | null; cancelAmount: string | null; cancelStatus: string | null; cancelEntryId: string | null;
  balanceAccount: AccountRef; plAccount: AccountRef; lines: Line[];
};
type Run = { id: string; month: string; entryDate: string; status: string; skipReason: string | null; journalEntryId: string | null; journalRef: string | null; total: string; lineCount: number; createdAt: string; reverseReason: string | null; reversalEntryId: string | null };
type View = "schedules" | "templates" | "runs";
const STOP_AR: Record<string, [string, string]> = {
  PERIOD_CLOSED: ["الفترة مقفلة نهائيًا", "the period is closed"], PERIOD_SOFT_CLOSED: ["الفترة مقفلة مؤقتًا", "the period is soft-closed"], NOT_RUN: ["لم يُشغَّل بعد", "not run yet"],
};

export default function DeferralsPage() {
  return <Suspense fallback={<OpsLoading />}><DeferralsPageScreen /></Suspense>;
}

function DeferralsPageScreen() {
  const { L, ar } = useLang();
  const sp = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const view: View = (["schedules", "templates", "runs"] as const).includes(sp.get("view") as View) ? (sp.get("view") as View) : "schedules";
  const setup = useApi<Setup>("/api/accounting/setup");
  const ov = useApi<Overview>("/api/accounting/deferrals");
  const w = useWrite();
  const go = (v: View) => router.replace(`${path}${v === "schedules" ? "" : `?view=${v}`}`);
  const [runMonth, setRunMonth] = useState(todayRiyadh().slice(0, 7));
  const [tick, setTick] = useState(0);

  async function run(month: string) {
    const r = await w.run<{ status: string; run: Run | null }>("run", "/api/accounting/deferrals/runs", "POST", { month });
    if (!r) return;
    w.setDone(r.status === "NOTHING_DUE" ? L(`لا أشهر مستحقة في ${month} — كل جدول اعتُرف بشهره مسبقًا.`, `Nothing due in ${month} — every schedule's month is recognised already.`)
      : r.run?.status === "SKIPPED" ? L(`سُجّل الاعتراف لشهر ${month} بلا قيد (المحاسبة غير مفعّلة أو قبل تاريخ البدء).`, `${month} recorded with no entry (accounting not active or before go-live).`)
      : L(`رُحّل قيد الاعتراف لشهر ${month} (${r.run?.journalRef ?? ""}).`, `${month} recognised and posted (${r.run?.journalRef ?? ""}).`));
    ov.reload(); setTick((t) => t + 1);
  }

  const d = ov.data;
  return (
    <AcctShell setup={setup.data} title={L("قوالب التأجيل", "Deferral templates")}>
      <Msg error={w.error ?? ov.error} done={w.done} onClose={() => { w.setError(null); w.setDone(null); }} />
      <p className="acct-scope">{L("المصروف المدفوع مقدماً والإيراد المؤجل يُعترف بهما شهرًا بشهر: قيد واحد متوازن لكل تشغيل، ولا يُعترف بالشهر مرتين، والفترة المقفلة ترفض.", "Prepaid expenses and deferred revenue are recognised month by month: one balanced entry per run, a month never twice, a closed period refused.")}
        {d && !d.accounting.active ? <b> {L("المحاسبة غير مفعّلة: تُسجَّل التشغيلات بلا قيود.", "Accounting is not active: runs are recorded with no entry.")}</b> : null}</p>
      {d && d.backlog.overdueCount > 0 ? (
        <div role="alert" className="acct-banner-note" data-testid="def-backlog">
          <b>{L(`${d.backlog.overdueCount} ${d.backlog.overdueCount === 1 ? "شهر مستحق" : "أشهر مستحقة"} لم يُعترف بها`, `${d.backlog.overdueCount} month(s) due, not recognised`)}</b>
          {" · "}<span className="hr-num">{money(d.backlog.overdueAmount)}</span> {L("ر.س", "SAR")}
          {d.backlog.stoppedAt ? <>{" · "}{L("متوقف عند", "stopped at")} <span className="hr-num">{d.backlog.stoppedAt.month}</span> ({L(STOP_AR[d.backlog.stoppedAt.reason]?.[0] ?? d.backlog.stoppedAt.reason, STOP_AR[d.backlog.stoppedAt.reason]?.[1] ?? d.backlog.stoppedAt.reason)})</> : null}
        </div>
      ) : null}
      {!d ? <OpsLoading /> : (
        <div className="acct-cards">
          <section className="acct-card" data-testid="def-due">
            <h2>{L("أشهر مستحقة للاعتراف", "Months due")}</h2>
            {d.due.length === 0 ? <p className="acct-hint">{L("لا أشهر مستحقة حتى هذا الشهر.", "Nothing due up to this month.")}</p> : (
              <ul className="acct-issues">{d.due.map((m) => (
                <li key={m.month}><span className="hr-num">{m.month}</span><span>{L(`${m.lines} سطر · `, `${m.lines} line(s) · `)}<span className="hr-num">{money(m.amount)}</span> {L("ر.س", "SAR")}</span>
                  {d.can.run ? <Btn size="sm" busy={w.busy === "run"} onClick={() => run(m.month)} data-testid={`def-run-${m.month}`}>{L("تشغيل", "Run")}</Btn> : <span />}</li>
              ))}</ul>
            )}
            {d.can.run ? <div className="acct-row">
              <Field label={L("تشغيل شهر", "Run a month")}><input type="month" className="hr-input" dir="ltr" value={runMonth} onChange={(e) => setRunMonth(e.target.value)} data-testid="def-run-month" /></Field>
              <Btn variant="primary" busy={w.busy === "run"} disabled={!/^\d{4}-\d{2}$/.test(runMonth)} onClick={() => run(runMonth)} data-testid="def-run">{L("تشغيل الاعتراف الشهري", "Run the monthly recognition")}</Btn>
            </div> : <p className="acct-hint" data-testid="def-run-needs-post">{L(NEEDS_POST[0], NEEDS_POST[1])}</p>}
          </section>
          <section className="acct-card" data-testid="def-recon">
            <h2>{L("مطابقة حسابات الميزانية", "Balance-sheet reconciliation")}</h2>
            {d.reconciliation.length === 0 ? <p className="acct-hint">{L("لا جداول نشطة.", "No active schedule.")}</p> : (
              <div className="hr-tablewrap"><table className="hr-table is-dense">
                <thead><tr><th>{L("الحساب", "Account")}</th><th className="num">{L("غير المعترف به", "Unrecognised")}</th><th className="num">{L("رصيد الدفتر", "Ledger balance")}</th><th className="num">{L("الفرق", "Difference")}</th></tr></thead>
                <tbody>{d.reconciliation.map((r) => <tr key={r.accountId} data-testid={`def-recon-${r.code}`}><td><span className="acct-code">{r.code}</span> {ar ? r.name : r.nameEn}{Number(r.openingPending) ? <span className="acct-sub">{L("بانتظار الأرصدة الافتتاحية", "Awaiting the opening")} <span className="hr-num">{money(r.openingPending)}</span></span> : null}</td><td className="num hr-num">{money(r.unrecognised)}</td><td className="num hr-num">{money(r.glBalance)}</td><td className={`num hr-num${r.status === "UNEXPLAINED" ? " acct-bad" : r.status === "EXPLAINED" ? " acct-warn" : ""}`}>{money(r.difference)}</td></tr>)}</tbody>
              </table></div>
            )}
            <p className="acct-hint">{L("الفرق يجب أن يكون صفرًا: رصيد أقل من غير المعترف به يعني أن مبلغ الجدول لم يُقيَّد على الحساب (أعد تصنيفه)، وأكبر منه مبالغ على الحساب لا يغطيها جدول.", "The difference should be zero: a balance below the unrecognised amount means a schedule's amount is not on the account (reclassify it); above it, amounts on the account no schedule covers.")}</p>
          </section>
        </div>
      )}
      <div className="acct-seg" role="group" aria-label={L("العرض", "View")}>
        <button type="button" aria-pressed={view === "schedules"} onClick={() => go("schedules")} data-testid="def-view-schedules">{L("الجداول", "Schedules")}</button>
        <button type="button" aria-pressed={view === "templates"} onClick={() => go("templates")} data-testid="def-view-templates">{L("القوالب", "Templates")}</button>
        <button type="button" aria-pressed={view === "runs"} onClick={() => go("runs")} data-testid="def-view-runs">{L("التشغيلات", "Runs")}</button>
      </div>
      {view === "templates" ? <TemplatesView can={!!d?.can.manage} /> : view === "runs" ? <RunsView key={tick} canReverse={!!d?.can.reverse} focus={sp.get("run")} onChange={() => ov.reload()} /> : <SchedulesView key={tick} ov={d} onChange={() => ov.reload()} />}
    </AcctShell>
  );
}

function SchedulesView({ ov, onChange }: { ov: Overview | null; onChange: () => void }) {
  const { L, ar } = useLang();
  const [status, setStatus] = useState("");
  const list = useApi<{ items: Schedule[]; total: number }>(`/api/accounting/deferrals/schedules?take=100${status ? `&status=${status}` : ""}`);
  const tpl = useApi<Templates>("/api/accounting/deferrals/templates?active=1");
  const w = useWrite();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ templateId: "", amount: "", startDate: todayRiyadh(), description: "", branchId: "", costCenterId: "", initialMode: "ON_ACCOUNT", reclassAccountId: "", sourceLineId: "" });
  const [cancelMode, setCancelMode] = useState<"RECOGNIZE_NOW" | "KEEP">(ov?.can.post ? "RECOGNIZE_NOW" : "KEEP");
  const canPost = !!ov?.can.post;
  const srcLines = useApi<{ rows: SourceLine[] }>(open && form.initialMode === "LINE" ? "/api/accounting/deferrals/source-lines" : null);
  const [cancelAccountId, setCancelAccountId] = useState("");
  // The preview of the current inputs (a fetched answer for other inputs is not shown).
  const pkey = open && form.templateId && /^\d+(\.\d{1,2})?$/.test(form.amount) && /^\d{4}-\d{2}-\d{2}$/.test(form.startDate) ? `${form.templateId}|${form.amount}|${form.startDate}` : null;
  const [pv, setPv] = useState<{ key: string; lines: { seq: number; periodStart: string; amount: string; days: number | null }[] | null; error: string | null } | null>(null);
  const preview = pv && pv.key === pkey ? pv.lines : null;
  const previewErr = pv && pv.key === pkey ? pv.error : null;
  const [detail, setDetail] = useState<Schedule | null>(null);
  const [cancelReason, setCancelReason] = useState("");

  useEffect(() => {
    if (!pkey) return;
    let off = false;
    const [templateId, amount, startDate] = pkey.split("|");
    acctFetch<{ lines: { seq: number; periodStart: string; amount: string; days: number | null }[] }>("/api/accounting/deferrals/schedules/preview", { json: { templateId, amount, startDate } })
      .then((r) => { if (!off) setPv({ key: pkey, lines: r.lines, error: null }); }).catch((e) => { if (!off) setPv({ key: pkey, lines: null, error: e instanceof Error ? e.message : String(e) }); });
    return () => { off = true; };
  }, [pkey]);

  async function create() {
    const fromLine = form.initialMode === "LINE";
    const body = { ...form, branchId: form.branchId || null, costCenterId: form.costCenterId || null, reclassAccountId: form.initialMode === "RECLASS" ? form.reclassAccountId : null,
      initialMode: fromLine ? null : form.initialMode, sourceType: fromLine ? "SUPPLIER_INVOICE_LINE" : "MANUAL", sourceId: fromLine ? form.sourceLineId : null };
    const r = await w.run("create", "/api/accounting/deferrals/schedules", "POST", body, L("أُنشئ جدول التأجيل.", "The deferral schedule is created."));
    if (r) { setOpen(false); setForm({ ...form, amount: "", description: "", initialMode: "ON_ACCOUNT", reclassAccountId: "", sourceLineId: "" }); list.reload(); onChange(); }
  }
  async function cancel() {
    if (!detail) return;
    const r = await w.run<Schedule>("cancel", `/api/accounting/deferrals/schedules/${detail.id}/cancel`, "POST", { reason: cancelReason, mode: cancelMode, accountId: cancelMode === "RECOGNIZE_NOW" && cancelAccountId ? cancelAccountId : null }, cancelMode === "RECOGNIZE_NOW" ? L("أُلغي الجدول وأُثبت باقيه.", "Cancelled; the remainder is recognised.") : L("أُلغي الجدول وبقي باقيه في الحساب.", "Cancelled; the remainder stays on the account."));
    if (r) { setDetail(r); setCancelReason(""); setCancelAccountId(""); list.reload(); onChange(); }
  }
  const templates = tpl.data?.templates ?? [];
  const chosen = templates.find((t) => t.id === form.templateId);
  const reclassType = chosen?.kind === "DEFERRED_REVENUE" ? "REVENUE" : "EXPENSE";
  return (
    <section className="acct-card" data-testid="def-schedules">
      <div className="acct-foot" style={{ borderTop: 0, paddingTop: 0 }}>
        <div className="acct-filters">
          <Field label={L("الحالة", "Status")}><Select value={status} onChange={(e) => setStatus(e.target.value)} data-testid="def-status-filter">
            <option value="">{L("الكل", "All")}</option>{Object.entries(SCHEDULE_STATUS).map(([k, v]) => <option key={k} value={k}>{L(v[0], v[1])}</option>)}
          </Select></Field>
        </div>
        {ov?.can.manage ? <Btn variant="primary" disabled={!templates.length} onClick={() => setOpen(true)} data-testid="def-new-schedule">{L("إنشاء جدول تأجيل", "New deferral schedule")}</Btn> : null}
      </div>
      {ov?.can.manage && tpl.data && !templates.length ? <p className="acct-hint">{L("أنشئ قالبًا أولًا من تبويب «القوالب».", "Create a template first (the «Templates» tab).")}</p> : null}
      {list.error ? <Msg error={list.error} /> : !list.data ? <OpsLoading /> : list.data.items.length === 0 ? <OpsEmpty title={L("لا جداول تأجيل", "No deferral schedule")} body={L("الجدول يوزّع مبلغًا مدفوعًا مقدماً أو مقبوضًا مقدماً على أشهر الاستحقاق.", "A schedule spreads an amount paid or received in advance over the months it belongs to.")} /> : (
        <div className="hr-tablewrap">
          <table className="hr-table" data-testid="def-schedule-list">
            <thead><tr><th>{L("الرقم", "Number")}</th><th>{L("الوصف", "Description")}</th><th className="acct-hide-m">{L("النوع", "Kind")}</th><th className="acct-hide-m">{L("البدء", "Start")}</th><th className="num">{L("المبلغ", "Amount")}</th><th className="num acct-hide-m">{L("المعترف به", "Recognised")}</th><th className="num">{L("المتبقي", "Remaining")}</th><th>{L("الحالة", "Status")}</th></tr></thead>
            <tbody>{list.data.items.map((s) => (
              <tr key={s.id} className="is-clickable" data-testid={`def-schedule-${s.number}`}>
                <td><button type="button" className="acct-linkbtn acct-code" onClick={() => setDetail(s)}>{s.number}</button></td>
                <td>{s.description}<span className="acct-sub">{s.months} {L("شهر", "months")} · {L(RULE_LABEL[s.startRule]?.[0] ?? s.startRule, RULE_LABEL[s.startRule]?.[1] ?? s.startRule)}</span></td>
                <td className="acct-hide-m">{L(KIND_LABEL[s.kind][0], KIND_LABEL[s.kind][1])}</td>
                <td className="acct-hide-m hr-num">{s.startDate}</td>
                <td className="num hr-num">{money(s.totalAmount)}</td>
                <td className="num hr-num acct-hide-m">{money(s.recognised)}</td>
                <td className="num hr-num">{money(s.remaining)}</td>
                <td><StatusTag map={SCHEDULE_STATUS} value={s.status} /></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <Dialog open={open} title={L("إنشاء جدول تأجيل", "New deferral schedule")} onClose={() => setOpen(false)}
        actions={<><Btn variant="primary" busy={w.busy === "create"} disabled={!preview || !form.description.trim() || (form.initialMode === "RECLASS" && !form.reclassAccountId) || (form.initialMode === "LINE" && !form.sourceLineId)} onClick={create} data-testid="def-create">{L("إنشاء الجدول", "Create the schedule")}</Btn><Btn onClick={() => setOpen(false)}>{L("إلغاء", "Cancel")}</Btn></>}>
        <Msg error={w.error} />
        <Field label={L("القالب", "Template")}><Select value={form.templateId} onChange={(e) => setForm({ ...form, templateId: e.target.value })} data-testid="def-template">
          <option value="">{L("اختر قالبًا", "Choose a template")}</option>
          {templates.map((t) => <option key={t.id} value={t.id}>{ar ? t.nameAr : t.nameEn ?? t.nameAr} · {L(KIND_LABEL[t.kind][0], KIND_LABEL[t.kind][1])} · {t.months} {L("شهر", "mo")}</option>)}
        </Select></Field>
        <Field label={L("الوصف", "Description")}><input className="hr-input" maxLength={300} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} data-testid="def-description" /></Field>
        <div className="acct-row">
          <Field label={L("المبلغ (ر.س، دون الضريبة)", "Amount (SAR, excl. VAT)")}><input className="hr-input acct-amount" dir="ltr" inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value.replace(/[^\d.]/g, "") })} data-testid="def-amount" /></Field>
          <Field label={L("تاريخ البدء", "Start date")}><input type="date" className="hr-input" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} data-testid="def-start" /></Field>
        </div>
        {ov && (ov.branches.length || ov.costCenters.length) ? <div className="acct-row">
          <Field label={L("الفرع (اختياري)", "Branch (optional)")}><Select value={form.branchId} onChange={(e) => setForm({ ...form, branchId: e.target.value })}><option value="">—</option>{ov.branches.map((b) => <option key={b.id} value={b.id}>{b.code} · {ar ? b.nameAr ?? b.nameEn : b.nameEn}</option>)}</Select></Field>
          <Field label={L("مركز التكلفة (اختياري)", "Cost centre (optional)")}><Select value={form.costCenterId} onChange={(e) => setForm({ ...form, costCenterId: e.target.value })}><option value="">—</option>{ov.costCenters.map((b) => <option key={b.id} value={b.id}>{b.code} · {ar ? b.nameAr ?? b.nameEn : b.nameEn}</option>)}</Select></Field>
        </div> : null}
        <fieldset className="acct-kv" style={{ border: 0, padding: 0, margin: 0 }} data-testid="def-initial-mode">
          <legend className="hr-label">{L("أين المبلغ الآن؟", "Where is the amount now?")}</legend>
          <label className="acct-toggle"><input type="radio" name="def-mode" checked={form.initialMode === "ON_ACCOUNT"} onChange={() => setForm({ ...form, initialMode: "ON_ACCOUNT" })} data-testid="def-mode-on-account" /><span><b>{L("المبلغ مسجّل في حساب الميزانية", "The amount is on the balance-sheet account")}</b><span className="acct-hint">{L("قُيّد على حساب المدفوع مقدماً أو الإيراد المؤجل: لا قيد عند الإنشاء.", "It was booked to the prepaid / deferred revenue account: no entry now.")}</span></span></label>
          {canPost ? <>
          <label className="acct-toggle"><input type="radio" name="def-mode" checked={form.initialMode === "RECLASS"} onChange={() => setForm({ ...form, initialMode: "RECLASS" })} data-testid="def-mode-reclass" /><span><b>{L("أعد التصنيف من حساب …", "Reclassify from an account …")}</b><span className="acct-hint">{L("قُيّد مصروفًا أو إيرادًا: قيد إعادة تصنيف واحد بالمبلغ في تاريخ البدء، فلا يُحتسب مرتين.", "It was booked as an expense / revenue: one reclass entry for the amount at the start date, so it is never counted twice.")}</span></span></label>
          {form.initialMode === "RECLASS" ? <Field label={chosen?.kind === "DEFERRED_REVENUE" ? L("حساب الإيراد الذي قُيّد فيه", "The revenue account it was booked to") : L("حساب المصروف الذي قُيّد فيه", "The expense account it was booked to")}>
            <Select value={form.reclassAccountId} onChange={(e) => setForm({ ...form, reclassAccountId: e.target.value })} data-testid="def-reclass-account">
              <option value="">{L("اختر حسابًا", "Choose an account")}</option>
              {(tpl.data?.accounts ?? []).filter((a) => a.type === reclassType).map((a) => <option key={a.id} value={a.id}>{accName(a, ar)}</option>)}
            </Select></Field> : null}
          {chosen?.kind !== "DEFERRED_REVENUE" ? <label className="acct-toggle"><input type="radio" name="def-mode" checked={form.initialMode === "LINE"} onChange={() => setForm({ ...form, initialMode: "LINE" })} data-testid="def-mode-line" /><span><b>{L("من سطر فاتورة مشتريات", "From a purchase-invoice line")}</b><span className="acct-hint">{L("سطر مصروف من فاتورة مرحّلة: يُعاد تصنيفه، ولا يُستخدم السطر إلا مرة واحدة بين الأصول الثابتة والتأجيل.", "An expense line of a posted invoice: it is reclassified; a line is used once across fixed assets and deferrals.")}</span></span></label> : null}
          {form.initialMode === "LINE" ? <Field label={L("السطر", "Line")}>
            <Select value={form.sourceLineId} onChange={(e) => { const l = srcLines.data?.rows.find((x) => x.lineId === e.target.value); setForm({ ...form, sourceLineId: e.target.value, amount: l && !form.amount ? l.remaining : form.amount }); }} data-testid="def-source-line">
              <option value="">{L("اختر السطر", "Choose the line")}</option>
              {(srcLines.data?.rows ?? []).map((l) => <option key={l.lineId} value={l.lineId}>{`${l.invoice.number ?? l.invoice.supplierRef ?? ""} · ${l.invoice.supplier.name} · #${l.lineNo} ${l.description} · ${L("المتبقي", "remaining")} ${money(l.remaining)} / ${money(l.capacity)}${Number(l.usedIn.fixedAssets) || Number(l.usedIn.deferrals) ? ` · ${L("مستخدم في", "used in")}: ${L("أصل ثابت", "fixed asset")} ${money(l.usedIn.fixedAssets)} / ${L("تأجيل", "deferral")} ${money(l.usedIn.deferrals)}` : ""}`}</option>)}
            </Select></Field> : null}
          </> : <p className="acct-hint" data-testid="def-needs-post">{L("أعد التصنيف أو من سطر فاتورة: ", "Reclassify or from an invoice line: ")}{L(NEEDS_POST[0], NEEDS_POST[1])}</p>}
        </fieldset>
        {chosen?.kind === "DEFERRED_REVENUE" ? <p className="acct-hint" data-testid="def-scope-note">{L(DEFERRED_SCOPE[0], DEFERRED_SCOPE[1])}</p> : null}
        {previewErr ? <p className="acct-bad">{previewErr}</p> : preview ? (
          <div className="hr-tablewrap"><table className="hr-table is-dense" data-testid="def-preview">
            <thead><tr><th>#</th><th>{L("الشهر", "Month")}</th><th className="num">{L("المبلغ", "Amount")}</th></tr></thead>
            <tbody>{preview.map((l) => <tr key={l.seq}><td className="hr-num">{l.seq}</td><td className="hr-num">{l.periodStart.slice(0, 7)}{l.days ? <span className="acct-sub">{L(`${l.days} يومًا`, `${l.days} days`)}</span> : null}</td><td className="num hr-num">{money(l.amount)}</td></tr>)}</tbody>
          </table></div>
        ) : <p className="acct-hint">{L("اختر القالب وأدخل المبلغ والتاريخ لمعاينة الأشهر (الباقي بالهللة في الشهر الأخير).", "Choose the template, enter the amount and date to preview the months (the halala remainder falls in the last month).")}</p>}
      </Dialog>
      <Dialog open={!!detail} title={detail ? `${detail.number} · ${detail.description}` : ""} onClose={() => setDetail(null)} testId="def-detail"
        actions={detail && detail.status !== "CANCELLED" && ov?.can.manage ? <><Btn variant="danger" busy={w.busy === "cancel"} disabled={cancelReason.trim().length < 3} onClick={cancel} data-testid="def-cancel">{L("إلغاء الجدول", "Cancel the schedule")}</Btn><Btn onClick={() => setDetail(null)}>{L("إغلاق", "Close")}</Btn></> : <Btn onClick={() => setDetail(null)}>{L("إغلاق", "Close")}</Btn>}>
        {detail ? <>
          <dl className="acct-kv">
            <div><dt>{L("النوع", "Kind")}</dt><dd>{L(KIND_LABEL[detail.kind][0], KIND_LABEL[detail.kind][1])} · {ar ? detail.template.nameAr : detail.template.nameEn ?? detail.template.nameAr}</dd></div>
            <div><dt>{L("حساب الميزانية", "Balance sheet")}</dt><dd>{accName(detail.balanceAccount, ar)}</dd></div>
            <div><dt>{L("حساب الدخل", "P&L")}</dt><dd>{accName(detail.plAccount, ar)}{detail.plDiffersFromLine ? <b className="acct-warn" role="note" data-testid="def-pl-differs"> · {L("حساب الإثبات يختلف عن حساب السطر", "The recognition account differs from the line's account")}</b> : null}</dd></div>
            <div><dt>{L("المصدر", "Source")}</dt><dd>{detail.sourceType === "MANUAL" ? L("يدوي", "Manual") : `${detail.sourceType} · ${detail.sourceId}`}</dd></div>
            <div><dt>{L("عند الإنشاء", "At creation")}</dt><dd data-testid="def-detail-mode">{detail.initialMode === "RECLASS" ? <>{L("إعادة تصنيف من", "Reclassified from")} {accName(detail.reclassAccount, ar)} · {detail.reclassEntryId ? <Link href={`/dashboard/accounting/journals/${detail.reclassEntryId}`}>{L("القيد", "Entry")}</Link> : L("بلا قيد (قبل بدء المحاسبة)", "no entry (before go-live)")}</> : L("المبلغ على حساب الميزانية (بلا قيد)", "On the balance-sheet account (no entry)")}</dd></div>
            {detail.cancelMode ? <div><dt>{L("عند الإلغاء", "At cancel")}</dt><dd>{detail.cancelMode === "RECOGNIZE_NOW" ? <>{L("أُثبت الباقي", "Remainder recognised")} <span className="hr-num">{money(detail.cancelAmount)}</span> {L("في", "into")} {accName(detail.cancelAccount, ar)}{detail.cancelEntryId ? <> · <Link href={`/dashboard/accounting/journals/${detail.cancelEntryId}`}>{L("القيد", "Entry")}</Link></> : null}</> : <>{L("بقي الباقي في الحساب", "Remainder kept on the account")} <span className="hr-num">{money(detail.cancelAmount)}</span></>}</dd></div> : null}
            <div><dt>{L("المبلغ", "Amount")}</dt><dd className="hr-num">{money(detail.totalAmount)} · {L("متبقٍ", "remaining")} {money(detail.remaining)}</dd></div>
            {detail.cancelReason ? <div><dt>{L("سبب الإلغاء", "Cancel reason")}</dt><dd>{detail.cancelReason}</dd></div> : null}
          </dl>
          <div className="hr-tablewrap"><table className="hr-table is-dense" data-testid="def-lines">
            <thead><tr><th>#</th><th>{L("الشهر", "Month")}</th><th className="num">{L("المبلغ", "Amount")}</th><th>{L("الحالة", "Status")}</th></tr></thead>
            <tbody>{detail.lines.map((l) => <tr key={l.id}><td className="hr-num">{l.seq}</td><td className="hr-num">{l.month}</td><td className="num hr-num">{money(l.amount)}</td><td><StatusTag map={LINE_STATUS} value={l.status} />{l.journalEntryId ? <> · <Link href={`/dashboard/accounting/journals/${l.journalEntryId}`}>{L("القيد", "Entry")}</Link></> : null}</td></tr>)}</tbody>
          </table></div>
          {detail.status !== "CANCELLED" && ov?.can.manage ? <fieldset className="acct-kv" style={{ border: 0, padding: 0, margin: 0 }} data-testid="def-cancel-mode">
            <legend className="hr-label">{L(`إلغاء الجدول — الباقي ${money(detail.remaining)} ر.س`, `Cancel the schedule — remainder ${money(detail.remaining)} SAR`)}</legend>
            {canPost ? <>
            <label className="acct-toggle"><input type="radio" name="def-cancel" checked={cancelMode === "RECOGNIZE_NOW"} onChange={() => setCancelMode("RECOGNIZE_NOW")} data-testid="def-cancel-now" /><span><b>{L("إثبات الباقي الآن", "Recognise the remainder now")}</b><span className="acct-hint">{L("قيد واحد اليوم إلى حساب الدخل أو حساب تختاره (حساب إعادة التصنيف لعكسها).", "One entry today into the P&L account or one you choose (the reclass account to undo it).")}</span></span></label>
            {cancelMode === "RECOGNIZE_NOW" ? <Field label={L("الحساب (فارغ = حساب الدخل)", "Account (empty = the P&L account)")}><Select value={cancelAccountId} onChange={(e) => setCancelAccountId(e.target.value)} data-testid="def-cancel-account">
              <option value="">{accName(detail.plAccount, ar)}</option>
              {(tpl.data?.accounts ?? []).filter((a) => a.id !== detail.balanceAccount.id && a.id !== detail.plAccount.id).map((a) => <option key={a.id} value={a.id}>{accName(a, ar)}</option>)}
            </Select></Field> : null}
            </> : <p className="acct-hint" data-testid="def-cancel-needs-post">{L("إثبات الباقي الآن: ", "Recognise the remainder now: ")}{L(NEEDS_POST[0], NEEDS_POST[1])}</p>}
            <label className="acct-toggle"><input type="radio" name="def-cancel" checked={cancelMode === "KEEP"} onChange={() => setCancelMode("KEEP")} data-testid="def-cancel-keep" /><span><b>{L("إبقاء في الحساب", "Keep it on the account")}</b><span className="acct-hint">{L("بلا قيد؛ يبقى الباقي في الحساب وفي المطابقة. الملاحظة مطلوبة.", "No entry; the remainder stays on the account and in the reconciliation. A note is required.")}</span></span></label>
            <Field label={cancelMode === "KEEP" ? L("الملاحظة (مطلوبة، تُسجَّل)", "Note (required, recorded)") : L("سبب الإلغاء (يُسجَّل)", "Reason (recorded)")}><textarea className="hr-input hr-textarea" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} data-testid="def-cancel-reason" /></Field>
          </fieldset> : null}
        </> : null}
      </Dialog>
    </section>
  );
}

function TemplatesView({ can }: { can: boolean }) {
  const { L, ar } = useLang();
  const t = useApi<Templates>("/api/accounting/deferrals/templates");
  const w = useWrite();
  const [open, setOpen] = useState(false);
  const empty = { nameAr: "", nameEn: "", kind: "PREPAID_EXPENSE", months: "12", startRule: "START_MONTH", plAccountId: "", balanceAccountId: "" };
  const [form, setForm] = useState(empty);
  const types = form.kind === "PREPAID_EXPENSE" ? { pl: "EXPENSE", bs: "ASSET" } : { pl: "REVENUE", bs: "LIABILITY" };
  const role = t.data?.roles[form.kind === "PREPAID_EXPENSE" ? "PREPAID_EXPENSES" : "DEFERRED_REVENUE"] ?? null;
  async function create() {
    const r = await w.run("create", "/api/accounting/deferrals/templates", "POST", { ...form, months: Number(form.months), nameEn: form.nameEn || null, balanceAccountId: form.balanceAccountId || null }, L("أُنشئ القالب.", "The template is created."));
    if (r) { setOpen(false); setForm(empty); t.reload(); }
  }
  async function toggle(x: Template) {
    if (await w.run("toggle", `/api/accounting/deferrals/templates/${x.id}`, "PATCH", { isActive: !x.isActive }, x.isActive ? L("أُوقف القالب.", "Deactivated.") : L("فُعّل القالب.", "Activated."))) t.reload();
  }
  return (
    <section className="acct-card" data-testid="def-templates">
      <Msg error={w.error ?? t.error} done={w.done} onClose={() => { w.setError(null); w.setDone(null); }} />
      <div className="acct-foot" style={{ borderTop: 0, paddingTop: 0 }}>
        <span className="acct-hint">{L("تعديل القالب يؤثر على الجداول الجديدة فقط؛ كل جدول يحتفظ بنسخته. ", "Editing a template affects new schedules only; each schedule keeps its own copy. ")}<span data-testid="def-usage-note">{L(DEFERRED_SCOPE[0], DEFERRED_SCOPE[1])}</span></span>
        {can ? <Btn variant="primary" disabled={!t.data?.accounts.length} onClick={() => setOpen(true)} data-testid="def-new-template">{L("قالب جديد", "New template")}</Btn> : null}
      </div>
      {t.data && !t.data.accounts.length ? <p className="acct-hint">{L("لا دليل حسابات بعد: هيّئ دليل الحسابات أولًا من الإعدادات.", "No chart of accounts yet: seed the chart first (Settings).")}</p> : null}
      {!t.data ? <OpsLoading /> : t.data.templates.length === 0 ? <OpsEmpty title={L("لا قوالب تأجيل", "No deferral template")} body={L("مثال: «إيجار سنوي مقدم» 12 شهرًا من شهر البدء، أو «اشتراك سنوي» إيراد مؤجل.", "E.g. «annual rent paid upfront» over 12 months, or «annual subscription» as deferred revenue.")} /> : (
        <div className="hr-tablewrap">
          <table className="hr-table" data-testid="def-template-list">
            <thead><tr><th>{L("القالب", "Template")}</th><th>{L("النوع", "Kind")}</th><th className="num">{L("الأشهر", "Months")}</th><th className="acct-hide-m">{L("قاعدة البدء", "Start rule")}</th><th className="acct-hide-m">{L("حساب الميزانية", "Balance sheet")}</th><th className="acct-hide-m">{L("حساب الدخل", "P&L")}</th><th>{L("الحالة", "Status")}</th></tr></thead>
            <tbody>{t.data.templates.map((x) => (
              <tr key={x.id} data-testid={`def-template-${x.id}`}>
                <td>{ar ? x.nameAr : x.nameEn ?? x.nameAr}<span className="acct-sub">{L(`${x.schedules} جدول`, `${x.schedules} schedule(s)`)}</span></td>
                <td>{L(KIND_LABEL[x.kind][0], KIND_LABEL[x.kind][1])}</td>
                <td className="num hr-num">{x.months}</td>
                <td className="acct-hide-m">{L(RULE_LABEL[x.startRule][0], RULE_LABEL[x.startRule][1])}</td>
                <td className="acct-hide-m">{accName(x.balanceAccount, ar)}{x.balanceFromRole ? <span className="acct-sub">{L("حساب الدور", "the role's account")}</span> : null}</td>
                <td className="acct-hide-m">{accName(x.plAccount, ar)}</td>
                <td>{can ? <Btn size="sm" variant="ghost" busy={w.busy === "toggle"} onClick={() => toggle(x)}>{x.isActive ? L("نشط · إيقاف", "Active · deactivate") : L("موقوف · تفعيل", "Inactive · activate")}</Btn> : x.isActive ? L("نشط", "Active") : L("موقوف", "Inactive")}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <Dialog open={open} title={L("قالب تأجيل جديد", "New deferral template")} onClose={() => setOpen(false)}
        actions={<><Btn variant="primary" busy={w.busy === "create"} disabled={!form.nameAr.trim() || !form.plAccountId || !(Number(form.months) >= 1 && Number(form.months) <= 120) || (!form.balanceAccountId && !role)} onClick={create} data-testid="def-template-create">{L("إنشاء القالب", "Create the template")}</Btn><Btn onClick={() => setOpen(false)}>{L("إلغاء", "Cancel")}</Btn></>}>
        <Msg error={w.error} />
        <Field label={L("الاسم", "Name")}><input className="hr-input" maxLength={120} value={form.nameAr} onChange={(e) => setForm({ ...form, nameAr: e.target.value })} data-testid="def-tpl-name" /></Field>
        <Field label={L("الاسم بالإنجليزية (اختياري)", "English name (optional)")}><input className="hr-input" dir="ltr" maxLength={120} value={form.nameEn} onChange={(e) => setForm({ ...form, nameEn: e.target.value })} /></Field>
        <div className="acct-row">
          <Field label={L("النوع", "Kind")}><Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value, plAccountId: "", balanceAccountId: "" })} data-testid="def-tpl-kind">
            {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{L(v[0], v[1])}</option>)}
          </Select></Field>
          <Field label={L("عدد الأشهر", "Months")}><input className="hr-input" dir="ltr" inputMode="numeric" value={form.months} onChange={(e) => setForm({ ...form, months: e.target.value.replace(/\D/g, "").slice(0, 3) })} data-testid="def-tpl-months" /></Field>
        </div>
        {form.kind === "DEFERRED_REVENUE" ? <p className="acct-hint" data-testid="def-tpl-scope">{L(DEFERRED_SCOPE[0], DEFERRED_SCOPE[1])}</p> : null}
        <Field label={L("قاعدة البدء", "Start rule")} help={form.startRule === "DAILY_PRORATA" ? L(PRORATA_HELP[0], PRORATA_HELP[1]) : L("من شهر البدء: يُحتسب شهر البدء شهرًا كاملًا. من الشهر التالي: يبدأ الاعتراف بعد شهر البدء.", "From the start month: the start month counts as a full month. From the next month: recognition starts after the start month.")}><Select value={form.startRule} onChange={(e) => setForm({ ...form, startRule: e.target.value })} data-testid="def-tpl-rule">
          {Object.entries(RULE_LABEL).map(([k, v]) => <option key={k} value={k}>{L(v[0], v[1])}</option>)}
        </Select></Field>
        <Field label={form.kind === "PREPAID_EXPENSE" ? L("حساب المصروف", "Expense account") : L("حساب الإيراد", "Revenue account")}><Select value={form.plAccountId} onChange={(e) => setForm({ ...form, plAccountId: e.target.value })} data-testid="def-tpl-pl">
          <option value="">{L("اختر حسابًا", "Choose an account")}</option>
          {(t.data?.accounts ?? []).filter((a) => a.type === types.pl).map((a) => <option key={a.id} value={a.id}>{accName(a, ar)}</option>)}
        </Select></Field>
        <Field label={L("حساب الميزانية", "Balance-sheet account")} help={role ? L(`فارغ = حساب الدور ${accName(role, true)}`, `Empty = the role's account ${accName(role, false)}`) : L("الدور غير مربوط: اختر حسابًا أو اربط الدور في الإعدادات.", "The role is not mapped: choose an account or map the role in Settings.")}>
          <Select value={form.balanceAccountId} onChange={(e) => setForm({ ...form, balanceAccountId: e.target.value })} data-testid="def-tpl-bs">
            <option value="">{role ? L("حساب الدور", "The role's account") : "—"}</option>
            {(t.data?.accounts ?? []).filter((a) => a.type === types.bs).map((a) => <option key={a.id} value={a.id}>{accName(a, ar)}</option>)}
          </Select>
        </Field>
      </Dialog>
    </section>
  );
}

function RunsView({ canReverse, focus, onChange }: { canReverse: boolean; focus: string | null; onChange: () => void }) {
  const { L } = useLang();
  const runs = useApi<{ items: Run[] }>("/api/accounting/deferrals/runs");
  const w = useWrite();
  const [target, setTarget] = useState<Run | null>(null);
  const [reason, setReason] = useState("");
  async function reverse() {
    if (!target) return;
    const r = await w.run("rev", `/api/accounting/deferrals/runs/${target.id}/reverse`, "POST", { reason }, L("عُكس التشغيل وعادت أشهره غير معترف بها.", "Reversed; its months are pending again."));
    if (r) { setTarget(null); setReason(""); runs.reload(); onChange(); }
  }
  return (
    <section className="acct-card" data-testid="def-runs">
      <Msg error={w.error ?? runs.error} done={w.done} onClose={() => { w.setError(null); w.setDone(null); }} />
      {!runs.data ? <OpsLoading /> : runs.data.items.length === 0 ? <OpsEmpty title={L("لا تشغيلات بعد", "No run yet")} body={L("شغّل الاعتراف الشهري لشهر مستحق.", "Run the monthly recognition for a due month.")} /> : (
        <div className="hr-tablewrap">
          <table className="hr-table" data-testid="def-run-list">
            <thead><tr><th>{L("الشهر", "Month")}</th><th>{L("الحالة", "Status")}</th><th>{L("القيد", "Entry")}</th><th className="num">{L("الأسطر", "Lines")}</th><th className="num">{L("المبلغ", "Amount")}</th><th>{L("الإجراء", "Action")}</th></tr></thead>
            <tbody>{runs.data.items.map((r) => (
              <tr key={r.id} aria-current={focus === r.id ? "true" : undefined} className={focus === r.id ? "is-sub" : undefined} data-testid={`def-runrow-${r.month}`}>
                <td className="hr-num">{r.month}<span className="acct-sub">{r.entryDate}</span></td>
                <td><StatusTag map={RUN_STATUS} value={r.status} />{r.reverseReason ? <span className="acct-sub">{r.reverseReason}</span> : null}</td>
                <td>{r.journalEntryId ? <Link className="acct-code" href={`/dashboard/accounting/journals/${r.journalEntryId}`}>{r.journalRef ?? L("القيد", "Entry")}</Link> : "—"}{r.reversalEntryId ? <> · <Link href={`/dashboard/accounting/journals/${r.reversalEntryId}`}>{L("قيد العكس", "Reversal")}</Link></> : null}</td>
                <td className="num hr-num">{r.lineCount}</td>
                <td className="num hr-num">{money(r.total)}</td>
                <td>{canReverse && r.status !== "REVERSED" ? <Btn size="sm" variant="ghost" onClick={() => setTarget(r)} data-testid={`def-reverse-${r.month}`}>{L("عكس", "Reverse")}</Btn> : null}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <Dialog open={!!target} title={L("عكس التشغيل", "Reverse the run")} sub={target?.month} onClose={() => setTarget(null)}
        actions={<><Btn variant="danger" busy={w.busy === "rev"} disabled={reason.trim().length < 3} onClick={reverse} data-testid="def-reverse-confirm">{L("عكس", "Reverse")}</Btn><Btn onClick={() => setTarget(null)}>{L("إلغاء", "Cancel")}</Btn></>}>
        <p>{L("يُعكس القيد بتاريخه نفسه (الفترة المقفلة ترفض)، وتعود أشهر التشغيل غير معترف بها لتُشغَّل من جديد.", "The entry is reversed on its own date (a closed period refuses), and the run's months return to pending.")}</p>
        <Field label={L("السبب (يُسجَّل)", "Reason (recorded)")}><textarea className="hr-input hr-textarea" value={reason} onChange={(e) => setReason(e.target.value)} data-testid="def-reverse-reason" /></Field>
      </Dialog>
    </section>
  );
}
