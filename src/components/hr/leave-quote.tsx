"use client";
// Leave request preview (M-04 R3): working days and the projected balance, computed by the
// server with the rules a submission must pass (`assessLeave`), shown while the form is
// filled. It is a preview only — the submission is revalidated under the person's lock and
// its refusal, if any, is shown as-is.
import { useEffect, useState } from "react";
import { Notice, days, hrFetch, useHrI18n } from "./ui";
import { MONTHS, WEEKDAYS, WEEKDAYS_SHORT_EN } from "@/lib/i18n/hr";
import type { Lang } from "@/lib/i18n/translations";

export type LeaveQuote = {
  days: number | null; weekendDays: number[] | null; tracksBalance: boolean; allowNegative: boolean;
  balance: string | null; pending: string | null; available: string | null; after: string | null;
  problems: { code: string | null; error: string; errorEn: string }[];
};

const isDay = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);

/** `url` is the quote endpoint (self or HR); `params` null while the form is incomplete. */
export function useLeaveQuote(url: string, params: Record<string, string> | null) {
  const key = params && isDay(params.startDate) && isDay(params.endDate) && params.endDate >= params.startDate && params.leaveTypeId ? new URLSearchParams(params).toString() : null;
  // The answer is kept with the query it answers, so a stale answer is never shown for new dates.
  const [res, setRes] = useState<{ key: string; quote: LeaveQuote | null; ok: boolean } | null>(null);
  // A failed preview (network, 5xx) is retried on demand; it never counts as a refusal (A-16).
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!key) return;
    let live = true;
    const t = setTimeout(() => {
      hrFetch<LeaveQuote>(`${url}?${key}`)
        .then((quote) => { if (live) setRes({ key, quote, ok: true }); })
        .catch(() => { if (live) setRes({ key, quote: null, ok: false }); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [url, key, attempt]);
  const current = key && res?.key === key ? res : null;
  const state: "idle" | "loading" | "ready" | "failed" = !key ? "idle" : !current ? "loading" : current.ok ? "ready" : "failed";
  const quote = current?.quote ?? null;
  // Blocks the submit button only on a refusal the server itself reported; a failed preview
  // never blocks — the server decides at submission.
  const blocking = state === "ready" && !!quote && quote.problems.length > 0;
  const retry = () => { setRes(null); setAttempt((a) => a + 1); };
  const range = key && params ? { start: params.startDate, end: params.endDate } : null;
  return { quote, state, blocking, retry, range };
}

/** Rows for a KV list: days and, for balance-tracked types, the balance after approval. */
export function quoteRows(q: ReturnType<typeof useLeaveQuote>, lang: Lang = "ar"): [string, React.ReactNode, string?][] {
  const { quote, state } = q;
  const L = (ar: string, en: string) => (lang === "en" ? en : ar);
  const pending = state === "loading" ? <span key="l" className="hr-caption">{L("يُحسب…", "Calculating…")}</span> : null;
  const rows: [string, React.ReactNode, string?][] = [
    [L("أيام العمل المحسوبة", "Working days counted"), pending ?? (quote?.days !== null && quote?.days !== undefined ? <span key="d" className="hr-num">{quote.days}</span> : <span key="d" className="hr-caption">—</span>)],
  ];
  if (quote?.tracksBalance && quote.after !== null && quote.available !== null) {
    const after = Number(quote.after);
    rows.push([
      L("الرصيد بعد الاعتماد", "Balance after approval"),
      // A shortfall is worded («عجز»), not shown as a signed number whose minus RTL can move.
      pending ?? (after < 0
        ? <span key="a">{L("عجز", "Short by")} <span className="hr-num">{days(String(-after))}</span> {L("يوم · المتاح", "days · available")} <span className="hr-num">{days(quote.available)}</span></span>
        : <span key="a"><span className="hr-num">{days(quote.after)}</span> {L("من", "of")} <span className="hr-num">{days(quote.available)}</span></span>),
      state === "ready" ? (after < 0 ? "danger" : "success") : undefined,
    ]);
  }
  return rows;
}

const weekdayOf = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };

/**
 * The caption and any refusal under the facts. `refused`: the server has already refused the
 * submission — its own message is shown, so the could-not-verify warning is no longer useful.
 */
export function QuoteNotes({ q, refused }: { q: ReturnType<typeof useLeaveQuote>; refused?: boolean }) {
  const { quote, state } = q;
  const { L, lang, en } = useHrI18n();
  const WD = en ? WEEKDAYS_SHORT_EN : WEEKDAYS.ar;
  // Not a refusal: the rules were not reachable. The request can still be sent; the server
  // revalidates it under the person's lock (A-16).
  if (state === "failed" && refused) return null;
  if (state === "failed") return (
    <Notice tone="warning">
      <span style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span>{L("تعذّر التحقق من الأيام والرصيد الآن. يمكنك الإرسال؛ يتحقق الخادم عند الإرسال.", "Couldn’t check the days and balance right now. You can still submit; the server checks on submission.")}</span>
        <button type="button" className="hr-btn is-sm" onClick={q.retry}>{L("إعادة المحاولة", "Try again")}</button>
      </span>
    </Notice>
  );
  if (state !== "ready" || !quote) return null;
  const weekend = quote.weekendDays?.map((d) => (en ? WEEKDAYS.en[d] : WEEKDAYS.ar[d])).join(en ? " and " : " و");
  // M-04 R3: the caption opens with the selected range's weekdays («الأحد–الثلاثاء ·»).
  const span = q.range ? (q.range.start === q.range.end ? WD[weekdayOf(q.range.start)] : `${WD[weekdayOf(q.range.start)]}–${WD[weekdayOf(q.range.end)]}`) : null;
  // M-04e: on a refusal the caption comes first in its short form, the refusal under it, and
  // the refusal says what to do next.
  if (quote.problems.length) return (
    <>
      <p className="hr-caption" style={{ margin: 0 }}>{L("الأيام تُحسب بسياسة الرواتب السارية", "Days are counted with the active payroll policy")}{weekend ? <> ({L("عطلة", "weekend:")} {weekend})</> : null}.</p>
      <Notice tone="danger">
        {quote.problems.map((p) => <div key={p.errorEn}>{lang === "en" ? p.errorEn : p.error}</div>)}
        <div>{L("عدّل التاريخين أو اختر نوعًا آخر.", "Change the dates or choose another type.")}</div>
      </Notice>
    </>
  );
  return (
    <p className="hr-caption" style={{ margin: 0 }}>
      {span ? <>{span} · </> : null}
      {weekend ? <>{L(`${weekend} عطلة بحسب سياسة الرواتب السارية. `, `${weekend} are the weekend under the active payroll policy. `)}</> : null}
      {quote.pending && Number(quote.pending) > 0 ? <>{L("يُستثنى من الرصيد", "Excluded from the balance:")} <span className="hr-num">{days(quote.pending)}</span> {L("يوم محجوزة لطلبات بانتظار القرار. ", "days reserved for requests awaiting a decision. ")}</> : null}
      {L("يُعاد التحقق عند الإرسال.", "Checked again on submission.")}
    </p>
  );
}

/**
 * «الأحد 8 نوفمبر 2026» / "Sun 8 Nov 2026" from an ISO day — independent of the browser's
 * date-control format (EN: short operational date, EN-VARIANTS).
 */
export function dayLabel(iso: string, lang: Lang = "ar") {
  if (!isDay(iso)) return null;
  const [y, m, d] = iso.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (lang === "en") return `${WEEKDAYS_SHORT_EN[wd]} ${d} ${MONTHS.en[m - 1].slice(0, 3)} ${y}`;
  return `${WEEKDAYS.ar[wd]} ${d} ${MONTHS.ar[m - 1]} ${y}`;
}
export const dayLabelAr = (iso: string) => dayLabel(iso, "ar");

/**
 * The selected range in words, under the native date controls (whose display format follows the
 * device locale, e.g. 11/08/2026). Read-only; announced politely when it changes.
 */
export function DateRangeSummary({ start, end }: { start: string; end: string }) {
  const { L, lang } = useHrI18n();
  const a = dayLabel(start, lang), b = dayLabel(end, lang);
  if (!a || !b) return null;
  const text = end < start ? L("تاريخ النهاية قبل تاريخ البداية.", "The end date is before the start date.") : start === end ? L(`يوم واحد: ${a}`, `One day: ${a}`) : L(`من ${a} إلى ${b} (شاملًا اليومين)`, `${a} to ${b} (both days included)`);
  return <p className="hr-caption hr-date-summary" aria-live="polite" style={{ margin: 0 }}><span className="hr-sr">{L("التواريخ المختارة: ", "Selected dates: ")}</span>{text}</p>;
}

