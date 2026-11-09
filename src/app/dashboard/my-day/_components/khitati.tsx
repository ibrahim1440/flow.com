"use client";

// D16 «خطتي» (owner-approved Figma page D16 1941:2, 9 Nov 2026): ONE place for what the rep means to do, from adding it to
// getting it done. «تذكير» and «موعد» are one thing — an item with a time is an appointment, a day only is a reminder; the
// word «بند» is gone. The kinds: زيارة · مكالمة · عرض سعر · تحصيل · عيّنة · شغلة ثانية.
//   · AddPlanSheet  — «أضف لخطتي»: one sheet (kind tiles, the customer with «عملاء يحتاجونك», ONE day strip, optional time).
//   · WhatHappened  — the ONE check-off rule: tap the circle → «وش صار؟». A visit / call is recorded (the record ticks it,
//                     services/sales/plans.ts `matchPlan`); a quotation / collection ticks itself («انحسبت تلقائياً»); a
//                     sample or something else is ticked by hand; «ما تمّت» moves it to another day.
//   · TodayPlan     — «خطة اليوم», the first block of «يومي»: the ordered checklist, the end-of-day «انقلها لبكرة», the
//                     empty state and the Sunday «خطّط أسبوعك» card. Reminders and appointments made before D16 (workspace
//                     tasks, follow-ups, calendar) show in it too until they are moved into the plan.
//   · WeekPlan      — the «خطتي» tab: the week day by day, progress against the targets (the supervisor's locked) and
//                     «خارج الخطة». With `rep`: the supervisor's view — read-only, may add and remove what the supervisor added.
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { D21Dialog } from "@/components/ui/Dialog";
import { HrRoot } from "@/components/hr/ui";
import { Ico, type D21IconName } from "@/components/shell/icons";
import { OUTCOME_LABELS } from "@/components/d21/labels";
import { useMyBook, type BookRow } from "../../customers/_components/my-book";
import { useWs, wsFetch, recordOf, type CrmDue, type Task } from "../../workspace/_components/kit";
import { CrmResultDialog, ResultDialog } from "../../workspace/_components/task-ui";
import { addDays, dayName, dayNum, MONTH_AR, wd, weekOf } from "./plan-dates";
import { dayLabel, isWork, nextWork, stripDays, timeLabel, type AMetric } from "./plan-logic";
export { dayLabel, isWork, nextWork, stripDays, timeLabel, type AMetric };
import { telHref, waNumber } from "./text";
import { useBackLayer } from "./back-layer";
import "../my-day.css";

export type Kind = AMetric | "CHECK";
type GMetric = AMetric | "NEW_CUSTOMERS";
export type Cust = { id: string; name: string; phone?: string | null; address?: string | null };
export type PItem = {
  id: string; source: "ADMIN" | "SELF"; kind: "GOAL" | "CHECK" | "ACTION"; metric: string | null; label: string | null; target: number | null;
  done: number | null; checked: boolean; setBy: string | null; customer: Cust | null; plannedDay: string | null; plannedTime: string | null;
  doneAt: string | null; doneOutcome: string | null; doneBody: string | null; weekStart: string | null; doneHow: "record" | "auto" | "manual" | null;
  /** «وش صار؟» for a call-list row (not a plan item): the deal of its follow-up / sample, kept on the recorded call (gate). */
  dealId?: string | null;
};
type Off = { id: string; metric: AMetric; customer: Cust | null; title: string | null; at: string; outcome: string | null; body: string | null };
export type PlanData = {
  period: "DAY" | "WEEK" | "MONTH"; start: string; end: string; weekStart: string; today: string; items: PItem[]; offPlan: Off[];
  counts: Record<GMetric, number>; readOnly: boolean; canSetGoals: boolean;
  /** Whether the caller may see the customers' phone and address (the row's call / WhatsApp / map). */
  contact?: boolean;
};

export const KINDS: { k: Kind; ar: string; en: string; icon: D21IconName }[] = [
  { k: "VISITS", ar: "زيارة", en: "Visit", icon: "users" },
  { k: "CALLS", ar: "مكالمة", en: "Call", icon: "phone" },
  { k: "QUOTES", ar: "عرض سعر", en: "Quotation", icon: "quote" },
  { k: "COLLECTION", ar: "تحصيل", en: "Collection", icon: "wallet" },
  { k: "SAMPLES", ar: "عيّنة", en: "Sample", icon: "flask" },
  { k: "CHECK", ar: "شغلة ثانية", en: "Something else", icon: "note" },
];
const KIND_OF = Object.fromEntries(KINDS.map((x) => [x.k, x])) as Record<Kind, (typeof KINDS)[number]>;
export const GOAL_T: Record<GMetric, [string, string]> = { VISITS: ["زيارات", "Visits"], CALLS: ["مكالمات", "Calls"], QUOTES: ["عروض سعر", "Quotations"], COLLECTION: ["تحصيل", "Collections"], SAMPLES: ["عيّنات", "Samples"], NEW_CUSTOMERS: ["عملاء جدد", "New customers"] };
const GOAL_ORDER: GMetric[] = ["VISITS", "CALLS", "QUOTES", "COLLECTION", "SAMPLES", "NEW_CUSTOMERS"];
export const kindOf = (it: Pick<PItem, "kind" | "metric">): Kind => (it.kind === "CHECK" ? "CHECK" : ((it.metric as AMetric) ?? "VISITS"));
const titleOf = (it: PItem) => (it.kind === "CHECK" ? it.label ?? "" : it.customer?.name ?? "");

/** Riyadh "HH:MM" now. */
const nowHmOf = () => new Date(Date.now() + 3 * 3_600_000).toISOString().slice(11, 16);
const riyadhNow = () => { const d = new Date(Date.now() + 3 * 3_600_000); return { iso: d.toISOString().slice(0, 10), hour: d.getUTCHours(), minute: d.getUTCMinutes() }; };
const atTime = (at: string, ar: boolean) => new Date(at).toLocaleTimeString(ar ? "ar-SA-u-nu-latn" : "en-GB", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Riyadh" });
const fmt = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 0 });
const mapHref = (c: Cust) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(c.address || c.name)}`;
const weekRange = (ws: string, ar: boolean) => {
  const last = addDays(ws, 4);
  const m = ar ? MONTH_AR[Number(last.slice(5, 7)) - 1] : new Date(`${last}T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" });
  return `${dayNum(ws)}–${dayNum(last)} ${m}`;
};
/** «✓ اتصلت · طلب 5 كجم · 10:40ص» — what happened, the note's first line, the time. */
function doneLine(it: PItem, ar: boolean): string {
  if (it.doneHow === "auto") return ar ? "✓ انحسبت تلقائياً" : "✓ Counted automatically";
  if (it.doneHow === "manual") return ar ? "✓ تمّت" : "✓ Done";
  const o = it.doneOutcome && OUTCOME_LABELS[it.doneOutcome] ? OUTCOME_LABELS[it.doneOutcome][ar ? "ar" : "en"] : ar ? "تمّت" : "Done";
  return `✓ ${[o, it.doneBody?.split("\n")[0]?.slice(0, 40) || null, it.doneAt ? atTime(it.doneAt, ar) : null].filter(Boolean).join(" · ")}`;
}
/** Today's order: appointments by their time first, then the rest as planned. */
const byTime = (a: PItem, b: PItem) => (a.plannedTime ?? "99").localeCompare(b.plannedTime ?? "99");

export async function send(url: string, method: string, json?: unknown): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const r = await fetch(url, { method, headers: json ? { "Content-Type": "application/json" } : undefined, body: json ? JSON.stringify(json) : undefined });
  const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: r.ok, status: r.status, data };
}
const errOf = (d: Record<string, unknown>, ar: boolean) => String((ar ? d.error : d.errorEn ?? d.error) ?? (ar ? "تعذّر الحفظ." : "Could not save."));

export function usePlanData(period: "DAY" | "WEEK", reload: number, rep?: string, date?: string, enabled = true) {
  const [plan, setPlan] = useState<PlanData | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let off = false;
    fetch(`/api/sales/plan?period=${period}${rep ? `&rep=${rep}` : ""}${date ? `&date=${date}` : ""}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((j: PlanData) => { if (!off) { setPlan(j); setFailed(false); } }).catch(() => { if (!off) setFailed(true); });
    return () => { off = true; };
  }, [period, reload, rep, date, enabled]);
  return { plan, failed };
}

/** «من المشرف · أحمد» under what the supervisor added. */
function FromBoss({ name, ar }: { name: string | null; ar: boolean }) {
  return <span className="kp-boss" data-testid="plan-from-boss"><Ico name="lock" small />{ar ? "من المشرف" : "From your supervisor"}{name ? ` · ${name.trim().split(/\s+/)[0]}` : ""}</span>;
}

function Circle({ done, onClick, label }: { done: boolean; onClick?: () => void; label: string }) {
  if (!onClick) return <span className={`pl-c${done ? " on" : ""}`} role="img" aria-label={label}>{done ? <Ico name="tick" small /> : null}</span>;
  return <button type="button" className={`pl-c${done ? " on" : ""}`} onClick={onClick} aria-label={label} data-testid="plan-tick">{done ? <Ico name="tick" small /> : null}</button>;
}

// ─── «أضف لخطتي» ─────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * One sheet: what (six tiles), for whom (search, «عملاء يحتاجونك»), when (one day strip; «تاريخ ثاني» for a later week),
 * and an optional time (= an appointment). From a customer's page the customer is set and the day is «بكرة»: two taps.
 */
export function AddPlanSheet({ ar, today, customer, rep, presetDay, cleanUrl, onClose, onSaved }: {
  ar: boolean; today: string; customer?: Cust | null; rep?: { id: string; name: string }; presetDay?: string | null;
  /** Opened by a deep link (`?add=plan`): the page's address without it (gate C1). */
  cleanUrl?: string;
  onClose: () => void; onSaved: (msg: string) => void;
}) {
  const strip = stripDays(today);
  const [kind, setKind] = useState<Kind>("VISITS");
  const [who, setWho] = useState<Cust | null>(customer ?? null);
  const [changing, setChanging] = useState(!customer);
  const [q, setQ] = useState("");
  const [label, setLabel] = useState("");
  const [note, setNote] = useState("");
  const initial = presetDay !== undefined ? presetDay : customer ? (strip[0] === today ? strip[1] : strip[0]) : strip[0];
  const [day, setDay] = useState<string | null>(initial);
  const [other, setOther] = useState(!!initial && !strip.includes(initial));
  const [time, setTime] = useState("");
  const [busy, setBusy] = useState(false);
  // The error belongs to what was tried: changing the kind, the customer or the day clears it (shown near the customer).
  const [failure, setFailure] = useState<{ key: string; msg: string } | null>(null);
  const [customers, setCustomers] = useState<Cust[] | null>(null);
  const book = useMyBook(!rep);
  useBackLayer(1, onClose, { cleanUrl });
  useEffect(() => {
    if (!changing || customers) return;
    let off = false;
    fetch(rep ? "/api/customers" : "/api/customers?owner=me", { cache: "no-store" }).then((r) => (r.ok ? r.json() : []))
      .then((j: { id: string; name: string; nameAr: string | null; phone?: string | null; accountOwnerId?: string | null }[]) => {
        if (!off) setCustomers((Array.isArray(j) ? j : []).filter((c) => !rep || !c.accountOwnerId || c.accountOwnerId === rep.id).map((c) => ({ id: c.id, name: c.nameAr ?? c.name, phone: c.phone ?? null })));
      }).catch(() => { if (!off) setCustomers([]); });
    return () => { off = true; };
  }, [changing, customers, rep]);
  const needYou = useMemo(() => {
    if (!book || rep) return [] as (Cust & { why: string })[];
    const rank = (r: BookRow) => (r.status === "STOPPED" ? 0 : r.declining ? 1 : r.contractDaysLeft !== null ? 2 : 9);
    return (book.book as (BookRow & { name?: string; nameAr?: string | null })[]).filter((r) => rank(r) < 9).sort((x, y) => rank(x) - rank(y)).slice(0, 4)
      .map((r) => ({ id: r.id, name: r.nameAr ?? r.name ?? "", why: r.status === "STOPPED" ? (ar ? "متوقف" : "Stopped") : r.declining ? (ar ? "طلبه يقل" : "Ordering less") : (ar ? "عقده يخلص" : "Contract ending") }));
  }, [book, rep, ar]);
  const found = q.trim() ? (customers ?? []).filter((c) => c.name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 6) : [];
  // «تاريخ ثاني» needs a picked date — today or later (the server refuses a past day too: PAST_DAY).
  const dayOk = !other || (!!day && day >= today);
  const ok = (kind === "CHECK" ? label.trim().length >= 2 : !!who) && dayOk;
  const tryKey = `${kind}|${who?.id ?? ""}|${day ?? ""}|${time}`;
  const err = failure && failure.key === tryKey ? failure.msg : "";
  const weekDate = day ?? (isWork(today) ? today : nextWork(today));
  const k = KIND_OF[kind];
  const whenText = day ? `${dayLabel(day, today, ar)}${time ? ` ${timeLabel(time, ar)}` : ""}` : ar ? "خلال الأسبوع" : "During the week";
  const summary = `${ar ? k.ar : k.en}${kind !== "CHECK" && who ? (ar ? ` لـ${who.name}` : ` · ${who.name}`) : kind === "CHECK" && label.trim() ? ` · ${label.trim()}` : ""} · ${whenText}${time && day ? (ar ? " · موعد" : " · appointment") : ""}`;
  const save = async () => {
    if (!ok || busy) return;
    setBusy(true); setFailure(null);
    const body: Record<string, unknown> = kind === "CHECK"
      ? { kind: "CHECK", label: label.trim(), plannedDay: day, plannedTime: day && time ? time : null, date: weekDate }
      : { kind: "ACTION", metric: kind, customerId: who!.id, label: note.trim() || null, plannedDay: day, plannedTime: day && time ? time : null, date: weekDate };
    const r = await send(rep ? "/api/sales/team-goals/items" : "/api/sales/plan/items", "POST", rep ? { ...body, employeeId: rep.id } : body);
    setBusy(false);
    if (!r.ok) { setFailure({ key: tryKey, msg: errOf(r.data, ar) }); return; }
    onSaved(ar ? `انضاف لخطتك: ${summary}` : `Added to your plan: ${summary}`);
  };
  return (
    <D21Dialog lang={ar ? "ar" : "en"} title={rep ? (ar ? `أضف لخطة ${rep.name}` : `Add to ${rep.name}'s plan`) : ar ? "أضف لخطتي" : "Add to my plan"}
      sub={customer && !changing ? customer.name : undefined} onClose={onClose} width={480} testId="plan-add-sheet"
      actions={<><button type="button" className="btn p" disabled={!ok || busy} onClick={save} data-testid="plan-add-save">{busy ? "…" : rep ? (ar ? "أضف لخطته" : "Add it") : ar ? "أضف لخطتي" : "Add to my plan"}</button>
        <button type="button" className="btn" onClick={onClose}>{ar ? "إلغاء" : "Cancel"}</button></>}>
      <div className="pl-sheet kp-sheet">
        <b className="pl-q">{ar ? "وش؟" : "What?"}</b>
        <div className="pl-tiles kp-tiles" role="radiogroup" aria-label={ar ? "النوع" : "Kind"}>
          {KINDS.map((t) => <button key={t.k} type="button" role="radio" aria-checked={kind === t.k} className={kind === t.k ? "on" : undefined} onClick={() => setKind(t.k)} data-testid={`plan-kind-${t.k}`}><Ico name={t.icon} />{ar ? t.ar : t.en}</button>)}
        </div>
        {kind === "CHECK" ? (
          <>
            <b className="pl-q">{ar ? "وش الشغلة؟" : "What is it?"}</b>
            <input className="pl-in" value={label} maxLength={200} onChange={(e) => setLabel(e.target.value)} placeholder={ar ? "مثال: طباعة كتالوج المعرض" : "e.g. print the fair catalogue"} data-testid="plan-check-text" />
          </>
        ) : (
          <>
            <b className="pl-q">{ar ? "لمين؟" : "For whom?"}</b>
            {who && !changing ? (
              <span className="kp-who" data-testid="plan-customer-set"><b>{who.name}</b>{!customer ? null : <button type="button" className="lk" onClick={() => setChanging(true)}>{ar ? "غيّر" : "Change"}</button>}</span>
            ) : (
              <>
                <span className="pl-search"><Ico name="search" small /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder={ar ? "ابحث باسم العميل" : "Search a customer"} data-testid="plan-customer-q" /></span>
                {who ? <span className="kp-who on"><Ico name="tick" small /><b>{who.name}</b></span> : null}
                {q.trim() ? (
                  <div role="radiogroup" className="pl-custs">
                    {found.map((c) => <button key={c.id} type="button" role="radio" aria-checked={who?.id === c.id} className={`pl-cust${who?.id === c.id ? " on" : ""}`} onClick={() => { setWho(c); setQ(""); }} data-testid="plan-customer"><span className="pl-radio" /><b>{c.name}</b></button>)}
                    {customers && !found.length ? <small className="pl-hint">{ar ? "ما لقينا عميل بهالاسم." : "No customer by that name."}</small> : null}
                  </div>
                ) : needYou.length ? (
                  <>
                    <small className="pl-hint">{ar ? "عملاء يحتاجونك" : "Customers who need you"}</small>
                    <div className="kp-chips">{needYou.map((c) => <button key={c.id} type="button" aria-pressed={who?.id === c.id} onClick={() => setWho(c)} data-testid="plan-customer-suggest">{c.name}<small> · {c.why}</small></button>)}</div>
                  </>
                ) : null}
              </>
            )}
          </>
        )}
        {err ? <p className="pl-err kp-err" role="alert" data-testid="plan-add-error">{err}</p> : null}
        <b className="pl-q">{ar ? "متى؟" : "When?"}</b>
        <div className="kp-chips" role="group" aria-label={ar ? "اليوم" : "Day"} data-testid="plan-days">
          {strip.map((d) => <button key={d} type="button" aria-pressed={!other && day === d} onClick={() => { setOther(false); setDay(d); }} data-testid={`plan-day-${d}`}>{dayLabel(d, today, ar)}</button>)}
          <button type="button" aria-pressed={!other && day === null} onClick={() => { setOther(false); setDay(null); setTime(""); }} data-testid="plan-day-week">{ar ? "خلال الأسبوع" : "During the week"}</button>
          <button type="button" aria-pressed={other} className="kp-other" onClick={() => { if (!other) { setOther(true); setDay(null); setTime(""); } }} data-testid="plan-day-other"><Ico name="cal" small />{ar ? "تاريخ ثاني" : "Another date"}</button>
        </div>
        {other ? (
          <>
            <input type="date" className="pl-in" min={today} value={day ?? ""} onChange={(e) => setDay(e.target.value || null)} aria-label={ar ? "التاريخ" : "Date"} data-testid="plan-date" />
            {!day ? <small className="pl-hint" data-testid="plan-date-need">{ar ? "اختر التاريخ." : "Pick the date."}</small>
              : day < today ? <small className="pl-err" data-testid="plan-date-past">{ar ? "هذا اليوم فات. اختر اليوم أو بعده." : "That day has passed. Choose today or later."}</small> : null}
          </>
        ) : null}
        <b className="pl-q">{ar ? "الوقت (اختياري)" : "Time (optional)"}</b>
        <span className="kp-time">
          <input type="time" className="pl-in" value={time} disabled={!day} onChange={(e) => setTime(e.target.value)} aria-label={ar ? "الوقت" : "Time"} data-testid="plan-time" />
          {time ? <button type="button" className="kp-chipbtn" onClick={() => setTime("")}>{ar ? "بدون وقت" : "No time"}</button> : null}
        </span>
        {day === today && time && time < nowHmOf() ? <small className="kp-late" role="status" data-testid="plan-time-passed">{ar ? "الوقت هذا فات اليوم — تقدر تحفظه إذا تسجّله متأخر." : "That time has already passed today — you can still save it."}</small> : null}
        <small className="pl-hint">{!day ? (ar ? "اختر يوم عشان تحط وقت." : "Pick a day to set a time.") : ar ? "إذا حطيت وقت يصير «موعد» ويطلع بوقته في «خطة اليوم»." : "With a time it is an appointment, shown at its time in «Today's plan»."}</small>
        {kind !== "CHECK" ? <input className="pl-in" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder={ar ? "ملاحظة (اختياري)" : "Note (optional)"} data-testid="plan-note" /> : null}
        {ok && !err ? <p className="pl-note kp-sum" data-testid="plan-add-summary"><Ico name="tick" small />{summary}</p> : null}
      </div>
    </D21Dialog>
  );
}

// ─── «وش صار؟» ────────────────────────────────────────────────────────────────────────────────────────────────────
type Opt = { k: string; ar: string; en: string; sub?: [string, string]; outcome?: string; next?: AMetric; manual?: boolean; move?: boolean };
const OPTS: Record<Kind, Opt[]> = {
  VISITS: [
    { k: "ok", ar: "تمّت — كله تمام", en: "Done — all good", outcome: "VISIT_COMPLETED" },
    { k: "quote", ar: "تمّت — يبي عرض سعر", en: "Done — wants a quotation", outcome: "VISIT_COMPLETED", next: "QUOTES" },
    { k: "sample", ar: "تمّت — يبي عيّنة", en: "Done — wants a sample", outcome: "VISIT_COMPLETED", next: "SAMPLES" },
    { k: "no", ar: "ما تمّت", en: "Didn't happen", sub: ["ما لقيته / تأجّلت — اختر يوم ثاني", "Not there / postponed — pick another day"], move: true },
  ],
  CALLS: [
    { k: "ok", ar: "ردّ — كله تمام", en: "Answered — all good", outcome: "INTERESTED" },
    { k: "quote", ar: "ردّ — يبي عرض سعر", en: "Answered — wants a quotation", outcome: "INTERESTED", next: "QUOTES" },
    { k: "sample", ar: "ردّ — يبي عيّنة", en: "Answered — wants a sample", outcome: "INTERESTED", next: "SAMPLES" },
    { k: "noanswer", ar: "ما ردّ", en: "No answer", sub: ["ما تنحسب مكالمة — اختر يوم ثاني", "Not counted — pick another day"], outcome: "NO_ANSWER", move: true },
  ],
  SAMPLES: [
    { k: "ok", ar: "تمّت — أرسلتها", en: "Done — sent", manual: true },
    { k: "no", ar: "ما تمّت", en: "Didn't happen", sub: ["اختر يوم ثاني", "Pick another day"], move: true },
  ],
  CHECK: [
    { k: "ok", ar: "تمّت ✓", en: "Done ✓", manual: true },
    { k: "no", ar: "ما تمّت", en: "Didn't happen", sub: ["اختر يوم ثاني", "Pick another day"], move: true },
  ],
  QUOTES: [{ k: "no", ar: "ما تمّت — أجّلها", en: "Not yet — move it", move: true }],
  COLLECTION: [{ k: "no", ar: "ما تمّت — أجّلها", en: "Not yet — move it", move: true }],
};

/** Tapping the circle of anything in the plan: one screen for every kind. */
export function WhatHappened({ ar, it, today, onClose, onSaved }: { ar: boolean; it: PItem; today: string; onClose: () => void; onSaved: (msg: string) => void }) {
  useBackLayer(1, onClose);
  // `it.id` empty: a customer from «كلّمهم اليوم» that is not in the plan — the call is recorded, nothing is moved.
  const inPlan = !!it.id;
  const kind = kindOf(it);
  const opts = OPTS[kind];
  const auto = kind === "QUOTES" || kind === "COLLECTION";
  const [pick, setPick] = useState<Opt | null>(auto ? null : opts[0]);
  const after = stripDays(today).filter((d) => d > today);
  const [moveTo, setMoveTo] = useState<string | null>(after[0] ?? null);
  const nextChoices: { m: AMetric; day: string | null; date?: string; ar: string; en: string }[] = [
    { m: "QUOTES", day: nextWork(today), ar: "عرض سعر · بكرة", en: "Quotation · tomorrow" },
    { m: "SAMPLES", day: nextWork(today), ar: "عيّنة · بكرة", en: "Sample · tomorrow" },
    { m: "CALLS", day: nextWork(nextWork(nextWork(today))), ar: "مكالمة · بعد 3 أيام", en: "Call · in 3 days" },
    { m: "VISITS", day: null, date: addDays(weekOf(today), 7), ar: "زيارة · الأسبوع الجاي", en: "Visit · next week" },
  ];
  const [next, setNext] = useState<AMetric | null>(opts[0]?.next ?? null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const name = titleOf(it);
  const k = KIND_OF[kind];
  const choose = (o: Opt) => { setPick(o); setNext(o.next ?? null); };
  if (it.checked) {
    return (
      <D21Dialog lang={ar ? "ar" : "en"} title={ar ? "وش صار؟" : "What happened?"} sub={`${ar ? k.ar : k.en} · ${name}`} onClose={onClose} width={420} testId="plan-what"
        actions={<>{it.doneHow === "manual" ? <button type="button" className="btn" disabled={busy} data-testid="plan-reopen"
          onClick={async () => { setBusy(true); const r = await send(`/api/sales/plan/items/${it.id}`, "PATCH", { checked: false }); setBusy(false); if (r.ok) onSaved(ar ? "رجعت مفتوحة." : "Reopened."); else setErr(errOf(r.data, ar)); }}>{ar ? "رجّعها مفتوحة" : "Reopen"}</button> : null}
          <button type="button" className="btn p" onClick={onClose}>{ar ? "تمام" : "OK"}</button></>}>
        <div className="pl-sheet"><p className="pl-note"><Ico name="tick" small />{doneLine(it, ar)}</p>{err ? <p className="pl-err" role="alert">{err}</p> : null}</div>
      </D21Dialog>
    );
  }
  const save = async () => {
    if (!pick || busy) return;
    setBusy(true); setErr("");
    let r: Awaited<ReturnType<typeof send>> | null = null;
    if (pick.outcome && it.customer && (kind === "VISITS" || kind === "CALLS")) {
      r = await send(`/api/customers/${it.customer.id}/activities`, "POST", {
        type: kind === "VISITS" ? "VISIT" : "CALL", subject: `${kind === "VISITS" ? "زيارة" : "مكالمة"} — ${name}`, outcome: pick.outcome, body: note.trim() || undefined, completed: true,
        ...(it.dealId ? { opportunityId: it.dealId } : {}),
      });
      if (!r.ok) { setBusy(false); setErr(errOf(r.data, ar)); return; }
    }
    if (pick.manual) {
      r = await send(`/api/sales/plan/items/${it.id}`, "PATCH", { checked: true });
      if (!r.ok) { setBusy(false); setErr(errOf(r.data, ar)); return; }
    }
    if (pick.move && inPlan) {
      r = await send(`/api/sales/plan/items/${it.id}`, "PATCH", { plannedDay: moveTo });
      if (!r.ok) { setBusy(false); setErr(errOf(r.data, ar)); return; }
    }
    if (next && !pick.move && it.customer) {
      const c = nextChoices.find((x) => x.m === next)!;
      const n = await send("/api/sales/plan/items", "POST", { kind: "ACTION", metric: next, customerId: it.customer.id, plannedDay: c.day, date: c.date ?? c.day ?? today });
      if (!n.ok && n.status !== 409) { setBusy(false); setErr(errOf(n.data, ar)); return; }
    }
    setBusy(false);
    onSaved(pick.move && inPlan ? (ar ? `انتقلت لـ${moveTo ? dayLabel(moveTo, today, true) : "خلال الأسبوع"}.` : "Moved.") : ar ? "انحفظ ✓" : "Saved ✓");
  };
  return (
    <D21Dialog lang={ar ? "ar" : "en"} title={ar ? "وش صار؟" : "What happened?"} sub={`${ar ? k.ar : k.en} · ${name}${it.plannedTime ? ` · ${timeLabel(it.plannedTime, ar)}` : ""}`} onClose={onClose} width={440} testId="plan-what"
      actions={<><button type="button" className="btn p" disabled={!pick || busy} onClick={save} data-testid="plan-what-save">{busy ? "…" : ar ? "احفظ" : "Save"}</button>
        {auto && it.customer ? <Link className="btn" href={`/dashboard/customers/${it.customer.id}`}>{ar ? "افتح صفحة العميل" : "Open the customer"}</Link> : null}
        <button type="button" className="btn" onClick={onClose}>{ar ? "إلغاء" : "Cancel"}</button></>}>
      <div className="pl-sheet">
        {auto ? <p className="pl-note" data-testid="plan-what-auto"><Ico name="tick" small />{kind === "QUOTES" ? (ar ? "ينحسب تلقائياً أول ما تصدر عرض السعر لهالعميل." : "It counts by itself once you issue the quotation.") : ar ? "ينحسب تلقائياً أول ما يتسجّل التحصيل من هالعميل." : "It counts by itself once the collection is recorded."}</p> : null}
        <div role="radiogroup" className="pl-custs">
          {opts.map((o) => (
            <button key={o.k} type="button" role="radio" aria-checked={pick?.k === o.k} className={`pl-cust${pick?.k === o.k ? " on" : ""}`} onClick={() => choose(o)} data-testid={`plan-what-${o.k}`}>
              <span className="pl-radio" /><span className="pl-cust-t"><b>{ar ? o.ar : o.en}</b>{o.sub ? <small>{ar ? o.sub[0] : o.sub[1]}</small> : null}</span>
            </button>
          ))}
        </div>
        {pick?.move && inPlan ? (
          <div className="kp-chips" role="group" aria-label={ar ? "أي يوم؟" : "Which day?"}>
            {after.map((d) => <button key={d} type="button" aria-pressed={moveTo === d} onClick={() => setMoveTo(d)} data-testid={`plan-move-${d}`}>{dayLabel(d, today, ar)}</button>)}
            <button type="button" aria-pressed={moveTo === null} onClick={() => setMoveTo(null)}>{ar ? "خلال الأسبوع" : "During the week"}</button>
          </div>
        ) : null}
        {pick && !auto && !(pick.move && kind !== "CALLS") ? <textarea className="pl-in pl-ta" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={ar ? "ملاحظة (اختياري)" : "Note (optional)"} data-testid="plan-what-note" /> : null}
        {pick && !pick.move && it.customer ? (
          <>
            <b className="pl-q">{ar ? "الخطوة الجاية (اختياري)" : "Next step (optional)"}</b>
            <div className="kp-chips" role="group">
              {nextChoices.map((c) => <button key={c.m} type="button" aria-pressed={next === c.m} onClick={() => setNext(next === c.m ? null : c.m)} data-testid={`plan-next-${c.m}`}><Ico name={KIND_OF[c.m].icon} small />{ar ? c.ar : c.en}</button>)}
            </div>
            <small className="pl-hint">{ar ? "تنضاف لخطتك بنفس الحفظ." : "It is added to your plan when you save."}</small>
          </>
        ) : null}
        {err ? <p className="pl-err" role="alert">{err}</p> : null}
      </div>
    </D21Dialog>
  );
}

// ─── A row of the plan ────────────────────────────────────────────────────────────────────────────────────────────
function PlanRow({ it, ar, today, onTick, onRemove, actions = true, compact = false, nowHm }: {
  it: PItem; ar: boolean; today: string; onTick?: () => void; onRemove?: () => void;
  /** Riyadh "HH:MM" now — an open appointment of today whose time has gone shows «فات الوقت». */
  nowHm?: string;
  /** The call / WhatsApp / map buttons — only when the caller may see the customer's contact (the plan's `contact`). */
  actions?: boolean; compact?: boolean;
}) {
  const kind = kindOf(it);
  const k = KIND_OF[kind];
  const c = it.customer;
  const tel = c ? telHref(c.phone) : null;
  const wa = c ? waNumber(c.phone) : null;
  const when = it.plannedTime ? `${timeLabel(it.plannedTime, ar)} · ${ar ? "موعد" : "appointment"}` : it.plannedDay === today ? (ar ? "خلال اليوم" : "Any time today") : null;
  const late = !it.checked && !!it.plannedTime && !!nowHm && it.plannedDay === today && it.plannedTime < nowHm;
  return (
    <li className={`kp-row${it.checked ? " done" : ""}${compact ? " sm" : ""}`} data-testid="plan-row" data-kind={kind}>
      <div className="kp-row-main">
        <Circle done={it.checked} onClick={onTick} label={it.checked ? (ar ? "تمّت" : "Done") : ar ? `وش صار: ${titleOf(it)}` : `What happened: ${titleOf(it)}`} />
        <button type="button" className="kp-row-t" onClick={onTick} disabled={!onTick}>
          <b className={it.checked && it.doneHow !== "auto" ? "strike" : undefined}>{titleOf(it)}</b>
          <small><Ico name={k.icon} small />{ar ? k.ar : k.en}{when ? <span className={it.plannedTime ? "appt" : undefined}> · {when}</span> : null}{late ? <span className="kp-late" data-testid="plan-late"> · {ar ? "فات الوقت" : "Time passed"}</span> : null}</small>
          {it.source === "ADMIN" ? <FromBoss name={it.setBy} ar={ar} /> : null}
          {it.checked ? <small className={it.doneHow === "auto" ? "auto" : "ok"} data-testid={it.doneHow === "auto" ? "plan-auto" : undefined}>{doneLine(it, ar)}</small> : it.kind === "ACTION" && it.label ? <small>{it.label}</small> : null}
        </button>
        {onRemove ? <button type="button" className="pl-x" onClick={onRemove} aria-label={ar ? "شيله من الخطة" : "Remove from the plan"} data-testid="plan-remove"><Ico name="close" small /></button> : null}
      </div>
      {actions && !it.checked && c && (tel || wa || c.address) ? (
        <div className="kp-acts">
          {tel ? <a className="kp-act" href={tel}><Ico name="phone" small />{ar ? "اتصال" : "Call"}</a> : null}
          {wa ? <a className="kp-act" href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer"><Ico name="chat" small />{ar ? "واتساب" : "WhatsApp"}</a> : null}
          {c.address ? <a className="kp-act" href={mapHref(c)} target="_blank" rel="noreferrer"><Ico name="pin" small />{ar ? "الموقع" : "Map"}</a> : null}
        </div>
      ) : null}
    </li>
  );
}

// ─── Reminders and appointments made before D16 (until moved into the plan) ──────────────────────────────────────
type Legacy = { key: string; at: number; title: string; sub: string | null; kind: "appt" | "reminder" | "task"; late: boolean; href: string; done: boolean; task?: Task; crm?: CrmDue; can: boolean };
type WsToday = { crm: CrmDue[]; schedule: { id: string; title: string; startAt: string; status: string; customer: { name: string } | null }[] };
function useLegacy(today: string) {
  const tasks = useWs<{ items: Task[] }>("/api/workspace/tasks?scope=mine&status=open&limit=50");
  const ws = useWs<WsToday>("/api/workspace/today");
  const end = Date.parse(`${today}T00:00:00Z`) - 3 * 3_600_000 + 86_400_000;
  const start = end - 86_400_000;
  const rows: Legacy[] = [];
  for (const t of tasks.data?.items ?? []) {
    const at = new Date(t.dueAt).getTime();
    if (!t.dueAt || at >= end) continue;
    rows.push({ key: `t:${t.id}`, at, title: t.title, sub: recordOf(t), kind: t.kind === "FOLLOW_UP" ? "reminder" : "task", late: at < start, href: `/dashboard/workspace/tasks?task=${encodeURIComponent(t.id)}`, done: false, task: t,
      can: t.actions.includes("complete") || t.actions.includes("record_result") });
  }
  for (const c of ws.data?.crm ?? []) {
    const at = new Date(c.dueAt).getTime();
    if (at >= end) continue;
    rows.push({ key: `c:${c.id}`, at, title: c.subject, sub: c.record, kind: "reminder", late: at < start, href: c.openUrl, done: false, crm: c, can: c.canRecord });
  }
  for (const a of ws.data?.schedule ?? []) {
    const at = new Date(a.startAt).getTime();
    rows.push({ key: `a:${a.id}`, at, title: a.title, sub: a.customer?.name ?? null, kind: "appt", late: false, href: `/dashboard/workspace/calendar?appointment=${a.id}`, done: a.status === "DONE", can: false });
  }
  rows.sort((x, y) => Number(y.late) - Number(x.late) || x.at - y.at);
  return { rows, reload: () => { tasks.reload(); ws.reload(); } };
}

// ─── «خطة اليوم» ──────────────────────────────────────────────────────────────────────────────────────────────────
/** The first block of «يومي»: today's checklist, the end of the day, the empty state, the Sunday card. */
export function TodayPlan({ ar, reloadKey, onFlash, onPlanWeek, onAdd, needYou }: {
  ar: boolean; reloadKey: number; onFlash: (f: { text: string; undo?: () => void }) => void; onPlanWeek: () => void; onAdd: () => void;
  /** How many customers «خطّط أسبوعك» would suggest — the Sunday card's line. */
  needYou: number;
}) {
  const [reload, setReload] = useState(0);
  const { plan, failed } = usePlanData("DAY", reloadKey + reload);
  const now = riyadhNow();
  const nowHm = `${String(now.hour).padStart(2, "0")}:${String(now.minute).padStart(2, "0")}`;
  const today = plan?.today ?? now.iso;
  const sunday = wd(today) === 0;
  const week = usePlanData("WEEK", reloadKey + reload, undefined, undefined, sunday);
  const legacy = useLegacy(today);
  const [what, setWhat] = useState<PItem | null>(null);
  const [legacyResult, setLegacyResult] = useState<Legacy | null>(null);
  const [picking, setPicking] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState(false);
  const sunKey = `kp-sunday-${weekOf(today)}`;
  const [sunHidden, setSunHidden] = useState(() => { try { return typeof window !== "undefined" && window.localStorage.getItem(sunKey) === "1"; } catch { return false; } });
  const bump = useCallback(() => { setReload((r) => r + 1); legacy.reload(); }, [legacy]);
  if (failed) return <section className="md-card kp-today" data-testid="md-plan-today"><p className="md-empty-line">{ar ? "تعذّر تحميل خطة اليوم." : "Could not load today's plan."}</p></section>;
  const items = (plan?.items ?? []).filter((i) => i.kind !== "GOAL" && i.plannedDay === today).sort(byTime);
  const open = items.filter((i) => !i.checked);
  const doneN = items.length - open.length;
  const total = items.length + legacy.rows.length;
  const pct = total ? Math.round(((doneN + legacy.rows.filter((r) => r.done).length) / total) * 100) : 0;
  const weekEmpty = !!week.plan && !week.plan.items.some((i) => i.kind !== "GOAL");
  const showSunday = sunday && !sunHidden && weekEmpty;
  const endOfDay = !!plan && !plan.readOnly && now.hour >= 16 && open.length > 0;
  const carry = async (ids?: string[]) => {
    setBusy(true);
    const r = await send("/api/sales/plan/carry", "POST", ids ? { ids } : {});
    setBusy(false); setPicking(null);
    if (!r.ok) { onFlash({ text: errOf(r.data, ar) }); return; }
    const moved = (r.data.moved as { id: string; plannedDay: string | null; plannedTime: string | null }[]) ?? [];
    const merged = Number(r.data.merged ?? 0);
    const skipped = Number(r.data.skipped ?? 0);
    const to = String(r.data.to ?? "");
    bump();
    const where = to === addDays(today, 1) ? (ar ? "بكرة" : "tomorrow") : dayName(to, ar);
    onFlash({
      text: (ar ? `انتقلت ${moved.length + merged} لـ${where}${merged ? ` (منها ${merged} كانت مخطّطة هناك فصارت وحدة)` : ""}` : `${moved.length + merged} moved to ${where}${merged ? ` (${merged} merged with the same already planned)` : ""}`)
        + (skipped ? (ar ? ` · ${skipped} من المشرف بقيت اليوم (مخطّط مثلها هناك)` : ` · ${skipped} from your supervisor stayed today (the same is planned there)`) : ""),
      undo: async () => { for (const m of moved) await send(`/api/sales/plan/items/${m.id}`, "PATCH", { plannedDay: m.plannedDay, plannedTime: m.plannedTime }); bump(); onFlash({ text: ar ? "رجعت لليوم." : "Moved back." }); },
    });
  };
  const completeLegacy = async (r: Legacy) => {
    if (!r.can) return;
    if (r.crm || r.task?.actions.includes("record_result")) { setLegacyResult(r); return; }
    try { await wsFetch(`/api/workspace/tasks/${r.task!.id}/transition`, { json: { action: "complete", version: r.task!.version } }); onFlash({ text: ar ? "تمّت ✓" : "Done ✓" }); }
    catch (e) { onFlash({ text: e instanceof Error ? e.message : ar ? "تعذّر الحفظ." : "Could not save." }); }
    legacy.reload();
  };
  const hideSunday = () => { try { window.localStorage.setItem(sunKey, "1"); } catch { /* private mode: hidden for this visit */ } setSunHidden(true); };
  return (
    <>
      {showSunday ? (
        <section className="md-card kp-sunday" data-testid="plan-sunday">
          <span className="kp-sunday-ico" aria-hidden><Ico name="cal" /></span>
          <div className="kp-sunday-t"><b>{ar ? "أسبوع جديد! خطّط أسبوعك في دقيقتين" : "A new week! Plan it in two minutes"}</b>
            {needYou ? <small>{ar ? `عندك ${needYou} عملاء يحتاجونك هالأسبوع.` : `${needYou} customers need you this week.`}</small> : null}</div>
          <div className="kp-sunday-a"><button type="button" className="btn p" onClick={onPlanWeek} data-testid="plan-sunday-go">{ar ? "خطّط أسبوعك" : "Plan your week"}</button>
            <button type="button" className="btn" onClick={hideSunday} data-testid="plan-sunday-skip">{ar ? "مو الحين" : "Not now"}</button></div>
        </section>
      ) : null}
      <section className="md-card kp-today" data-testid="md-plan-today" aria-labelledby="kp-today-h">
        <div className="md-h">
          <h2 id="kp-today-h"><Ico name="check" small className="md-h-ico2" />{ar ? "خطة اليوم" : "Today's plan"}{total ? <small className="kp-count" data-testid="plan-today-count">{ar ? `${doneN + legacy.rows.filter((r) => r.done).length} من ${total} خلصت` : `${doneN} of ${total} done`}</small> : null}</h2>
          {plan && !plan.readOnly ? <button type="button" className="kp-add" onClick={onAdd} data-testid="plan-today-add"><Ico name="plus" small />{ar ? "أضف" : "Add"}</button> : null}
        </div>
        {!plan ? <p className="md-empty-line">{ar ? "جارٍ التحميل…" : "Loading…"}</p> : !total ? (
          <div className="kp-empty" data-testid="plan-empty">
            <span className="kp-empty-ico" aria-hidden><Ico name="cal" /></span>
            <b>{ar ? "يوم حلو يبدأ بخطة" : "A good day starts with a plan"}</b>
            <small>{ar ? "حط وش ناوي تسوي اليوم أو هالأسبوع، ونذكّرك فيه." : "Put down what you mean to do today or this week."}</small>
            <button type="button" className="btn p" onClick={onPlanWeek} data-testid="plan-empty-week">{ar ? "خطّط أسبوعك" : "Plan your week"}</button>
            <button type="button" className="lk" onClick={onAdd}>{ar ? "أو أضف شي لليوم" : "or add something for today"}</button>
          </div>
        ) : (
          <>
            <span className="kp-bar" aria-hidden><i style={{ width: `${pct}%` }} /></span>
            <ol className="kp-list">
              {items.map((it) => <PlanRow key={it.id} it={it} ar={ar} today={today} actions={!!plan.contact} nowHm={nowHm} onTick={plan.readOnly ? undefined : () => setWhat(it)} />)}
              {legacy.rows.map((r) => (
                <li key={r.key} className={`kp-row${r.done ? " done" : ""}`} data-testid="plan-legacy">
                  <div className="kp-row-main">
                    <Circle done={r.done} onClick={r.can && !r.done ? () => void completeLegacy(r) : undefined} label={r.title} />
                    <Link className="kp-row-t" href={r.href}>
                      <b>{r.title}</b>
                      <small><Ico name={r.kind === "appt" ? "clock" : "bell"} small />{r.kind === "appt" ? `${ar ? "موعد" : "Appointment"} · ${atTime(new Date(r.at).toISOString(), ar)}` : r.late ? (ar ? "تذكير · متأخر" : "Reminder · overdue") : ar ? "تذكير" : "Reminder"}{r.sub ? <> · <bdi>{r.sub}</bdi></> : null}</small>
                    </Link>
                  </div>
                </li>
              ))}
            </ol>
          </>
        )}
        {endOfDay ? (
          <div className="kp-eod" data-testid="plan-eod">
            <b>{ar ? `باقي ${open.length} ما خلصت` : `${open.length} still open`}</b>
            <small>{ar ? "تبي تنقلها لبكرة؟" : "Move them to tomorrow?"}</small>
            {picking ? (
              <ul className="kp-pick">{open.map((it) => (
                <li key={it.id}><label><input type="checkbox" checked={picking.has(it.id)} onChange={(e) => { const s = new Set(picking); if (e.target.checked) s.add(it.id); else s.delete(it.id); setPicking(s); }} />{titleOf(it)}</label></li>
              ))}</ul>
            ) : null}
            <div className="kp-eod-a">
              {picking ? <button type="button" className="btn p" disabled={busy || !picking.size} onClick={() => void carry([...picking])} data-testid="plan-carry-picked">{ar ? `انقل ${picking.size}` : `Move ${picking.size}`}</button>
                : <button type="button" className="btn p" disabled={busy} onClick={() => void carry()} data-testid="plan-carry">{ar ? "انقلها لبكرة" : "Move to tomorrow"}</button>}
              <button type="button" className="btn" onClick={() => setPicking(picking ? null : new Set(open.map((i) => i.id)))} data-testid="plan-carry-choose">{picking ? (ar ? "رجوع" : "Back") : ar ? "أختار بنفسي" : "Let me choose"}</button>
            </div>
          </div>
        ) : null}
      </section>
      {what && plan ? <WhatHappened ar={ar} it={what} today={today} onClose={() => setWhat(null)} onSaved={(m) => { setWhat(null); bump(); onFlash({ text: m }); }} /> : null}
      {legacyResult ? (
        <HrRoot>
          {legacyResult.crm ? <CrmResultDialog crm={legacyResult.crm} onClose={() => setLegacyResult(null)} onDone={(m) => { setLegacyResult(null); legacy.reload(); onFlash({ text: m }); }} /> : null}
          {legacyResult.task ? <ResultDialog task={legacyResult.task} onClose={() => setLegacyResult(null)} onDone={(m) => { setLegacyResult(null); legacy.reload(); onFlash({ text: m }); }} /> : null}
        </HrRoot>
      ) : null}
    </>
  );
}

// ─── The «خطتي» tab ───────────────────────────────────────────────────────────────────────────────────────────────
type Goal = { metric: GMetric; target: number | null; done: number; admin: boolean; setBy: string | null; id: string | null };
function goalsOf(plan: PlanData): Goal[] {
  const out: Goal[] = [];
  for (const m of GOAL_ORDER) {
    const gs = plan.items.filter((i) => i.kind === "GOAL" && i.metric === m);
    const g = gs.find((x) => x.source === "ADMIN") ?? gs[0] ?? null;
    const planned = plan.items.some((i) => i.kind === "ACTION" && i.metric === m);
    const done = plan.counts[m] ?? 0;
    if (!g && !planned && !done && m !== "VISITS" && m !== "CALLS") continue;
    out.push({ metric: m, target: g?.target ?? null, done, admin: g?.source === "ADMIN", setBy: g?.setBy ?? null, id: g?.id ?? null });
  }
  return out;
}

function GoalBar({ g, ar, onEdit }: { g: Goal; ar: boolean; onEdit?: () => void }) {
  const pct = g.target ? Math.min(100, (g.done / g.target) * 100) : 0;
  return (
    <div className="kp-goal" data-testid={`plan-goal-${g.metric}`}>
      <span className="kp-goal-h">
        <b>{ar ? GOAL_T[g.metric][0] : GOAL_T[g.metric][1]}{g.admin ? <span className="kp-lock"><Ico name="lock" small />{ar ? "من المشرف" : "Supervisor"}</span> : null}</b>
        <span className="num"><b>{fmt(g.done)}</b>{g.target ? ` ${ar ? "من" : "of"} ${fmt(g.target)}` : ""}{g.metric === "COLLECTION" && g.target ? (ar ? " ر.س" : " SAR") : ""}
          {onEdit ? <button type="button" className="pl-edit" onClick={onEdit} aria-label={ar ? "حدّد هدفك" : "Set your target"} data-testid={`plan-goal-edit-${g.metric}`}><Ico name="edit" small /></button> : null}</span>
      </span>
      {g.target ? <span className="kp-bar"><i style={{ width: `${pct}%` }} /></span> : null}
    </div>
  );
}

function TargetDialog({ ar, start, metric, current, onClose, onSaved }: { ar: boolean; start: string; metric: GMetric; current: number | null; onClose: () => void; onSaved: () => void }) {
  useBackLayer(1, onClose);
  const [v, setV] = useState(current ? String(current) : "");
  const [err, setErr] = useState("");
  const save = async () => {
    const r = await send("/api/sales/plan", "PUT", { period: "WEEK", start, metric, target: v.trim() || null });
    if (!r.ok) { setErr(errOf(r.data, ar)); return; }
    onSaved();
  };
  return (
    <D21Dialog lang={ar ? "ar" : "en"} title={ar ? `هدفك: ${GOAL_T[metric][0]}` : `Your target: ${GOAL_T[metric][1]}`} sub={ar ? "كم تبي هالأسبوع؟ اتركه فاضي إذا ما تبي رقم." : "How many this week? Leave empty for none."} onClose={onClose} width={360}
      actions={<><button type="button" className="btn p" onClick={save} data-testid="plan-target-save">{ar ? "حفظ" : "Save"}</button><button type="button" className="btn" onClick={onClose}>{ar ? "إلغاء" : "Cancel"}</button></>}>
      <input className="pl-in num" inputMode="decimal" value={v} onChange={(e) => setV(e.target.value)} aria-label={ar ? "العدد" : "Number"} data-testid="plan-target" />
      {err ? <p className="pl-err" role="alert">{err}</p> : null}
    </D21Dialog>
  );
}

/**
 * «خطتي»: the week day by day (a phone stacks the days, a desktop lays them in columns with the targets beside them),
 * the week's targets, «خلال الأسبوع» and «خارج الخطة». `rep`: the supervisor's view of a rep's week.
 */
export function WeekPlan({ ar, rep, date, onPlanWeek, onFlash }: {
  ar: boolean; rep?: { id: string; name: string }; date?: string; onPlanWeek?: () => void; onFlash?: (f: { text: string; undo?: () => void }) => void;
}) {
  const [cursor, setCursor] = useState<string | undefined>(date);
  const [reload, setReload] = useState(0);
  const { plan, failed } = usePlanData("WEEK", reload, rep?.id, cursor);
  const admin = !!rep;
  const [what, setWhat] = useState<PItem | null>(null);
  const [adding, setAdding] = useState<{ day: string | null } | null>(null);
  const [target, setTarget] = useState<Goal | null>(null);
  const [openDays, setOpenDays] = useState<Record<string, boolean>>({});
  // A page that shows its own toast passes onFlash («يومي»); otherwise (the team targets page) the plan shows one itself.
  const [ownToast, setOwnToast] = useState<{ text: string; undo?: () => void } | null>(null);
  const say = (f: { text: string; undo?: () => void }) => (onFlash ? onFlash(f) : setOwnToast(f));
  const flash = (text: string) => say({ text });
  const bump = () => setReload((r) => r + 1);
  if (failed) return <section className="md-card"><p className="md-empty-line">{ar ? "تعذّر تحميل الخطة." : "Could not load the plan."}</p></section>;
  if (!plan) return <section className="md-card" aria-busy><p className="md-empty-line">{ar ? "جارٍ التحميل…" : "Loading…"}</p></section>;
  const ws = plan.weekStart;
  const today = plan.today;
  const ro = plan.readOnly && !admin;
  const canAdd = admin || !plan.readOnly;
  const isThisWeek = ws === weekOf(today);
  const items = plan.items.filter((i) => i.kind !== "GOAL");
  const days = [0, 1, 2, 3, 4, 5, 6].map((n) => addDays(ws, n)).filter((d) => isWork(d) || items.some((i) => i.plannedDay === d));
  const undated = items.filter((i) => !i.plannedDay);
  const goals = goalsOf(plan);
  const customs = plan.items.filter((i) => i.kind === "GOAL" && i.metric === "CUSTOM");
  // «شيله من الخطة»: removed at once, with «تراجع» for a few seconds that puts it back as it was (D16 gate, «أبو فهد»).
  const remove = async (it: PItem) => {
    const r = await send(admin ? `/api/sales/team-goals/items/${it.id}` : `/api/sales/plan/items/${it.id}`, "DELETE");
    if (!r.ok) { flash(errOf(r.data, ar)); return; }
    bump();
    const back = { kind: it.kind, metric: it.kind === "ACTION" ? it.metric : undefined, customerId: it.customer?.id, label: it.label, plannedDay: it.plannedDay,
      plannedTime: it.plannedTime, date: it.plannedDay ?? it.weekStart ?? ws, restore: true };
    say({
      text: ar ? `انشال من الخطة: ${titleOf(it)}` : `Removed: ${titleOf(it)}`,
      undo: async () => {
        const u = await send(admin ? "/api/sales/team-goals/items" : "/api/sales/plan/items", "POST", admin ? { ...back, employeeId: rep!.id } : back);
        bump();
        say({ text: u.ok ? (ar ? "رجع لخطتك ✓" : "Put back ✓") : errOf(u.data, ar) });
      },
    });
  };
  const mayRemove = (it: PItem) => !it.checked && (admin ? it.source === "ADMIN" : !plan.readOnly && it.source === "SELF");
  const row = (it: PItem) => <PlanRow key={it.id} it={it} ar={ar} today={today} compact actions={false}
    onTick={!admin && !plan.readOnly ? () => setWhat(it) : undefined} onRemove={mayRemove(it) ? () => void remove(it) : undefined} />;
  // The targets and «خارج الخطة» sit beside the days on a desktop; on a phone the order is targets · days · «خارج الخطة».
  const goalsCard = (
      <section className="md-card kp-goals" data-testid="plan-goals">
        <div className="md-h"><h2>{ar ? "التقدم مقابل الأهداف" : "Progress against targets"}</h2></div>
        {goals.map((g) => <GoalBar key={g.metric} g={g} ar={ar} onEdit={!admin && !plan.readOnly && !g.admin ? () => setTarget(g) : undefined} />)}
        {customs.map((c) => (
          <div key={c.id} className="kp-goal" data-testid="plan-goal-CUSTOM">
            <span className="kp-goal-h"><b>{c.label}{c.source === "ADMIN" ? <span className="kp-lock"><Ico name="lock" small />{ar ? "من المشرف" : "Supervisor"}</span> : null}</b>
              <span className="num"><b>{fmt(c.done ?? 0)}</b> {ar ? "من" : "of"} {fmt(c.target ?? 0)}
                {!admin && !plan.readOnly ? <button type="button" className="kp-chipbtn" onClick={async () => { const r = await send(`/api/sales/plan/items/${c.id}`, "PATCH", { manualDone: (c.done ?? 0) + 1 }); if (r.ok) bump(); }} data-testid="plan-bump">+1</button> : null}</span></span>
            <span className="kp-bar"><i style={{ width: `${Math.min(100, c.target ? ((c.done ?? 0) / c.target) * 100 : 0)}%` }} /></span>
          </div>
        ))}
      </section>
  );
  const offCard = (
      <section className="md-card kp-off" data-testid="plan-offplan">
        <div className="md-h"><h2>{ar ? "خارج الخطة" : "Outside the plan"}</h2></div>
        {plan.offPlan.length ? (
          <ul className="kp-list">{plan.offPlan.map((o) => (
            <li key={o.id} className="kp-row done sm" data-testid="plan-off">
              <div className="kp-row-main"><Circle done label={ar ? "تمّت" : "Done"} />
                <span className="kp-row-t"><b>{o.customer?.name ?? o.title ?? (ar ? "بدون عميل" : "No customer")}</b><small><Ico name={KIND_OF[o.metric].icon} small />{ar ? KIND_OF[o.metric].ar : KIND_OF[o.metric].en} · {dayName(new Date(Date.parse(o.at) + 3 * 3_600_000).toISOString().slice(0, 10), ar)}</small></span></div>
            </li>
          ))}</ul>
        ) : <p className="md-empty-line">{ar ? "ما فيه شي سجّلته بدون خطة." : "Nothing recorded outside the plan."}</p>}
        <small className="pl-hint">{ar ? "تنحسب في التقدم عادي." : "It counts toward progress as usual."}</small>
      </section>
  );
  return (
    <div className="kp-week" data-testid="plan-week-tab">
      <div className="kp-week-head">
        <div>
          <h2 data-testid="plan-title">{admin ? (ar ? `خطة ${rep!.name}` : `${rep!.name}'s plan`) : ar ? "خطتي" : "My plan"}</h2>
          <small>{isThisWeek ? (ar ? "هذا الأسبوع" : "This week") : ws > weekOf(today) ? (ar ? "أسبوع جاي" : "A coming week") : ar ? "أسبوع فات" : "A past week"} · {weekRange(ws, ar)}{admin ? (ar ? " · للاطلاع، وتقدر تضيف له" : " · read-only; you may add") : ""}</small>
        </div>
        <div className="kp-week-a">
          <span className="pl-nav" role="group" aria-label={ar ? "الأسابيع" : "Weeks"}>
            <button type="button" onClick={() => setCursor(addDays(ws, -7))} aria-label={ar ? "الأسبوع اللي فات" : "Previous week"} data-testid="plan-prev"><Ico name="chev" small /></button>
            <b>{weekRange(ws, ar)}</b>
            <button type="button" onClick={() => setCursor(addDays(ws, 7))} aria-label={ar ? "الأسبوع الجاي" : "Next week"} data-testid="plan-next"><Ico name="chev" small /></button>
          </span>
          {!isThisWeek ? <button type="button" className="lk" onClick={() => setCursor(undefined)} data-testid="plan-now">{ar ? "ارجع لهذا الأسبوع" : "Back to this week"}</button> : null}
          {!admin && !plan.readOnly && onPlanWeek ? <button type="button" className="btn sm" onClick={onPlanWeek} data-testid="plan-week-wizard"><Ico name="cal" small />{ar ? "خطّط أسبوعك" : "Plan your week"}</button> : null}
          {canAdd ? <button type="button" className="btn p sm" onClick={() => setAdding({ day: null })} data-testid="plan-add"><Ico name="plus" small />{admin ? (ar ? "أضف لخطته" : "Add") : ar ? "أضف لخطتي" : "Add to my plan"}</button> : null}
        </div>
      </div>
      <div className="kp-week-body">
        {goalsCard}
        <div className="kp-days">
          {days.map((d) => {
            const xs = items.filter((i) => i.plannedDay === d).sort(byTime);
            const dn = xs.filter((i) => i.checked).length;
            const past = d < today;
            const open = openDays[d] ?? (d === today || (!past && (xs.length > 0 || isThisWeek)) || (!isThisWeek && xs.length > 0));
            return (
              <section key={d} className={`kp-day${d === today ? " today" : ""}${open ? " open" : ""}`} data-testid={`plan-day-card-${d}`}>
                <button type="button" className="kp-day-h" onClick={() => setOpenDays({ ...openDays, [d]: !open })} aria-expanded={open}>
                  <b>{dayName(d, ar)} {dayNum(d)}{d === today ? <span className="kp-today-pill">{ar ? "اليوم" : "Today"}</span> : null}</b>
                  <small>{xs.length ? (dn === xs.length ? `${dn} ${ar ? "من" : "of"} ${xs.length} ✓` : `${dn} ${ar ? "من" : "of"} ${xs.length}`) : ar ? "فاضي" : "Empty"}</small>
                  <Ico name="chevd" small className="kp-day-chev" />
                </button>
                <div className="kp-day-b">
                  {xs.length ? <ul className="kp-list">{xs.map(row)}</ul> : null}
                  {canAdd && !past ? <button type="button" className="kp-add-day" onClick={() => setAdding({ day: d })} data-testid={`plan-add-day-${d}`}><Ico name="plus" small />{ar ? "أضف لهاليوم" : "Add to this day"}</button> : null}
                </div>
              </section>
            );
          })}
          <section className="kp-day open undated" data-testid="plan-day-card-week">
            <div className="kp-day-h static"><b>{ar ? "خلال الأسبوع" : "During the week"}</b><small>{undated.length ? (ar ? `${undated.length} · بدون يوم` : `${undated.length} · no day`) : ar ? "فاضي" : "Empty"}</small></div>
            <div className="kp-day-b">{undated.length ? <ul className="kp-list">{undated.map(row)}</ul> : null}</div>
          </section>
        </div>
        {offCard}
      </div>
      {ro ? <p className="pl-hint">{ar ? "أسبوع فات — للاطلاع." : "A past week — read-only."}</p> : null}
      {ownToast ? <PlanToast ar={ar} flash={ownToast} onClose={() => setOwnToast(null)} /> : null}
      {adding ? <AddPlanSheet ar={ar} today={today} rep={rep} presetDay={adding.day ?? undefined} onClose={() => setAdding(null)} onSaved={(m) => { setAdding(null); bump(); flash(m); }} /> : null}
      {what ? <WhatHappened ar={ar} it={what} today={today} onClose={() => setWhat(null)} onSaved={(m) => { setWhat(null); bump(); flash(m); }} /> : null}
      {target ? <TargetDialog ar={ar} start={ws} metric={target.metric} current={target.target} onClose={() => setTarget(null)} onSaved={() => { setTarget(null); bump(); }} /> : null}
    </div>
  );
}

/** For a page that only needs the plan's kind names (the team targets page). */
export const METRIC_AR: Record<string, string> = { VISITS: "زيارات", CALLS: "مكالمات", QUOTES: "عروض سعر", COLLECTION: "تحصيل", NEW_CUSTOMERS: "عملاء جدد", SAMPLES: "عيّنات", CUSTOM: "رقم خاص" };

/**
 * The toast of «خطتي» (D16 gate, «أبو فهد»: the «تراجع» after «انقلها لبكرة» rendered off-screen): fixed to the viewport,
 * bottom-centre above the phone's tab bar (safe-area aware), no layout shift. With «تراجع» it leaves after 5 s.
 */
export function PlanToast({ ar, flash, onClose }: { ar: boolean; flash: { text: string; undo?: () => void }; onClose: () => void }) {
  useEffect(() => {
    if (!flash.undo) return;
    const t = setTimeout(onClose, 5000);
    return () => clearTimeout(t);
  }, [flash, onClose]);
  return (
    <div className="kp-toast" role="status" aria-live="polite" data-testid="md-flash">
      <span>{flash.text}</span>
      {flash.undo ? <button type="button" className="kp-toast-undo" onClick={() => { const u = flash.undo!; onClose(); u(); }}>{ar ? "تراجع" : "Undo"}</button> : null}
      <button type="button" className="kp-toast-x" onClick={onClose} aria-label={ar ? "إخفاء" : "Dismiss"}>×</button>
    </div>
  );
}
