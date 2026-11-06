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
  const router = useRouter();
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
  const pick = (w: "activity" | "plan" | "appointment" | "task") => {
    setOpen(false);
    if (w === "plan") { router.push("/dashboard/my-day?tab=tasks&plan=new"); return; }
    setWhat(w);
  };
  const opts: { w: "activity" | "plan" | "appointment" | "task"; icon: D21IconName; ar: string; en: string; subAr: string; subEn: string }[] = [
    { w: "activity", icon: "phone", ar: "سجّل مكالمة أو زيارة", en: "Log a call or visit", subAr: "كلّمت عميل أو زرته؟ سجّل وش صار", subEn: "Record what happened" },
    { w: "plan", icon: "flag", ar: "بند في الخطة", en: "Plan an item", subAr: "زيارة أو مكالمة أو عيّنة — لأي يوم قدام", subEn: "A visit, call or sample — any day ahead" },
    { w: "appointment", icon: "cal", ar: "موعد مع عميل", en: "Appointment", subAr: "حدّد اليوم والساعة", subEn: "Pick the day and time" },
    { w: "task", icon: "bell", ar: "تذكير", en: "Reminder", subAr: "تابع عميل أو شي لازم تسويه — ومتى", subEn: "Follow up a customer or do something — and when" },
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
      {what === "task" ? <CreateTaskDialog reminder onClose={() => setWhat(null)} onCreated={(_t, m) => { setWhat(null); onDone(m); }} /> : null}
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
  const items: Item[] = [];
  if (data) {
    for (const a of data.schedule) {
      const at = new Date(a.startAt);
      items.push({ key: `a:${a.id}`, at, time: timeText(at, ar), title: a.title, sub: a.customer?.name ?? null, kind: "appt", late: false, href: `/dashboard/my-day?tab=calendar&appointment=${a.id}`, done: a.status === "DONE" });
    }
    // D8.1: tasks (late or due today) are «مهام اليوم»'s — one place per item; the schedule is appointments and the plan.
    // D8.1: follow-ups («تذكير»), late or today, are «مهام اليوم»'s — one place, one tap that records what happened.
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
      {!data ? <p className="md-empty-line" style={{ padding: "8px 0 4px" }}>{ar ? "جارٍ التحميل…" : "Loading…"}</p>
        : items.length === 0 ? (
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
