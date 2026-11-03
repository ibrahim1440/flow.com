"use client";

// «خطة الأسبوع v2» (owner-approved Figma page 07 «خيار ب», 3 Nov 2026): one plan, no «هدفي». Each kind of work — visits,
// calls, quotations, collections, samples — is ONE card: the number (the supervisor's or the rep's own), a bar of done ·
// planned · not planned yet, and the planned items, each a customer on a day. An item is done when the rep RECORDS it:
// ticking a planned visit or call opens «سجّل الزيارة» and the record is what ticks it (services/sales/plans.ts
// `matchPlan`); a visit nobody planned still counts and shows «خارج الخطة». What the supervisor set or put in the plan
// carries «من المشرف · <name>» directly under its title, and any update under that; the rep's own carries nothing.
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { D21Dialog } from "@/components/ui/Dialog";
import { Ico, type D21IconName } from "@/components/shell/icons";
import { OUTCOME_LABELS } from "@/components/d21/labels";
import { useMyBook, type BookRow } from "../../customers/_components/my-book";

type Period = "DAY" | "WEEK" | "MONTH";
type Metric = "VISITS" | "CALLS" | "QUOTES" | "COLLECTION" | "NEW_CUSTOMERS" | "SAMPLES" | "CUSTOM";
type AMetric = "VISITS" | "CALLS" | "QUOTES" | "COLLECTION" | "SAMPLES";
type Who = { id: string; name: string };
export type PlanItem = {
  id: string; source: "ADMIN" | "SELF"; kind: "GOAL" | "CHECK" | "ACTION"; metric: Metric | null; label: string | null; target: number | null;
  done: number | null; checked: boolean; setBy: string | null; customer: Who | null; plannedDay: string | null; doneAt: string | null;
  doneOutcome: string | null; doneBody: string | null;
};
type Off = { id: string; metric: AMetric; customer: Who | null; title: string | null; at: string; outcome: string | null; body: string | null };
export type Plan = {
  period: Period; start: string; end: string; weekStart: string; today: string; items: PlanItem[]; offPlan: Off[];
  counts: Record<Exclude<Metric, "CUSTOM">, number>; readOnly: boolean; canSetGoals: boolean;
};

const ACTIONS: AMetric[] = ["VISITS", "CALLS", "QUOTES", "COLLECTION", "SAMPLES"];
const ORDER: Exclude<Metric, "CUSTOM">[] = ["VISITS", "CALLS", "QUOTES", "COLLECTION", "SAMPLES", "NEW_CUSTOMERS"];
/** Per kind: the icon, the card's title, one item's noun, the plan link's verb, the open item's hint. */
const KIND: Record<Exclude<Metric, "CUSTOM">, { icon: D21IconName; title: [string, string]; one: [string, string]; plan: [string, string]; hint: string }> = {
  VISITS: { icon: "pin", title: ["زيارات عملاء", "Customer visits"], one: ["زيارة", "visit"], plan: ["خطّط زيارة", "Plan a visit"], hint: "اضغط الدائرة لما تزوره" },
  CALLS: { icon: "phone", title: ["مكالمات", "Calls"], one: ["مكالمة", "call"], plan: ["خطّط مكالمة", "Plan a call"], hint: "اضغط الدائرة لما تتصل" },
  QUOTES: { icon: "quote", title: ["عروض أسعار", "Quotations"], one: ["عرض سعر", "quotation"], plan: ["خطّط عرض سعر", "Plan a quotation"], hint: "ينشطب لحاله لما تصدر العرض" },
  COLLECTION: { icon: "wallet", title: ["تحصيل", "Collections"], one: ["تحصيل", "collection"], plan: ["خطّط تحصيل", "Plan a collection"], hint: "ينشطب لحاله لما يتسجّل التحصيل" },
  SAMPLES: { icon: "cup", title: ["عيّنات مرسلة", "Samples sent"], one: ["عيّنة", "sample"], plan: ["خطّط عيّنة", "Plan a sample"], hint: "ينشطب لحاله لما تنرسل العيّنة" },
  NEW_CUSTOMERS: { icon: "users", title: ["عملاء جدد", "New customers"], one: ["عميل جديد", "new customer"], plan: ["", ""], hint: "" },
};
export const METRIC_AR: Record<Metric, string> = { VISITS: "زيارات عملاء", CALLS: "مكالمات", QUOTES: "عروض أسعار", COLLECTION: "تحصيل", NEW_CUSTOMERS: "عملاء جدد", SAMPLES: "عيّنات مرسلة", CUSTOM: "رقم خاص" };
const PERIOD_T: Record<Period, [string, string]> = { DAY: ["خطة اليوم", "Today's plan"], WEEK: ["خطة هذا الأسبوع", "This week's plan"], MONTH: ["خطة هذا الشهر", "This month's plan"] };
const PERIOD_SEG: Record<Period, [string, string]> = { DAY: ["اليوم", "Today"], WEEK: ["الأسبوع", "Week"], MONTH: ["الشهر", "Month"] };
const WD_AR = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
const WD_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_AR = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];

const DAY = 86_400_000;
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const wd = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();
const dayNum = (iso: string) => Number(iso.slice(8, 10));
const dayName = (iso: string, ar: boolean) => (ar ? WD_AR : WD_EN)[wd(iso)];
const weekOf = (iso: string) => addDays(iso, -wd(iso));
/** The week new items go to: the week shown, or (on «اليوم» / «الشهر») this week. */
const addWeek = (p: { period: Period; weekStart: string; today: string }) => (p.period === "WEEK" ? p.weekStart : weekOf(p.today));
const riyadhDay = (at: string) => new Date(Date.parse(at) + 3 * 3_600_000).toISOString().slice(0, 10);
const timeText = (at: string, ar: boolean) => new Date(at).toLocaleTimeString(ar ? "ar-SA-u-nu-latn" : "en-GB", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Riyadh" });
const fmt = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 0 });
const range = (start: string, endExcl: string, ar: boolean) => {
  const last = addDays(endExcl, -1);
  const m = (iso: string) => (ar ? MONTH_AR[Number(iso.slice(5, 7)) - 1] : new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" }));
  return ar ? `${dayName(start, true)} ${dayNum(start)} – ${dayName(last, true)} ${dayNum(last)} ${m(last)}` : `${dayNum(start)} – ${dayNum(last)} ${m(last)}`;
};
const outcomeText = (o: string | null, ar: boolean) => (o && OUTCOME_LABELS[o] ? OUTCOME_LABELS[o][ar ? "ar" : "en"] : ar ? "تمت" : "Done");
/** «تمت الزيارة · طلب 5 كجم · 10:40ص»: what happened, the first line of the note, the time. */
const doneLine = (outcome: string | null, body: string | null, at: string | null, ar: boolean) =>
  [outcomeText(outcome, ar), body?.split("\n")[0]?.slice(0, 40) || null, at ? timeText(at, ar) : null].filter(Boolean).join(" · ");

async function send(url: string, method: string, json?: unknown): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(url, { method, headers: json ? { "Content-Type": "application/json" } : undefined, body: json ? JSON.stringify(json) : undefined });
  const b = await r.json().catch(() => ({}));
  return r.ok ? { ok: true } : { ok: false, error: b.error ?? b.message ?? "تعذّر الحفظ." };
}

export function usePlan(period: Period, reload: number, rep?: string, date?: string) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let off = false;
    fetch(`/api/sales/plan?period=${period}${rep ? `&rep=${rep}` : ""}${date ? `&date=${date}` : ""}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((j: Plan) => { if (!off) { setPlan(j); setFailed(false); } }).catch(() => { if (!off) setFailed(true); });
    return () => { off = true; };
  }, [period, reload, rep, date]);
  return { plan, failed };
}

/** «من المشرف · أحمد» — directly under the title of whatever the supervisor set or sent. */
function FromBoss({ name, ar }: { name: string | null; ar: boolean }) {
  return <span className="pl-boss" data-testid="plan-from-boss"><Ico name="lock" small />{ar ? "من المشرف" : "From your supervisor"}{name ? ` · ${name}` : ""}</span>;
}

/** One card's figures: done, the open planned items, what is not planned yet. */
type Group = { metric: Exclude<Metric, "CUSTOM">; goal: PlanItem | null; acts: PlanItem[]; off: Off[]; done: number; open: number; missing: number };

function groupsOf(plan: Plan): Group[] {
  const goals = plan.items.filter((i) => i.kind === "GOAL" && i.metric !== "CUSTOM");
  const out: Group[] = [];
  for (const m of ORDER) {
    const gs = goals.filter((g) => g.metric === m);
    const goal = gs.find((g) => g.source === "ADMIN") ?? gs[0] ?? null;
    const acts = plan.items.filter((i) => i.kind === "ACTION" && i.metric === m);
    const off = plan.offPlan.filter((o) => o.metric === m);
    if (!goal && !acts.length && !off.length) continue;
    const done = plan.counts[m] ?? 0;
    const open = acts.filter((a) => !a.checked).length;
    const missing = goal?.target ? Math.max(0, Math.ceil(goal.target - done - open)) : 0;
    out.push({ metric: m, goal, acts, off, done, open, missing });
  }
  return out;
}

function Bar({ g }: { g: Group }) {
  const t = g.goal?.target ?? 0;
  const whole = Math.max(t, g.done + g.open, 1);
  const seg = (n: number) => `${Math.max(0, (n / whole) * 100)}%`;
  return (
    <span className="pl-tri" aria-hidden>
      {g.done ? <i className="d" style={{ width: seg(Math.min(g.done, whole)) }} /> : null}
      {g.open ? <i className="p" style={{ width: seg(g.open) }} /> : null}
      {g.missing ? <i className="m" style={{ width: seg(g.missing) }} /> : null}
    </span>
  );
}

type Acts = {
  readOnly: boolean; admin: boolean;
  onTick: (it: PlanItem) => void; onCheck: (it: PlanItem) => void; onRemove: (it: PlanItem) => void;
  onPlan: (m: AMetric | "CHECK", customer?: Who) => void; onTarget: (m: Exclude<Metric, "CUSTOM">, g: PlanItem | null) => void; onBump: (it: PlanItem) => void;
  suggest: (m: AMetric) => Who[]; onSuggest: (m: AMetric, c: Who) => void;
};

function Circle({ done, onClick, label }: { done: boolean; onClick?: () => void; label: string }) {
  if (done) return <span className="pl-c on" role="img" aria-label={label}><Ico name="tick" small /></span>;
  if (!onClick) return <span className="pl-c" role="img" aria-label={label} />;
  return <button type="button" className="pl-c" onClick={onClick} aria-label={label} data-testid="plan-tick" />;
}

function ItemRow({ it, ar, a }: { it: PlanItem; ar: boolean; a: Acts }) {
  const k = it.metric && it.metric !== "CUSTOM" ? KIND[it.metric] : null;
  const name = it.kind === "CHECK" ? it.label ?? "" : it.customer?.name ?? "";
  const done = it.checked;
  const canAct = !a.readOnly && !done;
  const sub = done ? (it.kind === "CHECK" ? (ar ? "تمت" : "Done") : doneLine(it.doneOutcome, it.doneBody, it.doneAt, ar)) : it.kind === "ACTION" ? (it.label ?? (ar && k && !a.readOnly ? k.hint : null)) : null;
  const mayRemove = !done && (a.admin ? it.source === "ADMIN" : !a.readOnly && it.source === "SELF");
  return (
    <li className={`pl-it${done ? " done" : ""}`} data-testid="plan-item">
      <Circle done={done} label={done ? (ar ? "تمت" : "Done") : ar ? "سجّلها" : "Record it"}
        onClick={canAct ? () => (it.kind === "CHECK" ? a.onCheck(it) : a.onTick(it)) : undefined} />
      {k ? <Ico name={k.icon} small className="pl-it-ico" /> : <Ico name="note" small className="pl-it-ico" />}
      <span className="pl-it-t">
        <b>{name}</b>
        {it.source === "ADMIN" ? <FromBoss name={it.setBy} ar={ar} /> : null}
        {sub ? <small className={done ? "ok" : undefined}>{sub}</small> : null}
      </span>
      <span className="pl-it-end">
        <span className="pl-day">{it.plannedDay ? dayName(it.plannedDay, ar) : ar ? "هالأسبوع" : "This week"}</span>
        {mayRemove ? <button type="button" className="pl-x" onClick={() => a.onRemove(it)} aria-label={ar ? "شيله من الخطة" : "Remove from the plan"}><Ico name="close" small /></button> : null}
      </span>
    </li>
  );
}

function OffRow({ o, ar }: { o: Off; ar: boolean }) {
  return (
    <li className="pl-it done" data-testid="plan-off">
      <Circle done label={ar ? "تمت" : "Done"} />
      <Ico name={KIND[o.metric].icon} small className="pl-it-ico" />
      <span className="pl-it-t"><b>{o.customer?.name ?? o.title ?? (ar ? "بدون عميل" : "No customer")}</b><small className="ok">{doneLine(o.outcome, o.body, null, ar)}</small></span>
      <span className="pl-it-end"><span className="pl-tag">{ar ? "خارج الخطة" : "Unplanned"}</span><span className="pl-day">{dayName(riyadhDay(o.at), ar)}</span></span>
    </li>
  );
}

function GroupCard({ g, ar, a }: { g: Group; ar: boolean; a: Acts }) {
  const k = KIND[g.metric];
  const t = g.goal?.target ?? null;
  const admGoal = g.goal?.source === "ADMIN";
  // At most three unplanned records in the card (the latest); the rest as one line — the plan stays the subject.
  const offShown = [...g.off].sort((x, y) => y.at.localeCompare(x.at)).slice(0, 3);
  const offMore = g.off.length - offShown.length;
  const rows = [...g.acts.map((x) => ({ key: x.plannedDay ?? "9", el: <ItemRow key={x.id} it={x} ar={ar} a={a} /> })),
    ...offShown.map((o) => ({ key: riyadhDay(o.at), el: <OffRow key={o.id} o={o} ar={ar} /> }))].sort((x, y) => x.key.localeCompare(y.key));
  const canPlan = !a.readOnly && (ACTIONS as string[]).includes(g.metric);
  const canTarget = !a.readOnly && !a.admin && !admGoal;
  const sugg = canPlan && g.missing > 0 ? a.suggest(g.metric as AMetric) : [];
  return (
    <section className="pl-g" data-testid={`plan-card-${g.metric}`}>
      <div className="pl-g-h">
        <span className="pl-g-t"><b>{ar ? k.title[0] : k.title[1]}</b>{admGoal ? <FromBoss name={g.goal!.setBy} ar={ar} /> : null}</span>
        <span className="pl-g-n">
          <b className="num">{fmt(g.done)}</b>{t ? <small>{ar ? "من" : "of"} {fmt(t)}{g.metric === "COLLECTION" ? (ar ? " ر.س" : " SAR") : ""}</small> : null}
          {canTarget ? <button type="button" className="pl-edit" onClick={() => a.onTarget(g.metric, g.goal)} aria-label={ar ? "حدّد العدد" : "Set the number"} title={ar ? "حدّد العدد" : "Set the number"}><Ico name="edit" small /></button> : null}
        </span>
      </div>
      {t ? <><Bar g={g} />
        <span className="pl-leg"><i className="d" />{ar ? `تمت ${fmt(g.done)}` : `Done ${fmt(g.done)}`}<i className="p" />{ar ? `مخطط ${g.open}` : `Planned ${g.open}`}<i className="m" />{ar ? `بدون خطة ${g.missing}` : `Not planned ${g.missing}`}</span></> : null}
      {rows.length ? <ul className="pl-list">{rows.map((r) => r.el)}</ul> : null}
      {offMore > 0 ? <small className="pl-offmore">{ar ? `و${offMore} غيرها خارج الخطة` : `and ${offMore} more unplanned`}</small> : null}
      {canPlan && g.missing > 0 ? (
        <div className="pl-gap" data-testid="plan-gap">
          <b>{ar ? `باقي ${g.missing === 1 ? `${k.one[0]} وحدة` : `${g.missing}`} بدون خطة` : `${g.missing} not planned yet`}</b>
          {sugg.length ? <><span>{ar ? "عملاء يحتاجونك — اضغط اسم ويضاف لخطتك:" : "Customers who need you — tap one to add it:"}</span>
            <span className="pl-chips">{sugg.map((c) => <button key={c.id} type="button" onClick={() => a.onSuggest(g.metric as AMetric, c)}><Ico name="plus" small />{c.name}</button>)}</span></> : null}
        </div>
      ) : null}
      {canPlan ? <button type="button" className="pl-more" onClick={() => a.onPlan(g.metric as AMetric)} data-testid={`plan-add-${g.metric}`}><Ico name="plus" small />{ar ? k.plan[0] : k.plan[1]}</button> : null}
    </section>
  );
}

function CustomCard({ it, ar, a }: { it: PlanItem; ar: boolean; a: Acts }) {
  const t = it.target ?? 0, d = it.done ?? 0;
  return (
    <section className="pl-g" data-testid="plan-card-CUSTOM">
      <div className="pl-g-h">
        <span className="pl-g-t"><b>{it.label}</b>{it.source === "ADMIN" ? <FromBoss name={it.setBy} ar={ar} /> : null}</span>
        <span className="pl-g-n"><b className="num">{fmt(d)}</b><small>{ar ? "من" : "of"} {fmt(t)}</small></span>
      </div>
      <span className="pl-tri" aria-hidden><i className="d" style={{ width: `${Math.min(100, t ? (d / t) * 100 : 0)}%` }} /><i className="m" style={{ flex: 1 }} /></span>
      {!a.readOnly ? <div className="pl-bump"><small>{ar ? "اضغط «+1» كل ما سوّيتها." : "Tap «+1» each time you do it."}</small>
        <button type="button" className="btn p sm" onClick={() => a.onBump(it)} data-testid="plan-bump"><Ico name="plus" small />{ar ? "1 سوّيتها" : "1 done"}</button></div> : null}
    </section>
  );
}

/** The week, day by day: the desktop side column, and the strip of days on a phone. */
function Week({ plan, ar }: { plan: Plan; ar: boolean }) {
  const ws = plan.weekStart;
  const all = [...plan.items.filter((i) => i.kind !== "GOAL").map((i) => ({ day: i.plannedDay, done: i.checked, metric: i.metric, name: i.kind === "CHECK" ? i.label ?? "" : i.customer?.name ?? "", off: false, id: i.id })),
    ...plan.offPlan.map((o) => ({ day: riyadhDay(o.at), done: true, metric: o.metric as Metric, name: o.customer?.name ?? o.title ?? "", off: true, id: o.id }))];
  const days = [0, 1, 2, 3, 4, 5, 6].map((n) => addDays(ws, n)).filter((d) => wd(d) <= 4 || all.some((x) => x.day === d));
  const undated = all.filter((x) => !x.day);
  return (
    <>
      <div className="pl-strip" role="list" aria-label={ar ? "أيام الأسبوع" : "The week"}>
        {days.map((d) => {
          const xs = all.filter((x) => x.day === d);
          return (
            <span key={d} role="listitem" className={`pl-sd${d === plan.today ? " on" : ""}`}>
              <small>{dayName(d, ar)}</small><b className="num">{dayNum(d)}</b>
              <span className="pl-dots" aria-label={ar ? `${xs.filter((x) => x.done).length} منجز، ${xs.filter((x) => !x.done).length} مخطط` : undefined}>
                {xs.map((x) => <i key={x.id} className={x.done ? "d" : "p"} />)}
              </span>
            </span>
          );
        })}
      </div>
      <section className="md-card pl-agenda" aria-labelledby="pl-week-h" data-testid="plan-week">
        <div className="md-h"><h2 id="pl-week-h"><Ico name="cal" small className="md-h-ico2" />{ar ? "أسبوعي يوم بيوم" : "My week, day by day"}</h2></div>
        {days.map((d) => {
          const xsAll = all.filter((x) => x.day === d);
          const xs = xsAll.slice(0, 5);
          return (
            <div key={d} className={`pl-ad${d === plan.today ? " on" : ""}`}>
              <b>{dayName(d, ar)} {dayNum(d)}{d === plan.today ? (ar ? " · اليوم" : " · today") : ""}</b>
              {xs.length ? xs.map((x) => (
                <span key={x.id} className="pl-ar">
                  <span className={`pl-c sm${x.done ? " on" : ""}`} aria-hidden>{x.done ? <Ico name="tick" small /> : null}</span>
                  <Ico name={x.metric && x.metric !== "CUSTOM" ? KIND[x.metric].icon : "note"} small className="pl-it-ico" />
                  <span className={x.done ? "mut" : undefined}>{x.name}</span>
                  {x.off ? <span className="pl-tag">{ar ? "خارج الخطة" : "Unplanned"}</span> : null}
                </span>
              )) : <span className="pl-ad-none">—</span>}
              {xsAll.length > xs.length ? <span className="pl-ad-none">{ar ? `+${xsAll.length - xs.length} غيرها` : `+${xsAll.length - xs.length} more`}</span> : null}
            </div>
          );
        })}
        {undated.length ? <div className="pl-ad"><b>{ar ? "هالأسبوع (بدون يوم)" : "This week (no day)"}</b>
          {undated.map((x) => <span key={x.id} className="pl-ar"><span className={`pl-c sm${x.done ? " on" : ""}`} aria-hidden>{x.done ? <Ico name="tick" small /> : null}</span><span className={x.done ? "mut" : undefined}>{x.name}</span></span>)}</div> : null}
        <p className="pl-tip"><Ico name="bell" small />{ar ? "البند اللي له يوم يطلع في «جدول اليوم» في يومه." : "An item with a day shows in «Today's schedule» that day."}</p>
      </section>
    </>
  );
}

/** Customers the rep should see this week: stopped, ordering less, a contract ending — from «عملائي» (the same figures). */
function useSuggestions(enabled: boolean, plan: Plan | null) {
  const book = useMyBook(enabled);
  return useCallback((m: AMetric): Who[] => {
    if (!book || !plan) return [];
    const planned = new Set(plan.items.filter((i) => i.kind === "ACTION" && i.metric === m).map((i) => i.customer?.id));
    const rank = (r: BookRow) => (r.status === "STOPPED" ? 0 : r.declining ? 1 : r.contractDaysLeft !== null ? 2 : 9);
    return (book.book as (BookRow & { name?: string; nameAr?: string | null })[]).filter((r) => rank(r) < 9 && !planned.has(r.id))
      .sort((x, y) => rank(x) - rank(y)).slice(0, 3)
      .map((r) => ({ id: r.id, name: `${r.nameAr ?? r.name ?? ""} · ${r.status === "STOPPED" ? "متوقف" : r.declining ? `يتراجع ${Math.abs(Math.round(r.growthPct ?? 0))}%` : "عقده قريب ينتهي"}` }));
  }, [book, plan]);
}

/**
 * The plan of a week (or a day, or a month): the summary line, one card per kind of work, the free items, the week day by day.
 * `rep` set: the supervisor reading a rep's plan — read-only, except adding and removing what the supervisor put there.
 */
export function PlanView({ ar, rep, date, defaultPeriod = "WEEK", onChanged }: { ar: boolean; rep?: Who; date?: string; defaultPeriod?: Period; onChanged?: () => void }) {
  const [period, setPeriod] = useState<Period>(defaultPeriod);
  const [reload, setReload] = useState(0);
  const { plan, failed } = usePlan(period, reload, rep?.id, date);
  const bump = useCallback(() => { setReload((r) => r + 1); onChanged?.(); }, [onChanged]);
  const admin = !!rep;
  const readOnly = !!plan?.readOnly;
  const suggest = useSuggestions(!admin, plan);
  const [adding, setAdding] = useState<null | { metric: AMetric | "CHECK" | null; customer?: Who }>(null);
  const [logging, setLogging] = useState<PlanItem | null>(null);
  const [target, setTarget] = useState<null | { metric: Exclude<Metric, "CUSTOM">; goal: PlanItem | null }>(null);
  const [err, setErr] = useState("");
  const act = async (p: Promise<{ ok: boolean; error?: string }>) => { const r = await p; if (!r.ok) setErr(r.error ?? ""); else { setErr(""); bump(); } };
  const a: Acts = {
    readOnly, admin,
    onTick: (it) => setLogging(it),
    onCheck: (it) => act(send(`/api/sales/plan/items/${it.id}`, "PATCH", { checked: !it.checked })),
    onRemove: (it) => act(send(admin ? `/api/sales/team-goals/items/${it.id}` : `/api/sales/plan/items/${it.id}`, "DELETE")),
    onPlan: (m, customer) => setAdding({ metric: m, customer }),
    onTarget: (m, g) => setTarget({ metric: m, goal: g }),
    onBump: (it) => act(send(`/api/sales/plan/items/${it.id}`, "PATCH", { manualDone: (it.done ?? 0) + 1 })),
    suggest,
    onSuggest: (m, c) => act(send("/api/sales/plan/items", "POST", { kind: "ACTION", metric: m, customerId: c.id, date: plan ? addWeek(plan) : undefined })),
  };
  const groups = useMemo(() => (plan ? groupsOf(plan) : []), [plan]);
  const customs = (plan?.items ?? []).filter((i) => i.kind === "GOAL" && i.metric === "CUSTOM");
  const checks = (plan?.items ?? []).filter((i) => i.kind === "CHECK");
  const items = (plan?.items ?? []).filter((i) => i.kind !== "GOAL");
  const missing = groups.filter((g) => g.missing > 0 && (ACTIONS as string[]).includes(g.metric));
  const empty = plan && !groups.length && !customs.length && !checks.length;
  const canAdd = !!plan && (admin || !readOnly);
  return (
    <div className={`pl-wrap${admin ? " adm" : ""}`} id="plan" data-testid="md-plan-section">
      <section className="md-card pl-main" aria-labelledby="pl-h">
        <div className="pl-head">
          <div className="pl-head-t">
            <h2 id="pl-h"><Ico name="flag" small className="md-h-ico2" />{admin ? (ar ? `خطة ${rep!.name}` : `${rep!.name}'s plan`) : ar ? PERIOD_T[period][0] : PERIOD_T[period][1]}</h2>
            {plan ? <small>{range(plan.start, plan.end, ar)}{admin ? (ar ? " · للاطلاع، وتقدر تضيف له بنود" : " · read-only; you may add items") : ar ? " · خطتك خاصة فيك، والمشرف يشوفها بس" : " · yours; your supervisor only reads it"}</small> : null}
          </div>
          <div className="pl-head-a">
            {canAdd ? <button type="button" className="btn p sm" onClick={() => setAdding({ metric: null })} data-testid="plan-add"><Ico name="plus" small />{ar ? "خطّط بند" : "Plan an item"}</button> : null}
            {!admin ? <span className="pl-seg" role="group" aria-label={ar ? "فترة الخطة" : "Plan period"}>
              {(["DAY", "WEEK", "MONTH"] as Period[]).map((p) => <button key={p} type="button" aria-pressed={period === p} onClick={() => setPeriod(p)} data-testid={`plan-period-${p}`}>{ar ? PERIOD_SEG[p][0] : PERIOD_SEG[p][1]}</button>)}
            </span> : null}
          </div>
        </div>
        {err ? <p className="pl-err" role="alert">{err}</p> : null}
        {failed ? <p className="md-empty-line">{ar ? "تعذّر تحميل الخطة." : "Could not load the plan."}</p> : !plan ? <p className="md-empty-line">{ar ? "جارٍ التحميل…" : "Loading…"}</p> : empty ? (
          <div className="md-empty pl-empty" data-testid="plan-empty">
            <span className="md-empty-ico" aria-hidden><Ico name="flag" small /></span>
            <span>{admin ? (ar ? "ما فيه خطة لهالفترة." : "No plan for this period.") : ar ? "ما عندك خطة. خطّط زياراتك ومكالماتك، وتنشطب لحالها لما تسجّلها." : "No plan yet. Plan your visits and calls; they tick themselves when you record them."}</span>
            {canAdd ? <button type="button" className="btn p sm" onClick={() => setAdding({ metric: null })}><Ico name="plus" small />{ar ? "خطّط بند" : "Plan an item"}</button> : null}
          </div>
        ) : (
          <>
            {items.length || plan.offPlan.length || missing.length ? (
              <p className="pl-sum" data-testid="plan-summary">
                {items.length ? <span>{ar ? "التزامك بالخطة" : "Plan kept"} <b className="ok">{ar ? `${items.filter((i) => i.checked).length} من ${items.length} بنود` : `${items.filter((i) => i.checked).length} of ${items.length}`}</b></span> : null}
                {plan.offPlan.length ? <span>{ar ? "خارج الخطة" : "Unplanned"} <b className="in">{plan.offPlan.length}</b></span> : null}
                {missing.length ? <span>{ar ? "بدون خطة" : "Not planned"} <b className="wa">{missing.reduce((s, g) => s + g.missing, 0)} ({missing.map((g) => `${g.missing} ${ar ? KIND[g.metric].one[0] : KIND[g.metric].one[1]}`).join(ar ? " · " : ", ")})</b></span> : null}
              </p>
            ) : null}
            <div className="pl-cards">
              {groups.map((g) => <GroupCard key={g.metric} g={g} ar={ar} a={a} />)}
              {customs.map((c) => <CustomCard key={c.id} it={c} ar={ar} a={a} />)}
              {checks.length ? (
                <section className="pl-g" data-testid="plan-card-CHECK">
                  <div className="pl-g-h"><span className="pl-g-t"><b>{ar ? "بنود أخرى" : "Other items"}</b></span></div>
                  <ul className="pl-list">{checks.map((c) => <ItemRow key={c.id} it={c} ar={ar} a={a} />)}</ul>
                </section>
              ) : null}
            </div>
          </>
        )}
      </section>
      {plan && period !== "MONTH" ? <Week plan={plan} ar={ar} /> : null}
      {adding && plan ? <AddSheet ar={ar} plan={plan} preset={adding.metric} rep={rep} onClose={() => setAdding(null)} onSaved={() => { setAdding(null); bump(); }} /> : null}
      {logging && plan ? <LogSheet ar={ar} plan={plan} it={logging} group={groups.find((g) => g.metric === logging.metric) ?? null} onClose={() => setLogging(null)} onSaved={() => { setLogging(null); bump(); }} /> : null}
      {target && plan ? <TargetDialog ar={ar} plan={plan} metric={target.metric} goal={target.goal} onClose={() => setTarget(null)} onSaved={() => { setTarget(null); bump(); }} /> : null}
    </div>
  );
}

/** «خطّط بند»: three plain questions — what, for whom, which day. */
function AddSheet({ ar, plan, preset, rep, onClose, onSaved }: { ar: boolean; plan: Plan; preset: AMetric | "CHECK" | null; rep?: Who; onClose: () => void; onSaved: () => void }) {
  const [what, setWhat] = useState<AMetric | "CHECK">(preset ?? "VISITS");
  const [q, setQ] = useState("");
  const [who, setWho] = useState<Who | null>(null);
  const [text, setText] = useState("");
  const [day, setDay] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [customers, setCustomers] = useState<(Who & { owner: string | null })[] | null>(null);
  const book = useMyBook(!rep);
  useEffect(() => {
    let off = false;
    fetch(rep ? "/api/customers" : "/api/customers?owner=me", { cache: "no-store" }).then((r) => (r.ok ? r.json() : []))
      .then((j: { id: string; name: string; nameAr: string | null; accountOwnerId?: string | null }[]) => { if (!off) setCustomers((Array.isArray(j) ? j : []).map((c) => ({ id: c.id, name: c.nameAr ?? c.name, owner: c.accountOwnerId ?? null }))); })
      .catch(() => { if (!off) setCustomers([]); });
    return () => { off = true; };
  }, [rep]);
  const pool = useMemo(() => (customers ?? []).filter((c) => !rep || !c.owner || c.owner === rep.id), [customers, rep]);
  const suggested: (Who & { why: string; tone: string })[] = useMemo(() => {
    if (!book || rep) return [];
    const rank = (r: BookRow) => (r.status === "STOPPED" ? 0 : r.declining ? 1 : r.contractDaysLeft !== null ? 2 : 9);
    return (book.book as (BookRow & { name?: string; nameAr?: string | null })[]).filter((r) => rank(r) < 9).sort((x, y) => rank(x) - rank(y)).slice(0, 3)
      .map((r) => ({ id: r.id, name: r.nameAr ?? r.name ?? "", why: r.status === "STOPPED" ? (ar ? "متوقف" : "Stopped") : r.declining ? (ar ? `يتراجع ${Math.abs(Math.round(r.growthPct ?? 0))}%` : "Ordering less") : (ar ? `عقده ينتهي بعد ${r.contractDaysLeft} يوم` : "Contract ending"), tone: r.status === "STOPPED" ? "wa" : r.declining ? "er" : "in" }));
  }, [book, rep, ar]);
  const found = q.trim() ? pool.filter((c) => c.name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 6) : [];
  // With no search: the suggested customers first, then the rest of the book — so a pick never needs typing.
  const list = q.trim() ? found.map((c) => ({ ...c, why: "", tone: "" }))
    : [...suggested, ...pool.filter((c) => !suggested.some((x) => x.id === c.id)).map((c) => ({ ...c, why: "", tone: "" }))].slice(0, 6);
  const days = [0, 1, 2, 3, 4, 5, 6].map((n) => addDays(addWeek(plan), n)).filter((d) => wd(d) <= 4 && (rep ? true : d >= plan.today));
  const tiles: { m: AMetric | "CHECK"; icon: D21IconName; t: [string, string] }[] = [
    { m: "VISITS", icon: "pin", t: ["زيارة", "Visit"] }, { m: "CALLS", icon: "phone", t: ["مكالمة", "Call"] }, { m: "QUOTES", icon: "quote", t: ["عرض سعر", "Quotation"] },
    { m: "COLLECTION", icon: "wallet", t: ["تحصيل", "Collection"] }, { m: "SAMPLES", icon: "cup", t: ["عيّنة", "Sample"] }, { m: "CHECK", icon: "note", t: ["بند آخر", "Other"] },
  ];
  const ok = what === "CHECK" ? text.trim().length >= 2 : !!who;
  const save = async () => {
    setBusy(true); setErr("");
    const body = what === "CHECK" ? { kind: "CHECK", label: text, plannedDay: day, date: addWeek(plan) } : { kind: "ACTION", metric: what, customerId: who!.id, plannedDay: day, date: addWeek(plan) };
    const r = await send(rep ? "/api/sales/team-goals/items" : "/api/sales/plan/items", "POST", rep ? { ...body, employeeId: rep.id } : body);
    setBusy(false);
    if (!r.ok) { setErr(r.error ?? ""); return; }
    onSaved();
  };
  return (
    <D21Dialog lang={ar ? "ar" : "en"} title={rep ? (ar ? `أضف بند لخطة ${rep.name}` : `Add to ${rep.name}'s plan`) : ar ? "خطّط بند" : "Plan an item"} sub={ar ? "3 أسئلة بسيطة" : "Three quick questions"} onClose={onClose} width={480} testId="plan-add-sheet"
      actions={<><button type="button" className="btn p" disabled={!ok || busy} onClick={save} data-testid="plan-add-save">{busy ? "…" : rep ? (ar ? "أضفه لخطته" : "Add it") : ar ? "أضف لخطتي" : "Add to my plan"}</button><button type="button" className="btn" onClick={onClose}>{ar ? "إلغاء" : "Cancel"}</button></>}>
      <div className="pl-sheet">
        <b className="pl-q">{ar ? "1 · وش بتسوي؟" : "1 · What will you do?"}</b>
        <div className="pl-tiles" role="radiogroup">
          {tiles.map((t) => <button key={t.m} type="button" role="radio" aria-checked={what === t.m} className={what === t.m ? "on" : undefined} onClick={() => setWhat(t.m)} data-testid={`plan-kind-${t.m}`}><Ico name={t.icon} />{ar ? t.t[0] : t.t[1]}</button>)}
        </div>
        {what === "CHECK" ? (
          <>
            <b className="pl-q">{ar ? "2 · وش الشغلة؟" : "2 · What is it?"}</b>
            <input className="pl-in" value={text} maxLength={200} onChange={(e) => setText(e.target.value)} placeholder={ar ? "مثال: تسليم كشف حساب لمقهى رواية" : "e.g. hand over a statement"} data-testid="plan-check-text" />
          </>
        ) : (
          <>
            <b className="pl-q">{ar ? "2 · لمين؟" : "2 · For whom?"}</b>
            <span className="pl-search"><Ico name="search" small /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder={ar ? "ابحث باسم العميل" : "Search a customer"} data-testid="plan-customer-q" /></span>
            {!q.trim() && suggested.length ? <small className="pl-hint">{ar ? "مقترحين لك من «انتبه لعملائك»" : "Suggested from «Watch your customers»"}</small> : null}
            {who && !list.some((c) => c.id === who.id) ? <button type="button" className="pl-cust on" role="radio" aria-checked><span className="pl-radio" /><b>{who.name}</b></button> : null}
            <div role="radiogroup" className="pl-custs">
              {list.map((c) => (
                <button key={c.id} type="button" role="radio" aria-checked={who?.id === c.id} className={`pl-cust${who?.id === c.id ? " on" : ""}`} onClick={() => setWho({ id: c.id, name: c.name })} data-testid="plan-customer">
                  <span className="pl-radio" /><b>{c.name}</b>{c.why ? <span className={`md-pill ${c.tone}`}>{c.why}</span> : null}
                </button>
              ))}
              {q.trim() && customers && !found.length ? <small className="pl-hint">{ar ? "ما لقينا عميل بهالاسم." : "No customer by that name."}</small> : null}
            </div>
          </>
        )}
        <b className="pl-q">{ar ? "3 · أي يوم؟ (اختياري)" : "3 · Which day? (optional)"}</b>
        <div className="pl-days">
          {days.map((d) => <button key={d} type="button" aria-pressed={day === d} onClick={() => setDay(day === d ? null : d)}>{dayName(d, ar)}</button>)}
        </div>
        {what !== "CHECK" ? <p className="pl-note"><Ico name="tick" small />{ar ? `بينحسب في «${KIND[what].title[0]}» أول ما تسجّل ${KIND[what].one[0] === "عرض سعر" ? "عرض السعر" : KIND[what].one[0] === "تحصيل" ? "التحصيل" : `ال${KIND[what].one[0]}`}.` : `Counts toward «${KIND[what].title[1]}» once recorded.`}</p> : null}
        {err ? <p className="pl-err" role="alert">{err}</p> : null}
      </div>
    </D21Dialog>
  );
}

type Choice = { k: string; ar: string; en: string; sub?: string; outcome: string; counts: boolean };
const VISIT_CHOICES: Choice[] = [
  { k: "ordered", ar: "زرته وطلب", en: "Visited — ordered", outcome: "VISIT_COMPLETED", counts: true },
  { k: "visited", ar: "زرته وما طلب", en: "Visited — no order", outcome: "VISIT_COMPLETED", counts: true },
  { k: "absent", ar: "زرته وما لقيت المسؤول", en: "Visited — the buyer was out", sub: "تنحسب زيارة، ونذكّرك ترجع له", outcome: "VISIT_COMPLETED", counts: true },
];
const CALL_CHOICES: Choice[] = [
  { k: "interested", ar: "ردّ وهو مهتم", en: "Answered — interested", outcome: "INTERESTED", counts: true },
  { k: "follow", ar: "ردّ ويبي متابعة", en: "Answered — follow up", outcome: "FOLLOW_UP_REQUIRED", counts: true },
  { k: "no", ar: "ردّ وما يبي", en: "Answered — not interested", outcome: "NOT_INTERESTED", counts: true },
  { k: "noanswer", ar: "ما ردّ", en: "No answer", sub: "ما تنحسب مكالمة، والبند يبقى مفتوح", outcome: "NO_ANSWER", counts: false },
];

/** Ticking a planned item: a visit or a call is RECORDED here (and that ticks it); the others open the customer. */
function LogSheet({ ar, plan, it, group, onClose, onSaved }: { ar: boolean; plan: Plan; it: PlanItem; group: Group | null; onClose: () => void; onSaved: () => void }) {
  const m = it.metric as AMetric;
  const visit = m === "VISITS";
  const loggable = visit || m === "CALLS";
  const choices = visit ? VISIT_CHOICES : CALL_CHOICES;
  const [pick, setPick] = useState<Choice>(choices[0]);
  const [qty, setQty] = useState("");
  const [follow, setFollow] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [moving, setMoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const name = it.customer?.name ?? "";
  const from = it.plannedDay ? (ar ? `من خطتك (${dayName(it.plannedDay, true)})` : `from your plan (${dayName(it.plannedDay, false)})`) : ar ? "من خطتك" : "from your plan";
  const t = group?.goal?.target;
  const after = loggable && pick.counts ? (t ? (ar ? `بعد الحفظ: «${KIND[m].title[0]}» تصير ${fmt((group?.done ?? 0) + 1)} من ${fmt(t)}، والبند ينشطب لحاله.` : `After saving: ${fmt((group?.done ?? 0) + 1)} of ${fmt(t)}; the item ticks itself.`) : ar ? "بعد الحفظ ينشطب البند لحاله." : "After saving, the item ticks itself.") : null;
  const save = async () => {
    if (!it.customer) return;
    setBusy(true); setErr("");
    const lines = [pick.k === "ordered" && qty.trim() ? `طلب تقريبًا ${qty.trim()} كجم` : pick.k === "ordered" ? "طلب" : pick.k === "absent" ? "ما لقيت المسؤول" : null, note.trim() || null].filter(Boolean);
    const followDays = follow ?? (pick.k === "absent" ? 7 : null);
    const body: Record<string, unknown> = {
      type: visit ? "VISIT" : "CALL", subject: `${visit ? "زيارة" : "مكالمة"} — ${name}`, outcome: pick.outcome, body: lines.join("\n") || undefined, completed: true,
      ...(followDays ? { next: { channel: visit ? "VISIT" : "CALL", subject: `متابعة — ${name}`, dueAt: new Date(Date.now() + followDays * DAY).toISOString() } } : {}),
    };
    const r = await send(`/api/customers/${it.customer.id}/activities`, "POST", body);
    setBusy(false);
    if (!r.ok) { setErr(r.error ?? ""); return; }
    onSaved();
  };
  const move = async (d: string | null) => {
    setBusy(true);
    const r = await send(`/api/sales/plan/items/${it.id}`, "PATCH", { plannedDay: d });
    setBusy(false);
    if (!r.ok) { setErr(r.error ?? ""); return; }
    onSaved();
  };
  const nextDays = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => addDays(plan.today, n)).filter((d) => wd(d) <= 4).slice(0, 5);
  const title = loggable ? (visit ? (ar ? "سجّل الزيارة" : "Record the visit") : ar ? "سجّل المكالمة" : "Record the call") : ar ? `${KIND[m].one[0]} لـ${name}` : `${KIND[m].one[1]} for ${name}`;
  return (
    <D21Dialog lang={ar ? "ar" : "en"} title={title} sub={`${name} · ${from}`} onClose={onClose} width={460} testId="plan-log-sheet"
      actions={moving ? <button type="button" className="btn" onClick={() => setMoving(false)}>{ar ? "رجوع" : "Back"}</button> : <>
        {loggable ? <button type="button" className="btn p" disabled={busy} onClick={save} data-testid="plan-log-save">{busy ? "…" : visit ? (ar ? "احفظ الزيارة" : "Save the visit") : ar ? "احفظ المكالمة" : "Save the call"}</button>
          : it.customer ? <Link className="btn p" href={`/dashboard/customers/${it.customer.id}`}>{ar ? "افتح صفحة العميل" : "Open the customer"}</Link> : null}
        <button type="button" className="btn" onClick={() => setMoving(true)} data-testid="plan-log-later">{loggable ? (visit ? (ar ? "ما رحت · أجّلها" : "Not yet · move it") : ar ? "ما اتصلت · أجّلها" : "Not yet · move it") : ar ? "أجّلها" : "Move it"}</button></>}>
      {moving ? (
        <div className="pl-sheet">
          <b className="pl-q">{ar ? "أي يوم تبيها؟" : "Which day instead?"}</b>
          <div className="pl-days">{nextDays.map((d) => <button key={d} type="button" disabled={busy} onClick={() => move(d)}>{dayName(d, ar)} {dayNum(d)}</button>)}
            <button type="button" disabled={busy} onClick={() => move(null)}>{ar ? "بدون يوم" : "No day"}</button></div>
          {err ? <p className="pl-err" role="alert">{err}</p> : null}
        </div>
      ) : loggable ? (
        <div className="pl-sheet">
          <b className="pl-q">{ar ? "وش صار؟" : "What happened?"}</b>
          <div role="radiogroup" className="pl-custs">
            {choices.map((c) => (
              <button key={c.k} type="button" role="radio" aria-checked={pick.k === c.k} className={`pl-cust${pick.k === c.k ? " on" : ""}`} onClick={() => setPick(c)} data-testid={`plan-log-${c.k}`}>
                <span className="pl-radio" /><span className="pl-cust-t"><b>{ar ? c.ar : c.en}</b>{c.sub && ar ? <small>{c.sub}</small> : null}</span>
              </button>
            ))}
          </div>
          {pick.k === "ordered" ? <><b className="pl-q">{ar ? "كم طلب؟ (اختياري)" : "How much? (optional)"}</b>
            <span className="pl-qty"><input className="pl-in num" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} /><small>{ar ? "كجم تقريبًا" : "kg, roughly"}</small></span></> : null}
          <b className="pl-q">{ar ? "متى تتابعه؟ (اختياري)" : "Follow up when? (optional)"}</b>
          <div className="pl-days">
            {[[7, "بعد أسبوع", "In a week"], [14, "بعد أسبوعين", "In two weeks"]].map(([n, a2, e]) => <button key={n} type="button" aria-pressed={(follow ?? (pick.k === "absent" ? 7 : null)) === n} onClick={() => setFollow(follow === n ? null : (n as number))}>{ar ? a2 : e}</button>)}
          </div>
          <textarea className="pl-in pl-ta" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={ar ? "ملاحظة (اختياري)" : "Note (optional)"} />
          {after ? <p className="pl-note"><Ico name="tick" small />{after}</p> : <p className="pl-note wa">{ar ? pick.sub : ""}</p>}
          {err ? <p className="pl-err" role="alert">{err}</p> : null}
        </div>
      ) : (
        <div className="pl-sheet">
          <p className="pl-note"><Ico name="tick" small />{ar ? `${KIND[m].hint} — من صفحة العميل.` : "It ticks itself once recorded — from the customer's page."}</p>
          {err ? <p className="pl-err" role="alert">{err}</p> : null}
        </div>
      )}
    </D21Dialog>
  );
}

/** The rep's own number for a kind of work this period (empty removes it). */
function TargetDialog({ ar, plan, metric, goal, onClose, onSaved }: { ar: boolean; plan: Plan; metric: Exclude<Metric, "CUSTOM">; goal: PlanItem | null; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState(goal?.target ? String(goal.target) : "");
  const [err, setErr] = useState("");
  const save = async () => {
    const r = await send("/api/sales/plan", "PUT", { period: plan.period, start: plan.start, metric, target: v.trim() || null });
    if (!r.ok) { setErr(r.error ?? ""); return; }
    onSaved();
  };
  return (
    <D21Dialog lang={ar ? "ar" : "en"} title={ar ? KIND[metric].title[0] : KIND[metric].title[1]} sub={ar ? "كم تبي هالفترة؟ اتركه فاضي إذا ما تبي رقم." : "How many this period? Leave empty for none."} onClose={onClose} width={360}
      actions={<><button type="button" className="btn p" onClick={save} data-testid="plan-target-save">{ar ? "حفظ" : "Save"}</button><button type="button" className="btn" onClick={onClose}>{ar ? "إلغاء" : "Cancel"}</button></>}>
      <input className="pl-in num" inputMode="decimal" value={v} onChange={(e) => setV(e.target.value)} aria-label={ar ? "العدد" : "Number"} data-testid="plan-target" />
      {err ? <p className="pl-err" role="alert">{err}</p> : null}
    </D21Dialog>
  );
}

/** «خطة هذا الأسبوع» on «اليوم»: each kind's number in one line, and the way into the plan. */
export function PlanCard({ ar }: { ar: boolean }) {
  const { plan, failed } = usePlan("WEEK", 0);
  if (failed) return null;
  const groups = plan ? groupsOf(plan) : [];
  const items = (plan?.items ?? []).filter((i) => i.kind !== "GOAL");
  const todayOpen = items.filter((i) => !i.checked && i.plannedDay === plan?.today).length;
  return (
    <section className="md-card pl-card" data-testid="md-plan" aria-labelledby="md-plan-h">
      <div className="md-h"><h2 id="md-plan-h"><Ico name="flag" small className="md-h-ico2" />{ar ? "خطة هذا الأسبوع" : "This week's plan"}</h2>
        <Link className="lk" href="/dashboard/my-day?tab=tasks#plan">{groups.length ? (ar ? "افتح الخطة" : "Open the plan") : ar ? "خطّط أسبوعك" : "Plan your week"}</Link></div>
      {!plan ? <p className="md-empty-line">{ar ? "جارٍ التحميل…" : "Loading…"}</p> : !groups.length && !items.length ? (
        <div className="md-empty"><span>{ar ? "ما عندك خطة لهذا الأسبوع. خطّط زياراتك ومكالماتك، وتنشطب لحالها لما تسجّلها." : "No plan for this week yet."}</span>
          <Link className="btn sm" href="/dashboard/my-day?tab=tasks#plan">{ar ? "خطّط أسبوعك" : "Plan your week"}</Link></div>
      ) : (
        <div className="pl-mini">
          {groups.slice(0, 4).map((g) => (
            <div key={g.metric} className="pl-mini-r">
              <span className="pl-g-t"><b><Ico name={KIND[g.metric].icon} small />{ar ? KIND[g.metric].title[0] : KIND[g.metric].title[1]}</b>{g.goal?.source === "ADMIN" ? <FromBoss name={g.goal.setBy} ar={ar} /> : null}</span>
              <span className="num pl-mini-v">{fmt(g.done)}{g.goal?.target ? ` ${ar ? "من" : "of"} ${fmt(g.goal.target)}` : ""}</span>
              {g.goal?.target ? <Bar g={g} /> : null}
            </div>
          ))}
          {todayOpen ? <p className="md-note">{ar ? `اليوم عندك ${todayOpen} ${todayOpen === 1 ? "بند" : "بنود"} من خطتك.` : `${todayOpen} planned for today.`}</p> : null}
        </div>
      )}
    </section>
  );
}

/** The plan section at the top of «مهامي وخطتي». */
export function PlanSection({ ar }: { ar: boolean }) {
  return <PlanView ar={ar} />;
}
