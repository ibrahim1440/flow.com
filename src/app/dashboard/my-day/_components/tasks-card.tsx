"use client";
// «مهامي» / «مهام اليوم» — the rep's open tasks AND reminders as one small card (owner-approved Figma D8 / D8.1, 6 Nov 2026;
// Figma 07 188:106). It replaces the full «مساحة عملي · مهامي» page and «الأنشطة والمتابعات» that were embedded under
// the plan. Two sources, one list:
//   · workspace tasks (GET /api/workspace/tasks?scope=mine&status=open) — a box completes one in place, or records a
//     follow-up's result (ResultDialog), only when the task's `actions` allow it;
//   · «تذكير» — the open follow-ups with customers (GET /api/workspace/today `crm`: the reminder «ذكّرني بعد» writes) — the
//     box records what happened (CrmResultDialog).
// D8.1: an overdue item shows HERE only on «اليوم» (not in «جدول اليوم», no red pill), first, with a red «متأخرة» badge.
import { useState } from "react";
import Link from "next/link";
import { HrRoot } from "@/components/hr/ui";
import { Ico } from "@/components/shell/icons";
import { useWs, wsFetch, recordOf, type CrmDue, type Task } from "../../workspace/_components/kit";
import { CreateTaskDialog, CrmResultDialog, ResultDialog } from "../../workspace/_components/task-ui";

type List = { items: Task[]; next: string | null };
type Today = { crm: CrmDue[] };
type When = "late" | "today" | "week";
type Row = { key: string; when: When; at: number; title: string; sub: string | null; href: string; reminder: boolean; boss: string | null; task?: Task; crm?: CrmDue; can: boolean };
const GROUPS: { key: When; ar: string; en: string }[] = [
  { key: "late", ar: "متأخرة", en: "Overdue" },
  { key: "today", ar: "اليوم", en: "Today" },
  { key: "week", ar: "هذا الأسبوع", en: "This week" },
];

const DAY = 86_400_000;
/** The Riyadh day's first instant (UTC ms) for `t`. */
const riyadhDayStart = (t: number) => { const r = t + 3 * 3_600_000; return r - (r % DAY) - 3 * 3_600_000; };

function whenText(at: number, when: When, ar: boolean, now: number): string {
  const d = new Date(at);
  if (when === "late") {
    const days = Math.max(1, Math.round((riyadhDayStart(now) - riyadhDayStart(at)) / DAY));
    return ar ? (days === 1 ? "متأخرة يوم" : days === 2 ? "متأخرة يومين" : `متأخرة ${days} أيام`) : `${days}d overdue`;
  }
  const time = d.toLocaleTimeString(ar ? "ar-SA-u-nu-latn" : "en-GB", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Riyadh" });
  if (when === "today") return ar ? `اليوم ${time}` : `Today ${time}`;
  return `${d.toLocaleDateString(ar ? "ar-SA-u-nu-latn" : "en-GB", { weekday: "long", timeZone: "Asia/Riyadh" })} ${time}`;
}

/**
 * `mode="plan"`: «مهامي» beside the plan — overdue, today and this week, «+ تذكير». `mode="today"`: «مهام اليوم» on the
 * «اليوم» tab — overdue and today. Hidden on a manager's read-only view (the caller does not render it).
 */
export function TasksCard({ ar, mode, onChanged }: { ar: boolean; mode: "plan" | "today"; onChanged?: (msg: string) => void }) {
  const page = useWs<List>("/api/workspace/tasks?scope=mine&status=open&limit=50");
  const today = useWs<Today>("/api/workspace/today");
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState<Task | null>(null);
  const [crmResult, setCrmResult] = useState<CrmDue | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const L = (a: string, e: string) => (ar ? a : e);
  const reloadAll = () => { page.reload(); today.reload(); };
  const done = (msg: string) => { reloadAll(); onChanged?.(msg); };

  const complete = async (r: Row) => {
    if (busy || !r.can) return;
    if (r.crm) { setCrmResult(r.crm); return; }
    const t = r.task!;
    // A follow-up task records its result (the same dialog as everywhere); a plain task completes in place.
    if (t.actions.includes("record_result")) { setResult(t); return; }
    setBusy(t.id); setErr("");
    try {
      await wsFetch(`/api/workspace/tasks/${t.id}/transition`, { json: { action: "complete", version: t.version } });
      done(L("تمت المهمة.", "Task done."));
    } catch (e) {
      setErr(e instanceof Error ? e.message : L("تعذّر الحفظ.", "Could not save."));
      // A task changed elsewhere (409 STALE) or gone: show the list as it is now.
      reloadAll();
    } finally {
      setBusy(null);
    }
  };

  // eslint-disable-next-line react-hooks/purity -- the buckets are "now"-relative by design; a re-render re-buckets
  const now = Date.now();
  const dayStart = riyadhDayStart(now), dayEnd = dayStart + DAY;
  const bucketOf = (at: number): When => (at < dayStart ? "late" : at < dayEnd ? "today" : "week");
  const rows: Row[] = [];
  for (const t of page.data?.items ?? []) {
    if (!t.bucket || t.bucket === "LATER") continue;
    const at = new Date(t.dueAt).getTime();
    // One rule for tasks and reminders: «متأخرة» once its Riyadh day has passed; earlier today is still «اليوم».
    const when = bucketOf(at);
    rows.push({ key: `t:${t.id}`, when, at, title: t.title, sub: recordOf(t), href: `/dashboard/workspace/tasks?task=${encodeURIComponent(t.id)}`,
      reminder: t.kind === "FOLLOW_UP", boss: t.createdById !== t.assigneeId ? t.createdBy.name : null, task: t,
      can: t.actions.includes("complete") || t.actions.includes("record_result") });
  }
  for (const c of today.data?.crm ?? []) {
    const at = new Date(c.dueAt).getTime();
    rows.push({ key: `c:${c.id}`, when: bucketOf(at), at, title: c.subject, sub: ar ? c.record : c.recordEn ?? c.record, href: c.openUrl, reminder: true, boss: null, crm: c, can: c.canRecord });
  }
  rows.sort((x, y) => x.at - y.at);
  const groups = (mode === "today" ? GROUPS.slice(0, 2) : GROUPS)
    .map((g) => ({ ...g, items: rows.filter((r) => r.when === g.key) }))
    .filter((g) => g.items.length);
  const max = mode === "today" ? 5 : 8;
  let left = max;
  const shown = groups.map((g) => { const items = g.items.slice(0, Math.max(0, left)); left -= items.length; return { ...g, items }; }).filter((g) => g.items.length);
  const total = groups.reduce((s, g) => s + g.items.length, 0);
  const title = mode === "today" ? L("مهام اليوم", "Today's tasks") : L("مهامي", "My tasks");
  const loading = !page.data && !page.error;

  return (
    <section className="md-card md-tasks" id={mode === "today" ? "md-today-tasks" : "md-tasks"} data-testid={mode === "today" ? "md-today-tasks" : "md-tasks"} aria-labelledby={`md-tasks-h-${mode}`}>
      <div className="md-h">
        <h2 id={`md-tasks-h-${mode}`}><Ico name="check" small className="md-h-ico2" />{title}</h2>
        {mode === "plan"
          ? <button type="button" className="lk" onClick={() => setCreating(true)} data-testid="md-tasks-new">{L("+ تذكير", "+ Reminder")}</button>
          : <Link className="lk" href="/dashboard/workspace/tasks" data-testid="md-tasks-all">{L("كل المهام", "All tasks")}</Link>}
      </div>
      {err ? <p className="md-note md-tasks-err" role="alert">{err}</p> : null}
      {page.error && !page.data ? <p className="md-empty-line">{L("تعذّر تحميل المهام.", "Could not load the tasks.")}</p>
        : loading ? <p className="md-empty-line">{L("جارٍ التحميل…", "Loading…")}</p>
        : !total ? <p className="md-empty-line" data-testid="md-tasks-empty">{mode === "today" ? L("ما عندك مهام ولا تذكيرات اليوم.", "Nothing due today.") : L("ما عندك مهام ولا تذكيرات مفتوحة.", "Nothing open.")}</p>
        : shown.map((g) => (
          <div key={g.key} className="md-tasks-g">
            {mode === "plan" ? <span className={`md-tasks-gt${g.key === "late" ? " bad" : ""}`}>{ar ? g.ar : g.en}</span> : null}
            <ul>
              {g.items.map((r) => (
                <li key={r.key} className="md-task" data-testid={`md-task-${r.task?.id ?? r.crm!.id}`}>
                  <button type="button" className="md-task-box" disabled={!r.can || busy === r.task?.id} onClick={() => void complete(r)}
                    aria-label={r.crm || r.task?.actions.includes("record_result") ? L(`سجّل وش صار: ${r.title}`, `Record what happened: ${r.title}`) : L(`تمت: ${r.title}`, `Done: ${r.title}`)}
                    data-testid={`md-task-done-${r.task?.id ?? r.crm!.id}`} />
                  <Link className="md-task-main" href={r.href}>
                    <span className="md-task-t">
                      {r.when === "late" ? <span className="md-pill bad" data-testid="md-task-late">{L("متأخرة", "Overdue")}</span> : null}
                      {r.boss ? <span className="md-pill info" data-testid="md-task-boss">{L("من المشرف", "From your supervisor")}</span> : r.reminder ? <span className="md-pill warn">{L("تذكير", "Reminder")}</span> : null}
                      <b>{r.title}</b>
                    </span>
                    <small className={r.when === "late" ? "bad" : undefined}>
                      {whenText(r.at, r.when, ar, now)}{r.sub ? <> · <bdi>{r.sub}</bdi></> : null}{r.boss ? <> · {L("من", "from")} <bdi>{r.boss}</bdi></> : null}
                    </small>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      {mode === "plan" ? <Link className="lk md-tasks-more" href="/dashboard/workspace/tasks" data-testid="md-tasks-all">{L("كل المهام ←", "All tasks →")}</Link> : null}
      {creating || result || crmResult ? (
        <HrRoot>
          {creating ? <CreateTaskDialog reminder onClose={() => setCreating(false)} onCreated={(_t, m) => { setCreating(false); done(m); }} /> : null}
          {result ? <ResultDialog task={result} onClose={() => setResult(null)} onDone={(m) => { setResult(null); done(m); }} /> : null}
          {crmResult ? <CrmResultDialog crm={crmResult} onClose={() => setCrmResult(null)} onDone={(m) => { setCrmResult(null); done(m); }} /> : null}
        </HrRoot>
      ) : null}
    </section>
  );
}
