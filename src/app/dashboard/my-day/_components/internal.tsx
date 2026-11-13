"use client";

// D17 «شغلي» (owner-approved Figma page D17 1953:2, 9 Nov 2026): the plan's internal work beside the customer work — a
// meeting, a field round, a report / desk work, «شغلة ثانية». What this file holds:
//   · useInternal        — one read of GET /api/sales/plan/internal: the people to meet (the HR manager, the last invited,
//                          the team), the last field-round places, the report suggestions, the running weekly rules.
//   · InternalFields     — the add sheet's questions for an internal kind: «مع مين؟» + «أرسل له دعوة في النظام» (off unless
//                          chosen — owner decision 1a), «وين؟» + «كم عميل جديد؟», «وش هو؟»; the day strip and the time stay
//                          the sheet's own. «كرّرها كل أسبوع» with «لين متى؟».
//   · RoundSheet         — «وش طلع من الجولة؟»: shops visited and «أضف عميل محتمل» (again and again; the lead duplicate check
//                          of the leads API, sales › lead_write), then «خلصت الجولة».
//   · RepeatingCard      — «خطتي ← المتكرر»: each weekly rule with «عدّل» (from next week) and «وقّفه».
//   · InvitesCard        — a colleague's meeting this rep was invited to, with «حطها في خطتي» (owner decision b: by hand).
import { latinNumberText } from "@/lib/numbers/typed-number";
import { roundFailedCount, roundLastSent, roundOpenValue, roundPending, trackRoundSave, type SaveEnd } from "./round-cache";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { D21Dialog } from "@/components/ui/Dialog";
import { Ico } from "@/components/shell/icons";
import { dayName, dayNum } from "./plan-dates";
import { dayLabel, timeLabel } from "./plan-logic";
import { useBackLayer } from "./back-layer";
import { errOf, send, type PItem } from "./khitati";
import { countNoun } from "@/components/ops/ui";

/** «عميل محتمل واحد / عميلين محتملين / 3 عملاء محتملين / 11 عميلًا محتملًا» (Abu Fahd: «1 عملاء محتملين»). */
const LEAD_FORMS: [string, string, string, string, string, string] = ["عميل محتمل واحد", "عميلين محتملين", "عملاء محتملين", "عميلًا محتملًا", "lead", "leads"];
const SHOP_FORMS: [string, string, string, string, string, string] = ["محل واحد", "محلين", "محلات", "محلًا", "shop", "shops"];
export const leadsText = (n: number, ar: boolean) => countNoun(n, ar ? "ar" : "en", LEAD_FORMS);
export const shopsText = (n: number, ar: boolean) => countNoun(n, ar ? "ar" : "en", SHOP_FORMS);

export type Person = { id: string; name: string; role?: "manager" | "recent"; active?: boolean; hint?: string | null; self?: boolean };
export type Rule = { id: string; category: string; label: string; title?: string; weekday: number; plannedTime: string | null; durationMin: number | null; invite: boolean; area: string | null;
  startWeek: string | null; untilDay: string | null; attendees: Person[] };
export type Hints = { me?: string; people: Person[]; team: Person[]; areas: string[]; reports: string[]; repeating: Rule[]; canAddLeads: boolean; inPlan?: string[] };

export function useInternal(reload: number, enabled = true) {
  const [data, setData] = useState<Hints | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let off = false;
    fetch("/api/sales/plan/internal", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((j: Hints | null) => { if (!off && j) setData(j); }).catch(() => {});
    return () => { off = true; };
  }, [reload, enabled]);
  return data;
}

const WEEKDAYS = [0, 1, 2, 3, 4];
const WD_AR = ["أحد", "إثنين", "ثلاثاء", "أربعاء", "خميس", "جمعة", "سبت"];
const WD_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const everyDay = (wd: number, ar: boolean) => (ar ? `كل ${["أحد", "إثنين", "ثلاثاء", "أربعاء", "خميس", "جمعة", "سبت"][wd]}` : `Every ${WD_EN[wd]}`);
export const durationText = (m: number | null, ar: boolean) => (m === null ? "" : m === 30 ? (ar ? "نص ساعة" : "30 min") : m === 60 ? (ar ? "ساعة" : "1 hour") : m === 120 ? (ar ? "ساعتين" : "2 hours") : ar ? `${m} دقيقة` : `${m} min`);
/** The month's last day (Riyadh dates) — «آخر الشهر». */
const monthEnd = (day: string) => { const d = new Date(`${day}T00:00:00Z`); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10); };

/** «كرّرها كل أسبوع» + «لين متى؟»: off, or { until: null } (no end) / a day. */
export type Repeat = null | { until: string | null };
function RepeatBox({ ar, day, value, onChange }: { ar: boolean; day: string | null; value: Repeat; onChange: (r: Repeat) => void }) {
  const [other, setOther] = useState(false);
  const on = !!value;
  if (!day) return <small className="pl-hint" data-testid="plan-repeat-needs-day"><Ico name="repeat" small /> {ar ? "اختر يوم عشان تقدر تكرّرها كل أسبوع." : "Pick a day to repeat it every week."}</small>;
  const wd = new Date(`${day}T00:00:00Z`).getUTCDay();
  const end = monthEnd(day);
  return (
    <div className={`kp-repeat${on ? " on" : ""}`} data-testid="plan-repeat">
      <label className="kp-switch">
        <span><Ico name="repeat" small />{ar ? "كرّرها كل أسبوع" : "Repeat every week"}{on ? ` — ${everyDay(wd, ar)}` : ""}</span>
        <input type="checkbox" role="switch" checked={on} onChange={(e) => onChange(e.target.checked ? { until: null } : null)} data-testid="plan-repeat-toggle" />
      </label>
      {on ? (
        <>
          <small className="pl-hint">{ar ? "لين متى؟" : "Until?"}</small>
          <div className="kp-chips" role="group">
            <button type="button" aria-pressed={!other && value!.until === null} onClick={() => { setOther(false); onChange({ until: null }); }} data-testid="plan-repeat-noend">{ar ? "بدون نهاية" : "No end"}</button>
            <button type="button" aria-pressed={!other && value!.until === end} onClick={() => { setOther(false); onChange({ until: end }); }} data-testid="plan-repeat-month">{ar ? "آخر الشهر" : "End of month"}</button>
            <button type="button" aria-pressed={other} onClick={() => setOther(true)} data-testid="plan-repeat-date"><Ico name="cal" small />{ar ? "تاريخ…" : "Date…"}</button>
          </div>
          {other ? <input type="date" className="pl-in" min={day} value={value!.until ?? ""} onChange={(e) => onChange({ until: e.target.value || null })} aria-label={ar ? "لين" : "Until"} data-testid="plan-repeat-until" /> : null}
          <small className="pl-hint">{ar ? "تطلع في خطتك كل أسبوع لحالها. توقفها أو تعدّلها من «خطتي ← المتكرر»." : "It appears in your plan every week. Stop or change it in «My plan › Repeating»."}</small>
        </>
      ) : null}
    </div>
  );
}

export type InternalValue = { attendees: Person[]; invite: boolean; durationMin: number; area: string; targetNew: number | null; label: string; repeat: Repeat };
export const NEW_INTERNAL: InternalValue = { attendees: [], invite: false, durationMin: 30, area: "", targetNew: null, label: "", repeat: null };

/** The title written for an internal item: «اجتماع مع سعد وخالد» / «جولة في حي النرجس» / the report's / the free text. */
export function internalTitle(kind: string, v: InternalValue, ar: boolean): string {
  if (kind === "MEETING") return v.attendees.length ? `${ar ? "اجتماع مع" : "Meeting with"} ${v.attendees.map((a) => a.name.trim()).join(ar ? " و" : ", ")}` : ar ? "اجتماع" : "Meeting";
  if (kind === "FIELD_ROUND") return v.area.trim() ? `${ar ? "جولة في" : "Round in"} ${v.area.trim()}` : "";
  return v.label.trim();
}
export const internalOk = (kind: string, v: InternalValue) => (kind === "FIELD_ROUND" ? v.area.trim().length >= 2 : kind === "MEETING" ? true : v.label.trim().length >= 2);

/**
 * The questions of an internal kind. The sheet asks «متى؟» and the time itself, in between (Figma D17 A1–A3 order):
 * `part="top"` — what / with whom / where; `part="bottom"` — a meeting's length and «كرّرها كل أسبوع».
 */
export function InternalFields({ ar, kind, value, onChange, hints, day, time, part = "top", forRep }: {
  ar: boolean; kind: "MEETING" | "FIELD_ROUND" | "REPORT" | "CHECK"; value: InternalValue; onChange: (v: InternalValue) => void; hints: Hints | null; day: string | null; time: string;
  part?: "top" | "bottom";
  /** The supervisor adding to a rep's plan (the rep's name): the supervisor organises the meeting and the rep is invited; no repeat. */
  forRep?: string;
}) {
  const set = (p: Partial<InternalValue>) => onChange({ ...value, ...p });
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Person[]>([]);
  useEffect(() => {
    if (kind !== "MEETING" || q.trim().length < 2) return;
    let off = false;
    const t = setTimeout(() => {
      // The name, the job title, or a role word («المشرف», «مدير» → the supervisors) — Abu Fahd.
      fetch(`/api/sales/plan/internal?q=${encodeURIComponent(q.trim())}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : { found: [] }))
        .then((j: { found: Person[] }) => { if (!off) setFound((j.found ?? []).filter((p) => !p.self).slice(0, 6)); }).catch(() => {});
    }, 250);
    return () => { off = true; clearTimeout(t); };
  }, [q, kind]);
  if (part === "bottom") {
    return (
      <>
        {kind === "MEETING" ? <>
          <b className="pl-q">{ar ? "المدة" : "Length"}</b>
          <div className="kp-chips kp-sand" role="group" data-testid="plan-meet-duration">
            {[30, 60, 120].map((m) => <button key={m} type="button" aria-pressed={value.durationMin === m} onClick={() => set({ durationMin: m })}>{durationText(m, ar)}</button>)}
          </div>
        </> : null}
        {forRep ? null : <RepeatBox ar={ar} day={day} value={value.repeat} onChange={(repeat) => set({ repeat })} />}
      </>
    );
  }
  const has = (p: Person) => value.attendees.some((a) => a.id === p.id);
  const flip = (p: Person) => set({ attendees: has(p) ? value.attendees.filter((a) => a.id !== p.id) : [...value.attendees, p] });
  const team = hints?.team ?? [];
  const allTeam = team.length > 0 && team.every(has);
  if (kind === "MEETING") {
    const chips = hints?.people ?? [];
    return (
      <>
        <b className="pl-q">{ar ? "مع مين؟" : "With whom?"}</b>
        <div className="kp-chips kp-sand" role="group" data-testid="plan-meet-people">
          {chips.map((p) => <button key={p.id} type="button" className="kp-person" aria-pressed={has(p)} onClick={() => flip(p)} data-testid="plan-meet-person">
            {p.id === hints?.me ? (ar ? "أنا" : "Me") : p.name}{p.role === "manager" ? <small> · {ar ? "مشرفي" : "My supervisor"}</small> : null}</button>)}
          {team.length ? <button type="button" aria-pressed={allTeam} onClick={() => set({ attendees: allTeam ? value.attendees.filter((a) => !team.some((t) => t.id === a.id)) : [...value.attendees, ...team.filter((t) => !has(t))] })} data-testid="plan-meet-team">{ar ? "كل الفريق" : "The whole team"}</button> : null}
          {value.attendees.filter((a) => !chips.some((c) => c.id === a.id) && !team.some((t) => t.id === a.id)).map((p) => <button key={p.id} type="button" aria-pressed onClick={() => flip(p)}>{p.name}</button>)}
        </div>
        <span className="pl-search"><Ico name="search" small /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder={ar ? "ابحث عن زميل…" : "Find a colleague…"} data-testid="plan-meet-q" /></span>
        {q.trim().length >= 2 && found.length ? <div className="pl-custs">{found.map((p) => (
          <button key={p.id} type="button" className={`pl-cust${has(p) ? " on" : ""}`} onClick={() => { flip(p); setQ(""); }} data-testid="plan-meet-found"><span className="pl-radio" /><b>{p.name}</b>
            {p.role === "manager" ? <small> · {ar ? "مشرف" : "Supervisor"}</small> : p.hint ? <small> · {p.hint}</small> : null}</button>
        ))}</div> : null}
        {forRep ? (
          // Abu Fahd: the supervisor attends — with a time the meeting is in the supervisor's calendar and the rep is told.
          <small className="pl-note kp-sand" data-testid="plan-boss-note">{time && day
            ? (ar ? `تطلع في تقويمك ويوصل ${forRep}${value.attendees.length ? " واللي معه" : ""} إشعار بالاجتماع.` : `It goes in your calendar; ${forRep} is told.`)
            : (ar ? `حط وقت عشان تطلع في تقويمك ويوصل ${forRep} إشعار.` : `Set a time to put it in your calendar and tell ${forRep}.`)}</small>
        ) : (
          <label className="kp-switch kp-invite" data-testid="plan-invite">
            <span>{ar ? "أرسل له دعوة في النظام" : "Send them an invitation"}</span>
            <input type="checkbox" role="switch" checked={value.invite} disabled={!value.attendees.length} onChange={(e) => set({ invite: e.target.checked })} data-testid="plan-invite-toggle" />
          </label>
        )}
        {value.invite && (!day || !time) ? <small className="pl-err" data-testid="plan-invite-needs-time">{ar ? "الدعوة تحتاج يوم ووقت." : "An invitation needs a day and a time."}</small> : null}
      </>
    );
  }
  if (kind === "FIELD_ROUND") {
    return (
      <>
        <b className="pl-q">{ar ? "وين؟" : "Where?"}<small> {ar ? "الحي أو المنطقة" : "District or area"}</small></b>
        <input className="pl-in" value={value.area} maxLength={100} onChange={(e) => set({ area: e.target.value })} placeholder={ar ? "مثال: حي النرجس" : "e.g. Al Narjis"} data-testid="plan-round-area" />
        {hints?.areas.length ? <><small className="pl-hint">{ar ? "آخر الأماكن" : "Recent places"}</small>
          <div className="kp-chips kp-sand" role="group">{hints.areas.map((a) => <button key={a} type="button" aria-pressed={value.area.trim() === a} onClick={() => set({ area: a })} data-testid="plan-round-recent">{a}</button>)}</div></> : null}
        <b className="pl-q">{ar ? "كم عميل جديد تبي توصل له؟" : "New customers to reach"}<small> {ar ? "اختياري" : "optional"}</small></b>
        <Stepper ar={ar} value={value.targetNew ?? 0} max={99} onChange={(n) => set({ targetNew: n || null })} testId="plan-round-target" />
      </>
    );
  }
  const reports = kind === "REPORT" ? hints?.reports ?? [] : [];
  return (
    <>
      <b className="pl-q">{kind === "REPORT" ? (ar ? "وش هو؟" : "What is it?") : ar ? "وش الشغلة؟" : "What is it?"}</b>
      {reports.length ? <div className="kp-chips kp-sand" role="group" data-testid="plan-report-suggest">{reports.map((r) => (
        <button key={r} type="button" aria-pressed={value.label.trim() === r}
          onClick={() => set({ label: r })}>{r}</button>
      ))}</div> : null}
      <input className="pl-in" value={value.label} maxLength={200} onChange={(e) => set({ label: e.target.value })}
        placeholder={kind === "REPORT" ? (ar ? "أو اكتب…" : "Or write…") : ar ? "مثال: طباعة كتالوج المعرض" : "e.g. print the fair catalogue"} data-testid="plan-check-text" />
    </>
  );
}

function Stepper({ ar, value, max, onChange, testId }: { ar: boolean; value: number; max: number; onChange: (n: number) => void; testId: string }) {
  return (
    <span className="kp-step" role="group" data-testid={testId}>
      <button type="button" onClick={() => onChange(Math.min(max, value + 1))} aria-label={ar ? "زيد" : "More"} data-testid={`${testId}-plus`}>+</button>
      <input className="num" inputMode="numeric" value={String(value)} onChange={(e) => { const n = Number(latinNumberText(e.target.value).replace(/\D/g, "")); onChange(Number.isFinite(n) ? Math.min(max, n) : 0); }} aria-label={ar ? "العدد" : "Number"} data-testid={`${testId}-value`} />
      <button type="button" onClick={() => onChange(Math.max(0, value - 1))} aria-label={ar ? "نقّص" : "Fewer"}>−</button>
    </span>
  );
}

// ─── «وش طلع من الجولة؟» ─────────────────────────────────────────────────────────────────────────────────────────────
type Dup = { leadId: string; companyName: string; contactName: string | null };
type CustDup = { id: string | null; name: string | null };
export function RoundSheet({ ar, it, today, canAddLeads, onClose, onSaved }: { ar: boolean; it: PItem; today: string; canAddLeads: boolean; onClose: () => void; onSaved: (msg: string) => void }) {
  useBackLayer(1, onClose);
  // What the plan list shows for this round now; the sheet opens on a confirmed save from this tab while the list still
  // shows it (round-cache.ts), else on the server's value.
  const base = it.shopsVisited ?? 0;
  const [shops, setShops] = useState(() => roundOpenValue(it.id, it.shopsVisited));
  const shopsErrText = (n: number) => (ar ? `ما انحفظ العدد (${n}) — تأكد من الاتصال، ويُعاد الحفظ مع أي تعديل.` : `The count (${n}) was not saved — check the connection; it is sent again with your next change.`);
  const [shopsErr, setShopsErr] = useState(() => { const f = roundFailedCount(it.id); return f === null ? "" : shopsErrText(f); });
  const [leads, setLeads] = useState(it.roundLeads ?? []);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [dup, setDup] = useState<Dup[] | null>(null);
  const [custDup, setCustDup] = useState<CustDup[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // Abu Fahd: «كم محل زرت؟» is saved as the rep counts (a closed sheet or a reload keeps it). Only a 2xx confirms a
  // count (round-cache.ts); a failure says so here, and the next change sends again (D20.1 gate L1).
  const savedShops = useRef(shops);
  const latest = useRef(shops);
  useEffect(() => { latest.current = shops; }, [shops]);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const ended = (e: SaveEnd) => {
    if (!e.latest) return; // an older save answering late changes nothing (R2-L2)
    if (e.ok) { savedShops.current = e.count; if (mounted.current) setShopsErr(""); return; }
    if (!mounted.current) return;
    setShopsErr(shopsErrText(e.count));
    // Not saved. Taps made since are kept (they are sent with the next save); with none, back to what the server holds.
    if (latest.current !== e.count) return;
    const back = roundOpenValue(it.id, it.shopsVisited); // the last confirmed count, or the server's
    savedShops.current = back; setShops(back);
  };
  const saveShops = (n: number) => {
    void trackRoundSave(it.id, n, base, async () => (await send(`/api/sales/plan/items/${it.id}`, "PATCH", { shopsVisited: n })).ok).then(ended);
  };
  // Opened on a save still on its way (closed and opened again at once): its answer decides.
  useEffect(() => {
    const p = roundPending(it.id);
    if (p && p.count === shops) void p.done.then(ended);
  }, [it.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (shops === savedShops.current) return;
    const t = setTimeout(() => saveShops(shops), 600);
    return () => clearTimeout(t);
  }, [shops, it.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // Closed within the 600 ms wait: the count is still sent (it was dropped with the pending timer).
  // Not when that very count is already the last one sent (R2-L2: closing never resends a stale value).
  useEffect(() => () => { if (latest.current !== savedShops.current && latest.current !== roundLastSent(it.id)) saveShops(latest.current); }, [it.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const addLead = async (anyway = false) => {
    if (name.trim().length < 2 || busy) return;
    setBusy(true); setErr("");
    const r = await send("/api/sales/leads", "POST", { companyName: name.trim(), phone: phone.trim() || null, source: "WALK_IN", sourceNote: it.area ? `${ar ? "جولة ميدانية" : "Field round"} — ${it.area}` : null,
      fieldRoundItemId: it.id, ...(anyway ? { acknowledgeDuplicate: true } : {}) });
    setBusy(false);
    if (r.status === 409 && Array.isArray(r.data.customers)) { setCustDup(r.data.customers as CustDup[]); return; }
    if (r.status === 409 && Array.isArray(r.data.duplicates)) { setDup(r.data.duplicates as Dup[]); return; }
    if (!r.ok) { setErr(String((ar ? r.data.errorAr ?? r.data.error : r.data.error) ?? (ar ? "تعذّر الحفظ." : "Could not save."))); return; }
    const lead = r.data.lead as { id: string; companyName: string };
    setLeads([...leads, { id: lead.id, name: lead.companyName }]); setName(""); setPhone(""); setDup(null); setCustDup(null);
  };
  const finish = async () => {
    setBusy(true); setErr("");
    const r = await send(`/api/sales/plan/items/${it.id}`, "PATCH", { checked: true, shopsVisited: shops });
    setBusy(false);
    if (!r.ok) { setErr(errOf(r.data, ar)); return; }
    onSaved(ar ? `خلصت الجولة: ${shopsText(shops, true)} · ${leadsText(leads.length, true)}` : `Round done: ${shopsText(shops, false)} · ${leadsText(leads.length, false)}`);
  };
  const target = it.targetNew ? (ar ? ` (هدفك ${it.targetNew})` : ` (aim ${it.targetNew})`) : "";
  return (
    <D21Dialog lang={ar ? "ar" : "en"} title={ar ? "وش طلع من الجولة؟" : "How did the round go?"} sub={`${it.area ?? it.label ?? ""}${it.plannedDay ? ` · ${dayLabel(it.plannedDay, today, ar)}` : ""}`} onClose={onClose} width={460} testId="plan-round"
      actions={<><button type="button" className="btn p" disabled={busy} onClick={finish} data-testid="plan-round-done">{ar ? "خلصت الجولة" : "Round done"}</button>
        <button type="button" className="btn" onClick={onClose}>{ar ? "إلغاء" : "Cancel"}</button></>}>
      <div className="pl-sheet kp-sheet">
        <b className="pl-q">{ar ? "كم محل زرت؟" : "Shops visited?"}</b>
        <Stepper ar={ar} value={shops} max={999} onChange={setShops} testId="plan-round-shops" />
        {shopsErr ? <p className="pl-err" role="alert" data-testid="plan-round-shops-err">{shopsErr}</p> : null}
        <b className="pl-q">{ar ? "عملاء محتملين من الجولة" : "Leads from the round"}</b>
        {leads.length ? <ul className="kp-leads" data-testid="plan-round-leads">{leads.map((l) => <li key={l.id}><b>{l.name}</b><span><Ico name="tick" small />{ar ? "انضاف" : "Added"}</span></li>)}</ul> : null}
        {canAddLeads ? (
          <div className="kp-leadform" data-testid="plan-round-form">
            <b>{ar ? "أضف عميل محتمل" : "Add a lead"}</b>
            <input className="pl-in" value={name} maxLength={200} onChange={(e) => { setName(e.target.value); setDup(null); setCustDup(null); }} placeholder={ar ? "اسم المحل" : "Shop name"} data-testid="plan-round-name" />
            <input className="pl-in" value={phone} inputMode="tel" maxLength={30} onChange={(e) => { setPhone(e.target.value); setDup(null); setCustDup(null); }} placeholder={ar ? "الجوال (اختياري)" : "Mobile (optional)"} data-testid="plan-round-phone" />
            {custDup ? (
              // Abu Fahd: the phone is a CUSTOMER's — not added unless confirmed; another rep's customer without details.
              <div className="kp-dup" role="alert" data-testid="plan-round-custdup">
                <b>{custDup.some((c) => c.name) ? `${ar ? "هذا عميلك" : "This is your customer"}: ${custDup.filter((c) => c.name).map((c) => c.name).join("، ")}` : ar ? "هذا الرقم لعميل مسجّل عندنا" : "This number belongs to a customer we have"}</b>
                <span className="kp-chips">
                  {custDup.find((c) => c.id) ? <a className="kp-act" href={`/dashboard/customers/${custDup.find((c) => c.id)!.id}`} data-testid="plan-round-custdup-open">{ar ? "افتح العميل" : "Open the customer"}</a> : null}
                  <button type="button" onClick={() => { setCustDup(null); setName(""); setPhone(""); }} data-testid="plan-round-dup-skip">{ar ? "لا تضيفه" : "Don't add"}</button>
                  <button type="button" onClick={() => void addLead(true)} data-testid="plan-round-dup-add">{ar ? "أضفه على كل حال" : "Add anyway"}</button></span>
              </div>
            ) : dup ? (
              <div className="kp-dup" role="alert" data-testid="plan-round-dup">
                <b>{ar ? "هذا الجوال موجود عندنا" : "This number is already with us"}</b>
                <small>{dup.map((d) => d.companyName).join("، ")}</small>
                <span className="kp-chips"><button type="button" onClick={() => { setDup(null); setName(""); setPhone(""); }} data-testid="plan-round-dup-skip">{ar ? "لا تضيفه" : "Don't add"}</button>
                  <button type="button" onClick={() => void addLead(true)} data-testid="plan-round-dup-add">{ar ? "أضفه على كل حال" : "Add anyway"}</button></span>
              </div>
            ) : <button type="button" className="btn kp-sandbtn" disabled={busy || name.trim().length < 2} onClick={() => void addLead()} data-testid="plan-round-add"><Ico name="plus" small />{ar ? "أضفه" : "Add"}</button>}
            <small className="pl-hint">{ar ? "كل واحد ينضاف على طول — أضف قد ما تبي." : "Each one is saved at once — add as many as you like."}</small>
          </div>
        ) : <p className="pl-note" data-testid="plan-round-noperm">{ar ? "إضافة العملاء المحتملين تحتاج صلاحية. اكتب الأسماء في ملاحظة، والمشرف يضيفهم." : "Adding leads needs a permission. Note the names; your supervisor adds them."}</p>}
        <p className="pl-note kp-sum kp-sand" data-testid="plan-round-summary">{`${shopsText(shops, ar)} · ${leadsText(leads.length, ar)}${target}`}</p>
        {err ? <p className="pl-err" role="alert">{err}</p> : null}
      </div>
    </D21Dialog>
  );
}

// ─── «المتكرر» ───────────────────────────────────────────────────────────────────────────────────────────────────────
const ICON_OF: Record<string, "meet" | "pin" | "doc" | "note"> = { MEETING: "meet", FIELD_ROUND: "pin", REPORT: "doc", OTHER: "note" };
const ruleWhen = (r: Rule, ar: boolean) => [everyDay(r.weekday, ar), r.plannedTime ? timeLabel(r.plannedTime, ar) : null, r.durationMin ? durationText(r.durationMin, ar) : null,
  r.attendees.length ? `${ar ? "مع" : "with"} ${r.attendees.map((a) => a.name.trim()).join(ar ? " و" : ", ")}` : null].filter(Boolean).join(" · ");
const ruleUntil = (r: Rule, ar: boolean) => (r.untilDay ? `${ar ? "لين" : "Until"} ${dayNum(r.untilDay)} ${r.untilDay.slice(5, 7)}/${r.untilDay.slice(0, 4)}` : ar ? "بدون نهاية" : "No end");

export function RepeatingCard({ ar, rules, issues = [], onChanged }: { ar: boolean; rules: Rule[]; issues?: string[]; onChanged: (msg: string) => void }) {
  const [edit, setEdit] = useState<Rule | null>(null);
  const [stop, setStop] = useState<Rule | null>(null);
  if (!rules.length) return null;
  return (
    <section className="md-card kp-repeating" id="plan-repeating" data-testid="plan-repeating">
      <div className="md-h"><h2><Ico name="repeat" small className="md-h-ico2" />{ar ? "المتكرر" : "Repeating"}<small className="kp-count">{rules.length}</small></h2></div>
      <ul className="kp-list">{rules.map((r) => (
        <li key={r.id} className="kp-row kp-int sm" data-testid="plan-rule">
          <div className="kp-row-main"><span className="kp-row-t"><b>{r.title ?? r.label}</b>
            <small><Ico name={ICON_OF[r.category] ?? "note"} small />{ruleWhen(r, ar)}</small><small>{ruleUntil(r, ar)}</small>
            {issues.includes(r.id) ? <small className="kp-late" data-testid="plan-rule-issue">{ar ? "تعذّر تجهيز الأسابيع الجاية — جرّب «عدّل» واحفظ" : "The coming weeks could not be prepared — try «Edit» and save"}</small> : null}</span></div>
          <div className="kp-acts"><button type="button" className="kp-act" onClick={() => setEdit(r)} data-testid="plan-rule-edit">{ar ? "عدّل" : "Edit"}</button>
            <button type="button" className="kp-act dan" onClick={() => setStop(r)} data-testid="plan-rule-stop">{ar ? "وقّفه" : "Stop"}</button></div>
        </li>
      ))}</ul>
      {edit ? <RuleEdit ar={ar} rule={edit} onClose={() => setEdit(null)} onSaved={(m) => { setEdit(null); onChanged(m); }} onStop={() => { setStop(edit); setEdit(null); }} /> : null}
      {stop ? <StopRule ar={ar} rule={stop} onClose={() => setStop(null)} onDone={(m) => { setStop(null); onChanged(m); }} /> : null}
    </section>
  );
}

function RuleEdit({ ar, rule, onClose, onSaved, onStop }: { ar: boolean; rule: Rule; onClose: () => void; onSaved: (m: string) => void; onStop: () => void }) {
  useBackLayer(1, onClose);
  const [wd, setWd] = useState(rule.weekday);
  const [name, setName] = useState(rule.label);
  const [time, setTime] = useState(rule.plannedTime ?? "");
  const [until, setUntil] = useState<string | null>(rule.untilDay);
  const [other, setOther] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [today] = useState(() => new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10));
  const end = monthEnd(today);
  const save = async () => {
    setBusy(true); setErr("");
    const r = await send(`/api/sales/plan/recurrences/${rule.id}`, "PATCH", { weekday: wd, plannedTime: time || null, untilDay: until, ...(name.trim() !== rule.label ? { label: name.trim() } : {}) });
    setBusy(false);
    if (!r.ok) { setErr(errOf(r.data, ar)); return; }
    onSaved(ar ? "انحفظ — من الأسبوع الجاي." : "Saved — from next week.");
  };
  return (
    <D21Dialog lang={ar ? "ar" : "en"} title={ar ? "عدّل المتكرر" : "Edit repeating"} sub={rule.title ?? rule.label} onClose={onClose} width={440} testId="plan-rule-dialog"
      actions={<><button type="button" className="btn p" disabled={busy || (rule.invite && !time)} onClick={save} data-testid="plan-rule-save">{ar ? "احفظ" : "Save"}</button>
        <button type="button" className="btn" onClick={onStop} data-testid="plan-rule-stop2">{ar ? "وقّف التكرار" : "Stop repeating"}</button></>}>
      <div className="pl-sheet kp-sheet">
        <b className="pl-q">{ar ? "الاسم" : "Name"}</b>
        <input className="pl-in" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} data-testid="plan-rule-name" />
        {rule.attendees.length ? (
          <>
            <b className="pl-q">{ar ? "مع مين؟" : "With whom?"}</b>
            <ul className="kp-leads" data-testid="plan-rule-people">{rule.attendees.map((a) => (
              <li key={a.id} className={a.active === false ? "off" : undefined}><b>{a.name}</b>{a.active === false ? <small data-testid="plan-rule-inactive">{ar ? "زميل ما عاد نشط — ينشال من الاجتماع" : "No longer active — removed from the meeting"}</small> : null}</li>
            ))}</ul>
          </>
        ) : null}
        <b className="pl-q">{ar ? "أي يوم؟" : "Which day?"}</b>
        <div className="kp-chips kp-sand" role="group" data-testid="plan-rule-days">{WEEKDAYS.map((d) => <button key={d} type="button" aria-pressed={wd === d} onClick={() => setWd(d)}>{ar ? WD_AR[d] : WD_EN[d]}</button>)}</div>
        <b className="pl-q">{rule.invite ? (ar ? "الوقت" : "Time") : ar ? "الوقت (اختياري)" : "Time (optional)"}</b>
        <input type="time" className="pl-in" value={time} onChange={(e) => setTime(e.target.value)} aria-label={ar ? "الوقت" : "Time"} data-testid="plan-rule-time" />
        <b className="pl-q">{ar ? "لين متى؟" : "Until?"}</b>
        <div className="kp-chips kp-sand" role="group">
          <button type="button" aria-pressed={!other && until === null} onClick={() => { setOther(false); setUntil(null); }}>{ar ? "بدون نهاية" : "No end"}</button>
          <button type="button" aria-pressed={!other && until === end} onClick={() => { setOther(false); setUntil(end); }}>{ar ? "آخر الشهر" : "End of month"}</button>
          <button type="button" aria-pressed={other} onClick={() => setOther(true)}><Ico name="cal" small />{ar ? "تاريخ…" : "Date…"}</button>
        </div>
        {other ? <input type="date" className="pl-in" min={today} value={until ?? ""} onChange={(e) => setUntil(e.target.value || null)} aria-label={ar ? "لين" : "Until"} /> : null}
        <p className="pl-note kp-sum kp-sand">{ar ? `من الأسبوع الجاي: ${everyDay(wd, true)}${time ? ` ${timeLabel(time, true)}` : ""} · ${until ? `لين ${until}` : "بدون نهاية"}. هالأسبوع ما يتغيّر.` : `From next week: ${everyDay(wd, false)}. This week stays.`}</p>
        {err ? <p className="pl-err" role="alert">{err}</p> : null}
      </div>
    </D21Dialog>
  );
}

function StopRule({ ar, rule, onClose, onDone }: { ar: boolean; rule: Rule; onClose: () => void; onDone: (m: string) => void }) {
  useBackLayer(1, onClose);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    const r = await send(`/api/sales/plan/recurrences/${rule.id}`, "PATCH", { stop: true });
    setBusy(false);
    if (!r.ok) { setErr(errOf(r.data, ar)); return; }
    onDone(ar ? `وقّفنا «${rule.label}».` : `Stopped «${rule.label}».`);
  };
  return (
    <D21Dialog lang={ar ? "ar" : "en"} title={ar ? `توقف «${rule.label}»؟` : `Stop «${rule.label}»?`} onClose={onClose} width={420} testId="plan-rule-stop-dialog"
      actions={<><button type="button" className="btn dan" disabled={busy} onClick={go} data-testid="plan-rule-stop-yes">{ar ? "وقّفه" : "Stop it"}</button>
        <button type="button" className="btn" onClick={onClose}>{ar ? "لا، خلّه" : "No, keep it"}</button></>}>
      <p className="pl-sheet">{ar ? "اللي في خطتك هالأسبوع يبقى، وما يطلع من الأسبوع الجاي. تقدر ترجّعه من «أضف» وقت ما تبي." : "This week's stays; it won't appear from next week."}
        {rule.invite ? (ar ? " والمدعوين يوصلهم إن الاجتماعات الجاية انلغت." : " The invited colleagues are told the coming meetings are cancelled.") : ""}</p>
      {err ? <p className="pl-err" role="alert">{err}</p> : null}
    </D21Dialog>
  );
}

// ─── Invitations from colleagues ─────────────────────────────────────────────────────────────────────────────────────
export type Appt = { id: string; title: string; startAt: string; endAt: string; status: string; kind?: string; actions?: string[]; organizer?: { name: string } | null; recurRule?: string | null };
/** A colleague's meeting this rep is in and has not put in the plan: «دعوة اجتماع من …» with «حطها في خطتي». */
export function InvitesCard({ ar, invites, onAdded }: { ar: boolean; invites: Appt[]; onAdded: (msg: string) => void }) {
  const [hidden, setHidden] = useState<Set<string>>(() => { try { return new Set(JSON.parse(window.localStorage.getItem("kp-invites-hidden") ?? "[]") as string[]); } catch { return new Set(); } });
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const shown = invites.filter((a) => !hidden.has(a.id)).slice(0, 3);
  if (!shown.length) return null;
  const hide = (id: string) => { const s = new Set(hidden); s.add(id); setHidden(s); try { window.localStorage.setItem("kp-invites-hidden", JSON.stringify([...s].slice(-50))); } catch { /* private mode */ } };
  const add = async (a: Appt) => {
    setBusy(a.id); setErr("");
    const r = await send("/api/sales/plan/items", "POST", { appointmentId: a.id });
    setBusy(null);
    if (!r.ok && r.status !== 409) { setErr(errOf(r.data, ar)); return; }
    hide(a.id);
    onAdded(ar ? `انضاف لخطتك: ${a.title}` : `Added to your plan: ${a.title}`);
  };
  const when = (a: Appt) => {
    const loc = new Date(Date.parse(a.startAt) + 3 * 3_600_000).toISOString();
    const day = loc.slice(0, 10), hm = loc.slice(11, 16);
    const mins = Math.round((Date.parse(a.endAt) - Date.parse(a.startAt)) / 60_000);
    return [`${dayName(day, ar)} ${dayNum(day)}`, timeLabel(hm, ar), durationText(mins, ar)].filter(Boolean).join(" · ");
  };
  return (
    <>
      {shown.map((a) => (
        <section key={a.id} className="md-card kp-invite-card" data-testid="plan-invite-card">
          <b><Ico name="meet" small />{ar ? `دعوة اجتماع${a.organizer?.name ? ` من ${a.organizer.name.trim()}` : ""}` : `Meeting invite${a.organizer?.name ? ` from ${a.organizer.name}` : ""}`}</b>
          <small>{a.title} · {when(a)}</small>
          <div className="kp-acts">
            <Link className="kp-act" href={`/dashboard/workspace/calendar?appointment=${a.id}`}><Ico name="cal" small />{ar ? "افتح الموعد" : "Open"}</Link>
            <button type="button" className="kp-act sand" disabled={busy === a.id} onClick={() => void add(a)} data-testid="plan-invite-add"><Ico name="plus" small />{ar ? "حطها في خطتي" : "Put it in my plan"}</button>
            <button type="button" className="kp-act" onClick={() => hide(a.id)} data-testid="plan-invite-hide">{ar ? "مو الحين" : "Not now"}</button>
          </div>
          {err ? <p className="pl-err" role="alert">{err}</p> : null}
        </section>
      ))}
    </>
  );
}

