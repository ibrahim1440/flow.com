"use client";

/**
 * «يومي» — the sales rep's day (batch 24 WP-B; approved mockup council-sales/sales-concept.html «الواجهة ١» and «٥»).
 *
 * One question each morning: who do I call today, why, and what is it worth. Every figure comes from
 * GET /api/sales/my-day (rules: lib/services/sales/my-day/rules.ts), computed on the server for the caller's own book
 * (Customer.accountOwnerId) — or, for a sales manager, a rep's day read-only (`?rep=`). No ranking between reps.
 *
 * Desktop: greeting + streak, the target bar, «كلّمهم اليوم», deals in negotiation, «ينمون معك», the book by tier,
 * «عملائي» and contracts ending soon. Phone (390): four cards — target, the call list (swipe right = done, left = until
 * tomorrow), deals, my customers — and the tab bar يومي · عملائي · ＋ · صفقاتي · هدفي.
 */
import { Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useLang, api } from "../sales/_components/ui";
import { useUser } from "../user-context";
import { useD21Phone, useD21Title, usePhone } from "@/components/shell/page-context";
import { HrRoot } from "@/components/hr/ui";
import { ActivityDialog } from "../customers/[id]/dialogs";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { Ico } from "@/components/shell/icons";
import { AddMenu, HubTabs, hubTabOf, type HubTab } from "./_components/hub";
import { AddPlanSheet, GOAL_T, PlanToast, TodayPlan, WeekPlan, WhatHappened, usePlanData, type PItem } from "./_components/khitati";
import { PlanWeekWizard, suggestionsOf, type WeekSource } from "./_components/plan-week";
import { useDropStaleLayer } from "./_components/back-layer";
import { SalesBand, type BandTarget, type LogTarget } from "./_components/sales-band";
import { filterCallList, callFilterOf, type CallFilter } from "@/lib/services/sales/my-day/filters";
import {
  TIER_LABEL, days, greeting, streakText, n, reasonPill, telHref, todayLine, waNumber, whyLine,
  type Lang, type Reason, type Tier,
} from "./_components/text";

type CallItem = {
  key: string; customerId: string | null; name: string; nameAr: string | null; phone: string | null; tier: Tier | null;
  kgPerMonth: number; reason: Reason; others: string[]; intervalDays: number | null; lastContactDays: number | null;
};
type Day = {
  rep: { id: string; name: string }; generatedAt: string; readOnly: boolean; teamView: boolean; viewerId: string;
  target: BandTarget & {
    remaining: string | null; streakWeeks: number; personalBest: { month: string; amount: string } | null; newBest: boolean; hasPlan: boolean;
  };
  callList: CallItem[];
  deals: { id: string; title: string; amount: string; customerId: string | null; customerName: string | null; customerNameAr: string | null; stageAr: string; stageEn: string;
    /** Pipeline v2: what the deal page says is required now, and its one action (server-computed). */
    requiredNow?: { key: string; ar: string; en: string } | null; nextAction?: { key: string; ar: string; en: string; quoteId: string | null } | null }[];
  openDeals: number;
  growing: { id: string; name: string; nameAr: string | null; pct: number; lastKg: number; prevKg: number }[];
  tiers: { totalKg: number; percentile: boolean; groups: { tier: Tier; count: number; kg: number; share: number; customers: { id: string; name: string; nameAr: string | null; kgPerMonth: number; share: number }[] }[] };
  counts: { total: number; active: number; negotiating: number; stopped: number; growing?: number; declining?: number; contracts?: number };
  contracts: { customerId: string; customerName: string; fileId: string; title: string; validUntil: string; daysLeft: number }[];
  contractWindowDays?: number;
};

const TOP = 5;
const nameOf = (x: { name: string; nameAr?: string | null }, ar: boolean) => (ar ? x.nameAr || x.name : x.name);

export default function MyDayPage() {
  return <Suspense fallback={null}><MyDay /></Suspense>;
}

function MyDay() {
  const lang = useLang();
  const ar = lang === "ar";
  const phone = usePhone();
  const user = useUser();
  const router = useRouter();
  const sp = useSearchParams();
  const rep = sp.get("rep");
  const tab = hubTabOf(sp.get("tab"));
  const [data, setData] = useState<Day | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const [all, setAll] = useState(false);
  // The full list's filter chips (council fix round 2, item 7).
  const [filter, setFilter] = useState<CallFilter>("ALL");
  const [flash, setFlash] = useState<{ text: string; undo?: () => void } | null>(null);
  const [logFor, setLogFor] = useState<{ item: CallItem; kind: "CALL" | "WHATSAPP" } | null>(null);
  const openLog = useCallback((item: CallItem, kind: "CALL" | "WHATSAPP" = "CALL") => { setFlash(null); setLogFor({ item, kind }); }, []);
  // «عند العملاء» (D11 sheet E): a call / WhatsApp opens the same log dialog as «كلّمهم اليوم».
  const openLogFor = useCallback((c: LogTarget, kind: "CALL" | "WHATSAPP") => setLogFor({
    item: { key: `owed:${c.customerId}`, customerId: c.customerId, name: c.name, nameAr: c.nameAr, phone: c.phone, tier: null, kgPerMonth: 0,
      reason: { code: "NO_CONTACT", days: null, thresholdDays: 0 }, others: [], intervalDays: null, lastContactDays: null }, kind,
  }), []);
  // D16 «خطتي»: «أضف لخطتي» (one sheet; `?add=plan` from «＋ جديد», the old `?plan=new` too) and «خطّط أسبوعك».
  const [adding, setAdding] = useState(false);
  const [wizard, setWizard] = useState(false);
  const [planTick, setPlanTick] = useState(0);
  const addAsked = sp.get("add") === "plan" || sp.get("plan") === "new";
  const [seenAdd, setSeenAdd] = useState(false);
  // Opened by the link: the sheet takes the parameter off the page's own entry as it opens (gate C1), so neither Back,
  // a save nor a reload opens it again.
  const [addFromLink, setAddFromLink] = useState(false);
  if (addAsked && !seenAdd) { setSeenAdd(true); setAdding(true); setAddFromLink(true); }
  if (!addAsked && seenAdd) setSeenAdd(false);
  // D16 gate («أبو فهد»): who is already in «خطة اليوم» leaves «كلّمهم اليوم»; the week's targets for the band.
  const dayPlan = usePlanData("DAY", planTick, undefined, undefined, !rep);
  const weekPlan = usePlanData("WEEK", planTick, undefined, undefined, !rep);
  const plannedToday = new Set((dayPlan.plan?.items ?? []).filter((i) => i.kind === "ACTION" && i.plannedDay === dayPlan.plan?.today && i.customer).map((i) => i.customer!.id));
  // A sheet opening takes the last toast away (it would cover the sheet's top — «أبو فهد» retest).
  const openSheet = useCallback((open: () => void) => { setFlash(null); open(); }, []);
  const goTab = useCallback((t: HubTab) => router.replace(t === "today" ? "/dashboard/my-day" : `/dashboard/my-day?tab=${t}`, { scroll: false }), [router]);
  const closeAdd = useCallback(() => { setAdding(false); setAddFromLink(false); }, []);
  useDropStaleLayer();
  const [reps, setReps] = useState<{ id: string; name: string }[]>([]);
  // D8.1: back from logging on a customer page («＋ جديد › نشاط» started here): say it was saved, then drop the flag.
  const logged = sp.get("logged") === "1";
  const [seenLogged, setSeenLogged] = useState(false);
  if (logged && !seenLogged) { setSeenLogged(true); setFlash({ text: ar ? "انحفظ النشاط ✓ — وتلقاه في صفحة العميل." : "Activity saved ✓ — it is on the customer's page." }); }
  useEffect(() => { if (logged) router.replace(tab === "today" ? "/dashboard/my-day" : `/dashboard/my-day?tab=${tab}`, { scroll: false }); }, [logged, router, tab]);

  useD21Title(ar ? "يومي" : "My day");
  // The phone bar is the shell's rep bar (AppShell, council fix round 1): the same on every sales page.
  useD21Phone({ title: ar ? "يومي" : "My day" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await api<Day>(`/api/sales/my-day${rep ? `?rep=${encodeURIComponent(rep)}` : ""}`);
      if (cancelled) return;
      if (res.ok) { setData(res.data); setError(""); } else { setData(null); setError(res.data.error ?? (ar ? "تعذّر تحميل يومك." : "Could not load your day.")); }
    })();
    return () => { cancelled = true; };
  }, [rep, tick, ar]);

  const teamView = !!data?.teamView;
  useEffect(() => {
    if (!teamView) return;
    api<{ reps: { id: string; name: string }[] }>("/api/sales/my-day/reps").then((r) => { if (r.ok) setReps(r.data.reps); });
  }, [teamView]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const snooze = useCallback(async (item: CallItem) => {
    if (!item.customerId) return;
    const res = await api(`/api/sales/my-day/snooze`, { method: "POST", body: { customerId: item.customerId } });
    if (!res.ok) { setFlash({ text: res.data.error ?? (ar ? "تعذّر التأجيل." : "Could not snooze.") }); return; }
    setFlash({
      text: ar ? `أجّلنا ${nameOf(item, ar)} لبكرة` : `${item.name} moved to tomorrow`,
      undo: async () => { await api(`/api/sales/my-day/snooze?customerId=${encodeURIComponent(item.customerId!)}`, { method: "DELETE" }); setFlash(null); reload(); },
    });
    reload();
  }, [ar, reload]);

  if (error) {
    return <div className="pg"><div className="md"><div className="notice er" role="alert" data-testid="md-error">{error}</div></div></div>;
  }
  if (!data) {
    return <div className="pg"><div className="perf-loading" role="status" aria-live="polite"><span className="perf-spin" /><span className="sr-only">{ar ? "جارٍ التحميل" : "Loading"}</span></div></div>;
  }

  const ro = data.readOnly;
  const firstName = (data.rep.name || "").trim().split(/\s+/)[0] ?? "";
  const now = new Date(data.generatedAt);
  // D16 gate: a customer already in «خطة اليوم» is not repeated in «كلّمهم اليوم».
  const callList = data.callList.filter((c) => !c.customerId || !plannedToday.has(c.customerId));
  // «كلّمته — بانتظار الطلب» rows stay on the list but are not calls to make: the counts leave them out.
  const callCount = callList.filter((c) => c.reason.code !== "CALLED").length;
  const listed = callList.length;
  // The whole list is on screen when «الكل» is open or when it is short anyway: then the chips filter it.
  const full = all || listed <= TOP;
  const shown = full ? filterCallList(callList, filter) : callList.slice(0, TOP);
  const empty = data.counts.total === 0;
  const who = ro ? firstName : null;

  const banner = ro || teamView ? (
    <div className="md-ro" data-testid="md-readonly">
      {ro ? <span>{ar ? <>تشاهد يوم <bdi>{data.rep.name}</bdi> — للعرض فقط</> : <>Viewing <bdi>{data.rep.name}</bdi>&apos;s day — read-only</>}</span>
        : <span>{ar ? "هذا يومك أنت. تقدر تشوف يوم أي مندوب:" : "This is your own day. Open a rep's day:"}</span>}
      {teamView ? (
        <select aria-label={ar ? "المندوب" : "Rep"} value={ro ? data.rep.id : ""} data-testid="md-rep"
          onChange={(e) => router.push(e.target.value ? `/dashboard/my-day?rep=${encodeURIComponent(e.target.value)}` : "/dashboard/my-day")}>
          <option value="">{ar ? "يومي أنا" : "My own day"}</option>
          {reps.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          {ro && !reps.some((r) => r.id === data.rep.id) ? <option value={data.rep.id}>{data.rep.name}</option> : null}
        </select>
      ) : null}
    </div>
  ) : null;

  // D16 gate («أبو فهد»): one toast, fixed to the viewport above the tab bar — no jump, never off-screen.
  const flashBar = flash ? <PlanToast ar={ar} flash={flash} onClose={() => setFlash(null)} /> : null;

  // The day at a glance under the greeting (approved Figma «يومي — تصور», 3 Nov 2026): what kinds of calls wait today.
  const kinds = summaryOf(callList);
  const perms = user?.permissions;
  const acts = !ro && perms ? [
    hasSubPrivilege(perms, "orders", "create") ? { href: "/dashboard/my-day?new=order", ar: "+ طلب جديد", en: "+ New order", p: true, id: "md-new-order" } : null,
    hasSubPrivilege(perms, "sales", "quote_write") ? { href: "/dashboard/sales/quotes/new", ar: "عرض سعر", en: "Quotation", p: false, id: "md-new-quote" } : null,
    hasSubPrivilege(perms, "sales", "collection_submit") ? { href: "/dashboard/sales/collections", ar: "تسجيل تحصيل", en: "Record a collection", p: false, id: "md-new-collection" } : null,
  ].filter((x): x is NonNullable<typeof x> => x !== null) : [];
  const hello = (
    <div className="md-hello">
      <div className="md-hello-main">
        <span className="md-eyebrow">{ar ? "يومي" : "My day"} · {todayLine(now, lang)}</span>
        <h1 data-testid="md-greeting">{ro ? (ar ? <>يوم <bdi>{data.rep.name}</bdi></> : <><bdi>{data.rep.name}</bdi>&apos;s day</>) : greeting(now, firstName, lang)}</h1>
        <p className="md-sum" data-testid="md-summary">
          {callCount === 0
            ? <span>{ar ? (ro ? "ما عنده اتصالات مهمة اليوم" : "ما عندك اتصالات مهمة اليوم") : "No important calls today"}</span>
            : kinds.map((k) => <span key={k.en} className={`md-dot ${k.tone}`}><i aria-hidden />{ar ? k.ar : k.en}</span>)}
        </p>
      </div>
      <div className="md-hello-side">
        <Streak d={data} lang={lang} third={ro} />
        {/* D8.1: no overdue pill — overdue items show once, in «مهام اليوم» / «مهامي», with a red «متأخرة» badge. */}
        {!ro ? <AddMenu ar={ar} links={acts.map((a) => ({ href: a.href, ar: a.ar.replace(/^\+ /, ""), en: a.en.replace(/^\+ /, ""), id: a.id }))} onDone={(m) => { setFlash({ text: m }); reload(); setTick((t) => t + 1); }} onPlan={() => openSheet(() => setAdding(true))} /> : null}
      </div>
    </div>
  );

  // D16: the tabs «اليوم · خطتي» (never on a manager's read-only view of a rep's day).
  const tabsBar = !ro ? <HubTabs tab={tab} ar={ar} onTab={goTab} /> : null;
  const today = new Date(Date.parse(data.generatedAt) + 3 * 3_600_000).toISOString().slice(0, 10);
  const weekSource: WeekSource = { callList: data.callList, contracts: data.contracts, owed: data.target.owed?.customers ?? [] };
  const planned = () => { setPlanTick((t) => t + 1); };
  const weekGoals = (() => {
    const p = weekPlan.plan;
    if (!p) return null;
    const gs = p.items.filter((i) => i.kind === "GOAL" && i.source === "ADMIN" && i.metric && i.metric in GOAL_T && i.target);
    return gs.length ? gs.map((g) => `${GOAL_T[g.metric as keyof typeof GOAL_T][ar ? 0 : 1]} ${p.counts[g.metric as keyof typeof p.counts] ?? 0} ${ar ? "من" : "of"} ${g.target}`).join(" · ") : null;
  })();
  const planLayer = !ro ? (
    <>
      {adding ? <AddPlanSheet ar={ar} today={today} cleanUrl={addFromLink ? (tab === "today" ? "/dashboard/my-day" : `/dashboard/my-day?tab=${tab}`) : undefined} onClose={closeAdd} onSaved={(m) => { closeAdd(); planned(); setFlash({ text: m }); }} /> : null}
      {wizard ? <PlanWeekWizard ar={ar} today={today} source={weekSource} onClose={() => setWizard(false)} onDone={(m) => { setWizard(false); planned(); setFlash({ text: m }); }} /> : null}
    </>
  ) : null;
  // «خطة اليوم» — the first block of «اليوم» (Figma D16 A1).
  const todayPlan = !ro ? <TodayPlan ar={ar} reloadKey={planTick} onFlash={setFlash} onPlanWeek={() => openSheet(() => setWizard(true))} onAdd={() => openSheet(() => setAdding(true))} needYou={suggestionsOf(weekSource, ar).length} /> : null;
  if (!ro && tab === "plan") {
    return (
      <div className="pg">
        <div className="md" data-testid="md-page" data-tab={tab}>
          {flashBar}
          {hello}
          {tabsBar}
          <WeekPlan key={planTick} ar={ar} onPlanWeek={() => openSheet(() => setWizard(true))} onFlash={setFlash} />
        </div>
        {planLayer}
      </div>
    );
  }

  // D16 gate («أبو فهد»): «سجّل النتيجة» of a call opens «وش صار؟» — the same sheet as the plan; its next step goes into
  // «خطتي». A WhatsApp keeps its own log (the plan's sheet has no WhatsApp).
  const callAsPlan: PItem | null = logFor && logFor.kind === "CALL" && logFor.item.customerId ? {
    id: "", source: "SELF", kind: "ACTION", metric: "CALLS", label: null, target: null, done: null, checked: false, setBy: null,
    customer: { id: logFor.item.customerId, name: nameOf(logFor.item, ar), phone: logFor.item.phone }, plannedDay: null, plannedTime: null,
    doneAt: null, doneOutcome: null, doneBody: null, weekStart: null, doneHow: null,
    // A follow-up or a sample row: the call stays on that deal's timeline (gate).
    dealId: logFor.item.reason.code === "FOLLOW_UP" || logFor.item.reason.code === "SAMPLE" ? logFor.item.reason.dealId : null,
  } : null;
  const quick = callAsPlan && !ro ? (
    <WhatHappened ar={ar} it={callAsPlan} today={today} onClose={() => setLogFor(null)} onSaved={(m) => { setLogFor(null); setFlash({ text: m }); reload(); planned(); }} />
  ) : logFor && !ro ? (
    <HrRoot>
      <ActivityDialog ar={ar} customerId={logFor.item.customerId} customerName={nameOf(logFor.item, ar)} deals={[]} initialKind={logFor.kind}
        defaultDealId={logFor.item.reason.code === "FOLLOW_UP" || logFor.item.reason.code === "SAMPLE" ? logFor.item.reason.dealId : null}
        onClose={() => setLogFor(null)} onDone={() => { setLogFor(null); setFlash({ text: ar ? "تم التسجيل." : "Logged." }); reload(); }} />
    </HrRoot>
  ) : null;

  if (phone) {
    return (
      <div className="pg">
        <div className="md" data-testid="md-page" data-phone="1">
          {banner}
          {flashBar}
          {hello}
          {tabsBar}
          {todayPlan}
          {empty ? <NoBookNotice lang={lang} /> : null}
          {/* Owner (6 Nov 2026): on a phone the target, then «كلّمهم اليوم» — under «خطة اليوم» (D16). */}
          <SalesBand t={data.target} lang={lang} who={who} phone ro={ro} viewerId={data.viewerId} onLog={openLogFor} weekGoals={weekGoals} />
          <CallCard d={{ ...data, callList }} lang={lang} items={shown} total={listed} all={full} onAll={() => setAll((v) => !v)} ro={ro} empty={empty}
            filter={filter} onFilter={setFilter} onDone={openLog} onSnooze={snooze} phone />
          <AttentionStrip d={data} lang={lang} ro={ro} />
          <DealsCard d={data} lang={lang} />
          <CustomersCard d={data} lang={lang} />
          {/* Under the four main cards (council fix round 1, P0-5): contracts, the book by tier with each one's share, growing. */}
          <details className="md-fold" open={data.contracts.length > 0} data-testid="md-fold-contracts"><summary>{ar ? "عقود قريبة تنتهي" : "Contracts ending soon"}{data.contracts.length ? <span className="num"> ({n(data.contracts.length)})</span> : null}</summary><ContractsCard d={data} lang={lang} /></details>
          <details className="md-fold" data-testid="md-fold-tiers"><summary>{ar ? "عملائي حسب التصنيف" : "My customers by tier"}</summary><TiersCard d={data} lang={lang} /></details>
          <details className="md-fold" data-testid="md-fold-growing"><summary>{ar ? "ينمون معك" : "Growing with you"}</summary><GrowingCard d={data} lang={lang} /></details>
        </div>
        {quick}
        {planLayer}
      </div>
    );
  }

  return (
    <div className="pg">
      <div className="md" data-testid="md-page">
        {banner}
        {flashBar}
        {hello}
        {tabsBar}
        {todayPlan}
        {empty ? <NoBookNotice lang={lang} /> : null}
        <SalesBand t={data.target} lang={lang} who={who} phone={false} ro={ro} viewerId={data.viewerId} onLog={openLogFor} weekGoals={weekGoals} />
        <AttentionStrip d={data} lang={lang} ro={ro} />
        <CallCard d={{ ...data, callList }} lang={lang} items={shown} total={listed} all={full} onAll={() => setAll((v) => !v)} ro={ro} empty={empty}
          filter={filter} onFilter={setFilter} onDone={openLog} onSnooze={snooze} />
        {/* What the owner kept from after the design (6 Nov 2026), under the rows Figma draws. */}
        <div className="md-grid2">
          <DealsCard d={data} lang={lang} />
          <GrowingCard d={data} lang={lang} />
        </div>
        <div className="md-grid2 md-row3">
          <div className="md-pair">
            <TiersCard d={data} lang={lang} />
            <CustomersCard d={data} lang={lang} />
          </div>
          <ContractsCard d={data} lang={lang} />
        </div>
      </div>
      {quick}
      {planLayer}
    </div>
  );
}

/**
 * The line under the greeting: the waiting calls grouped by colour (red late, amber due / quiet, blue samples, olive
 * follow-ups), «كلّمته — بانتظار الطلب» rows left out as in the count beside them.
 */
function summaryOf(list: CallItem[]): { tone: "bad" | "warn" | "info" | "pri"; ar: string; en: string }[] {
  const c = { late: 0, due: 0, quiet: 0, sample: 0, follow: 0 };
  for (const i of list) {
    const k = i.reason.code;
    if (k === "LATE") c.late++; else if (k === "DUE" || k === "EXPECTED") c.due++; else if (k === "NO_CONTACT") c.quiet++;
    else if (k === "SAMPLE") c.sample++; else if (k === "FOLLOW_UP") c.follow++;
  }
  const out: { tone: "bad" | "warn" | "info" | "pri"; ar: string; en: string }[] = [];
  const cnt = (v: number, one: string, two: string, few: string) => (v === 1 ? one : v === 2 ? two : `${n(v)} ${few}`);
  if (c.follow) out.push({ tone: "pri", ar: cnt(c.follow, "متابعة وحدة اليوم", "متابعتين اليوم", "متابعات اليوم"), en: `${n(c.follow)} follow-up${c.follow === 1 ? "" : "s"} today` });
  if (c.late) out.push({ tone: "bad", ar: cnt(c.late, "عميل متأخر عن طلبه", "عميلين متأخرين عن طلبهم", "عملاء متأخرين عن طلبهم"), en: `${n(c.late)} late to reorder` });
  if (c.due) out.push({ tone: "warn", ar: cnt(c.due, "عميل حان موعد طلبه", "عميلين حان موعد طلبهم", "عملاء حان موعد طلبهم"), en: `${n(c.due)} due to order` });
  if (c.sample) out.push({ tone: "info", ar: cnt(c.sample, "عيّنة تنتظر رأيهم", "عيّنتين تنتظر رأيهم", "عيّنات تنتظر رأيهم"), en: `${n(c.sample)} sample${c.sample === 1 ? "" : "s"} awaiting feedback` });
  if (c.quiet) out.push({ tone: "warn", ar: cnt(c.quiet, "عميل ما تواصلت معه من فترة", "عميلين ما تواصلت معهم من فترة", "عملاء ما تواصلت معهم من فترة"), en: `${n(c.quiet)} not contacted lately` });
  return out;
}


/** The round initial beside a customer's name (first letter, Arabic name first). */
function Initial({ name }: { name: string }) {
  const ch = Array.from(name.replace(/^(مقهى|مقهي|شركة|مؤسسة|محامص|محمصة|مطعم|مطاعم|سلسلة)\s+/, "").trim().replace(/^ال(?=\S{2})/, ""))[0] ?? "؟";
  return <span className="md-av" aria-hidden>{ch}</span>;
}

/**
 * «انتبه لعملائك» (owner-approved Figma 160:107, 3 Nov 2026): what in the book needs attention, each a link to «عملائي»
 * already filtered (`?f=`) — the same customers the counts are made of. Shown only when there is something.
 */
function AttentionStrip({ d, lang, ro }: { d: Day; lang: Lang; ro: boolean }) {
  const ar = lang === "ar";
  if (ro) return null;
  const c = d.counts;
  const soonest = d.contracts.length ? Math.min(...d.contracts.map((k) => k.daysLeft)) : null;
  const items = [
    c.stopped ? { f: "stopped", tone: "warn", n: c.stopped, ar: "متوقفين", en: "Stopped" } : null,
    c.declining ? { f: "declining", tone: "bad", n: c.declining, ar: "يتراجعون", en: "Declining" } : null,
    c.contracts ? { f: "contracts", tone: "sig", n: c.contracts, ar: soonest !== null && soonest >= 0 ? `عقد ينتهي بعد ${days(soonest, "ar")}` : "عقود قريبة تنتهي", en: "Contracts ending soon" } : null,
  ].filter((x): x is NonNullable<typeof x> => x !== null);
  const deals = d.openDeals;
  if (!items.length && !deals) return null;
  return (
    <nav className="md-attn" aria-label={ar ? "انتبه لعملائك" : "Mind your customers"} data-testid="md-attention">
      <span className="md-attn-h"><Ico name="bell" small />{ar ? "انتبه لعملائك" : "Mind your customers"}</span>
      <span className="md-attn-items">
        {items.map((x) => (
          <Link key={x.f} className={`md-attn-i ${x.tone}`} href={`/dashboard/customers?f=${x.f}`} data-testid={`md-attn-${x.f}`}>
            <b className="num">{n(x.n)}</b> {ar ? x.ar : x.en} <span aria-hidden>‹</span>
          </Link>
        ))}
        {deals ? <Link className="md-attn-i info" href="/dashboard/sales/pipeline" data-testid="md-attn-deals"><b className="num">{n(deals)}</b> {ar ? "صفقات مفتوحة" : "Open deals"} <span aria-hidden>‹</span></Link> : null}
      </span>
    </nav>
  );
}

// ── Cards ────────────────────────────────────────────────────────────────────────────────────

function Card({ title, link, testId, children }: { title: ReactNode; link?: ReactNode; testId: string; children: ReactNode }) {
  return (
    <section className="md-card" data-testid={testId} aria-labelledby={`${testId}-h`}>
      <div className="md-h"><h2 id={`${testId}-h`}>{title}</h2>{link}</div>
      {children}
    </section>
  );
}

/** A card's empty state: centred in the card's fixed frame, its action centred under it (owner, Figma 3 Nov 2026). */
function Empty({ children, action, icon }: { children: ReactNode; action?: ReactNode; icon?: "phone" }) {
  return <div className="md-empty" data-testid="md-empty">{icon ? <span className="md-empty-ico" aria-hidden><Ico name={icon} small /></span> : null}<span>{children}</span>{action}</div>;
}

/**
 * A rep with no customers (council fix round 2, item 8): ONE message at the top of the page (`NoBookNotice`); each card
 * then says only a short line, never the same sentence five times.
 */
function NoBookNotice({ lang }: { lang: Lang }) {
  return (
    <div className="md-card md-nobook" role="status" data-testid="md-nobook">
      <b>{lang === "ar" ? "ما عندك عملاء معيّنين لك بعد" : "No customers are assigned to you yet"}</b>
      <span>{lang === "ar" ? "اطلب من مديرك يعيّن لك عملاءك، وتطلع هنا قائمة اتصالاتك وتصنيف عملائك." : "Ask your manager to assign your accounts; your calls and your book will show here."}</span>
    </div>
  );
}

function NoBook({ lang }: { lang: Lang }) {
  return <p className="md-empty-line" data-testid="md-empty-line">{lang === "ar" ? "لا شيء هنا بعد" : "Nothing here yet"}</p>;
}

function Streak({ d, lang, third }: { d: Day; lang: Lang; third?: boolean }) {
  const ar = lang === "ar";
  if (d.target.streakWeeks >= 1) {
    return <span className="md-pill sig" data-testid="md-streak"><Ico name="flame" small />{streakText(d.target.streakWeeks, lang, third)}</span>;
  }
  if (d.target.newBest) return <span className="md-pill ok" data-testid="md-best"><Ico name="check" small />{third ? (ar ? "هذا أفضل شهر له" : "Their best month yet") : ar ? "هذا أفضل شهر لك" : "Your best month yet"}</span>;
  return null;
}

function CallActions({ item, lang, ro, onDone, onSnooze }: { item: CallItem; lang: Lang; ro: boolean; onDone: (i: CallItem, kind?: "CALL" | "WHATSAPP") => void; onSnooze: (i: CallItem) => void; phone?: boolean }) {
  const ar = lang === "ar";
  const tel = telHref(item.phone);
  const wa = waNumber(item.phone);
  const nm = nameOf(item, ar);
  return (
    <div className="md-acts">
      {/* 📞 / 💬 call or open WhatsApp AND open the same log dialog as the customer page (council fix round 1). */}
      {tel ? <a className="md-ic" href={tel} onClick={() => { if (!ro) onDone(item, "CALL"); }} aria-label={ar ? `اتصل بـ ${nm}` : `Call ${nm}`} title={ar ? "اتصال" : "Call"} data-testid="md-call"><Ico name="phone" small /></a> : null}
      {wa ? <a className="md-ic" href={`https://wa.me/${wa}`} target="_blank" rel="noopener noreferrer" onClick={() => { if (!ro) onDone(item, "WHATSAPP"); }} aria-label={ar ? `واتساب ${nm}` : `WhatsApp ${nm}`} title={ar ? "واتساب" : "WhatsApp"} data-testid="md-wa"><Ico name="chat" small /></a> : null}
      {!ro && item.reason.code !== "CALLED" ? <button type="button" className="btn sm md-log" onClick={() => onDone(item)} aria-label={ar ? `سجّل نتيجة التواصل مع ${nm}` : `Log the outcome with ${nm}`} data-testid="md-done">{ar ? "سجّل النتيجة" : "Log outcome"}</button> : null}
      {!ro && item.customerId && item.reason.code !== "CALLED" ? <button type="button" className="md-ic" onClick={() => onSnooze(item)} aria-label={ar ? `أجّل ${nm} لبكرة` : `Snooze ${nm} until tomorrow`} title={ar ? "أجّل لبكرة" : "Tomorrow"} data-testid="md-snooze"><Ico name="clock" small /></button> : null}
    </div>
  );
}

function CallRow({ item, lang, ro, onDone, onSnooze, phone }: { item: CallItem; lang: Lang; ro: boolean; onDone: (i: CallItem, kind?: "CALL" | "WHATSAPP") => void; onSnooze: (i: CallItem) => void; phone?: boolean }) {
  const ar = lang === "ar";
  const pill = reasonPill(item.reason, lang);
  const nm = nameOf(item, ar);
  const href = item.customerId ? `/dashboard/customers/${item.customerId}` : item.reason.code === "FOLLOW_UP" || item.reason.code === "SAMPLE" ? `/dashboard/sales/deals/${item.reason.dealId}` : null;
  return (
    <div className="md-row" data-testid="md-call-row" data-reason={item.reason.code}>
      <Initial name={nm} />
      <div className="md-who">
        <b>{href ? <Link href={href}><bdi>{nm}</bdi></Link> : <bdi>{nm}</bdi>}</b>
        <span className="md-meta"><span className={`md-pill sq ${pill.tone}`}>{pill.text}</span><span className="md-why">{whyLine(item, lang, ro)}</span></span>
      </div>
      <CallActions item={item} lang={lang} ro={ro} onDone={onDone} onSnooze={onSnooze} phone={phone} />
    </div>
  );
}

/** A phone row: swipe right = done (the log dialog), swipe left = until tomorrow. The buttons do the same. */
function SwipeRow(props: { item: CallItem; lang: Lang; ro: boolean; onDone: (i: CallItem, kind?: "CALL" | "WHATSAPP") => void; onSnooze: (i: CallItem) => void }) {
  const ar = props.lang === "ar";
  const [dx, setDx] = useState(0);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const can = !props.ro && props.item.reason.code !== "CALLED";
  return (
    <div className="md-swipe">
      <div className="bg" aria-hidden><span className="done">✓ {ar ? "تم" : "Done"}</span><span className="later">{ar ? "بكرة" : "Tomorrow"} ⏰</span></div>
      <div className="fg" style={{ transform: `translateX(${dx}px)` }}
        onPointerDown={(e) => { if (!can || e.pointerType === "mouse") return; start.current = { x: e.clientX, y: e.clientY, id: e.pointerId }; }}
        onPointerMove={(e) => {
          const s = start.current; if (!s || s.id !== e.pointerId) return;
          const x = e.clientX - s.x;
          if (Math.abs(e.clientY - s.y) > 30 && Math.abs(x) < 20) { start.current = null; setDx(0); return; }
          setDx(Math.max(-120, Math.min(120, x)));
        }}
        onPointerUp={() => {
          const x = dx; start.current = null; setDx(0);
          if (x > 80) props.onDone(props.item);
          else if (x < -80 && props.item.customerId) props.onSnooze(props.item);
        }}
        onPointerCancel={() => { start.current = null; setDx(0); }}>
        <CallRow {...props} phone />
      </div>
    </div>
  );
}

const FILTERS: { id: CallFilter; ar: string; en: string }[] = [
  { id: "ALL", ar: "الكل", en: "All" },
  { id: "LATE", ar: "متأخرين", en: "Late" },
  { id: "EXPECTED", ar: "متوقع قريبًا", en: "Expected soon" },
  { id: "SAMPLE", ar: "عيّنات", en: "Samples" },
  { id: "FOLLOW_UP", ar: "متابعات", en: "Follow-ups" },
];

function CallCard({ d, lang, items, total, all, onAll, ro, empty, filter, onFilter, onDone, onSnooze, phone }: {
  d: Day; lang: Lang; items: CallItem[]; total: number; all: boolean; onAll: () => void; ro: boolean; empty: boolean;
  filter: CallFilter; onFilter: (f: CallFilter) => void;
  onDone: (i: CallItem, kind?: "CALL" | "WHATSAPP") => void; onSnooze: (i: CallItem) => void; phone?: boolean;
}) {
  const ar = lang === "ar";
  const link = total > TOP ? <button type="button" className="lk" onClick={onAll} data-testid="md-call-all">{all ? (ar ? "أهم 5 فقط" : "Top 5 only") : (ar ? `الكل (${n(total)})` : `All (${n(total)})`)}</button> : null;
  const countOf = (f: CallFilter) => (f === "ALL" ? d.callList.length : d.callList.filter((i) => callFilterOf(i) === f).length);
  return (
    <Card title={<>{ar ? "كلّمهم اليوم" : "Call them today"}{total ? <span className="md-count num">{n(total)}</span> : null}</>} link={link} testId="md-calls">
      {/* The swipe hint at the TOP of the list (seat 5 r2), before the rows it explains. */}
      {phone && items.length > 0 && !ro ? <p className="md-hint" data-testid="md-swipe-hint">{ar ? "اسحب البطاقة يمين = تم · يسار = أجّل لبكرة" : "Swipe right = done · left = tomorrow"}</p> : null}
      {all && !empty && total > 0 ? (
        <div className="md-chips" role="group" aria-label={ar ? "تصفية القائمة" : "Filter the list"} data-testid="md-filters">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" className="md-chip" aria-pressed={filter === f.id} data-testid={`md-filter-${f.id}`} onClick={() => onFilter(f.id)}>
              {ar ? f.ar : f.en} <span className="num">({n(countOf(f.id))})</span>
            </button>
          ))}
        </div>
      ) : null}
      {empty ? <NoBook lang={lang} />
        : items.length === 0 ? (all && filter !== "ALL"
          ? <Empty>{ar ? "ما فيه أحد في هذا التصنيف اليوم." : "Nobody in this group today."}</Empty>
          : <Empty icon="phone" action={<Link className="btn sm" href="/dashboard/customers">{ar ? "افتح عملائي" : "Open my customers"}</Link>}>{ar ? "ما فيه أحد لازم تكلمه اليوم. كل عملائك على موعدهم. تقدر تمر على عملائك أو تسجّل زيارة." : "Nobody needs a call today — every account is on track."}</Empty>)
          : items.map((it) => phone
            ? <SwipeRow key={it.key} item={it} lang={lang} ro={ro} onDone={onDone} onSnooze={onSnooze} />
            : <CallRow key={it.key} item={it} lang={lang} ro={ro} onDone={onDone} onSnooze={onSnooze} />)}
    </Card>
  );
}

function DealsCard({ d, lang }: { d: Day; lang: Lang }) {
  const ar = lang === "ar";
  return (
    <Card title={ar ? "صفقات في عرض السعر والتفاوض" : "Deals in quotation & negotiation"} testId="md-deals" link={<Link className="lk" href="/dashboard/sales/pipeline">{ar ? "صفقاتي" : "My deals"}</Link>}>
      {d.deals.length === 0
        ? <Empty action={<Link className="btn sm" href="/dashboard/sales/quotes/new">{ar ? "عرض سعر جديد" : "New quotation"}</Link>}>{ar ? "ما عندك صفقات في عرض السعر والتفاوض الحين. أرسل عرض سعر لعميل مهتم وتطلع هنا." : "No deals in quotation & negotiation. Send a quotation to an interested customer."}</Empty>
        : d.deals.slice(0, 6).map((x) => (
          <div className="md-mini" key={x.id} data-testid="md-deal">
            <Link href={`/dashboard/sales/deals/${x.id}`}><bdi>{x.customerName ? (ar ? x.customerNameAr || x.customerName : x.customerName) : x.title}</bdi> <span className="sub" data-testid="md-deal-required">· {x.requiredNow ? (ar ? x.requiredNow.ar : x.requiredNow.en) : (ar ? x.stageAr : x.stageEn)}</span></Link>
            <span className="num">{n(x.amount)} <span className="sub">{ar ? "ريال" : "SAR"}</span></span>
          </div>
        ))}
    </Card>
  );
}

function GrowingCard({ d, lang }: { d: Day; lang: Lang }) {
  const ar = lang === "ar";
  return (
    <Card title={<><Ico name="trend" small className="md-h-ico" />{ar ? "ينمون معك" : "Growing with you"}</>} testId="md-growing">
      {d.counts.total === 0 ? <NoBook lang={lang} />
        : d.growing.length === 0 ? <Empty>{ar ? "ما فيه عميل ينمو بوضوح حاليًا. نحتاج طلبين على الأقل في كل فترة عشان نحكم." : "No customer is clearly growing right now (two orders per period are needed)."}</Empty>
          : d.growing.slice(0, 5).map((g) => (
            <div className="md-mini" key={g.id} data-testid="md-grow">
              <Link href={`/dashboard/customers/${g.id}`}><bdi>{nameOf(g, ar)}</bdi> <span className="sub">· {n(g.prevKg)} ← {n(g.lastKg)} {ar ? "كجم" : "kg"}</span></Link>
              <span className="md-pill ok"><bdi>+{n(g.pct, 0)}%</bdi></span>
            </div>
          ))}
      <p className="md-note">{ar ? "آخر 3 شهور مقابل الـ3 اللي قبلها، بالكيلو" : "Last 3 months vs the 3 before, in kg"}</p>
    </Card>
  );
}

function TiersCard({ d, lang }: { d: Day; lang: Lang }) {
  const ar = lang === "ar";
  const cls: Record<Tier, string> = { VIP: "md-t-vip", REGULAR: "md-t-regular", SMALL: "md-t-small", QUIET: "md-t-quiet" };
  return (
    <Card title={ar ? "عملائي حسب التصنيف" : "My customers by tier"} testId="md-tiers">
      {d.counts.total === 0 ? <NoBook lang={lang} />
        : d.tiers.totalKg <= 0 ? <Empty>{ar ? "ما فيه طلبات آخر 3 شهور، فالتصنيف يطلع بعد أول طلبات عملائك." : "No orders in the last 3 months — tiers appear after your customers order."}</Empty>
          : (
            <div className="md-tiers" style={{ display: "grid" }}>
              <div className="md-tierbar" role="img" aria-label={d.tiers.groups.map((g) => `${ar ? TIER_LABEL[g.tier].ar : TIER_LABEL[g.tier].en} ${g.share}%`).join("، ")}>
                {d.tiers.groups.filter((g) => g.share > 0).map((g) => <span key={g.tier} className={cls[g.tier]} style={{ width: `${g.share}%` }} />)}
              </div>
              <div className="md-legend">
                {d.tiers.groups.filter((g) => g.tier !== "QUIET" || g.count > 0).map((g) => (
                  <span key={g.tier} data-testid={`md-tier-${g.tier}`}><i className={cls[g.tier]} />{ar ? TIER_LABEL[g.tier].ar : TIER_LABEL[g.tier].en} · {n(g.count)} {ar ? (g.count === 1 ? "عميل" : "عملاء") : "customers"} · <bdi>{n(g.share, 0)}%</bdi></span>
                ))}
              </div>
              <p className="md-note">{ar ? "الحصة من كمية طلبات عملائك (كجم) آخر 3 شهور" : "Share of your customers' kg ordered in the last 3 months"}{!d.tiers.percentile ? (ar ? " · عملاؤك أقل من 8، فالتصنيف بالحدود فقط" : " · fewer than 8 customers: the floors decide") : ""}</p>
              {d.tiers.groups.filter((g) => g.count > 0).map((g) => (
                <details key={g.tier}>
                  <summary>{ar ? TIER_LABEL[g.tier].ar : TIER_LABEL[g.tier].en} ({n(g.count)})</summary>
                  {g.customers.map((c) => (
                    <div className="md-mini" key={c.id}>
                      <Link href={`/dashboard/customers/${c.id}`}><bdi>{nameOf(c, ar)}</bdi> <span className="sub">· {n(c.kgPerMonth)} {ar ? "كجم/شهر" : "kg/mo"}</span></Link>
                      <span className="sub num">{n(c.share, 1)}%</span>
                    </div>
                  ))}
                </details>
              ))}
            </div>
          )}
    </Card>
  );
}

function CustomersCard({ d, lang }: { d: Day; lang: Lang }) {
  const ar = lang === "ar";
  const c = d.counts;
  return (
    <Card title={ar ? "عملائي" : "My customers"} testId="md-customers" link={<Link className="lk" href="/dashboard/customers">{ar ? "الكل" : "All"}</Link>}>
      {c.total === 0 ? <NoBook lang={lang} /> : (
        <>
          {/* One bar, three parts: the shares of the book (approved Figma «عملائي»). Not every customer is in one of the three. */}
          <div className="md-stack-bar" role="img" aria-label={ar ? `نشطين ${c.active}، يتفاوضون ${c.negotiating}، متوقفين ${c.stopped}` : `Active ${c.active}, negotiating ${c.negotiating}, stopped ${c.stopped}`}>
            {c.active ? <span className="ok" style={{ flexGrow: c.active }} /> : null}
            {c.negotiating ? <span className="info" style={{ flexGrow: c.negotiating }} /> : null}
            {c.stopped ? <span className="warn" style={{ flexGrow: c.stopped }} /> : null}
          </div>
          <div className="md-legend3">
            <div><span className="md-dot ok"><i aria-hidden />{ar ? "نشطين" : "Active"}</span><b className="num" data-testid="md-count-active">{n(c.active)}</b></div>
            <div><span className="md-dot info"><i aria-hidden />{ar ? "يتفاوضون" : "Negotiating"}</span><b className="num">{n(c.negotiating)}</b></div>
            <div><span className="md-dot warn"><i aria-hidden />{ar ? "متوقفين" : "Stopped"}</span><b className="num" style={c.stopped ? { color: "var(--status-danger)" } : undefined}>{n(c.stopped)}</b></div>
          </div>
          <p className="md-note">{ar ? `من ${n(c.total)} عميل · النشط اللي طلب خلال 3 شهور أو ضعف عادته` : `of ${n(c.total)} · active = ordered within 3 months or twice their rhythm`}</p>
        </>
      )}
    </Card>
  );
}

function ContractsCard({ d, lang }: { d: Day; lang: Lang }) {
  const ar = lang === "ar";
  return (
    <Card title={ar ? "عقود قريبة تنتهي" : "Contracts ending soon"} testId="md-contracts">
      {d.contracts.length === 0 ? <Empty>{ar ? `ما فيه عقود تنتهي خلال ${n(d.contractWindowDays ?? 45)} يوم.` : `No contract ends within ${n(d.contractWindowDays ?? 45)} days.`}</Empty>
        : d.contracts.map((k) => (
          <div className="md-mini" key={k.fileId}>
            <Link href={`/dashboard/customers/${k.customerId}`}><bdi>{k.customerName}</bdi> <span className="sub">· <bdi>{k.title}</bdi></span></Link>
            <span className={`md-pill ${k.daysLeft < 0 ? "bad" : "warn"}`}>{k.daysLeft < 0 ? (ar ? "منتهي" : "Expired") : ar ? `بعد ${days(k.daysLeft, "ar")}` : `in ${days(k.daysLeft, "en")}`}</span>
          </div>
        ))}
    </Card>
  );
}

