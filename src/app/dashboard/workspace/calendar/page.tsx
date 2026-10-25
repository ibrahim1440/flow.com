"use client";
// «مساحة عملي · التقويم» (Figma WS-06, 1746:1696 week / 1747:2108 month / 1747:2420 agenda / 1746:2049 form).
// View, date and layers live in the URL. The phone opens on the agenda. Layers: my appointments, my
// deadlines, the team (HR direct reports or team_view), marketing occasions (marketing module), leave.
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { Btn, OpsBanner, OpsError, OpsLoading, useL } from "@/components/ops/ui";
import { usePhone } from "@/components/shell/page-context";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { dayOf, monthOf } from "@/lib/workspace/format";
import { riyadhDay, riyadhDayStart } from "@/lib/workspace/time";
import { WsPage, WsShell, useLang, useNow, useSelection, wsFetch } from "../_components/kit";
import { TaskPane } from "../_components/task-ui";
import { Agenda, AppointmentDialog, AppointmentPane, MonthGrid, OccasionDialog, OccasionPane, TimeGrid, addDaysIso, weekStart, type CalEvent } from "../_components/calendar-ui";
import { useUser } from "../../user-context";

type Cal = { events: CalEvent[]; team: { available: boolean }; occasions: { available: boolean } };
type View = "day" | "week" | "month" | "agenda";
const LAYERS: [string, string, string][] = [["mine", "مواعيدي", "My appointments"], ["tasks", "استحقاقات مهامي", "My deadlines"], ["team", "الفريق", "Team"], ["occasions", "المناسبات التسويقية", "Marketing occasions"], ["leave", "الإجازات", "Leave"]];

export default function CalendarPage() {
  return <Suspense fallback={null}><Calendar /></Suspense>;
}

function Calendar() {
  const L = useL();
  const lang = useLang();
  const now = useNow();
  const phone = usePhone();
  const user = useUser();
  const router = useRouter();
  const sp = useSearchParams();
  const view = (sp.get("view") as View) || (phone ? "agenda" : "week");
  const date = sp.get("date") || riyadhDay(now);
  const layers = (sp.get("layers") ?? "mine,tasks,occasions,leave").split(",").filter(Boolean);
  const [apptId, setApptId] = useSelection("appointment");
  const [taskId, setTaskId] = useSelection("task");
  const [occ, setOcc] = useState<CalEvent | null>(null);
  const [creating, setCreating] = useState<null | "appointment" | "occasion">(null);
  const [toast, setToast] = useState<string | null>(null);
  const [data, setData] = useState<Cal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const set = (k: string, v: string) => {
    const u = new URLSearchParams(sp.toString());
    u.set(k, v);
    router.replace(`?${u.toString()}`, { scroll: false });
  };
  const range = useMemo(() => {
    if (view === "day") return { from: date, days: 1 };
    if (view === "week") return { from: weekStart(date), days: 7 };
    if (view === "agenda") return { from: date, days: 14 };
    const first = `${date.slice(0, 7)}-01`;
    return { from: weekStart(first), days: 42 };
  }, [view, date]);
  useEffect(() => {
    let alive = true;
    const from = riyadhDayStart(range.from)!, to = riyadhDayStart(addDaysIso(range.from, range.days))!;
    wsFetch<Cal>(`/api/workspace/calendar?from=${from.toISOString()}&to=${to.toISOString()}&layers=${layers.join(",")}`)
      .then((d) => { if (alive) { setData(d); setError(null); } })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.from, range.days, layers.join(","), tick]);

  const step = (dir: 1 | -1) => {
    const n = view === "day" ? 1 : view === "week" ? 7 : view === "agenda" ? 14 : 0;
    if (n) return set("date", addDaysIso(date, dir * n));
    const [y, m] = date.split("-").map(Number);
    const t = new Date(Date.UTC(y, m - 1 + dir, 1));
    set("date", t.toISOString().slice(0, 10));
  };
  const open = (e: CalEvent) => {
    if (e.kind === "APPOINTMENT" && e.appointment) setApptId(e.appointment.id);
    else if (e.kind === "TASK_DUE" && e.taskId) setTaskId(e.taskId);
    else if (e.kind === "OCCASION") setOcc(e);
    else if (e.openUrl) router.push(e.openUrl);
  };
  const toggle = (l: string) => set("layers", (layers.includes(l) ? layers.filter((x) => x !== l) : [...layers, l]).join(","));
  const canOcc = !!user && hasSubPrivilege(user.permissions, "marketing", "campaigns_manage");
  const changed = (m?: string) => { if (m) setToast(m); setTick((x) => x + 1); };
  const title = view === "month" ? monthOf(date.slice(0, 7), lang) : view === "day" ? dayOf(`${date}T09:00:00Z`, lang, now) : `${dayOf(`${range.from}T09:00:00Z`, lang, now)} — ${dayOf(`${addDaysIso(range.from, range.days - 1)}T09:00:00Z`, lang, now)}`;

  return (
    <WsShell open={!!(apptId || taskId || occ)} wide>
      <WsPage title={L("التقويم", "Calendar")} testId="ws-calendar" actions={<>
        <Btn variant="primary" onClick={() => setCreating("appointment")} data-testid="ws-new-appointment">{L("موعد جديد", "New appointment")}</Btn>
        {canOcc ? <Btn onClick={() => setCreating("occasion")}>{L("مناسبة تسويقية", "Marketing occasion")}</Btn> : null}
      </>}>
        {toast ? <OpsBanner tone="success" onClose={() => setToast(null)}>{toast}</OpsBanner> : null}
        <div className="ws-calbar">
          <div className="ws-calnav">
            <button type="button" className="hr-btn is-ghost is-sm" onClick={() => step(-1)} aria-label={L("السابق", "Previous")}>{lang === "ar" ? "›" : "‹"}</button>
            <button type="button" className="hr-btn is-sm" onClick={() => set("date", riyadhDay(now))}>{L("اليوم", "Today")}</button>
            <button type="button" className="hr-btn is-ghost is-sm" onClick={() => step(1)} aria-label={L("التالي", "Next")}>{lang === "ar" ? "‹" : "›"}</button>
            <h2 className="ws-caltitle" aria-live="polite">{title}</h2>
          </div>
          <div className="ws-seg" role="group" aria-label={L("العرض", "View")}>
            {([["day", "يوم", "Day"], ["week", "أسبوع", "Week"], ["month", "شهر", "Month"], ["agenda", "أجندة", "Agenda"]] as const).map(([v, a, e]) => <button key={v} type="button" aria-pressed={view === v} onClick={() => set("view", v)}>{L(a, e)}</button>)}
          </div>
        </div>
        <div className="ws-layers" role="group" aria-label={L("الطبقات", "Layers")}>
          {LAYERS.filter(([k]) => (k !== "team" || data?.team.available !== false) && (k !== "occasions" || data?.occasions.available !== false)).map(([k, a, e]) => (
            <label key={k} className={`ws-layer layer-${k}${layers.includes(k) ? " is-on" : ""}`}><input type="checkbox" checked={layers.includes(k)} onChange={() => toggle(k)} /><span aria-hidden="true" className="ws-swatch" /> {L(a, e)}</label>
          ))}
        </div>
        {error ? <OpsError message={error} onRetry={() => setTick((x) => x + 1)} /> : null}
        {!data && !error ? <OpsLoading /> : null}
        {data ? (
          view === "agenda" ? <Agenda from={range.from} days={range.days} events={data.events} onOpen={open} now={now} />
          : view === "month" ? <MonthGrid month={date.slice(0, 7)} events={data.events} onOpen={open} onDay={(d) => router.replace(`?${new URLSearchParams({ ...Object.fromEntries(sp), view: "day", date: d })}`, { scroll: false })} now={now} />
          : <TimeGrid days={Array.from({ length: range.days }, (_, i) => addDaysIso(range.from, i))} events={data.events} onOpen={open} now={now} />
        ) : null}
        <p className="hr-caption ws-cal-note">{L("◆ استحقاق مهمة (لا يحجز الوقت) · الكتل مواعيد محجوزة · الأشرطة إجازات ومناسبات. المزامنة مع تقويمات خارجية غير مفعّلة.", "◆ task deadline (reserves no time) · blocks are appointments · bars are leave and occasions. Sync with external calendars is not enabled.")}</p>
      </WsPage>
      {apptId ? <AppointmentPane id={apptId} onClose={() => setApptId(null)} onChanged={changed} /> : null}
      {!apptId && taskId ? <TaskPane id={taskId} onClose={() => setTaskId(null)} onChanged={changed} /> : null}
      {!apptId && !taskId && occ ? <OccasionPane ev={occ} canManage={canOcc} onClose={() => setOcc(null)} onChanged={(m) => { changed(m); setOcc(null); }} /> : null}
      {creating === "appointment" ? <AppointmentDialog onClose={() => setCreating(null)} onSaved={(m) => { setCreating(null); changed(m); }} /> : null}
      {creating === "occasion" ? <OccasionDialog onClose={() => setCreating(null)} onSaved={(m) => { setCreating(null); changed(m); }} /> : null}
    </WsShell>
  );
}
