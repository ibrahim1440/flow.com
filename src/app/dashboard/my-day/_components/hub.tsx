"use client";

// «يومي الموحّد» (owner-approved Figma «06 · يومي الموحّد», 3 Nov 2026): the rep's ONE home — three tabs (اليوم ·
// مهامي · التقويم) and ONE «أضف». The tasks and the calendar are «مساحة عملي»'s own screens, shown here as tabs (same
// APIs, same dialogs); «جدول اليوم» reads «مساحة عملي · اليوم» (GET /api/workspace/today).
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Ico, type D21IconName } from "@/components/shell/icons";
import { CreateTaskDialog } from "../../workspace/_components/task-ui";
import { AppointmentDialog } from "../../workspace/_components/calendar-ui";
import { LogActivityPicker } from "../../sales/activities/LogActivityPicker";

export type HubTab = "today" | "tasks" | "calendar";
export const HUB_TABS: { id: HubTab; ar: string; en: string; icon: D21IconName }[] = [
  { id: "today", ar: "اليوم", en: "Today", icon: "home" },
  { id: "tasks", ar: "مهامي وخطتي", en: "Tasks & plan", icon: "check" },
  { id: "calendar", ar: "التقويم", en: "Calendar", icon: "cal" },
];
export const hubTabOf = (v: string | null): HubTab => (v === "tasks" || v === "calendar" ? v : "today");

export function HubTabs({ tab, ar }: { tab: HubTab; ar: boolean }) {
  const router = useRouter();
  return (
    <div className="md-tabs" role="tablist" aria-label={ar ? "أقسام يومي" : "My day sections"} data-testid="md-tabs">
      {HUB_TABS.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? "on" : undefined}
          onClick={() => router.replace(t.id === "today" ? "/dashboard/my-day" : `/dashboard/my-day?tab=${t.id}`, { scroll: false })}
          data-testid={`md-tab-${t.id}`}>
          <Ico name={t.icon} small />{ar ? t.ar : t.en}
        </button>
      ))}
    </div>
  );
}

type QuickLink = { href: string; ar: string; en: string; id: string };

/**
 * «أضف»: what a rep adds during the day, in plain words with an icon each — a call or visit (the activity dialog, the
 * customer chosen first), an appointment, a task — then the sales documents the rep may start.
 */
export function AddMenu({ ar, links, onDone }: { ar: boolean; links: QuickLink[]; onDone: (msg: string) => void }) {
  const [open, setOpen] = useState(false);
  const [what, setWhat] = useState<null | "activity" | "appointment" | "task">(null);
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", off); window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("mousedown", off); window.removeEventListener("keydown", esc); };
  }, [open]);
  const pick = (w: "activity" | "appointment" | "task") => { setOpen(false); setWhat(w); };
  const opts: { w: "activity" | "appointment" | "task"; icon: D21IconName; ar: string; en: string; subAr: string; subEn: string }[] = [
    { w: "activity", icon: "phone", ar: "سجّل مكالمة أو زيارة", en: "Log a call or visit", subAr: "كلّمت عميل أو زرته؟ سجّل وش صار", subEn: "Record what happened" },
    { w: "appointment", icon: "cal", ar: "موعد مع عميل", en: "Appointment", subAr: "حدّد اليوم والساعة", subEn: "Pick the day and time" },
    { w: "task", icon: "check", ar: "مهمة", en: "Task", subAr: "شي لازم تسويه ومتى", subEn: "Something to do, and when" },
  ];
  return (
    <div className="md-add" ref={box}>
      <button type="button" className="btn p md-add-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid="md-add">
        <Ico name="plus" small />{ar ? "أضف" : "Add"}
      </button>
      {open ? (
        <div className="md-add-menu" role="menu" data-testid="md-add-menu">
          {opts.map((o) => (
            <button key={o.w} type="button" role="menuitem" className="md-add-opt" onClick={() => pick(o.w)} data-testid={`md-add-${o.w}`}>
              <span className="md-add-ico" aria-hidden><Ico name={o.icon} /></span>
              <span><b>{ar ? o.ar : o.en}</b><small>{ar ? o.subAr : o.subEn}</small></span>
            </button>
          ))}
          {links.length ? <div className="md-add-sep" role="separator" /> : null}
          {links.map((l) => <Link key={l.id} role="menuitem" className="md-add-link" href={l.href} onClick={() => setOpen(false)} data-testid={l.id}>{ar ? l.ar : l.en}</Link>)}
        </div>
      ) : null}
      {what === "activity" ? <LogActivityPicker lang={ar ? "ar" : "en"} onClose={() => setWhat(null)} onDone={() => { setWhat(null); onDone(ar ? "تم التسجيل." : "Logged."); }} /> : null}
      {what === "appointment" ? <AppointmentDialog onClose={() => setWhat(null)} onSaved={(m) => { setWhat(null); onDone(m); }} /> : null}
      {what === "task" ? <CreateTaskDialog onClose={() => setWhat(null)} onCreated={(_t, m) => { setWhat(null); onDone(m); }} /> : null}
    </div>
  );
}

type TodayData = {
  tasks: { id: string; title: string; dueAt: string; overdue?: boolean; bucket?: string | null; status: string; customer?: { name: string } | null }[];
  crm: { id: string; subject: string; dueAt: string; record: string | null; openUrl: string; type: string }[];
  schedule: { id: string; title: string; startAt: string; endAt: string; kind: string; customer: { name: string } | null; status: string }[];
};
type Item = { key: string; at: Date; time: string; title: string; sub: string | null; kind: "appt" | "task" | "follow" | "plan"; late: boolean; href: string; done: boolean };
type PlanToday = { today: string; items: { id: string; kind: string; metric: string | null; label: string | null; checked: boolean; plannedDay: string | null; customer: { name: string } | null; setBy: string | null; source: string }[] };
const PLAN_VERB: Record<string, string> = { VISITS: "زيارة", CALLS: "مكالمة", QUOTES: "عرض سعر", COLLECTION: "تحصيل", SAMPLES: "عيّنة" };

const timeText = (d: Date, ar: boolean) => d.toLocaleTimeString(ar ? "ar-SA-u-nu-latn" : "en-GB", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Riyadh" });
const riyadhDay = (d: Date) => new Date(d.getTime() + 3 * 3_600_000).toISOString().slice(0, 10);

/** «جدول اليوم»: today's appointments, tasks due today or late, and follow-ups — one list by the hour. */
export function TodaySchedule({ ar, reloadKey }: { ar: boolean; reloadKey: number }) {
  const [data, setData] = useState<TodayData | null>(null);
  const [failed, setFailed] = useState(false);
  const [plan, setPlan] = useState<PlanToday | null>(null);
  const load = useCallback(() => {
    fetch("/api/workspace/today", { cache: "no-store" }).then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((j: TodayData) => { setData(j); setFailed(false); }).catch(() => setFailed(true));
    // «خطة الأسبوع v2»: what the rep planned for today shows here, on its day.
    fetch("/api/sales/plan?period=DAY", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((j: PlanToday | null) => setPlan(j)).catch(() => setPlan(null));
  }, []);
  useEffect(() => { load(); }, [load, reloadKey]);
  if (failed) return null;
  const now = new Date();
  const today = riyadhDay(now);
  const items: Item[] = [];
  let lateFollow = 0;
  if (data) {
    for (const a of data.schedule) {
      const at = new Date(a.startAt);
      items.push({ key: `a:${a.id}`, at, time: timeText(at, ar), title: a.title, sub: a.customer?.name ?? null, kind: "appt", late: false, href: `/dashboard/my-day?tab=calendar&appointment=${a.id}`, done: a.status === "DONE" });
    }
    for (const t of data.tasks) {
      const at = new Date(t.dueAt);
      if (!t.overdue && riyadhDay(at) !== today) continue;
      items.push({ key: `t:${t.id}`, at, time: t.overdue ? (ar ? "متأخرة" : "Late") : timeText(at, ar), title: t.title, sub: t.customer?.name ?? null, kind: "task", late: !!t.overdue, href: `/dashboard/my-day?tab=tasks&task=${t.id}`, done: false });
    }
    for (const c of data.crm) {
      const at = new Date(c.dueAt);
      const late = at < now && riyadhDay(at) !== today;
      // Late follow-ups are ONE line (below), not a wall of rows: the schedule is today's.
      if (late) { lateFollow++; continue; }
      if (riyadhDay(at) !== today) continue;
      items.push({ key: `c:${c.id}`, at, time: timeText(at, ar), title: c.subject, sub: c.record, kind: "follow", late: false, href: c.openUrl, done: false });
    }
  }
  for (const p of plan?.items ?? []) {
    if ((p.kind !== "ACTION" && p.kind !== "CHECK") || p.plannedDay !== plan?.today) continue;
    const what = p.kind === "CHECK" ? p.label ?? "" : `${PLAN_VERB[p.metric ?? ""] ?? ""} ${p.customer?.name ?? ""}`.trim();
    items.push({ key: `p:${p.id}`, at: new Date(`${p.plannedDay}T05:00:00Z`), time: ar ? "اليوم" : "Today", title: what, sub: p.source === "ADMIN" ? (ar ? `من المشرف${p.setBy ? ` · ${p.setBy}` : ""}` : "From your supervisor") : null,
      kind: "plan", late: false, href: "/dashboard/my-day?tab=tasks#plan", done: p.checked });
  }
  items.sort((x, y) => Number(y.late) - Number(x.late) || x.at.getTime() - y.at.getTime());
  const KIND: Record<Item["kind"], [string, string, string]> = { appt: ["موعد", "Appointment", "in"], task: ["مهمة", "Task", "pri"], follow: ["متابعة", "Follow-up", "warn"], plan: ["من خطتك", "Planned", "ok"] };
  let nowShown = false;
  return (
    <section className="md-card md-sched" data-testid="md-schedule" aria-labelledby="md-schedule-h">
      <div className="md-h">
        <h2 id="md-schedule-h"><Ico name="cal" small className="md-h-ico2" />{ar ? "جدول اليوم" : "Today's schedule"}</h2>
        <Link className="lk" href="/dashboard/my-day?tab=calendar">{ar ? "التقويم" : "Calendar"}</Link>
      </div>
      {data && lateFollow > 0 ? (
        <Link className="md-sched-late" href="/dashboard/my-day?tab=tasks#activities" data-testid="md-schedule-late">
          <b className="num">{lateFollow}</b> {ar ? (lateFollow === 1 ? "متابعة متأخرة مع العملاء" : "متابعات متأخرة مع العملاء") : `late follow-up${lateFollow === 1 ? "" : "s"}`} <span aria-hidden>‹</span>
        </Link>
      ) : null}
      {!data ? <p className="md-empty-line" style={{ padding: "8px 0 4px" }}>{ar ? "جارٍ التحميل…" : "Loading…"}</p>
        : items.length === 0 && lateFollow === 0 ? (
          <div className="md-empty" data-testid="md-schedule-empty">
            <span className="md-empty-ico" aria-hidden><Ico name="cal" small /></span>
            <span>{ar ? "ما عندك مواعيد ولا مهام اليوم." : "No appointments or tasks today."}</span>
          </div>
        ) : (
          <ol className="md-sched-list">
            {items.map((it) => {
              const showNow = !nowShown && !it.late && it.at > now;
              if (showNow) nowShown = true;
              const k = KIND[it.kind];
              return (
                <li key={it.key}>
                  {showNow ? <div className="md-now" aria-hidden><span>{ar ? "الآن" : "Now"} {timeText(now, ar)}</span><i /></div> : null}
                  <Link href={it.href} className={`md-sched-row${it.done ? " done" : ""}`} data-testid="md-schedule-row">
                    <span className={`md-sched-time${it.late ? " late" : ""}`}>{it.time}</span>
                    <span className={`md-sched-bar ${k[2]}`} aria-hidden />
                    <span className="md-sched-what"><b>{it.title}</b>{it.sub ? <small><bdi>{it.sub}</bdi></small> : null}</span>
                    <span className={`md-pill sq ${k[2]}`}>{it.done ? (ar ? "✓ تم" : "✓ Done") : ar ? k[0] : k[1]}</span>
                  </Link>
                </li>
              );
            })}
          </ol>
        )}
    </section>
  );
}
