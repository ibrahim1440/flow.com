"use client";

/**
 * «يومي» D11 — the sales bar (owner-approved Figma 1JbZgpMqmPkUVne8ms9Ozz page 1843:2: A 1859:790, C1–C3, D, E 1859:1757,
 * F 1859:1843, G 1859:1300, Desk-A 1852:528, Desk-B 1852:814; notes 1861:898). Every figure comes from GET /api/sales/my-day
 * (services/sales/my-day/sales-bar.ts): one bar, two layers against the month's target — sales light, COLLECTED solid and
 * the headline. Stages 0→100 %, 100→120, 120→150, then full; the end label shows the next stage's bonus from the plan.
 * «met» and the celebration follow collected only. Two cards: «عمولة مستحقة · على اللي انحصّل» and «عند العملاء» (sheet E
 * on a phone, a 440 side panel on a desktop). Tapping collected opens its breakdown (F).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { Ico } from "@/components/shell/icons";
import { useTrap } from "@/components/shell/QuickJump";
import { days, monthName, n, telHref, waNumber, type Lang } from "./text";

type Bonus = { kind: "FIXED" | "DISCRETIONARY"; amount: string | null } | null;
export type OwedCustomer = { customerId: string; name: string; nameAr: string | null; phone: string | null; net: string; gross: string; fullNet: string; sharePct: number; invoices: number; oldestDays: number };
export type BandTarget = {
  month: string; target: string | null; achieved: string; percent: string | null; met: boolean | null; daysLeft: number;
  commissionVisible: boolean; accrued: string | null;
  sales: string;
  bar: {
    stage: { index: 0 | 1 | 2 | 3; from: number; to: number | null };
    collectedPct: string; salesPct: string; collectedWidth: number; salesWidth: number; pace: number | null;
    next: { percent: number; remaining: string; perDay: string | null; bonus: Bonus } | null;
    reachedBonus: Bonus; invoicedNotCollected: boolean;
  } | null;
  owed: { net: string; gross: string; invoices: number; monthNet?: string; customers: OwedCustomer[] };
  drafts: { amount: string; count: number };
  breakdown: { fromMonth: string; fromBefore: string; advances: string; total: string };
};
export type LogTarget = { customerId: string; name: string; nameAr: string | null; phone: string | null };

const sar = (ar: boolean) => (ar ? "ر.س" : "SAR");
/** D13's «متأخر X / ماشي صح» line under the bar — hidden for now by the owner (8 Nov 2026); flip to show it again. */
const SHOW_PACE: boolean = false;
/** «120%» inside an Arabic sentence: an LRM keeps the sign after the number (as the Figma text does). */
const pc = (v: number | string) => `\u200E${v}%`;

function bonusText(b: Bonus, ar: boolean): string | null {
  if (!b) return null;
  if (b.kind === "DISCRETIONARY") return ar ? "مكافأة بقرار الإدارة" : "bonus at management's discretion";
  return ar ? `مكافأة ${n(b.amount ?? 0)}` : `bonus ${n(b.amount ?? 0)}`;
}

/** The first time collected crosses 100 / 120 / 150 % this month: once per stage, on this device (a convenience only). */
function useCelebration(key: string | null): boolean {
  // Read once when the bar mounts (it mounts with its data); marked seen afterwards, so a reload does not repeat it.
  const [show] = useState(() => {
    if (!key || typeof window === "undefined") return false;
    try { return window.localStorage.getItem(key) !== "1"; } catch { return true; }
  });
  useEffect(() => {
    if (!key || !show) return;
    try { window.localStorage.setItem(key, "1"); } catch { /* private window */ }
  }, [key, show]);
  return show;
}

export function SalesBand({ t, lang, who, phone, ro, viewerId, onLog, weekGoals }: {
  t: BandTarget; lang: Lang; who: string | null; phone: boolean; ro: boolean; viewerId: string;
  onLog: (c: LogTarget, kind: "CALL" | "WHATSAPP") => void;
  /** D16 gate («أبو فهد»): the supervisor's targets of this week («زيارات 9 من 15 · …») — shown instead of «ما فيه هدف»
   *  when there is no monthly target but there are weekly ones. */
  weekGoals?: string | null;
}) {
  const ar = lang === "ar";
  const third = who !== null;
  const month = monthName(t.month, lang);
  const [open, setOpen] = useState<null | "owed" | "breakdown">(null);
  const bar = t.bar;
  const celebrate = useCelebration(bar && bar.stage.index >= 1 && !ro ? `hq.mdStage.v1.${viewerId}.${t.month}.${bar.stage.index}` : null);

  const cards = (
    <div className="md-sb-cards">
      {t.commissionVisible ? (
        <div className="md-sb-card" data-testid="md-accrued">
          <small>{ar ? "عمولة مستحقة" : "Accrued commission"}</small>
          <span className="md-sb-val"><b className="num">{n(t.accrued ?? 0)}</b> {sar(ar)}</span>
          <small>{ar ? "على اللي انحصّل" : "on what was collected"}</small>
          {bar?.reachedBonus?.kind === "FIXED" ? (
            <em data-testid="md-accrued-bonus">{ar ? <>فيها مكافأة {bar.stage.index === 3 ? "المرحلة" : "الهدف"} <bdi className="num">{n(bar.reachedBonus.amount ?? 0)}</bdi></> : <>incl. a <bdi className="num">{n(bar.reachedBonus.amount ?? 0)}</bdi> bonus</>}</em>
          ) : null}
        </div>
      ) : null}
      {t.owed.invoices > 0 ? (
        <button type="button" className="md-sb-card is-btn" onClick={() => setOpen("owed")} data-testid="md-owed" aria-haspopup="dialog">
          <small>{ar ? "عند العملاء" : "Owed by customers"}</small>
          <span className="md-sb-val"><b className="num">{n(t.owed.net)}</b> {sar(ar)}</span>
          {/* D13 (owner, 8 Nov): every month's open invoices, and how much of it is this month's. */}
          <small data-testid="md-owed-sub">{ar ? <>كل الأشهر{Number(t.owed.monthNet ?? 0) > 0 ? <> · منها <bdi className="num">{n(t.owed.monthNet ?? 0)}</bdi> من هالشهر</> : null} ←</> : <>All months{Number(t.owed.monthNet ?? 0) > 0 ? <> · SAR <bdi className="num">{n(t.owed.monthNet ?? 0)}</bdi> from this month</> : null} →</>}</small>
        </button>
      ) : (
        <div className="md-sb-card" data-testid="md-owed">
          <small>{ar ? "عند العملاء" : "Owed by customers"}</small>
          <span className="md-sb-val"><b className="num">0</b> {sar(ar)}</span>
          <small>{ar ? "ما فيه فواتير مفتوحة" : "No open invoices"}</small>
        </div>
      )}
    </div>
  );


  const sheets = (
    <>
      {open === "owed" ? <OwedSheet t={t} lang={lang} phone={phone} ro={ro} onLog={onLog} onClose={() => setOpen(null)} /> : null}
      {open === "breakdown" ? <BreakdownSheet t={t} lang={lang} phone={phone} onClose={() => setOpen(null)} /> : null}
    </>
  );

  // G — no target this month: one message, «هدفي وعمولتي», the two cards.
  if (t.target === null || !bar) {
    const quiet = Number(t.achieved) === 0 && Number(t.sales) === 0;
    return (
      <>
      <section className="md-sb is-empty" data-testid="md-target" aria-label={ar ? `هدف ${month}` : `${month} target`}>
        <div className="md-sb-main">
          <span className="md-sb-lbl">{ar ? `هدف ${month}` : `${month} target`}</span>
          {weekGoals && !third ? (
            <p className="md-sb-msg" data-testid="md-week-targets">{ar ? "أهداف هالأسبوع من مشرفك: " : "This week's targets from your supervisor: "}<bdi>{weekGoals}</bdi> <Link href="/dashboard/my-day?tab=plan">{ar ? "خطتي ←" : "My plan →"}</Link></p>
          ) : (
          <p className="md-sb-msg" data-testid="md-no-target">{third ? (ar ? <>ما فيه هدف مسجّل لـ<bdi>{who}</bdi> هذا الشهر.</> : <>No target is set for <bdi>{who}</bdi> this month.</>)
            : ar ? "ما فيه هدف مسجّل لك هذا الشهر — اطلب من مديرك يحدد هدفك." : "No target is set for you this month — ask your manager to set one."}</p>
          )}
          {quiet ? <p className="md-sb-sub">{ar ? "ولا فيه مبيعات أو تحصيل بعد. أول فاتورة تصدر لك وأول تحصيل ينعتمد يطلعون هنا." : "No sales or collections yet. Your first issued invoice and first approved collection will show here."}</p>
            : <p className="md-sb-sub">{ar ? <>المحصّل <bdi className="num">{n(t.achieved)}</bdi> ر.س · مبيعات {month} <bdi className="num">{n(t.sales)}</bdi> ر.س</> : <>Collected SAR <bdi className="num">{n(t.achieved)}</bdi> · {month} sales SAR <bdi className="num">{n(t.sales)}</bdi></>}</p>}
          <Link className="md-sb-link" href="/dashboard/sales/my-commissions">{ar ? "هدفي وعمولتي ←" : "My target and commission →"}</Link>
        </div>
        <div className="md-sb-side">{cards}</div>
      </section>
      {sheets}
      </>
    );
  }

  const stage = bar.stage;
  const top = stage.index === 3;
  const nextBonus = bar.next ? bonusText(bar.next.bonus, ar) : null;
  const target = Number(t.target);
  // The pace tick: where the month says you should be today — only inside the current stage (in practice stage 1).
  const paceAmount = bar.pace !== null && stage.to !== null ? Math.round(((stage.from + bar.pace * (stage.to - stage.from)) / 100) * target) : null;
  // The owner (8 Nov, later): no «0» at the start of the first stage; a later stage still shows the one it opened from.
  const startLabel = stage.index === 0 ? "" : `✓ ${pc(stage.from)}`;
  // How far the collected is from today's pace (positive = behind), rounded to the riyal; none outside the stage's pace.
  const gap = paceAmount !== null ? Math.round(paceAmount - Number(t.achieved)) : null;
  // The owner (8 Nov): the end label is the stage's percent only — no bonus text (the line below says the bonus).
  const endLabel = top ? (ar ? "+150%" : "150%+") : `${stage.to}%`;
  const aria = ar
    ? `المحصّل ${pc(n(bar.collectedPct, 0))} من الهدف، المرحلة ${stage.index + 1} من 4`
    : `Collected ${n(bar.collectedPct, 0)}% of the target, stage ${stage.index + 1} of 4`;

  return (
    <>
    <section className="md-sb" data-testid="md-target" data-stage={stage.index} aria-label={ar ? `هدف ${month}` : `${month} target`}>
      <div className="md-sb-main">
        <span className="md-sb-lbl">{ar ? <>هدف {month} · <bdi className="num">{n(target)}</bdi> ر.س{phone ? null : " قبل الضريبة"}</> : <>{month} target · SAR <bdi className="num">{n(target)}</bdi>{phone ? null : " before VAT"}</>}</span>
        <div className="md-sb-figs">
          <button type="button" className="md-sb-col" onClick={() => setOpen("breakdown")} data-testid="md-collected" aria-haspopup="dialog"
            aria-label={ar ? "تفصيل المحصّل" : "Collected breakdown"}>
            {/* D13 (owner, 8 Nov): one figure, one percent — what was collected (the only one the bonus counts). */}
            <span className="md-sb-key">{ar ? (third ? "حصّل" : "حصّلت") : "Collected"}</span>
            <span className="md-sb-head">
              <b className="num" data-testid="md-target-achieved">{n(t.achieved)}</b>
              <span>{sar(ar)}</span>
              <span className="md-sb-chev" aria-hidden>›</span>
            </span>
          </button>
          <bdi className="num md-sb-pct" dir="ltr" data-testid="md-target-pct">{n(bar.collectedPct, 0)}%</bdi>
        </div>

        {celebrate && stage.index >= 1 ? (
          <div className="md-sb-party" role="status" data-testid="md-celebrate">
            <span className="md-sb-pill">✓ {top
              ? (ar ? <>فوق {pc(150)} · {third ? "أخذ" : "أخذت"} أعلى {bonusText(bar.reachedBonus, ar) ?? "مكافأة"}</> : <>Above 150% · the top bonus</>)
              : (ar ? <>مبروك! {third ? "حصّل" : "حصّلت"} {stage.index === 1 ? `هدف ${month}` : pc(stage.from)}{bar.reachedBonus?.kind === "FIXED" ? <> · مكافأة <bdi className="num">{n(bar.reachedBonus.amount ?? 0)}</bdi> انضافت</> : null}</> : <>Well done! {stage.from}% collected</>)}</span>
            {!top ? <small>{ar ? `الشريط انفتح على المرحلة الجاية: من ${pc(stage.from)} إلى ${pc(stage.to!)}` : `The bar opened on the next stage: ${stage.from}% to ${stage.to}%`}</small> : null}
          </div>
        ) : top ? (
          <span className="md-sb-pill" data-testid="md-top">✓ {ar ? <>فوق {pc(150)} · {third ? "أخذ" : "أخذت"} أعلى {bonusText(bar.reachedBonus, ar) ?? "مكافأة"}</> : <>Above 150% · the top bonus</>}</span>
        ) : null}
        {stage.index >= 1 && !top ? <span className="md-sb-badge" data-testid="md-next-stage">{ar ? `المرحلة الجاية ${pc(stage.to!)}` : `Next stage ${stage.to}%`}{nextBonus ? ` · ${nextBonus}` : ""}</span> : null}

        {bar.invoicedNotCollected ? (
          <div className="md-sb-warn" role="note" data-testid="md-invoiced-warning">
            <b>{ar ? (third ? "فوتر هدفه، بس المكافأة لسا ما تحققت" : "فوترت هدفك، بس المكافأة لسا ما تحققت") : "Target invoiced — the bonus is not earned yet"}</b>
            <span>{ar ? <>المكافأة على المحصّل: لازم المحصّل يوصل {pc(100)}{bar.next?.bonus?.kind === "FIXED" ? <> عشان {third ? "ياخذ" : "تاخذ"} <bdi className="num">{n(bar.next.bonus.amount ?? 0)}</bdi></> : null}</> : "The bonus follows collections: collected must reach 100%."}</span>
          </div>
        ) : null}

        <div className="md-sb-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Number(bar.collectedPct))}
          aria-valuetext={aria} aria-label={aria} data-testid="md-bar">
          <div className="md-sb-track">
            <i className="solid" style={{ width: `${bar.collectedWidth * 100}%` }} data-testid="md-bar-collected" />
          </div>
          <div className="md-sb-ends"><bdi className="num" dir={ar ? "rtl" : "ltr"}>{startLabel}</bdi><bdi className="num" dir="ltr" data-testid="md-bar-end">{endLabel}</bdi></div>
        </div>
        {/* D13: where the month says the rep should be today, as a sentence (the bar's tick replaced). */}
        {/* The owner (8 Nov, later): the pace sentence is hidden for now (SHOW_PACE). */}
        {SHOW_PACE && gap !== null ? (gap > 0
          ? <p className="md-sb-paceline is-late" data-testid="md-pace">⚠️ {ar ? <>متأخر <bdi className="num">{n(gap)}</bdi> ر.س عن المفروض لليوم</> : <>SAR <bdi className="num">{n(gap)}</bdi> behind today&apos;s pace</>}</p>
          : <p className="md-sb-paceline is-ok" data-testid="md-pace">✓ {ar ? <>ماشي صح{gap < 0 ? <> · متقدم <bdi className="num">{n(-gap)}</bdi> ر.س</> : null}</> : <>On pace{gap < 0 ? <> · SAR <bdi className="num">{n(-gap)}</bdi> ahead</> : null}</>}</p>) : null}

        {bar.next ? (
          <>
            <p className="md-sb-next" data-testid="md-next">{ar
              ? <>باقي {third ? "يحصّل" : "تحصّل"} <bdi className="num">{n(bar.next.remaining)}</bdi> ر.س {nextBonus ? <>و{third ? "ياخذ" : "تاخذ"} {nextBonus}</> : <>{third ? "يوصل" : "توصل"} {pc(bar.next.percent)}</>}</>
              : <>SAR <bdi className="num">{n(bar.next.remaining)}</bdi> to collect {nextBonus ? <>for a {nextBonus}</> : <>to reach {bar.next.percent}%</>}</>}</p>
            <p className="md-sb-sub">{ar
              ? <>باقي {days(t.daysLeft, lang)}{bar.next.perDay !== null ? <> · {third ? "يحتاج يحصّل" : "تحتاج تحصّل"} <bdi className="num">{n(bar.next.perDay)}</bdi> ر.س باليوم</> : null}</>
              : <>{days(t.daysLeft, lang)} left{bar.next.perDay !== null ? <> · SAR <bdi className="num">{n(bar.next.perDay)}</bdi> a day</> : null}</>}</p>
          </>
        ) : (
          <p className="md-sb-next">{ar ? `كل ريال تحصّله الحين يزيد عمولتك — ما فيه مرحلة بعد ${pc(150)}` : "Every riyal collected now adds to your commission — no stage after 150%"}</p>
        )}
        {/* The owner (8 Nov): «بانتظار المحاسب … مسودة» and the before-VAT note are not shown on the band. */}
      </div>
      <div className="md-sb-side">{cards}</div>
    </section>
    {sheets}
    </>
  );
}

/** A phone bottom sheet / a desktop side panel (440, Figma Desk-B 1852:1100). */
function Panel({ ar, phone, title, testId, onClose, children, foot }: { ar: boolean; phone: boolean; title: string; testId: string; onClose: () => void; children: ReactNode; foot: ReactNode }) {
  const ref = useTrap(onClose);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { closeRef.current?.focus(); }, []);
  return (
    <div className={phone ? "d21-out-scrim" : "md-sp-scrim"} onClick={onClose}>
      <div ref={ref} className={phone ? "d21-out md-sheet" : "md-sp"} role="dialog" aria-modal="true" aria-label={title} dir={ar ? "rtl" : "ltr"}
        onClick={(e) => e.stopPropagation()} data-testid={testId}>
        {phone ? <span className="d21-out-grab" aria-hidden /> : (
          <button ref={closeRef} type="button" className="md-sp-x" onClick={onClose} aria-label={ar ? "إغلاق" : "Close"}><Ico name="close" small /></button>
        )}
        <div className="md-sheet-body">{children}</div>
        <div className="md-sheet-foot">
          {foot}
          {phone ? <button ref={closeRef} type="button" className="btn" onClick={onClose} data-testid={`${testId}-close`}>{ar ? "إغلاق" : "Close"}</button> : null}
        </div>
      </div>
    </div>
  );
}

function ageTone(d: number) { return d > 30 ? "bad" : d > 14 ? "warn" : "info"; }

function OwedSheet({ t, lang, phone, ro, onLog, onClose }: { t: BandTarget; lang: Lang; phone: boolean; ro: boolean; onLog: (c: LogTarget, kind: "CALL" | "WHATSAPP") => void; onClose: () => void }) {
  const ar = lang === "ar";
  const o = t.owed;
  return (
    <Panel ar={ar} phone={phone} title={ar ? "عند العملاء" : "Owed by customers"} testId="md-owed-sheet" onClose={onClose}
      foot={<Link className="md-sheet-link" href="/dashboard/sales/invoices">{ar ? "كل فواتيري المفتوحة ←" : "All my open invoices →"}</Link>}>
      <div className="md-sheet-head">
        <h2>{ar ? "عند العملاء" : "Owed by customers"}</h2>
        {phone ? <span className="md-sheet-amt"><b className="num">{n(o.net)}</b> {sar(ar)}</span> : null}
      </div>
      <p className="md-sheet-sub">{ar
        ? <><bdi className="num">{n(o.invoices)}</bdi> فواتير صادرة ما انحصّلت · قبل الضريبة{phone ? <> (العملاء يدفعون <bdi className="num">{n(o.gross)}</bdi> ر.س مع الضريبة)</> : null} · الأقدم أول</>
        : <><bdi className="num">{n(o.invoices)}</bdi> issued invoices not collected · before VAT{phone ? <> (customers pay SAR <bdi className="num">{n(o.gross)}</bdi> with VAT)</> : null} · oldest first</>}</p>
      {!phone ? (
        <>
          <div className="md-sp-total"><span>{ar ? "المجموع قبل الضريبة" : "Total before VAT"}</span><span><b className="num">{n(o.net)}</b> {sar(ar)}</span></div>
          <p className="md-sheet-sub">{ar ? <>العملاء يدفعون <bdi className="num">{n(o.gross)}</bdi> ر.س مع الضريبة</> : <>Customers pay SAR <bdi className="num">{n(o.gross)}</bdi> with VAT</>}</p>
        </>
      ) : null}
      <ul className="md-owed-list">
        {o.customers.map((c) => {
          const nm = ar ? c.nameAr || c.name : c.name;
          const tel = telHref(c.phone);
          const wa = waNumber(c.phone);
          const log = { customerId: c.customerId, name: c.name, nameAr: c.nameAr, phone: c.phone };
          return (
            <li key={c.customerId} className="md-owed-row" data-testid="md-owed-row">
              <div className="md-owed-top">
                <Link href={`/dashboard/customers/${c.customerId}`}><b><bdi>{nm}</bdi></b></Link>
                <span className="num">{n(c.net)} {sar(ar)}</span>
              </div>
              <div className="md-owed-meta">
                <span>{ar ? <><bdi className="num">{n(c.invoices)}</bdi> فاتورة</> : <><bdi className="num">{n(c.invoices)}</bdi> {c.invoices === 1 ? "invoice" : "invoices"}</>}</span>
                <span className={`md-pill sq ${ageTone(c.oldestDays)}`}>{ar ? `أقدم فاتورة ${days(c.oldestDays, lang)}` : `Oldest invoice ${days(c.oldestDays, lang)}`}</span>
                {c.sharePct < 100 ? <span className="md-pill sq" data-testid="md-owed-shared">{ar ? <>مشتركة {pc(c.sharePct)} · الكامل <bdi className="num">{n(c.fullNet)}</bdi></> : <>Shared {c.sharePct}% · full <bdi className="num">{n(c.fullNet)}</bdi></>}</span> : null}
              </div>
              <div className="md-owed-acts">
                {tel ? <a className="btn sm" href={tel} onClick={() => { if (!ro) onLog(log, "CALL"); }} data-testid="md-owed-call"><Ico name="phone" small />{ar ? "اتصال" : "Call"}</a> : null}
                {wa ? <a className="btn sm" href={`https://wa.me/${wa}`} target="_blank" rel="noopener noreferrer" onClick={() => { if (!ro) onLog(log, "WHATSAPP"); }} data-testid="md-owed-wa"><Ico name="chat" small />{ar ? "واتساب" : "WhatsApp"}</a> : null}
              </div>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

function BreakdownSheet({ t, lang, phone, onClose }: { t: BandTarget; lang: Lang; phone: boolean; onClose: () => void }) {
  const ar = lang === "ar";
  const b = t.breakdown;
  const month = monthName(t.month, lang);
  const total = Number(b.total);
  const w = (v: string) => (total > 0 ? `${(Number(v) / total) * 100}%` : "0");
  const rows: { key: string; tone: string; title: string; sub: string; v: string }[] = [
    { key: "month", tone: "a", title: ar ? `من فواتير ${month}` : `From ${month} invoices`, sub: ar ? "فواتير صدرت هالشهر وانحصّلت" : "Invoices issued this month and collected", v: b.fromMonth },
    { key: "before", tone: "b", title: ar ? "من فواتير قبل" : "From earlier invoices", sub: ar ? "فواتير الشهور اللي قبل، انحصّلت هالشهر" : "Earlier months' invoices collected this month", v: b.fromBefore },
    { key: "advance", tone: "c", title: ar ? "دفعات مقدمة وأرصدة سابقة" : "Advances & opening balances", sub: ar ? "تحصيل ما انخصص على فاتورة للحين، أو سدّد رصيد قديم" : "Collected, not on an invoice yet, or paying an opening balance", v: b.advances },
  ];
  return (
    <Panel ar={ar} phone={phone} title={ar ? `المحصّل في ${month}` : `Collected in ${month}`} testId="md-breakdown-sheet" onClose={onClose}
      foot={<Link className="md-sheet-link" href="/dashboard/sales/collections">{ar ? "ليش هالرقم؟ الإيصالات ←" : "Why this number? Receipts →"}</Link>}>
      <div className="md-sheet-head">
        <h2>{ar ? `المحصّل في ${month}` : `Collected in ${month}`}</h2>
        <span className="md-sheet-amt"><b className="num" data-testid="md-breakdown-total">{n(b.total)}</b> {sar(ar)}</span>
      </div>
      <p className="md-sheet-sub">{ar ? "قبل الضريبة · هذا الرقم اللي تنحسب عليه عمولتك ومكافأتك" : "Before VAT · the figure your commission and bonus are based on"}</p>
      <div className="md-bd-bar" aria-hidden>{rows.map((r) => <i key={r.key} className={r.tone} style={{ width: w(r.v) }} />)}</div>
      <ul className="md-bd-list">
        {rows.map((r) => (
          <li key={r.key} data-testid={`md-breakdown-${r.key}`}>
            <div><b><i className={`sw ${r.tone}`} aria-hidden />{r.title}</b><small>{r.sub}</small></div>
            <span><b className="num">{n(r.v)}</b> {sar(ar)}</span>
          </li>
        ))}
        <li className="is-total"><div><b>{ar ? "المجموع = المحصّل" : "Total = collected"}</b></div><span><b className="num">{n(b.total)}</b> {sar(ar)}</span></li>
      </ul>
      <p className="md-sheet-sub">{ar ? `الدفعة المقدمة تنتقل تلقائيًا لـ«من فواتير ${month}» أو «قبل» لما تنخصص على فاتورة.` : "An advance moves to an invoice row once it is applied to an invoice."}</p>
    </Panel>
  );
}
