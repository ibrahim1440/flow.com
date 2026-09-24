"use client";

import { useState, useEffect } from "react";
import { TrendingUp, Download } from "lucide-react";
import {
  useLang, ProvisionalBanner, PageHeader, Alert, Card, SectionTitle, EmptyState, Spinner,
  Field, TextInput, Money, Pill, TableWrap, api,
} from "../_components/ui";

/**
 * Sales reports.
 *
 * ── Conversion rate is a cohort rate ──
 * "Leads this month divided by deals this month" measures nothing, because the two sets are
 * unrelated: a lead from March converts in May. The figure here is "of the leads that
 * ARRIVED in this window, how many became deals" — computed from the conversion rows that
 * link the two, which is what those rows exist for. The label says so, because a
 * conversion rate with no stated denominator is a number people quote for years.
 *
 * PROVISIONAL INTERFACE — see the banner.
 */

type Report = {
  periodStart: string;
  periodEnd: string;
  scope: "own" | "all";
  leads: {
    created: number;
    converted: number;
    conversionRatePercent: string;
    newCustomersCreated: number;
    bySource: { source: string; count: number }[];
  };
  pipeline: {
    openCount: number;
    openValue: string;
    byStage: { stageId: string; code: string; nameEn: string; nameAr: string; count: number; value: string }[];
  };
  closed: {
    won: number;
    wonValue: string;
    lost: number;
    lostValue: string;
    winRatePercent: string;
    lostReasons: { reason: string; count: number }[];
  };
  duration: { sampleSize: number; medianDays: number | null; meanDays: number | null };
};

const SOURCE_LABELS: Record<string, { en: string; ar: string }> = {
  WALK_IN: { en: "Walk-in", ar: "زيارة مباشرة" },
  REFERRAL: { en: "Referral", ar: "توصية" },
  PHONE: { en: "Phone", ar: "هاتف" },
  SOCIAL: { en: "Social media", ar: "وسائل التواصل" },
  EXHIBITION: { en: "Exhibition", ar: "معرض" },
  WEBSITE: { en: "Website", ar: "الموقع" },
  OTHER: { en: "Other", ar: "أخرى" },
};

function thisMonth(): string {
  const riyadh = new Date(Date.now() + 3 * 3600_000);
  return `${riyadh.getUTCFullYear()}-${String(riyadh.getUTCMonth() + 1).padStart(2, "0")}`;
}

export default function ReportsPage() {
  const lang = useLang();
  const ar = lang === "ar";

  const [month, setMonth] = useState(thisMonth());
  const [data, setData] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  /**
   * Loads the period.
   *
   * The fetch lives in the effect rather than in a `useCallback` the effect then calls. The
   * lint rule resolves a called callback and sees setState reachable from the effect body;
   * inlining puts the first `await` before any state write, which is the property the rule
   * is actually asking for. Nothing else calls this, so there is nothing to keep callable.
   *
   * `cancelled` guards against a slow response for an old month landing after a newer one.
   */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await api<Report>(`/api/sales/reports?month=${month}`);
      if (cancelled) return;
      if (res.ok) {
        setData(res.data);
        setError("");
      } else {
        setError(res.data.error ?? (ar ? "تعذّر التحميل." : "Could not load."));
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [month, ar]);

  if (loading) return <Spinner />;
  if (!data) return <Alert kind="error">{error}</Alert>;

  const maxStage = Math.max(1, ...data.pipeline.byStage.map((s) => s.count));

  return (
    <div className="space-y-6">
      <ProvisionalBanner />

      <PageHeader
        title={ar ? "تقارير المبيعات" : "Sales reports"}
        subtitle={
          data.scope === "own" ? (
            <span className="text-[11px] text-brown/60 font-semibold">
              {ar ? "أداؤك أنت فقط" : "your own performance only"}
            </span>
          ) : null
        }
        actions={
          <>
            <div className="w-40">
              <Field id="rp-month" label={ar ? "الشهر" : "Month"}>
                <TextInput id="rp-month" type="month" value={month} onChange={setMonth} />
              </Field>
            </div>
            <a
              // A real link rather than a scripted download: the browser handles the file,
              // the Content-Disposition header names it, and it survives JavaScript failing.
              href={`/api/sales/reports?month=${month}&format=csv`}
              download
              data-testid="export-report"
              className="flex items-center gap-1.5 px-4 py-2.5 bg-white border-2 border-border text-charcoal rounded-xl text-sm font-bold hover:border-orange active:scale-[0.98] transition-all"
            >
              <Download size={16} aria-hidden /> {ar ? "تصدير CSV" : "Export CSV"}
            </a>
          </>
        }
      />

      {error && <Alert kind="error" onDismiss={() => setError("")}>{error}</Alert>}

      {/* ── Headline figures ──────────────────────────────────────── */}
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat
          label={ar ? "عملاء محتملون جدد" : "New leads"}
          value={String(data.leads.created)}
          note={
            ar
              ? `${data.leads.converted} تحوّلت`
              : `${data.leads.converted} converted`
          }
          testId="stat-leads"
        />
        <Stat
          label={ar ? "معدّل التحويل" : "Conversion rate"}
          value={`${data.leads.conversionRatePercent}%`}
          note={
            ar
              ? `من العملاء المحتملين الذين وصلوا هذا الشهر (${data.leads.created})`
              : `of the leads that arrived this month (${data.leads.created})`
          }
          testId="stat-conversion"
        />
        <Stat
          label={ar ? "معدّل الكسب" : "Win rate"}
          value={`${data.closed.winRatePercent}%`}
          note={
            ar
              ? `${data.closed.won} مكسوبة · ${data.closed.lost} خاسرة`
              : `${data.closed.won} won · ${data.closed.lost} lost`
          }
          testId="stat-winrate"
        />
        <Stat
          label={ar ? "قيمة المسار المفتوح" : "Open pipeline"}
          value={data.pipeline.openValue}
          note={
            ar ? `${data.pipeline.openCount} صفقة` : `${data.pipeline.openCount} deals`
          }
          money
          testId="stat-pipeline"
        />
      </div>

      <div className="grid lg:grid-cols-2 gap-5 items-start">
        {/* ── Pipeline by stage ──────────────────────────────────── */}
        <Card>
          <SectionTitle>
            <span className="inline-flex items-center gap-1.5">
              <TrendingUp size={14} aria-hidden /> {ar ? "المسار حسب المرحلة" : "Pipeline by stage"}
            </span>
          </SectionTitle>
          {data.pipeline.byStage.length === 0 ? (
            <EmptyState>{ar ? "لا توجد صفقات مفتوحة." : "No open deals."}</EmptyState>
          ) : (
            <ul className="space-y-3" data-testid="stage-breakdown">
              {data.pipeline.byStage.map((s) => (
                <li key={s.stageId}>
                  <div className="flex items-baseline justify-between gap-2 mb-1">
                    <span className="text-sm font-bold text-charcoal">{ar ? s.nameAr : s.nameEn}</span>
                    <span className="text-xs tabular-nums text-brown">
                      {s.count} · <Money value={s.value} />
                    </span>
                  </div>
                  <div className="h-2 bg-cream rounded-full overflow-hidden">
                    <div
                      className="h-full bg-orange rounded-full"
                      style={{ width: `${(s.count / maxStage) * 100}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* ── Lead sources ───────────────────────────────────────── */}
        <Card>
          <SectionTitle>{ar ? "مصادر العملاء المحتملين" : "Lead sources"}</SectionTitle>
          {data.leads.bySource.length === 0 ? (
            <EmptyState>{ar ? "لا يوجد عملاء محتملون هذا الشهر." : "No leads this month."}</EmptyState>
          ) : (
            <TableWrap>
              <table className="w-full text-sm">
                <tbody>
                  {data.leads.bySource.map((s) => (
                    <tr key={s.source} className="border-b border-border last:border-0">
                      <td className="py-2 font-semibold">
                        {ar ? (SOURCE_LABELS[s.source]?.ar ?? s.source) : (SOURCE_LABELS[s.source]?.en ?? s.source)}
                      </td>
                      <td className="py-2 text-end tabular-nums font-bold">{s.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>

        {/* ── Why deals were lost ────────────────────────────────── */}
        <Card>
          <SectionTitle>{ar ? "أسباب الخسارة" : "Why deals were lost"}</SectionTitle>
          {data.closed.lostReasons.length === 0 ? (
            <EmptyState>{ar ? "لم تُخسر صفقات هذا الشهر." : "No deals lost this month."}</EmptyState>
          ) : (
            <ul className="space-y-2" data-testid="lost-reasons">
              {data.closed.lostReasons.map((r, i) => (
                <li key={i} className="flex items-start justify-between gap-3 text-sm">
                  <span className="break-words flex-1">{r.reason}</span>
                  <Pill tone="bad">{r.count}</Pill>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* ── Cycle length ───────────────────────────────────────── */}
        <Card>
          <SectionTitle>{ar ? "طول دورة البيع" : "Sales cycle"}</SectionTitle>
          {data.duration.sampleSize === 0 ? (
            <EmptyState>{ar ? "لم تُغلق صفقات هذا الشهر." : "No deals closed this month."}</EmptyState>
          ) : (
            <dl className="space-y-3 text-sm" data-testid="cycle-stats">
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-xs font-bold text-brown/70">{ar ? "الوسيط" : "Median"}</dt>
                <dd className="text-xl font-extrabold tabular-nums">
                  {data.duration.medianDays} <span className="text-xs font-semibold">{ar ? "يوم" : "days"}</span>
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-xs font-bold text-brown/70">{ar ? "المتوسط" : "Mean"}</dt>
                <dd className="font-bold tabular-nums">
                  {data.duration.meanDays} <span className="text-xs">{ar ? "يوم" : "days"}</span>
                </dd>
              </div>
              <p className="text-[11px] text-brown/60 font-medium pt-1 border-t border-border">
                {ar
                  ? `من ${data.duration.sampleSize} صفقة أُغلقت هذا الشهر. الوسيط مذكور أولاً لأن صفقة واحدة طويلة تجرّ المتوسط إلى رقم لا يعرفه أحد.`
                  : `From ${data.duration.sampleSize} deals closed this month. The median leads because one nine-month deal drags an average nobody recognises.`}
              </p>
            </dl>
          )}
        </Card>
      </div>

      <div className="grid sm:grid-cols-3 gap-4">
        <Stat label={ar ? "قيمة المكسوب" : "Won value"} value={data.closed.wonValue} money testId="stat-won" />
        <Stat label={ar ? "قيمة الخاسر" : "Lost value"} value={data.closed.lostValue} money testId="stat-lost" />
        <Stat
          label={ar ? "عملاء جدد أُنشئوا" : "New customers created"}
          value={String(data.leads.newCustomersCreated)}
          note={ar ? "من تحويل العملاء المحتملين" : "from lead conversion"}
          testId="stat-customers"
        />
      </div>
    </div>
  );
}

function Stat({
  label, value, note, money, testId,
}: {
  label: string; value: string; note?: string; money?: boolean; testId?: string;
}) {
  return (
    <div className="bg-white rounded-2xl border border-border p-4" data-testid={testId}>
      <p className="text-[11px] uppercase font-bold text-brown/60 tracking-wide">{label}</p>
      <p className="text-2xl font-extrabold text-charcoal mt-1 tabular-nums">
        {money ? <Money value={value} /> : value}
      </p>
      {note && <p className="text-[11px] text-brown/60 font-medium mt-1">{note}</p>}
    </div>
  );
}
