"use client";
// «مساحة عملي · اليوم» (Figma Phase 11 · WS-01, 1740:150 / 1740:593 / 1740:180340). What needs action,
// in the order it needs it — overdue, my decisions, due today, in progress — with one named action per
// row, and today's schedule beside it. Not a gallery of cards: four small counters that filter.
import Link from "next/link";
import { Fragment, useMemo, useState } from "react";
import { Btn, Notice, OpsBanner, OpsEmpty, OpsError, OpsLoading, useL } from "@/components/ops/ui";
import { dayOf, dueLabel, greeting, overdueBy, timeOf, ago } from "@/lib/workspace/format";
import { DueText, PriorityMark, TypeChip, approvalTitle, WsPage, WsShell, recordOf, useLang, useNow, useSelection, useWs, type ApprovalItem, type Appointment, type CrmDue, type QuoteDue, type ReorderDue, type Task } from "./_components/kit";
import { CreateTaskDialog, CrmResultDialog, ReorderCallDialog, TaskPane } from "./_components/task-ui";
import { useUser } from "../user-context";
import { DecisionPane } from "./_components/approval-ui";
import { AppointmentDialog } from "./_components/calendar-ui";
import { PendingRequestsCard } from "./_components/pending-requests";

type Today = {
  now: string; day: string;
  counts: { overdue: number; dueToday: number; approvals: number; review: number };
  nextAppointment: { id: string; title: string; kind: string; startAt: string; endAt: string; location: string | null } | null;
  tasks: Task[]; review: Task[]; approvals: ApprovalItem[]; approvalsUnavailable: string[]; crm: CrmDue[]; quotes?: QuoteDue[]; reorder?: ReorderDue[];
  schedule: Appointment[]; upcoming: Appointment[];
};
type Row =
  | { kind: "task"; key: string; group: string; at: string; task: Task }
  | { kind: "approval"; key: string; group: string; at: string; item: ApprovalItem }
  | { kind: "crm"; key: string; group: string; at: string; crm: CrmDue }
  | { kind: "quote"; key: string; group: string; at: string; quote: QuoteDue }
  | { kind: "appt"; key: string; group: string; at: string; appt: Appointment };

const ACTION: Record<string, [string, string]> = { start: ["بدء المهمة", "Start"], resume: ["استئناف", "Resume"], complete: ["إكمال", "Complete"], record_result: ["تسجيل النتيجة", "Record result"], approve_review: ["مراجعة الإنجاز", "Review"] };

export default function TodayPage() {
  const L = useL();
  const lang = useLang();
  const now = useNow();
  const { data, error, loading, reload } = useWs<Today>("/api/workspace/today");
  const me = { data: { user: useUser() } };
  const [taskId, setTaskId] = useSelection("task");
  const [approvalKey, setApprovalKey] = useSelection("approval");
  const [creating, setCreating] = useState(false);
  const [newAppt, setNewAppt] = useState(false);
  const [filter, setFilter] = useState<"" | "overdue" | "today" | "approvals">("");
  const [toast, setToast] = useState<string | null>(null);
  const [showLater, setShowLater] = useState(false);
  const [crmResult, setCrmResult] = useState<CrmDue | null>(null);
  const [reorderCall, setReorderCall] = useState<ReorderDue | null>(null);

  const rows = useMemo<Row[]>(() => {
    if (!data) return [];
    const out: Row[] = [];
    const g = (t: { overdue?: boolean; bucket?: string | null; status?: string }) =>
      t.overdue ? "overdue" : t.bucket === "TODAY" ? (t.status === "IN_PROGRESS" ? "progress" : "today") : t.status === "IN_PROGRESS" ? "progress" : "later";
    for (const t of data.tasks) out.push({ kind: "task", key: `t:${t.id}`, group: g(t), at: t.dueAt, task: t });
    for (const t of data.review) out.push({ kind: "task", key: `r:${t.id}`, group: "decide", at: t.dueAt, task: t });
    for (const a of data.approvals) out.push({ kind: "approval", key: `a:${a.key}`, group: "decide", at: a.createdAt, item: a });
    for (const c of data.crm) {
      const late = new Date(c.dueAt) < now;
      const today = dueLabel(c.dueAt, lang, now).startsWith(lang === "ar" ? "اليوم" : "Today");
      out.push({ kind: "crm", key: `c:${c.id}`, group: late ? "overdue" : today ? "today" : "later", at: c.dueAt, crm: c });
    }
    for (const q of data.quotes ?? []) {
      const late = new Date(q.dueAt) < now;
      const today = dueLabel(q.dueAt, lang, now).startsWith(lang === "ar" ? "اليوم" : "Today");
      out.push({ kind: "quote", key: `q:${q.id}`, group: late ? "overdue" : today ? "today" : "later", at: q.dueAt, quote: q });
    }
    for (const a of data.schedule) if (new Date(a.endAt) > now) out.push({ kind: "appt", key: `p:${a.id}`, group: "today", at: a.startAt, appt: a });
    // Within a group: what is urgent first (an URGENT / HIGH task before a NORMAL one), then the
    // longest-waiting — not the order things were created in.
    const weight = (r: Row) => (r.kind === "task" ? ({ URGENT: 0, HIGH: 1 } as Record<string, number>)[r.task.priority] ?? 2 : 2);
    return out.sort((x, y) => weight(x) - weight(y) || x.at.localeCompare(y.at));
  }, [data, now, lang]);

  const groups: { key: string; title: string }[] = [
    { key: "overdue", title: L("متأخرة", "Overdue") }, { key: "decide", title: L("بانتظار قراري", "Waiting for my decision") },
    { key: "today", title: L("مستحقة اليوم", "Due today") }, { key: "progress", title: L("قيد التنفيذ", "In progress") },
  ];
  const visible = (r: Row) => !filter || (filter === "overdue" ? r.group === "overdue" : filter === "today" ? r.group === "today" : r.group === "decide");
  const later = rows.filter((r) => r.group === "later");
  const [heldApproval, setHeldApproval] = useState<ApprovalItem | null>(null);
  const selectedApproval = data?.approvals.find((a) => a.key === approvalKey) ?? (heldApproval && heldApproval.key === approvalKey ? heldApproval : null);
  const name = me.data?.user?.name?.split(" ")[0];
  const changed = (msg?: string) => { if (msg) setToast(msg); reload(); };

  const actions = (
    <>
      <Btn variant="primary" onClick={() => setCreating(true)} data-testid="ws-new-task">{L("مهمة جديدة", "New task")}</Btn>
      <Btn onClick={() => setNewAppt(true)}>{L("موعد جديد", "New appointment")}</Btn>
    </>
  );

  const rowView = (r: Row) => {
    if (r.kind === "task") {
      const t = r.task;
      // The meaningful next step first: a follow-up's result, a review, then resume / start / complete.
      const main = ["record_result", "approve_review", "resume", "start", "complete"].find((a) => t.actions.includes(a));
      return (
        <li key={r.key} className="ws-row">
          <TypeChip type={t.kind} />
          <button type="button" className="ws-row-main" onClick={() => setTaskId(t.id)} aria-label={L(`فتح المهمة: ${t.title}`, `Open task: ${t.title}`)}>
            <span className="ws-row-title">{t.title}</span>
            <span className="ws-row-meta">
              {recordOf(t) ? <span>{recordOf(t)}</span> : null}
              {t.createdById !== t.assigneeId ? <span>{L("من", "from")} {t.createdBy.name}</span> : null}
              <DueText dueAt={t.dueAt} overdue={t.overdue} now={now} />
              <PriorityMark priority={t.priority} />
            </span>
          </button>
          {main ? <Btn size="sm" onClick={() => setTaskId(t.id)}>{L(...ACTION[main])}</Btn> : <Btn size="sm" variant="ghost" onClick={() => setTaskId(t.id)}>{L("فتح", "Open")}</Btn>}
        </li>
      );
    }
    if (r.kind === "approval") {
      const a = r.item;
      return (
        <li key={r.key} className="ws-row">
          <TypeChip type={a.type} />
          <button type="button" className="ws-row-main" onClick={() => setApprovalKey(a.key)}>
            <span className="ws-row-title">{approvalTitle(a, lang)}</span>
            <span className="ws-row-meta"><span>{a.requester}</span><span>{ago(a.createdAt, lang, now)}</span>{a.warnings.length ? <span className="hr-flag tone-warning"><span>{lang === "ar" ? a.warnings[0].ar : a.warnings[0].en}</span></span> : null}</span>
          </button>
          <Btn size="sm" variant="primary" onClick={() => setApprovalKey(a.key)}>{L("مراجعة واعتماد", "Review & decide")}</Btn>
        </li>
      );
    }
    if (r.kind === "crm") {
      // Customer · the action asked for · when, and the action itself as the button (recorded in place).
      const c = r.crm;
      const late = new Date(c.dueAt) < now;
      return (
        <li key={r.key} className="ws-row">
          <TypeChip type={c.type === "SAMPLE_FOLLOW_UP" ? "CRM" : ["CALL", "VISIT", "MEETING"].includes(c.type) ? c.type : "CRM"} />
          <Link className="ws-row-main" href={c.openUrl}>
            <span className="ws-row-title">{(lang === "ar" ? c.record : c.recordEn ?? c.record) ?? c.subject}</span>
            <span className="ws-row-meta"><span>{L(c.action.ar, c.action.en)}</span>{c.record && c.subject !== c.record ? <span>{c.subject}</span> : null}<span className={`ws-due${late ? " is-overdue" : ""}`}>{late ? overdueBy(c.dueAt, lang, now) : dueLabel(c.dueAt, lang, now)}</span></span>
          </Link>
          {c.canRecord
            ? <Btn size="sm" onClick={() => setCrmResult(c)} data-testid={`crm-result-${c.id}`}>{L("تسجيل النتيجة", "Record result")}</Btn>
            : <Link className="hr-btn is-sm" href={c.openUrl}>{L("فتح في المبيعات", "Open in Sales")}</Link>}
        </li>
      );
    }
    if (r.kind === "quote") {
      const q = r.quote;
      const late = new Date(q.dueAt) < now;
      return (
        <li key={r.key} className="ws-row">
          <TypeChip type="QUOTE" />
          <Link className="ws-row-main" href={q.openUrl}>
            <span className="ws-row-title">{(lang === "ar" ? q.record : q.recordEn ?? q.record) ?? q.deal}</span>
            <span className="ws-row-meta"><span>{L("متابعة رد العميل على العرض", "Follow up the customer's answer")} {q.quoteNumber}</span>{q.validUntil ? <span>{L("صالح حتى", "valid until")} {dayOf(new Date(q.validUntil), lang, now)}</span> : null}<span className={`ws-due${late ? " is-overdue" : ""}`}>{late ? overdueBy(q.dueAt, lang, now) : dueLabel(q.dueAt, lang, now)}</span></span>
          </Link>
          <Link className="hr-btn is-sm" href={q.openUrl}>{L("متابعة العرض", "Follow up")}</Link>
        </li>
      );
    }
    const a = r.appt;
    return (
      <li key={r.key} className="ws-row">
        <TypeChip type={a.kind} />
        <Link className="ws-row-main" href={`/dashboard/workspace/calendar?appointment=${a.id}`}>
          <span className="ws-row-title">{a.title}</span>
          <span className="ws-row-meta">{a.customer?.name ? <span>{a.customer.name}</span> : null}{a.location ? <span>{a.location}</span> : null}<span className="ws-due">{dueLabel(a.startAt, lang, now)}</span></span>
        </Link>
        <Link className="hr-btn is-sm is-ghost" href={`/dashboard/workspace/calendar?appointment=${a.id}`}>{L("فتح", "Open")}</Link>
      </li>
    );
  };

  return (
    <WsShell open={!!(taskId || selectedApproval)}>
      <WsPage title={name ? `${greeting(lang, now)}${L("، ", ", ")}${name}` : L("اليوم", "Today")} sub={<span className="hr-caption">{dayOf(now, lang, now)}</span>} actions={actions} testId="ws-today">
        {toast ? <OpsBanner tone="success" onClose={() => setToast(null)}>{toast}</OpsBanner> : null}
        {error ? <OpsError message={error.message} onRetry={reload} /> : null}
        {loading && !data ? <OpsLoading /> : null}
        {data ? (
          <>
            {data.approvalsUnavailable.length ? <Notice tone="warning">{L("تعذّر تحميل بعض طلبات الاعتماد الآن؛ أعد المحاولة بعد قليل.", "Some approvals could not be loaded right now; try again shortly.")}</Notice> : null}
            <div className="ws-counters" role="group" aria-label={L("ملخص اليوم", "Today at a glance")}>
              <button type="button" aria-pressed={filter === "overdue"} className={`ws-counter${data.counts.overdue ? " is-danger" : ""}`} onClick={() => setFilter((f) => (f === "overdue" ? "" : "overdue"))} data-testid="count-overdue">
                <span>{data.counts.overdue ? <span aria-hidden="true">● </span> : null}{L("متأخرة", "Overdue")}</span><b>{data.counts.overdue}</b>
              </button>
              <button type="button" aria-pressed={filter === "today"} className="ws-counter" onClick={() => setFilter((f) => (f === "today" ? "" : "today"))}>
                <span>{L("مستحقة اليوم", "Due today")}</span><b>{data.counts.dueToday}</b>
              </button>
              <button type="button" aria-pressed={filter === "approvals"} className="ws-counter" onClick={() => setFilter((f) => (f === "approvals" ? "" : "approvals"))}>
                <span>{L("بانتظار قراري", "Waiting for me")}</span><b>{data.counts.approvals + data.counts.review}</b>
              </button>
              {data.nextAppointment ? (
                <Link className="ws-counter is-wide" href={`/dashboard/workspace/calendar?appointment=${data.nextAppointment.id}`}>
                  <span>{L("الموعد القادم", "Next appointment")}</span><b className="ws-counter-text">{timeOf(data.nextAppointment.startAt, lang)} · {data.nextAppointment.title}</b>
                </Link>
              ) : <div className="ws-counter is-wide is-static"><span>{L("الموعد القادم", "Next appointment")}</span><b className="ws-counter-text">{L("لا مواعيد قادمة", "None scheduled")}</b></div>}
            </div>

            <div className="ws-today">
              <section className="ws-list" aria-labelledby="ws-need">
                <h2 id="ws-need" className="hr-section">{L("يحتاج تصرفك", "Needs your action")} <span className="hr-caption">· {rows.filter((r) => r.group !== "later").length}</span></h2>
                {rows.filter((r) => r.group !== "later").length === 0 ? (
                  <OpsEmpty title={L("لا شيء يحتاج تصرفك الآن", "Nothing needs your action now")} body={L("ستظهر هنا المهام المستحقة والطلبات التي تنتظر قرارك.", "Due work and decisions waiting for you appear here.")} action={<Btn onClick={() => setCreating(true)}>{L("أنشئ مهمة", "Create a task")}</Btn>} />
                ) : groups.map((g) => {
                  const list = rows.filter((r) => r.group === g.key && visible(r));
                  if (!list.length) return null;
                  return (
                    <div key={g.key} className={`ws-group is-${g.key}`}>
                      <h3 className="ws-group-title">{g.title}</h3>
                      <ul className="ws-rows">{list.map(rowView)}</ul>
                    </div>
                  );
                })}
                {later.length && !filter ? (
                  <div className="ws-group">
                    <button type="button" className="ws-more" aria-expanded={showLater} onClick={() => setShowLater((v) => !v)}>{showLater ? "▾" : "▸"} {L("الأيام السبعة القادمة", "Next seven days")} · {later.length}</button>
                    {showLater ? <ul className="ws-rows">{later.map(rowView)}</ul> : null}
                  </div>
                ) : null}
                {data.reorder?.length && !filter ? <ReorderList items={data.reorder} onCall={setReorderCall} /> : null}
              </section>

              <div className="ws-side">
                <aside className="ws-schedule" aria-labelledby="ws-sched">
                  <h2 id="ws-sched" className="hr-section">{L("جدول اليوم", "Today's schedule")}</h2>
                  <ScheduleList data={data} now={now} />
                </aside>
                {/* The person's own pending HR requests — followed in «خدماتي», shown here only as a pointer. */}
                <PendingRequestsCard now={now} />
              </div>
            </div>
          </>
        ) : null}
      </WsPage>

      {taskId ? <TaskPane id={taskId} onClose={() => setTaskId(null)} onChanged={changed} /> : null}
      {!taskId && selectedApproval ? <DecisionPane item={selectedApproval} onClose={() => { setApprovalKey(null); setHeldApproval(null); }} onDecided={(m, it) => { if (m) { setToast(m); setHeldApproval(it); } reload(); }} /> : null}
      {creating ? <CreateTaskDialog onClose={() => setCreating(false)} onCreated={(t, m) => { setCreating(false); setToast(m); reload(); setTaskId(t.id); }} /> : null}
      {reorderCall ? <ReorderCallDialog item={reorderCall} onClose={() => setReorderCall(null)} onDone={(m) => { setReorderCall(null); setToast(m); reload(); }} /> : null}
      {crmResult ? <CrmResultDialog crm={crmResult} onClose={() => setCrmResult(null)} onDone={(m) => { setCrmResult(null); setToast(m); reload(); }} /> : null}
      {newAppt ? <AppointmentDialog onClose={() => setNewAppt(false)} onSaved={(m) => { setNewAppt(false); setToast(m); reload(); }} /> : null}
    </WsShell>
  );
}

const REORDER_STATE: Record<ReorderDue["state"], [string, string, string]> = {
  DUE: ["حان موعد إعادة الطلب", "Due to reorder", ""],
  LATE: ["متأخر عن موعده", "Late to reorder", " tone-warning"],
  INACTIVE: ["منقطع عن الشراء", "Stopped ordering", " tone-danger"],
};

/**
 * «عملاء يحتاجون اتصالاً»: suggestions from the account's own reorder rhythm — the customer, why (N days
 * since the last order against a usual N), what they usually take, and «تسجيل اتصال».
 */
function ReorderList({ items, onCall }: { items: ReorderDue[]; onCall: (r: ReorderDue) => void }) {
  const L = useL();
  const lang = useLang();
  return (
    <div className="ws-group is-reorder" data-testid="ws-reorder">
      <h3 className="ws-group-title">{L("عملاء يحتاجون اتصالاً", "Customers to call")} <span className="hr-caption">· {items.length}</span></h3>
      <ul className="ws-rows">
        {items.map((r) => {
          const [ar, en, tone] = REORDER_STATE[r.state];
          return (
            <li key={r.customerId} className="ws-row">
              <TypeChip type="CALL" />
              <Link className="ws-row-main" href={r.openUrl}>
                <span className="ws-row-title">{lang === "ar" ? r.name : r.nameEn}</span>
                <span className="ws-row-meta">
                  <span className={`hr-flag${tone}`}><span>{L(ar, en)}</span></span>
                  <span>{L(`آخر طلب قبل ${r.daysSince} يومًا · المعتاد كل ${r.intervalDays} يومًا`, `Last order ${r.daysSince} days ago · usually every ${r.intervalDays} days`)}</span>
                  {r.usualItems.length ? <span>{r.usualItems.join("، ")}</span> : null}
                </span>
              </Link>
              {r.canRecord ? <Btn size="sm" onClick={() => onCall(r)}>{L("تسجيل اتصال", "Log a call")}</Btn> : <Link className="hr-btn is-sm" href={r.openUrl}>{L("فتح", "Open")}</Link>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Appointments as blocks and timed deadlines as markers, with «الآن». */
function ScheduleList({ data, now }: { data: Today; now: Date }) {
  const L = useL();
  const lang = useLang();
  const dayEnd = new Date(new Date(`${data.day}T00:00:00+03:00`).getTime() + 86_400_000);
  const items = [
    ...data.schedule.map((a) => ({ at: a.startAt, node: (
      <li key={`a${a.id}`} className="ws-slot is-block"><span className="ws-slot-time">{timeOf(a.startAt, lang)}</span>
        <Link href={`/dashboard/workspace/calendar?appointment=${a.id}`} className="ws-slot-body"><b>{a.title}</b><span>{[a.location, a.customer?.name].filter(Boolean).join(" · ") || L("حتى ", "until ") + timeOf(a.endAt, lang)}</span></Link></li>
    ) })),
    ...data.tasks.filter((t) => !t.overdue && new Date(t.dueAt) < dayEnd).map((t) => ({ at: t.dueAt, node: (
      <li key={`t${t.id}`} className="ws-slot is-marker"><span className="ws-slot-time">{timeOf(t.dueAt, lang)}</span><span className="ws-slot-body"><span>{t.title}</span><span className="hr-caption">{L("استحقاق مهمة", "Task due")}</span></span></li>
    ) })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  if (!items.length) return <p className="hr-caption">{L("لا مواعيد اليوم.", "Nothing scheduled today.")}</p>;
  const nowIdx = items.findIndex((i) => new Date(i.at) > now);
  return (
    <ol className="ws-slots">
      {items.map((i, k) => (
        <Fragment key={k}>{k === nowIdx ? <li className="ws-now" aria-label={L("الآن", "Now")}><span>{timeOf(now, lang)}</span> {L("الآن", "Now")}</li> : null}{i.node}</Fragment>
      ))}
    </ol>
  );
}
