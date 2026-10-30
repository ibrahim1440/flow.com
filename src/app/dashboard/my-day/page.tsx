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
import { filterCallList, callFilterOf, type CallFilter } from "@/lib/services/sales/my-day/filters";
import {
  TIER_LABEL, days, greeting, streakText, monthName, n, reasonPill, telHref, todayLine, waNumber, whyLine,
  type Lang, type Reason, type Tier,
} from "./_components/text";

type CallItem = {
  key: string; customerId: string | null; name: string; nameAr: string | null; phone: string | null; tier: Tier | null;
  kgPerMonth: number; reason: Reason; others: string[]; intervalDays: number | null; lastContactDays: number | null;
};
type Day = {
  rep: { id: string; name: string }; generatedAt: string; readOnly: boolean; teamView: boolean; viewerId: string;
  target: {
    month: string; target: string | null; achieved: string; percent: string | null; remaining: string | null; met: boolean | null;
    daysLeft: number; streakWeeks: number; personalBest: { month: string; amount: string } | null; newBest: boolean;
    commissionVisible: boolean; accrued: string | null; estimate: string | null; estimateDiscretionary: boolean; hasPlan: boolean;
  };
  callList: CallItem[];
  deals: { id: string; title: string; amount: string; customerId: string | null; customerName: string | null; customerNameAr: string | null; stageAr: string; stageEn: string }[];
  openDeals: number;
  growing: { id: string; name: string; nameAr: string | null; pct: number; lastKg: number; prevKg: number }[];
  tiers: { totalKg: number; percentile: boolean; groups: { tier: Tier; count: number; kg: number; share: number; customers: { id: string; name: string; nameAr: string | null; kgPerMonth: number; share: number }[] }[] };
  counts: { total: number; active: number; negotiating: number; stopped: number };
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
  const rep = useSearchParams().get("rep");
  const [data, setData] = useState<Day | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const [all, setAll] = useState(false);
  // The full list's filter chips (council fix round 2, item 7).
  const [filter, setFilter] = useState<CallFilter>("ALL");
  const [logFor, setLogFor] = useState<{ item: CallItem; kind: "CALL" | "WHATSAPP" } | null>(null);
  const openLog = useCallback((item: CallItem, kind: "CALL" | "WHATSAPP" = "CALL") => setLogFor({ item, kind }), []);
  const [flash, setFlash] = useState<{ text: string; undo?: () => void } | null>(null);
  const [reps, setReps] = useState<{ id: string; name: string }[]>([]);
  // One-time notice (council fix round 1, P0-15): «يومي» became the home page; the old one is a setting away.
  // A per-person convenience on this device (localStorage), never a business record.
  const introKey = user ? `hq.mydayIntro.v1.${user.id}` : null;
  const [intro, setIntro] = useState(() => {
    if (!introKey || typeof window === "undefined") return false;
    try { return window.localStorage.getItem(introKey) !== "seen"; } catch { return false; }
  });
  const closeIntro = useCallback(() => { setIntro(false); try { if (introKey) window.localStorage.setItem(introKey, "seen"); } catch { /* private window */ } }, [introKey]);

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
  // «كلّمته — بانتظار الطلب» rows stay on the list but are not calls to make: the counts leave them out.
  const callCount = data.callList.filter((c) => c.reason.code !== "CALLED").length;
  const listed = data.callList.length;
  // The whole list is on screen when «الكل» is open or when it is short anyway: then the chips filter it.
  const full = all || listed <= TOP;
  const shown = full ? filterCallList(data.callList, filter) : data.callList.slice(0, TOP);
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

  const introBar = intro && !ro ? (
    <div className="notice ok" role="status" data-testid="md-intro">
      <span style={{ flex: 1 }}>{ar ? <>صفحتك الرئيسية صارت «يومي» — تقدر ترجع للقديمة من <Link href="/dashboard/profile" onClick={closeIntro}>الملف الشخصي</Link>.</> : <>Your home page is now «My day» — you can switch back in <Link href="/dashboard/profile" onClick={closeIntro}>your profile</Link>.</>}</span>
      <button type="button" className="btn g sm" onClick={closeIntro} aria-label={ar ? "فهمت" : "Got it"} data-testid="md-intro-close">{ar ? "فهمت" : "Got it"}</button>
    </div>
  ) : null;

  const flashBar = flash ? (
    <div className="notice ok" role="status" data-testid="md-flash">
      <span style={{ flex: 1 }}>{flash.text}</span>
      {flash.undo ? <button type="button" className="btn sm" onClick={flash.undo}>{ar ? "تراجع" : "Undo"}</button> : null}
      <button type="button" className="btn g sm" onClick={() => setFlash(null)} aria-label={ar ? "إخفاء" : "Dismiss"}>×</button>
    </div>
  ) : null;

  const hello = (
    <div className="md-hello">
      <div>
        <h1 data-testid="md-greeting">{ro ? (ar ? <>يوم <bdi>{data.rep.name}</bdi></> : <><bdi>{data.rep.name}</bdi>&apos;s day</>) : greeting(now, firstName, lang)}</h1>
        <p>{todayLine(now, lang)} · {callCount === 0
          ? (ar ? "ما عندك اتصالات مهمة اليوم" : "no important calls today")
          : ro ? (ar ? `${n(Math.min(callCount, TOP))} اتصالات مهمة اليوم` : `${n(Math.min(callCount, TOP))} important calls today`)
            : ar ? `عندك ${n(Math.min(callCount, TOP))} اتصالات مهمة اليوم` : `${n(Math.min(callCount, TOP))} important calls today`}</p>
      </div>
      <Streak d={data} lang={lang} third={ro} />
    </div>
  );

  const quick = logFor && !ro ? (
    <HrRoot>
      <ActivityDialog ar={ar} customerId={logFor.item.customerId} customerName={nameOf(logFor.item, ar)} deals={[]} initialKind={logFor.kind}
        defaultDealId={logFor.item.reason.code === "FOLLOW_UP" || logFor.item.reason.code === "SAMPLE" ? logFor.item.reason.dealId : null}
        onClose={() => setLogFor(null)} onDone={() => { setLogFor(null); setFlash({ text: ar ? "تم التسجيل. ممتاز 👌" : "Logged." }); reload(); }} />
    </HrRoot>
  ) : null;

  if (phone) {
    return (
      <div className="pg">
        <div className="md" data-testid="md-page" data-phone="1">
          {banner}
          {introBar}
          {flashBar}
          {hello}
          {empty ? <NoBookNotice lang={lang} /> : null}
          <TargetCard d={data} lang={lang} who={who} compact />
          <CallCard d={data} lang={lang} items={shown} total={listed} all={full} onAll={() => setAll((v) => !v)} ro={ro} empty={empty}
            filter={filter} onFilter={setFilter} onDone={openLog} onSnooze={snooze} phone />
          <DealsCard d={data} lang={lang} />
          <CustomersCard d={data} lang={lang} />
          {/* Under the four main cards (council fix round 1, P0-5): contracts, the book by tier with each one's share, growing. */}
          <details className="md-fold" open={data.contracts.length > 0} data-testid="md-fold-contracts"><summary>{ar ? "عقود قريبة تنتهي" : "Contracts ending soon"}{data.contracts.length ? <span className="num"> ({n(data.contracts.length)})</span> : null}</summary><ContractsCard d={data} lang={lang} /></details>
          <details className="md-fold" data-testid="md-fold-tiers"><summary>{ar ? "عملائي حسب التصنيف" : "My customers by tier"}</summary><TiersCard d={data} lang={lang} /></details>
          <details className="md-fold" data-testid="md-fold-growing"><summary>{ar ? "ينمون معك" : "Growing with you"}</summary><GrowingCard d={data} lang={lang} /></details>
        </div>
        {quick}
      </div>
    );
  }

  return (
    <div className="pg">
      <div className="md" data-testid="md-page">
        {banner}
        {introBar}
        {flashBar}
        {hello}
        {empty ? <NoBookNotice lang={lang} /> : null}
        <TargetCard d={data} lang={lang} who={who} />
        <div className="md-grid2">
          <CallCard d={data} lang={lang} items={shown} total={listed} all={full} onAll={() => setAll((v) => !v)} ro={ro} empty={empty}
            filter={filter} onFilter={setFilter} onDone={openLog} onSnooze={snooze} />
          <div className="md-stack">
            <DealsCard d={data} lang={lang} />
            <GrowingCard d={data} lang={lang} />
          </div>
        </div>
        <div className="md-grid3">
          <TiersCard d={data} lang={lang} />
          <CustomersCard d={data} lang={lang} />
          <ContractsCard d={data} lang={lang} />
        </div>
      </div>
      {quick}
    </div>
  );
}

// ── Cards ────────────────────────────────────────────────────────────────────────────────────

function Card({ title, link, testId, children }: { title: ReactNode; link?: ReactNode; testId: string; children: ReactNode }) {
  return (
    <section className="md-card" data-testid={testId} aria-label={typeof title === "string" ? title : undefined}>
      <div className="md-h"><h2>{title}</h2>{link}</div>
      {children}
    </section>
  );
}

function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return <div className="md-empty" data-testid="md-empty">{children}{action}</div>;
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
    return <span className="md-pill sig" data-testid="md-streak">🔥 {streakText(d.target.streakWeeks, lang, third)}</span>;
  }
  if (d.target.newBest) return <span className="md-pill ok" data-testid="md-best">🏆 {third ? (ar ? "هذا أفضل شهر له" : "Their best month yet") : ar ? "هذا أفضل شهر لك" : "Your best month yet"}</span>;
  return null;
}

/** `who`: the rep's first name when a manager reads the day (third person, council fix round 2 item 8); null = «لك». */
function TargetCard({ d, lang, compact, who }: { d: Day; lang: Lang; compact?: boolean; who: string | null }) {
  const ar = lang === "ar";
  const third = who !== null;
  const t = d.target;
  const month = monthName(t.month, lang);
  const title = ar ? `هدف ${month} (التحصيل)` : `${month} target (collections)`;
  if (t.target === null) {
    return (
      <Card title={title} testId="md-target" link={<Link className="lk" href="/dashboard/sales/my-commissions">{ar ? "هدفي وعمولتي" : "My target"}</Link>}>
        <Empty>{third ? (ar ? <>ما فيه هدف مسجّل لـ<bdi>{who}</bdi> هذا الشهر.</> : <>No target is set for <bdi>{who}</bdi> this month.</>)
          : ar ? "ما فيه هدف مسجّل لك هذا الشهر — اطلب من مديرك يحدد هدفك." : "No target is set for you this month — ask your manager to set one."}</Empty>
      </Card>
    );
  }
  const pct = Number(t.percent ?? 0);
  const width = Math.max(0, Math.min(100, pct));
  const remain = Number(t.remaining ?? 0);
  const left = days(t.daysLeft, lang);
  const sub = t.met
    ? (third ? (ar ? <>وصل <bdi>{who}</bdi> الهدف 👏</> : <><bdi>{who}</bdi> reached the target</>) : ar ? "وصلت الهدف 👏 كل ريال تحصّله الحين زيادة لك" : "Target reached — every riyal now is extra")
    : third ? (ar ? <>باقي لـ<bdi>{who}</bdi> <b className="num" style={{ color: "var(--text-primary)" }}>{n(remain)}</b> ريال يوصل الهدف · باقي {left}</>
      : <>SAR <b className="num">{n(remain)}</b> for <bdi>{who}</bdi> to go · {left} left</>)
    : ar ? <>باقي لك <b className="num" style={{ color: "var(--text-primary)" }}>{n(remain)}</b> ريال توصل الهدف · باقي {left}</>
      : <>SAR <b className="num">{n(remain)}</b> to go · {left} left</>;
  if (compact) {
    return (
      <Card title={ar ? `هدف ${month}` : `${month} target`} testId="md-target" link={<span className="num" style={{ fontWeight: 600 }}>{n(pct, 0)}%</span>}>
        <div className="md-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(width)} aria-label={title}><i style={{ width: `${width}%` }} /></div>
        <p className="md-note">{ar ? <>باقي{third ? <> لـ<bdi>{who}</bdi></> : null} <b className="num" style={{ color: "var(--text-primary)" }}>{n(remain)}</b> ريال · باقي {left}</> : <>SAR {n(remain)} to go · {left} left</>}</p>
        {t.commissionVisible ? (
          <div className="md-kv2" data-testid="md-commission-phone">
            <span data-testid="md-accrued">{ar ? (third ? "عمولته المستحقة" : "عمولتك المستحقة") : "Accrued"} <b className="num">{n(t.accrued ?? 0)}</b> {ar ? "ريال" : "SAR"}</span>
            <span data-testid="md-estimate">{ar ? (third ? "متوقعة لو وصل الهدف" : "متوقعة لو وصلت الهدف") : third ? "If the target is reached" : "If you reach the target"} <b className="num">{t.estimate === null ? "—" : n(t.estimate)}</b>{t.estimate === null ? null : <> {ar ? "ريال" : "SAR"}</>} · <em>{ar ? "تقدير" : "estimate"}</em></span>
          </div>
        ) : null}
      </Card>
    );
  }
  return (
    <section className="md-card" data-testid="md-target" aria-label={title}>
      <div className="md-target">
        <div style={{ display: "grid", gap: 8 }}>
          <div className="md-h"><h2>{title}</h2><span className="num" style={{ fontWeight: 600, fontSize: 18 }} data-testid="md-target-pct">{n(pct, 0)}%</span></div>
          <div className="md-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(width)} aria-label={title}><i style={{ width: `${width}%` }} /></div>
          <p className="md-note">{sub}</p>
          <p className="md-note">{ar ? <>{third ? <>حصّل <bdi>{who}</bdi></> : "حصّلت"} <bdi className="num">{n(t.achieved)}</bdi> من <bdi className="num">{n(t.target)}</bdi> ريال (قبل الضريبة)</> : <>Collected SAR {n(t.achieved)} of {n(t.target)} (before VAT)</>}</p>
        </div>
        {t.commissionVisible ? (
          <>
            <div className="md-kv" data-testid="md-accrued">
              <small>{ar ? "عمولة مستحقة" : "Accrued commission"}</small>
              <span className="big">{n(t.accrued ?? 0)}</span>
              <small>{ar ? (third ? "ريال، محسوبة على اللي حصّله" : "ريال، محسوبة على اللي حصّلته") : "SAR, on what was collected"}</small>
            </div>
            <div className="md-kv" data-testid="md-estimate">
              <small>{ar ? (third ? "متوقعة لو وصل الهدف" : "متوقعة لو وصلت الهدف") : third ? "If the target is reached" : "If you reach the target"}</small>
              <span className="big sig">{t.estimate === null ? "—" : n(t.estimate)}</span>
              <small>{t.estimate === null
                ? (ar ? (t.hasPlan ? "تقدير غير متاح" : "ما عندك خطة عمولة") : (t.hasPlan ? "Estimate unavailable" : "No commission plan"))
                : ar ? `ريال، تقدير${t.estimateDiscretionary ? " · مكافأة الهدف تخضع لقرار الإدارة" : ""}` : `SAR, estimate${t.estimateDiscretionary ? " · the target bonus is a management decision" : ""}`}</small>
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}

function CallActions({ item, lang, ro, onDone, onSnooze }: { item: CallItem; lang: Lang; ro: boolean; onDone: (i: CallItem, kind?: "CALL" | "WHATSAPP") => void; onSnooze: (i: CallItem) => void; phone?: boolean }) {
  const ar = lang === "ar";
  const tel = telHref(item.phone);
  const wa = waNumber(item.phone);
  const nm = nameOf(item, ar);
  return (
    <div className="md-acts">
      {/* 📞 / 💬 call or open WhatsApp AND open the same log dialog as the customer page (council fix round 1). */}
      {tel ? <a className="md-ic" href={tel} onClick={() => { if (!ro) onDone(item, "CALL"); }} aria-label={ar ? `اتصل بـ ${nm}` : `Call ${nm}`} title={ar ? "اتصال" : "Call"} data-testid="md-call">📞</a> : null}
      {wa ? <a className="md-ic" href={`https://wa.me/${wa}`} target="_blank" rel="noopener noreferrer" onClick={() => { if (!ro) onDone(item, "WHATSAPP"); }} aria-label={ar ? `واتساب ${nm}` : `WhatsApp ${nm}`} title={ar ? "واتساب" : "WhatsApp"} data-testid="md-wa">💬</a> : null}
      {!ro && item.reason.code !== "CALLED" ? <button type="button" className="md-ic done" onClick={() => onDone(item)} aria-label={ar ? `سجّل التواصل مع ${nm}` : `Log contact with ${nm}`} title={ar ? "تم — سجّل" : "Done — log it"} data-testid="md-done">✓</button> : null}
      {!ro && item.customerId && item.reason.code !== "CALLED" ? <button type="button" className="md-ic" onClick={() => onSnooze(item)} aria-label={ar ? `أجّل ${nm} لبكرة` : `Snooze ${nm} until tomorrow`} title={ar ? "أجّل لبكرة" : "Tomorrow"} data-testid="md-snooze">⏰</button> : null}
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
      <div className="md-who">
        <b>{href ? <Link href={href}><bdi>{nm}</bdi></Link> : <bdi>{nm}</bdi>} <span className={`md-pill ${pill.tone}`}>{pill.text}</span></b>
        <span className="md-why">{whyLine(item, lang, ro)}</span>
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
    <Card title={ar ? "كلّمهم اليوم" : "Call them today"} link={link} testId="md-calls">
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
          : <Empty action={<Link className="btn sm" href="/dashboard/customers">{ar ? "افتح عملائي" : "Open my customers"}</Link>}>{ar ? "ما فيه أحد لازم تكلمه اليوم 👌 كل عملائك على موعدهم. تقدر تمر على عملائك أو تسجّل زيارة." : "Nobody needs a call today — every account is on track."}</Empty>)
          : items.map((it) => phone
            ? <SwipeRow key={it.key} item={it} lang={lang} ro={ro} onDone={onDone} onSnooze={onSnooze} />
            : <CallRow key={it.key} item={it} lang={lang} ro={ro} onDone={onDone} onSnooze={onSnooze} />)}
    </Card>
  );
}

function DealsCard({ d, lang }: { d: Day; lang: Lang }) {
  const ar = lang === "ar";
  return (
    <Card title={ar ? "صفقات في التفاوض" : "Deals in negotiation"} testId="md-deals" link={<Link className="lk" href="/dashboard/sales/pipeline">{ar ? "صفقاتي" : "My deals"}</Link>}>
      {d.deals.length === 0
        ? <Empty action={<Link className="btn sm" href="/dashboard/sales/quotes/new">{ar ? "عرض سعر جديد" : "New quotation"}</Link>}>{ar ? "ما عندك صفقات في التفاوض الحين. أرسل عرض سعر لعميل مهتم وتطلع هنا." : "No deals in negotiation. Send a quotation to an interested customer."}</Empty>
        : d.deals.slice(0, 6).map((x) => (
          <div className="md-mini" key={x.id} data-testid="md-deal">
            <Link href={`/dashboard/sales/deals/${x.id}`}><bdi>{x.customerName ? (ar ? x.customerNameAr || x.customerName : x.customerName) : x.title}</bdi> <span className="sub">· {ar ? x.stageAr : x.stageEn}</span></Link>
            <span className="num">{n(x.amount)} <span className="sub">{ar ? "ريال" : "SAR"}</span></span>
          </div>
        ))}
    </Card>
  );
}

function GrowingCard({ d, lang }: { d: Day; lang: Lang }) {
  const ar = lang === "ar";
  return (
    <Card title={ar ? "ينمون معك 📈" : "Growing with you 📈"} testId="md-growing">
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
            <div className="md-tiers" style={{ display: "grid", gap: 8 }}>
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
          <div className="md-mini"><span>{ar ? "نشطين" : "Active"}</span><b className="num" data-testid="md-count-active">{n(c.active)}</b></div>
          <div className="md-mini"><span>{ar ? "يتفاوضون" : "Negotiating"}</span><b className="num">{n(c.negotiating)}</b></div>
          <div className="md-mini"><span>{ar ? "متوقفين" : "Stopped"}</span><b className="num" style={c.stopped ? { color: "var(--status-danger)" } : undefined}>{n(c.stopped)}</b></div>
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

