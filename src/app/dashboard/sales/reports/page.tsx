"use client";

import { useState, useEffect } from "react";
import { TrendingUp, Download } from "lucide-react";
import {
  useLang, ProvisionalBanner, PageHeader, Alert, Card, SectionTitle, EmptyState, Spinner,
  Money, api, FilterSelect, LEAD_SOURCE_LABELS, num, StatStrip, Stat, monthOptions,
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

// The shared map. This screen used to keep its own, which named WALK_IN "زيارة مباشرة" and
// REFERRAL "توصية" while the list screen called them "زيارة" and "إحالة" — the same source
// under two names, one report apart.
const SOURCE_LABELS = LEAD_SOURCE_LABELS;

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

  /** Counts and percentages in the reader's own numerals. */
  const n = (v: number) => num(v, lang);
  const pct = (raw: string) => {
    // The server sends "36.84"; the trailing ".00" is noise in a headline figure.
    const trimmed = raw.replace(/\.0+$/, "");
    return ar ? `${trimmed}%` : `${trimmed}%`;
  };
  const months = monthOptions(month, lang);
  const currentMonthLabel = months.find((o) => o.value === month)?.label ?? month;

  return (
    <div className="space-y-[18px]">
      <ProvisionalBanner />

      <PageHeader
        title={ar ? "تقارير المبيعات" : "Sales reports"}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <span>{currentMonthLabel}</span>
            <span aria-hidden className="text-oo-border-strong">·</span>
            <span>
              {ar ? "النطاق: " : "scope: "}
              {data.scope === "own" ? (ar ? "أداؤك أنت" : "your own") : (ar ? "كل الفريق" : "the whole team")}
            </span>
            <span aria-hidden className="text-oo-border-strong">·</span>
            <span>{ar ? "الأرقام من صافي المحصّل" : "figures are net collections"}</span>
          </span>
        }
        actions={
          <>
            <FilterSelect
              value={month}
              onChange={setMonth}
              label={ar ? "الشهر" : "Month"}
              width="w-[180px]"
              testId="rp-month"
            >
              {months.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </FilterSelect>
            <a
              // A real link rather than a scripted download: the browser handles the file,
              // the Content-Disposition header names it, and it survives JavaScript failing.
              href={`/api/sales/reports?month=${month}&format=csv`}
              download
              data-testid="export-report"
              className="inline-flex items-center gap-2 rounded-[10px] border border-oo-border-strong bg-oo-bg-default px-[18px] py-[10px] text-[14px] font-medium leading-[22px] text-oo-text-primary transition-colors hover:border-oo-action-primary"
            >
              <Download size={16} aria-hidden /> {ar ? "تصدير CSV" : "Export CSV"}
            </a>
          </>
        }
      />

      {error && <Alert kind="error" onDismiss={() => setError("")}>{error}</Alert>}

      {/* ── Headline figures ──────────────────────────────────────── */}
      <StatStrip>
        <Stat
          label={ar ? "قيمة المسار المفتوح" : "Open pipeline"}
          value={data.pipeline.openValue}
          note={ar ? `${n(data.pipeline.openCount)} صفقة` : `${data.pipeline.openCount} deals`}
          money
          testId="stat-pipeline"
        />
        <Stat
          label={ar ? "معدّل الكسب" : "Win rate"}
          value={pct(data.closed.winRatePercent)}
          note={
            ar
              ? `${n(data.closed.won)} مكسوبة · ${n(data.closed.lost)} خاسرة`
              : `${data.closed.won} won · ${data.closed.lost} lost`
          }
          testId="stat-winrate"
        />
        <Stat
          label={ar ? "متوسط مدة الدورة" : "Median cycle"}
          value={
            data.duration.medianDays === null
              ? "—"
              : ar
                ? `${n(data.duration.medianDays)} يوماً`
                : `${data.duration.medianDays} days`
          }
          note={ar ? "من الإنشاء إلى الإغلاق" : "from creation to close"}
          testId="stat-cycle"
        />
        <Stat
          label={ar ? "نسبة التحويل" : "Conversion rate"}
          value={pct(data.leads.conversionRatePercent)}
          note={
            ar
              ? `من عميل محتمل إلى صفقة · ${n(data.leads.created)} وصلوا`
              : `from lead to deal · ${data.leads.created} arrived`
          }
          testId="stat-conversion"
        />
      </StatStrip>

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
            // The design draws this as label, track, count on one line. The track's fill
            // starts at the reading edge — the right in Arabic — so a longer bar grows the
            // way the eye already travels.
            <ul className="space-y-2.5" data-testid="stage-breakdown">
              {data.pipeline.byStage.map((s) => (
                <li key={s.stageId} className="flex items-center gap-3">
                  <span className="w-[90px] shrink-0 text-[14px] leading-[22px] text-oo-text-primary">
                    {ar ? s.nameAr : s.nameEn}
                  </span>
                  <div className="h-[10px] flex-1 overflow-hidden rounded-[10px] bg-oo-bg-subtle">
                    <div
                      className="h-[10px] bg-oo-status-preparing"
                      style={{ width: `${(s.count / maxStage) * 100}%` }}
                    />
                  </div>
                  <span className="w-[130px] shrink-0 text-end text-[12px] leading-[18px] text-oo-text-secondary">
                    {n(s.count)} · <Money value={s.value} />
                  </span>
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
            <ul className="space-y-2" data-testid="source-breakdown">
              {data.leads.bySource.map((s) => (
                <li
                  key={s.source}
                  className="flex items-center justify-between rounded-[10px] bg-oo-bg-subtle px-3 py-[9px] text-[14px] leading-[22px] text-oo-text-primary"
                >
                  <span className="tabular-nums font-medium">{n(s.count)}</span>
                  <span>
                    {ar ? (SOURCE_LABELS[s.source]?.ar ?? s.source) : (SOURCE_LABELS[s.source]?.en ?? s.source)}
                  </span>
                </li>
              ))}
            </ul>
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
                <li
                  key={i}
                  className="flex items-start justify-between gap-3 rounded-[10px] bg-oo-bg-subtle px-3 py-[9px] text-[14px] leading-[22px] text-oo-text-primary"
                >
                  <span className="shrink-0 tabular-nums font-medium text-oo-status-rejected">{n(r.count)}</span>
                  <span className="break-words text-end">{r.reason}</span>
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
            <dl className="space-y-2" data-testid="cycle-stats">
              {[
                [ar ? "الوسيط" : "Median", data.duration.medianDays],
                [ar ? "المتوسط" : "Mean", data.duration.meanDays],
              ].map(([label_, days]) => (
                <div
                  key={String(label_)}
                  className="flex items-center justify-between rounded-[10px] bg-oo-bg-subtle px-3 py-[9px] text-[14px] leading-[22px] text-oo-text-primary"
                >
                  <dd className="tabular-nums font-medium">
                    {days === null ? "—" : ar ? `${n(Number(days))} يوماً` : `${days} days`}
                  </dd>
                  <dt>{label_}</dt>
                </div>
              ))}
              <p className="pt-1 text-[12px] leading-[18px] text-oo-text-muted">
                {ar
                  ? `من ${n(data.duration.sampleSize)} صفقة أُغلقت هذا الشهر. الوسيط مذكور أولاً لأن صفقة واحدة طويلة تجرّ المتوسط إلى رقم لا يعرفه أحد.`
                  : `From ${data.duration.sampleSize} deals closed this month. The median leads because one nine-month deal drags an average nobody recognises.`}
              </p>
            </dl>
          )}
        </Card>
      </div>

      <StatStrip>
        <Stat label={ar ? "قيمة المكسوب" : "Won value"} value={data.closed.wonValue} money testId="stat-won" />
        <Stat label={ar ? "قيمة الخاسر" : "Lost value"} value={data.closed.lostValue} money testId="stat-lost" />
        <Stat
          label={ar ? "عملاء محتملون جدد" : "New leads"}
          value={n(data.leads.created)}
          note={ar ? `${n(data.leads.converted)} تحوّلت` : `${data.leads.converted} converted`}
          testId="stat-leads"
        />
        <Stat
          label={ar ? "عملاء جدد أُنشئوا" : "New customers created"}
          value={n(data.leads.newCustomersCreated)}
          note={ar ? "من تحويل العملاء المحتملين" : "from lead conversion"}
          testId="stat-customers"
        />
      </StatStrip>
    </div>
  );
}

