"use client";
// «مساحة عملي · التقويم» — the appointment form (with the participants' clashes), the appointment pane,
// the occasion form, and the calendar grid itself: day · week · month · agenda (the phone's default).
// Appointments are blocks of time; task deadlines are markers at their instant (a deadline never blocks a
// day); leave, occasions and campaigns are all-day bars. Every time is Asia/Riyadh.
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Btn, Field, Notice, OpsPane, useL } from "@/components/ops/ui";
import { Select } from "@/components/ui/Select";
import { Dialog, HrApiError } from "@/components/hr/ui";
import { dayOf, dueLabel, timeOf } from "@/lib/workspace/format";
import { fromRiyadh, parseRiyadhLocal, riyadhDay, riyadhParts, toRiyadhLocal } from "@/lib/workspace/time";
import { OUTCOMES, TypeChip, useLang, useWs, wsFetch, type Appointment } from "./kit";
import { LinkPicker, usePeople } from "./task-ui";

export type CalEvent = {
  id: string; kind: "APPOINTMENT" | "TASK_DUE" | "CRM_DUE" | "LEAVE" | "OCCASION" | "CAMPAIGN"; layer: string; title: string; titleEn?: string;
  start: string; end: string; allDay?: boolean; overdue?: boolean; priority?: string; assignee?: string; taskId?: string; status?: string; mine?: boolean;
  record?: string | null; openUrl?: string; appointment?: Appointment; occasion?: { id: string; name: string; status: string; sourceUrl: string | null; sourceNote: string | null; lastVerifiedAt: string | null; version: number; _count: { tasks: number }; kind: string };
};

const HOURS = Array.from({ length: 15 }, (_, i) => i + 7); // 07:00–21:00 Riyadh
const DAY = 86_400_000;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The Riyadh day ("YYYY-MM-DD") an event touches, for the all-day bars and the agenda. */
const evDays = (e: CalEvent): string[] => {
  if (e.allDay) {
    const out: string[] = [];
    for (let d = new Date(`${e.start}T00:00:00Z`); d <= new Date(`${e.end}T00:00:00Z`) && out.length < 62; d = new Date(d.getTime() + DAY)) out.push(d.toISOString().slice(0, 10));
    return out;
  }
  return [riyadhDay(new Date(e.start))];
};

export function weekStart(day: string): string {
  // Weeks start on Sunday (the working week).
  const d = new Date(`${day}T00:00:00Z`);
  return new Date(d.getTime() - d.getUTCDay() * DAY).toISOString().slice(0, 10);
}
export const addDaysIso = (day: string, n: number) => new Date(new Date(`${day}T00:00:00Z`).getTime() + n * DAY).toISOString().slice(0, 10);

function EventChip({ e, onOpen }: { e: CalEvent; onOpen: (e: CalEvent) => void }) {
  const L = useL();
  const lang = useLang();
  const title = lang === "en" ? e.titleEn ?? e.title : e.title;
  const label = e.kind === "TASK_DUE" || e.kind === "CRM_DUE" ? `${timeOf(e.start, lang)} · ${title}` : e.kind === "APPOINTMENT" ? `${timeOf(e.start, lang)} ${title}` : title;
  const what = { APPOINTMENT: L("موعد", "Appointment"), TASK_DUE: L("استحقاق مهمة", "Task due"), CRM_DUE: L("متابعة", "Follow-up"), LEAVE: L("إجازة", "Leave"), OCCASION: L("مناسبة", "Occasion"), CAMPAIGN: L("حملة", "Campaign") }[e.kind];
  return (
    <button type="button" className={`ws-ev is-${e.kind.toLowerCase()} layer-${e.layer}${e.overdue ? " is-overdue" : ""}${e.status === "PENDING" ? " is-pending" : ""}`} onClick={() => onOpen(e)} title={`${what}: ${title}`}>
      <span className="hr-sr">{what}: </span>{e.kind === "TASK_DUE" || e.kind === "CRM_DUE" ? <span aria-hidden="true">◆ </span> : null}{label}{e.overdue ? <span className="hr-sr"> — {L("متأخرة", "overdue")}</span> : null}
    </button>
  );
}

/** Day and week: hours down, days across; appointments placed by time, deadlines as markers. */
export function TimeGrid({ days, events, onOpen, now }: { days: string[]; events: CalEvent[]; onOpen: (e: CalEvent) => void; now: Date }) {
  const lang = useLang();
  const L = useL();
  const today = riyadhDay(now);
  const top = (iso: string) => {
    const p = riyadhParts(new Date(iso));
    return Math.max(0, Math.min(HOURS.length, p.hour - HOURS[0] + p.minute / 60));
  };
  return (
    <div className="ws-tgrid" style={{ ["--ws-days" as string]: days.length }} role="grid" aria-label={L("التقويم", "Calendar")}>
      <div className="ws-tg-head" role="row">
        <span />
        {days.map((d) => <span key={d} role="columnheader" className={d === today ? "is-today" : undefined}>{dayOf(`${d}T09:00:00Z`, lang, now)}</span>)}
      </div>
      <div className="ws-tg-allday" role="row">
        <span className="hr-caption">{L("طوال اليوم", "All day")}</span>
        {days.map((d) => <div key={d} role="gridcell">{events.filter((e) => e.allDay && evDays(e).includes(d)).map((e) => <EventChip key={e.id} e={e} onOpen={onOpen} />)}</div>)}
      </div>
      <div className="ws-tg-body">
        <div className="ws-tg-hours">{HOURS.map((h) => <span key={h}>{timeOf(fromRiyadh(2026, 1, 1, h), lang)}</span>)}</div>
        {days.map((d) => (
          <div key={d} className={`ws-tg-col${d === today ? " is-today" : ""}`} role="gridcell" aria-label={dayOf(`${d}T09:00:00Z`, lang, now)}>
            {d === today ? <span className="ws-tg-now" style={{ top: `calc(${top(now.toISOString())} * var(--ws-hour))` }} aria-label={L("الآن", "Now")} /> : null}
            {events.filter((e) => !e.allDay && riyadhDay(new Date(e.start)) === d).map((e) => {
              const t = top(e.start);
              const h = e.kind === "APPOINTMENT" ? Math.max(0.5, top(e.end) - t) : 0;
              return (
                <div key={e.id} className={`ws-tg-item${e.kind === "APPOINTMENT" ? " is-block" : " is-marker"}`} style={{ top: `calc(${t} * var(--ws-hour))`, ...(h ? { height: `calc(${h} * var(--ws-hour))` } : {}) }}>
                  <EventChip e={e} onOpen={onOpen} />
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

export function MonthGrid({ month, events, onOpen, onDay, now }: { month: string; events: CalEvent[]; onOpen: (e: CalEvent) => void; onDay: (d: string) => void; now: Date }) {
  const L = useL();
  const lang = useLang();
  const first = `${month}-01`;
  const start = weekStart(first);
  const cells = Array.from({ length: 42 }, (_, i) => addDaysIso(start, i));
  const today = riyadhDay(now);
  const names = lang === "ar" ? ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"] : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return (
    <div className="ws-month" role="grid" aria-label={L("الشهر", "Month")}>
      {names.map((n) => <span key={n} className="ws-month-head" role="columnheader">{n}</span>)}
      {cells.map((d) => {
        const list = events.filter((e) => evDays(e).includes(d));
        return (
          <div key={d} role="gridcell" className={`ws-month-cell${d.slice(0, 7) !== month ? " is-other" : ""}${d === today ? " is-today" : ""}`}>
            <button type="button" className="ws-month-day" onClick={() => onDay(d)} aria-label={dayOf(`${d}T09:00:00Z`, lang, now)}>{Number(d.slice(8))}</button>
            {list.slice(0, 3).map((e) => <EventChip key={e.id} e={e} onOpen={onOpen} />)}
            {list.length > 3 ? <button type="button" className="ws-month-more" onClick={() => onDay(d)}>+{list.length - 3}</button> : null}
          </div>
        );
      })}
    </div>
  );
}

export function Agenda({ from, days, events, onOpen, now }: { from: string; days: number; events: CalEvent[]; onOpen: (e: CalEvent) => void; now: Date }) {
  const L = useL();
  const lang = useLang();
  const list = Array.from({ length: days }, (_, i) => addDaysIso(from, i)).map((d) => ({ d, items: events.filter((e) => evDays(e).includes(d)).sort((a, b) => Number(!!b.allDay) - Number(!!a.allDay) || a.start.localeCompare(b.start)) })).filter((x) => x.items.length);
  if (!list.length) return <p className="hr-caption ws-empty-cal">{L("لا شيء في هذه الفترة.", "Nothing in this period.")}</p>;
  return (
    <ol className="ws-agenda">
      {list.map(({ d, items }) => (
        <li key={d}>
          <h3 className={`ws-agenda-day${d === riyadhDay(now) ? " is-today" : ""}`}>{dayOf(`${d}T09:00:00Z`, lang, now)}</h3>
          <ul>{items.map((e) => (
            <li key={e.id} className="ws-agenda-item">
              <span className="ws-agenda-time">{e.allDay ? L("طوال اليوم", "All day") : e.kind === "APPOINTMENT" ? `${timeOf(e.start, lang)} – ${timeOf(e.end, lang)}` : timeOf(e.start, lang)}</span>
              <EventChip e={e} onOpen={onOpen} />
            </li>
          ))}</ul>
        </li>
      ))}
    </ol>
  );
}

type Clash = { employeeId: string; name: string | null; kind: "APPOINTMENT" | "LEAVE"; title: string | null; startAt: string; endAt: string };

/** New or edited appointment. Clashes of the people invited are shown as they are chosen. */
export function AppointmentDialog({ appt, onClose, onSaved, defaultStart }: { appt?: Appointment; onClose: () => void; onSaved: (m: string) => void; defaultStart?: Date }) {
  const L = useL();
  const lang = useLang();
  const people = usePeople("invite");
  const [kind, setKind] = useState<string>(appt?.kind ?? "MEETING");
  const [title, setTitle] = useState(appt?.title ?? "");
  // The next half hour, unless the appointment or the caller says otherwise.
  const [startAt, setStartAt] = useState(() => toRiyadhLocal(appt ? new Date(appt.startAt) : defaultStart ?? new Date(Math.ceil(Date.now() / 1_800_000) * 1_800_000)));
  const [minutes, setMinutes] = useState(appt ? Math.round((new Date(appt.endAt).getTime() - new Date(appt.startAt).getTime()) / 60_000) : 30);
  const [location, setLocation] = useState(appt?.location ?? "");
  const [meetingUrl, setMeetingUrl] = useState(appt?.meetingUrl ?? "");
  const [participants, setParticipants] = useState<string[]>(appt?.participants.map((p) => p.employeeId) ?? []);
  const [link, setLink] = useState<{ type: "customer" | "lead" | "deal"; id: string; label: string } | null>(
    appt?.customer ? { type: "customer", id: appt.customer.id, label: appt.customer.name } : appt?.opportunity ? { type: "deal", id: appt.opportunity.id, label: appt.opportunity.title } : appt?.lead ? { type: "lead", id: appt.lead.id, label: appt.lead.companyName } : null);
  const [remind, setRemind] = useState(String(appt?.remindBeforeMinutes ?? 30));
  const [recur, setRecur] = useState("");
  const [notes, setNotes] = useState(appt?.notes ?? "");
  const [clashes, setClashes] = useState<Clash[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const s = parseRiyadhLocal(startAt);
  const e = s ? new Date(s.getTime() + minutes * 60_000) : null;

  useEffect(() => {
    if (!s || !e) return;
    let alive = true;
    const t = setTimeout(() => {
      wsFetch<{ items: Clash[] }>("/api/workspace/conflicts", { json: { participantIds: participants, startAt: s.toISOString(), endAt: e.toISOString(), exceptId: appt?.id } })
        .then((r) => alive && setClashes(r.items)).catch(() => alive && setClashes([]));
    }, 300);
    return () => { alive = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startAt, minutes, participants.join(",")]);

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      if (!s || !e) throw new Error(L("الوقت غير صالح.", "The time is not valid."));
      const body = {
        kind, title, startAt: s.toISOString(), endAt: e.toISOString(), location: location || null, meetingUrl: meetingUrl || null, participantIds: participants, notes: notes || null,
        remindBeforeMinutes: remind === "" ? null : Number(remind),
        customerId: link?.type === "customer" ? link.id : null, leadId: link?.type === "lead" ? link.id : null, opportunityId: link?.type === "deal" ? link.id : null,
        ...(appt ? { version: appt.version } : recur ? { recurRule: recur, recurInterval: 1 } : {}),
      };
      if (appt) await wsFetch(`/api/workspace/appointments/${appt.id}`, { method: "PATCH", json: body });
      else await wsFetch("/api/workspace/appointments", { json: body });
      onSaved(appt ? L("حُدّث الموعد وأُبلغ المشاركون.", "Appointment updated; participants told.") : L("أُضيف الموعد وأُرسلت الدعوات.", "Appointment added; invitations sent."));
    } catch (x) {
      setErr(x instanceof HrApiError && x.code === "STALE" ? L("تغيّر الموعد بعد فتحه. أغلق وافتحه من جديد.", "The appointment changed after you opened it. Close and reopen it.") : msg(x));
    } finally { setBusy(false); }
  };

  return (
    <Dialog open title={appt ? L("تعديل الموعد", "Edit appointment") : L("موعد جديد", "New appointment")} onClose={onClose} className="ws-dialog" testId="appointment-dialog" actions={<>
      <Btn onClick={onClose}>{L("تراجع", "Back")}</Btn>
      <Btn variant="primary" busy={busy} disabled={!title.trim() || !s} onClick={() => void save()} data-testid="appointment-save">{appt ? L("حفظ التغييرات", "Save changes") : L("إضافة الموعد", "Add appointment")}</Btn>
    </>}>
      {err ? <Notice tone="danger">{err}</Notice> : null}
      <div className="ws-row2">
        <Field label={L("النوع", "Type")}><Select className="hr-select" value={kind} onChange={(x) => setKind(x.target.value)}>
          <option value="MEETING">{L("اجتماع", "Meeting")}</option><option value="VISIT">{L("زيارة", "Visit")}</option><option value="CALL">{L("مكالمة", "Call")}</option><option value="OTHER">{L("آخر", "Other")}</option>
        </Select></Field>
        <Field label={L("العنوان", "Title")}><input className="hr-input" value={title} onChange={(x) => setTitle(x.target.value)} maxLength={300} /></Field>
      </div>
      <div className="ws-row2">
        <Field label={L("البداية (بتوقيت الرياض)", "Starts (Riyadh)")}><input type="datetime-local" className="hr-input" value={startAt} onChange={(x) => setStartAt(x.target.value)} /></Field>
        <Field label={L("المدة", "Duration")}><Select className="hr-select" value={String(minutes)} onChange={(x) => setMinutes(Number(x.target.value))}>
          {[15, 30, 45, 60, 90, 120, 180, 240].map((m) => <option key={m} value={m}>{m < 60 ? L(`${m} دقيقة`, `${m} min`) : L(`${m / 60} ساعة`, `${m / 60} h`)}</option>)}
        </Select></Field>
      </div>
      {s && e ? <p className="hr-caption">{dueLabel(s, lang)} – {timeOf(e, lang)}</p> : null}
      <Field label={L("المشاركون", "Participants")}>
        <div className="ws-watchers">{people.filter((p) => !p.self).map((p) => (
          <label key={p.id} className={`ws-choice${participants.includes(p.id) ? " is-on" : ""}`}><input type="checkbox" checked={participants.includes(p.id)} onChange={(x) => setParticipants((w) => (x.target.checked ? [...w, p.id] : w.filter((y) => y !== p.id)))} /> {p.name}</label>
        ))}</div>
      </Field>
      {clashes.length ? (
        <Notice tone="warning">
          <b>{L("تعارض في الوقت", "Time clash")}</b>
          <ul className="ws-clashes">{clashes.map((c, i) => <li key={i}>{c.name ?? "—"}: {c.title ?? L("مشغول", "Busy")}{c.kind === "APPOINTMENT" ? ` (${timeOf(c.startAt, lang)}–${timeOf(c.endAt, lang)})` : ""}</li>)}</ul>
          <span className="hr-caption">{L("يمكنك الحفظ رغم التعارض.", "You can still save.")}</span>
        </Notice>
      ) : null}
      <div className="ws-row2">
        <Field label={L("المكان", "Place")}><input className="hr-input" value={location} onChange={(x) => setLocation(x.target.value)} maxLength={300} /></Field>
        <Field label={L("رابط الاجتماع", "Meeting link")}><input className="hr-input" type="url" dir="ltr" value={meetingUrl} onChange={(x) => setMeetingUrl(x.target.value)} placeholder="https://" /></Field>
      </div>
      <Field label={L("مرتبط بعميل أو صفقة", "Customer or deal")}><LinkPicker value={link} onChange={setLink} /></Field>
      <div className="ws-row2">
        <Field label={L("التذكير", "Reminder")}><Select className="hr-select" value={remind} onChange={(x) => setRemind(x.target.value)}>
          <option value="">{L("بلا تذكير", "None")}</option><option value="15">{L("قبل 15 دقيقة", "15 min before")}</option><option value="30">{L("قبل 30 دقيقة", "30 min before")}</option><option value="60">{L("قبل ساعة", "1 h before")}</option><option value="1440">{L("قبل يوم", "1 day before")}</option>
        </Select></Field>
        {!appt ? <Field label={L("التكرار", "Repeat")}><Select className="hr-select" value={recur} onChange={(x) => setRecur(x.target.value)}>
          <option value="">{L("لا يتكرر", "Does not repeat")}</option><option value="DAILY">{L("يوميًا", "Daily")}</option><option value="WEEKLY">{L("أسبوعيًا", "Weekly")}</option><option value="MONTHLY">{L("شهريًا", "Monthly")}</option>
        </Select></Field> : null}
      </div>
      <Field label={L("ملاحظات", "Notes")}><textarea className="hr-input" rows={2} value={notes} onChange={(x) => setNotes(x.target.value)} maxLength={4000} /></Field>
    </Dialog>
  );
}

/** One appointment: when, where, who; edit / cancel (organiser); «تم الموعد» or «تسجيل النتيجة». */
export function AppointmentPane({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: (m: string) => void }) {
  const L = useL();
  const lang = useLang();
  const { data: a, error, reload } = useWs<Appointment>(`/api/workspace/appointments/${encodeURIComponent(id)}`);
  const [edit, setEdit] = useState(false);
  const [mode, setMode] = useState<null | "cancel" | "result">(null);
  const [text, setText] = useState("");
  const [outcome, setOutcome] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: "success" | "danger"; t: string } | null>(null);
  const run = async (fn: () => Promise<unknown>, m: string) => {
    setBusy(true); setNote(null);
    try { await fn(); setNote({ tone: "success", t: m }); setMode(null); reload(); onChanged(m); } catch (x) { setNote({ tone: "danger", t: msg(x) }); } finally { setBusy(false); }
  };
  const linked = !!(a && (a.customerId || a.leadId || a.opportunityId));
  const footer = a && a.status === "SCHEDULED" ? (
    mode === "cancel" ? <div className="ws-pane-actions"><Btn variant="danger" busy={busy} onClick={() => void run(() => wsFetch(`/api/workspace/appointments/${id}/cancel`, { json: { reason: text } }), L("أُلغي الموعد وأُبلغ المشاركون.", "Cancelled; participants told."))}>{L("إلغاء الموعد", "Cancel appointment")}</Btn><Btn onClick={() => setMode(null)}>{L("تراجع", "Back")}</Btn></div>
    : mode === "result" ? <div className="ws-pane-actions"><Btn variant="primary" busy={busy} disabled={linked && !outcome} onClick={() => void run(() => wsFetch(`/api/workspace/appointments/${id}/complete`, { json: { outcome: outcome || undefined, note: text } }), linked ? L("سُجلت النتيجة في سجل العميل.", "Result saved to the customer timeline.") : L("سُجل أن الموعد تم.", "Marked as held."))}>{L("حفظ", "Save")}</Btn><Btn onClick={() => setMode(null)}>{L("تراجع", "Back")}</Btn></div>
    : <div className="ws-pane-actions">
        {a.actions.includes("record_result") ? <Btn variant="primary" onClick={() => setMode("result")}>{L("تسجيل النتيجة", "Record result")}</Btn> : null}
        {a.actions.includes("mark_done") ? <Btn variant="primary" onClick={() => setMode("result")}>{L("تم الموعد", "Mark as held")}</Btn> : null}
        {a.actions.includes("edit") ? <Btn onClick={() => setEdit(true)}>{L("تعديل أو إعادة جدولة", "Edit or reschedule")}</Btn> : null}
        {a.actions.includes("cancel") ? <Btn variant="ghost" onClick={() => setMode("cancel")}>{L("إلغاء الموعد", "Cancel")}</Btn> : null}
      </div>
  ) : null;
  return (
    <OpsPane label={L("تفاصيل الموعد", "Appointment")} title={a?.title ?? L("الموعد", "Appointment")} sub={a ? <TypeChip type={a.kind} /> : null} onClose={onClose} busy={busy} footer={footer} drawer="open" testId="appointment-pane">
      {error ? <Notice tone="danger">{error.message}</Notice> : null}
      {note ? <Notice tone={note.tone}>{note.t}</Notice> : null}
      {a ? (
        <div className="hr-stack">
          {a.status === "CANCELLED" ? <Notice tone="warning">{L("هذا الموعد ملغى.", "This appointment is cancelled.")}</Notice> : null}
          {a.status === "DONE" ? <Notice tone="success">{L("تم هذا الموعد.", "This appointment was held.")}</Notice> : null}
          {a.status === "SCHEDULED" && a.past ? <Notice tone="info">{L("انتهى وقت الموعد؛ انتهاء الوقت لا يعني تنفيذه — سجّل ما حدث.", "The time has passed; that does not mean it happened — record what did.")}</Notice> : null}
          <dl className="hr-kv ws-kv">
            <div><dt>{L("الوقت", "When")}</dt><dd>{dueLabel(a.startAt, lang)} – {timeOf(a.endAt, lang)}</dd></div>
            {a.location ? <div><dt>{L("المكان", "Place")}</dt><dd>{a.location}</dd></div> : null}
            {a.meetingUrl ? <div><dt>{L("الرابط", "Link")}</dt><dd><a href={a.meetingUrl} target="_blank" rel="noopener noreferrer" dir="ltr">{a.meetingUrl}</a></dd></div> : null}
            <div><dt>{L("المنظّم", "Organiser")}</dt><dd>{a.organizer.name}</dd></div>
            {a.participants.length ? <div><dt>{L("المشاركون", "Participants")}</dt><dd>{a.participants.map((p) => p.employee.name).join("، ")}</dd></div> : null}
            {a.customer || a.opportunity || a.lead ? <div><dt>{L("مرتبط بـ", "Linked to")}</dt><dd>{a.customer ? <Link href={`/dashboard/customers/${a.customer.id}`}>{a.customer.name}</Link> : a.opportunity ? <Link href={`/dashboard/sales/deals/${a.opportunity.id}`}>{a.opportunity.title}</Link> : a.lead?.companyName}</dd></div> : null}
          </dl>
          {a.notes ? <p className="ws-desc">{a.notes}</p> : null}
          {mode === "cancel" ? <Field label={L("سبب الإلغاء (يصل للمشاركين)", "Reason (sent to participants)")}><textarea className="hr-input" rows={2} value={text} onChange={(x) => setText(x.target.value)} maxLength={500} /></Field> : null}
          {mode === "result" ? (
            <>
              {linked ? <fieldset className="ws-choices"><legend className="hr-label">{L("ماذا حدث؟", "What happened?")}</legend>
                {OUTCOMES.map(([v, ar, en]) => <label key={v} className={`ws-choice${outcome === v ? " is-on" : ""}`}><input type="radio" name="ao" checked={outcome === v} onChange={() => setOutcome(v)} /> {L(ar, en)}</label>)}
              </fieldset> : null}
              <Field label={L("ملاحظة", "Note")}><textarea className="hr-input" rows={2} value={text} onChange={(x) => setText(x.target.value)} maxLength={2000} /></Field>
            </>
          ) : null}
        </div>
      ) : null}
      {edit && a ? <AppointmentDialog appt={a} onClose={() => setEdit(false)} onSaved={(m) => { setEdit(false); setNote({ tone: "success", t: m }); reload(); onChanged(m); }} /> : null}
    </OpsPane>
  );
}

/** A marketing occasion: add / review (confirm with its source) / plan the preparation tasks. */
export function OccasionPane({ ev, canManage, onClose, onChanged }: { ev: CalEvent; canManage: boolean; onClose: () => void; onChanged: (m: string) => void }) {
  const L = useL();
  const lang = useLang();
  const o = ev.occasion!;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: "success" | "danger"; t: string } | null>(null);
  const run = async (fn: () => Promise<unknown>, m: string) => {
    setBusy(true); setNote(null);
    try { await fn(); setNote({ tone: "success", t: m }); onChanged(m); } catch (x) { setNote({ tone: "danger", t: msg(x) }); } finally { setBusy(false); }
  };
  const footer = canManage ? (
    <div className="ws-pane-actions">
      {o.status === "DRAFT" ? <Btn variant="primary" busy={busy} onClick={() => void run(() => wsFetch(`/api/workspace/occasions/${o.id}/confirm`, { json: { version: o.version } }), L("اعتُمد التاريخ بعد المراجعة.", "Date confirmed after review."))}>{L("اعتماد بعد المراجعة", "Confirm after review")}</Btn> : null}
      {o.status === "CONFIRMED" && o._count.tasks === 0 ? <Btn variant="primary" busy={busy} onClick={() => void run(() => wsFetch(`/api/workspace/occasions/${o.id}/prep`, { json: {} }), L("أُنشئت مهام التحضير الخمس.", "The five preparation tasks were created."))}>{L("إنشاء مهام التحضير", "Create preparation tasks")}</Btn> : null}
    </div>
  ) : null;
  return (
    <OpsPane label={L("المناسبة", "Occasion")} title={o.name} sub={<span className={`hr-dot tone-${o.status === "CONFIRMED" ? "success" : "warning"}`}><span>{o.status === "CONFIRMED" ? L("معتمدة", "Confirmed") : L("مسودة — تحتاج مراجعة", "Draft — needs review")}</span></span>} onClose={onClose} busy={busy} footer={footer} drawer="open" testId="occasion-pane">
      {note ? <Notice tone={note.tone}>{note.t}</Notice> : null}
      <dl className="hr-kv ws-kv">
        <div><dt>{L("التاريخ", "Dates")}</dt><dd>{dayOf(`${ev.start}T09:00:00Z`, lang)}{ev.end !== ev.start ? ` — ${dayOf(`${ev.end}T09:00:00Z`, lang)}` : ""}</dd></div>
        <div><dt>{L("المصدر", "Source")}</dt><dd>{o.sourceUrl ? <a href={o.sourceUrl} target="_blank" rel="noopener noreferrer" dir="ltr">{o.sourceUrl}</a> : o.sourceNote ?? <span className="ws-due is-overdue">{L("لم يُحدد — مطلوب قبل الاعتماد", "Not set — required to confirm")}</span>}</dd></div>
        <div><dt>{L("آخر تحقق", "Last verified")}</dt><dd>{o.lastVerifiedAt ? dueLabel(o.lastVerifiedAt, lang) : "—"}</dd></div>
        <div><dt>{L("مهام التحضير", "Preparation tasks")}</dt><dd>{o._count.tasks}</dd></div>
      </dl>
      <p className="hr-caption">{L("لا يُفترض ثبات التاريخ سنويًا؛ كل سنة سجل جديد بمصدره.", "Dates are never assumed to repeat yearly; each year is its own record with its source.")}</p>
    </OpsPane>
  );
}

export function OccasionDialog({ onClose, onSaved }: { onClose: () => void; onSaved: (m: string) => void }) {
  const L = useL();
  const today = riyadhDay(new Date());
  const [f, setF] = useState({ name: "", kind: "OCCASION", startDate: today, endDate: today, location: "", sourceUrl: "", sourceNote: "", notes: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (x: { target: { value: string } }) => setF((v) => ({ ...v, [k]: x.target.value }));
  const save = async () => {
    setBusy(true); setErr(null);
    try { await wsFetch("/api/workspace/occasions", { json: { ...f, endDate: f.endDate || f.startDate } }); onSaved(L("أُضيفت المناسبة كمسودة؛ راجِعها واعتمدها.", "Added as a draft; review and confirm it.")); }
    catch (x) { setErr(msg(x)); } finally { setBusy(false); }
  };
  const valid = useMemo(() => f.name.trim() && f.startDate && (!f.endDate || f.endDate >= f.startDate), [f]);
  return (
    <Dialog open title={L("مناسبة أو معرض أو حملة", "Occasion, exhibition or campaign")} onClose={onClose} className="ws-dialog" actions={<>
      <Btn onClick={onClose}>{L("تراجع", "Back")}</Btn>
      <Btn variant="primary" busy={busy} disabled={!valid} onClick={() => void save()}>{L("إضافة كمسودة", "Add as draft")}</Btn>
    </>}>
      {err ? <Notice tone="danger">{err}</Notice> : null}
      <div className="ws-row2">
        <Field label={L("الاسم", "Name")}><input className="hr-input" value={f.name} onChange={set("name")} maxLength={300} /></Field>
        <Field label={L("النوع", "Type")}><Select className="hr-select" value={f.kind} onChange={set("kind")}>
          <option value="OCCASION">{L("مناسبة", "Occasion")}</option><option value="EXHIBITION">{L("معرض", "Exhibition")}</option><option value="CAMPAIGN">{L("حملة", "Campaign")}</option><option value="HOLIDAY">{L("عطلة", "Holiday")}</option>
        </Select></Field>
      </div>
      <div className="ws-row2">
        <Field label={L("من", "From")}><input type="date" className="hr-input" value={f.startDate} onChange={set("startDate")} /></Field>
        <Field label={L("إلى", "To")}><input type="date" className="hr-input" min={f.startDate} value={f.endDate} onChange={set("endDate")} /></Field>
      </div>
      <Field label={L("رابط المصدر", "Source link")} help={L("مطلوب مصدر (رابط أو وصف) قبل اعتماد التاريخ.", "A source (link or note) is required before the date is confirmed.")}><input className="hr-input" type="url" dir="ltr" value={f.sourceUrl} onChange={set("sourceUrl")} placeholder="https://" /></Field>
      <Field label={L("أو وصف المصدر", "Or describe the source")}><input className="hr-input" value={f.sourceNote} onChange={set("sourceNote")} maxLength={500} /></Field>
      <Field label={L("المكان", "Place")}><input className="hr-input" value={f.location} onChange={set("location")} maxLength={300} /></Field>
    </Dialog>
  );
}
