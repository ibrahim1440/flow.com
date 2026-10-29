"use client";

// «المعاملة المتكررة»: the rule and its next dates, what each run makes, the actions (edit, pause / resume, cancel,
// auto-post for journals — journal_post + step-up, «تشغيل المستحق الآن»), the runs with links to their documents and the
// failure reasons («إعادة المحاولة»), and the audit trail. The API re-checks every duty.
import Link from "next/link";
import { use, useState } from "react";
import { OpsLoading } from "@/components/ops/ui";
import { hasModuleAccess, hasSubPrivilege } from "@/lib/auth-shared";
import { FREQ_LABEL, KIND_LABEL, RUN_LABEL, STATUS_LABEL, errorIn, type RecurringStatus, type RunStatus } from "@/lib/accounting/recurring/shared";
import type { ScheduleDetail } from "@/lib/accounting/recurring/schedules";
import { useUser } from "../../../user-context";
import { AcctShell, Msg, money, useApi, useLang, useWrite, type Setup } from "../../_ui/shell";
import { RecurringForm, type RecurringValue } from "../../_ui/recurring-form";

type Detail = Omit<ScheduleDetail, "createdAt" | "updatedAt"> & { createdAt: string; updatedAt: string; people: Record<string, string> };
type Dims = { accounts: { id: string; code: string; nameAr: string | null; nameEn: string }[] };
const TONE: Record<RecurringStatus, string> = { ACTIVE: "success", PAUSED: "warning", COMPLETED: "neutral", CANCELLED: "cancelled" };
const RUN_TONE: Record<RunStatus, string> = { CREATED: "info", POSTED: "success", SKIPPED: "neutral", FAILED: "danger" };

const toValue = (s: Detail): RecurringValue => ({
  name: s.name, description: s.description ?? "", kind: s.kind, sourceType: s.sourceType, templateId: s.templateId ?? "", totalAmount: s.totalAmount ?? "",
  sourceEntryId: s.sourceEntryId ?? "", sourceInvoiceId: s.sourceInvoiceId ?? "", frequency: s.frequency, interval: String(s.interval), startDate: s.startDate,
  endMode: s.endDate ? "DATE" : s.maxOccurrences ? "COUNT" : "NONE", endDate: s.endDate ?? "", maxOccurrences: s.maxOccurrences ? String(s.maxOccurrences) : "",
});

export default function RecurringDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { L, lang } = useLang();
  const setup = useApi<Setup>("/api/accounting/setup");
  const q = useApi<Detail>(`/api/accounting/recurring/${id}`);
  const dims = useApi<Dims>("/api/accounting/dimensions");
  const user = useUser();
  const w = useWrite();
  const [editing, setEditing] = useState(false);
  const s = q.data;
  const can = setup.data?.can;
  const canSales = !!user && hasModuleAccess(user.permissions, "sales") && hasSubPrivilege(user.permissions, "sales", "invoices_create");
  const who = (x: string | null | undefined) => (x ? (x === "system:recurring" ? L("المجدول", "Scheduler") : s?.people[x] ?? x) : "—");
  const acc = (aid: string) => { const a = dims.data?.accounts.find((x) => x.id === aid); return a ? `${a.code} · ${L(a.nameAr ?? a.nameEn, a.nameEn)}` : aid; };
  const at = (v: string | Date | null) => (v ? new Date(v).toLocaleString(lang === "en" ? "en-GB" : "ar-SA-u-nu-latn-ca-gregory", { timeZone: "Asia/Riyadh", dateStyle: "short", timeStyle: "short" }) : "—");
  const act = async (key: string, url: string, body: unknown, ok: string) => { if (await w.run(key, url, "POST", body, ok)) q.reload(); };
  const live = s && (s.status === "ACTIVE" || s.status === "PAUSED");

  return (
    <AcctShell setup={setup.data} title={s ? `${s.ref} · ${s.name}` : L("المعاملة المتكررة", "Recurring transaction")}
      meta={<Link href="/dashboard/accounting/recurring" className="acct-hint">→ {L("المعاملات المتكررة", "Recurring transactions")}</Link>}
      actions={s && can?.recurring && live && !editing ? (
        <span className="acct-actions">
          {s.status === "ACTIVE" ? <button type="button" className="hr-btn" disabled={!!w.busy} onClick={() => act("run", "/api/accounting/recurring/run-due", { scheduleIds: [s.id] }, L("شُغّل المستحق.", "Due runs done."))} data-testid="rec-run-one">{L("تشغيل المستحق الآن", "Run due now")}</button> : null}
          {can?.journalCreate ? <button type="button" className="hr-btn" disabled={!!w.busy} onClick={() => setEditing(true)} data-testid="rec-edit">{L("تعديل", "Edit")}</button> : null}
          <button type="button" className="hr-btn" disabled={!!w.busy} onClick={() => act("pause", `/api/accounting/recurring/${s.id}/pause`, { paused: s.status === "ACTIVE" }, s.status === "ACTIVE" ? L("أوقفت مؤقتًا.", "Paused.") : L("استؤنفت.", "Resumed."))} data-testid="rec-pause">{s.status === "ACTIVE" ? L("إيقاف مؤقت", "Pause") : L("استئناف", "Resume")}</button>
          <button type="button" className="hr-btn is-ghost" disabled={!!w.busy} onClick={() => { if (window.confirm(L("إلغاء المعاملة المتكررة؟ لا تُنشأ بعدها مستندات، ويبقى سجلها.", "Cancel this recurring transaction? No further documents are made; its history stays."))) void act("cancel", `/api/accounting/recurring/${s.id}/cancel`, {}, L("أُلغيت المعاملة.", "Cancelled.")); }} data-testid="rec-cancel">{L("إلغاء المعاملة", "Cancel")}</button>
        </span>
      ) : undefined}>
      <Msg error={w.error ?? q.error} done={w.done} onClose={() => { w.setError(null); w.setDone(null); }} />
      {!s ? <OpsLoading /> : editing ? (
        <RecurringForm initial={toValue(s)} id={s.id} expectedUpdatedAt={s.updatedAt} canSales={canSales} />
      ) : (
        <>
          <section className="acct-card" data-testid="rec-detail">
            <dl className="acct-kv-grid">
              <div><dt>{L("الحالة", "Status")}</dt><dd><span className={`hr-dot tone-${TONE[s.status as RecurringStatus]}`}><span data-testid="rec-status-text">{L(STATUS_LABEL[s.status as RecurringStatus][0], STATUS_LABEL[s.status as RecurringStatus][1])}</span></span></dd></div>
              <div><dt>{L("النوع", "Type")}</dt><dd>{L(KIND_LABEL[s.kind][0], KIND_LABEL[s.kind][1])}{s.template ? <> · <Link href="/dashboard/accounting/journal-templates">{s.template.name}</Link></> : s.payload.kind === "JOURNAL" && s.payload.sourceLabel ? ` · ${s.payload.sourceLabel}` : s.payload.kind === "SALES_INVOICE" ? ` · ${s.payload.sourceNumber ?? ""} ${s.payload.customerName}` : ""}</dd></div>
              <div><dt>{L("المبلغ في كل مرة", "Amount each time")}</dt><dd className="hr-num">{money(s.amount)} {L("ر.س", "SAR")}</dd></div>
              <div><dt>{L("التكرار", "Frequency")}</dt><dd>{L(FREQ_LABEL[s.frequency][0], FREQ_LABEL[s.frequency][1])}{s.interval > 1 ? L(` · كل ${s.interval}`, ` · every ${s.interval}`) : ""}</dd></div>
              <div><dt>{L("البدء", "Starts")}</dt><dd className="hr-num">{s.startDate}</dd></div>
              <div><dt>{L("الانتهاء", "Ends")}</dt><dd className="hr-num">{s.endDate ?? (s.maxOccurrences ? L(`بعد ${s.maxOccurrences} مرة`, `after ${s.maxOccurrences}`) : L("بلا نهاية", "Never"))}</dd></div>
              <div><dt>{L("تاريخ التكرار التالي", "Next date")}</dt><dd className="hr-num" data-testid="rec-next">{s.nextRunDate ?? "—"}</dd></div>
              <div><dt>{L("أنشأها", "Created by")}</dt><dd>{who(s.createdBy)} · {at(s.createdAt)}</dd></div>
              {s.kind === "JOURNAL" ? <div><dt>{L("الترحيل التلقائي", "Auto-post")}</dt><dd data-testid="rec-authorised">{s.autoPost && s.autoPostApprovedBy
                ? L(`فعّله ${who(s.autoPostApprovedBy)} في ${at(s.autoPostApprovedAt)}${s.autoPostSodBypass ? " (بنفسه — استثناء فصل مهام)" : ""}`, `Authorised by ${who(s.autoPostApprovedBy)} on ${at(s.autoPostApprovedAt)}${s.autoPostSodBypass ? " (own preparer — SoD exception)" : ""}`)
                : L("غير مفعّل · مسودات", "Off · drafts")}</dd></div> : null}
              {s.status === "PAUSED" ? <div><dt>{L("سبب الإيقاف", "Paused because")}</dt><dd data-testid="rec-pause-reason">{s.pauseReason ?? L(`أوقفها ${who(s.pausedBy)}`, `Paused by ${who(s.pausedBy)}`)}</dd></div> : null}
            </dl>
            {s.upcoming.length ? <p className="acct-hint">{L("القادمة:", "Upcoming:")} <span className="hr-num" dir="ltr">{s.upcoming.map((u) => u.date).join(" · ")}</span></p> : null}
          </section>

          {s.kind === "JOURNAL" ? (
            <section className="acct-card" data-testid="rec-autopost">
              <h3>{L("الترحيل التلقائي", "Auto-post")}</h3>
              {s.autoPost
                ? <p>{L(`مفعّل — يُرحَّل القيد في موعده دون مسودة. فعّله ${who(s.autoPostApprovedBy)} في ${at(s.autoPostApprovedAt)}.`, `On — the journal posts on its date with no draft. Authorised by ${who(s.autoPostApprovedBy)} on ${at(s.autoPostApprovedAt)}.`)}</p>
                : <p className="acct-hint">{L("غير مفعّل — كل تشغيل يُنشئ مسودة قيد تُقدَّم وتُعتمد وتُرحَّل كالمعتاد.", "Off — each run creates a journal draft that is submitted, approved and posted as usual.")}</p>}
              <p className="acct-hint">{L("يفعّله من يملك صلاحية ترحيل القيود مع تأكيد الهوية، ولا يفعّله مُعدّ المعاملة إن منع إعداد فصل المهام ذلك. أي تعديل على المعاملة يلغيه.", "Switched on by someone who may post journals, with a step-up; not by the transaction's preparer when the SoD setting forbids it. Any edit withdraws it.")}</p>
              {live ? (s.autoPost
                ? (can?.recurring ? <span><button type="button" className="hr-btn" disabled={!!w.busy} onClick={() => act("ap", `/api/accounting/recurring/${s.id}/auto-post`, { on: false }, L("أُلغي الترحيل التلقائي.", "Auto-post withdrawn."))} data-testid="rec-autopost-off">{L("إلغاء الترحيل التلقائي", "Withdraw auto-post")}</button></span> : null)
                : (can?.recurring && can?.journalPost ? <span><button type="button" className="hr-btn is-primary" disabled={!!w.busy} onClick={() => act("ap", `/api/accounting/recurring/${s.id}/auto-post`, { on: true, expectedUpdatedAt: s.updatedAt }, L("فُعّل الترحيل التلقائي.", "Auto-post authorised."))} data-testid="rec-autopost-on">{L("تفعيل الترحيل التلقائي", "Authorise auto-post")}</button></span> : null)) : null}
            </section>
          ) : null}

          <section className="acct-card">
            <h3>{L("ما يُنشأ في كل مرة", "What each run makes")}</h3>
            {s.payload.kind === "JOURNAL" ? (
              <div className="hr-tablewrap">
                <table className="hr-table is-dense" data-testid="rec-lines">
                  <thead><tr><th>{L("الحساب", "Account")}</th><th>{L("البيان", "Memo")}</th><th className="num">{L("مدين", "Debit")}</th><th className="num">{L("دائن", "Credit")}</th></tr></thead>
                  <tbody>{s.payload.lines.map((l, i) => <tr key={i}><td>{acc(l.accountId)}</td><td>{l.description ?? "—"}</td><td className="num hr-num">{money(l.debit, true)}</td><td className="num hr-num">{money(l.credit, true)}</td></tr>)}</tbody>
                </table>
              </div>
            ) : (
              <div className="hr-tablewrap">
                <table className="hr-table is-dense" data-testid="rec-lines">
                  <thead><tr><th>{L("البند", "Line")}</th><th className="num">{L("الكمية", "Qty")}</th><th className="num">{L("سعر الوحدة", "Unit price")}</th><th>{L("الضريبة", "VAT")}</th></tr></thead>
                  <tbody>{s.payload.lines.map((l, i) => <tr key={i}><td>{l.description}</td><td className="num hr-num">{l.quantity}</td><td className="num hr-num">{money(l.unitPrice)}</td><td className="hr-num">{l.taxCategory} {l.taxRatePercent}٪</td></tr>)}</tbody>
                </table>
              </div>
            )}
          </section>

          <section className="acct-card" id="runs" data-testid="rec-runs">
            <h3>{L("سجل التشغيل", "Runs")}</h3>
            {s.runs.length === 0 ? <p className="acct-hint">{L("لم يُشغَّل بعد.", "Not run yet.")}</p> : (
              <div className="hr-tablewrap">
                <table className="hr-table is-dense is-mrow">
                  <thead><tr><th>{L("تاريخ الاستحقاق", "Due date")}</th><th>{L("النتيجة", "Result")}</th><th>{L("المستند", "Document")}</th><th>{L("السبب", "Reason")}</th><th>{L("شغّله", "Run by")}</th><th><span className="hr-sr">{L("إجراء", "Action")}</span></th></tr></thead>
                  <tbody>
                    {s.runs.map((r) => (
                      <tr key={r.id} data-testid={`rec-run-${r.dueDate}`}>
                        <td className="m-title"><span className="hr-num">{r.dueDate}</span><span className="hr-msub acct-show-m">{r.document ? r.document.ref ?? L("مسودة", "Draft") : ""} {r.status === "FAILED" ? errorIn(r.errorMessage, lang === "en" ? "en" : "ar") : ""}</span></td>
                        <td className="m-end"><span className={`hr-dot tone-${RUN_TONE[r.status as RunStatus]}`}><span>{L(RUN_LABEL[r.status as RunStatus][0], RUN_LABEL[r.status as RunStatus][1])}</span></span>{r.attempts > 1 ? <span className="hr-msub">{L(`${r.attempts} محاولات`, `${r.attempts} attempts`)}</span> : null}{r.autoPost ? <span className="hr-msub">{L(`ترحيل تلقائي · ${who(r.autoPostBy)}`, `Auto-post · ${who(r.autoPostBy)}`)}</span> : null}</td>
                        <td>{r.document ? <Link href={r.document.href} className="acct-code">{r.document.ref ?? L("مسودة", "Draft")}</Link> : "—"}</td>
                        <td className="hr-caption">{r.status === "FAILED" ? errorIn(r.errorMessage, lang === "en" ? "en" : "ar") : r.skipReason === "BEFORE_GO_LIVE" ? L("قبل تاريخ بدء المحاسبة", "Before the go-live date") : r.skipReason === "NOT_ACTIVE" ? L("المحاسبة غير مفعّلة", "Accounting not activated") : ""}</td>
                        <td>{who(r.actorId)} · <span className="hr-num">{at(r.updatedAt)}</span></td>
                        <td className="ops-actions">{r.status === "FAILED" && can?.recurring && s.status !== "CANCELLED" ? <button type="button" className="hr-btn is-sm" disabled={!!w.busy} onClick={() => act(`r-${r.id}`, `/api/accounting/recurring/runs/${r.id}/retry`, {}, L("أُعيدت المحاولة.", "Retried."))} data-testid={`rec-retry-${r.dueDate}`}>{L("إعادة المحاولة", "Retry")}</button> : null}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="acct-card" data-testid="rec-audit">
            <h3>{L("سجل التدقيق", "Audit trail")}</h3>
            {s.audit.length === 0 ? <p className="acct-hint">—</p> : (
              <ul className="acct-kv">
                {s.audit.map((a) => <li key={a.id} className="hr-caption"><span className="hr-num">{at(a.at)}</span> · {who(a.actorId)} · {a.entityType === "RecurringRun" ? L("تشغيل", "Run") : L("المعاملة", "Transaction")} {a.action}{a.changed.length ? ` (${a.changed.join(", ")})` : ""}{a.reason ? ` — ${a.reason}` : ""}</li>)}
              </ul>
            )}
          </section>
        </>
      )}
    </AcctShell>
  );
}
