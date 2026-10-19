"use client";

import { useState, useEffect, type ReactNode } from "react";
import { useLang, api, LEAD_SOURCE_LABELS, num, formatMoney, monthOptions } from "../_components/ui";
import { useInitialMonth, PerfHeader, MonthChip, Bar, PerfNote, PerfNotice, PerfLoading, Metrics } from "../_components/perf";
import { usePhone, useD21Phone } from "@/components/shell/page-context";
import Link from "next/link";
import { useUser } from "../../user-context";
import { seesTeamReports } from "@/lib/services/sales/scope";

/**
 * Sales reports — Direction 2.1, GX A-P04 «تقارير المبيعات» (`1222:100243`, EN `1230:124232`,
 * 1024 `1224:4857`, 390 `1432:16498`).
 *
 * ── Conversion rate is a cohort rate ──
 * "Leads this month divided by deals this month" measures nothing, because the two sets are
 * unrelated: a lead from March converts in May. The figure here is "of the leads that
 * ARRIVED in this window, how many became deals" — computed from the conversion rows that
 * link the two, which is what those rows exist for. The label says so, because a
 * conversion rate with no stated denominator is a number people quote for years.
 *
 * Visual port: the same report request and CSV link; nothing is computed here that was not
 * computed before.
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

/**
 * The team's reports are the sales manager's and the admin's (owner decision, batch Sales B).
 * The route guard is module-level, so a rep who types the address is told so here — and the
 * endpoint answers them 403 anyway. Their own figures are on «لوحة الأداء».
 */
export default function ReportsRoute() {
  const user = useUser();
  const lang = useLang();
  const ar = lang === "ar";
  if (!user) return <PerfLoading ar={ar} />;
  if (!seesTeamReports(user.permissions, user.role)) return <NoReports ar={ar} />;
  return <ReportsPage />;
}

function NoReports({ ar }: { ar: boolean }) {
  useD21Phone({ title: ar ? "تقارير المبيعات" : "Sales reports", sub: ar ? "الأداء والعمولات" : "Performance and commissions" });
  return (
    <div className="pg">
      <div style={{ padding: "64px 0", textAlign: "center", display: "grid", gap: 10, justifyItems: "center" }} data-testid="reports-no-access" role="status">
        <p style={{ fontWeight: 600, margin: 0, fontSize: 16 }}>{ar ? "تقارير المبيعات لمدير المبيعات والمسؤول" : "Sales reports are for the sales manager and the admin"}</p>
        <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 13.5 }}>
          {ar ? "أداؤك أنت — المحصّل والهدف والصفقات والعروض — في «لوحة الأداء»." : "Your own performance — collected, target, deals and quotations — is on the performance dashboard."}
        </p>
        <Link className="btn" href="/dashboard/sales/performance" data-testid="reports-go-dashboard">{ar ? "فتح لوحة الأداء" : "Open the performance dashboard"}</Link>
      </div>
    </div>
  );
}

function ReportsPage() {
  const lang = useLang();
  const ar = lang === "ar";
  const phone = usePhone();

  const initialMonth = useInitialMonth();
  const [month, setMonth] = useState(initialMonth);
  const [data, setData] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  /**
   * Loads the period. The fetch lives in the effect (the first `await` precedes every state
   * write); `cancelled` guards against a slow response for an old month landing after a newer one.
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

  if (loading) return <PerfLoading ar={ar} />;
  if (!data) {
    return <div className="pg"><PerfNotice kind="error" ar={ar}>{error}</PerfNotice></div>;
  }

  const maxValue = Math.max(1, ...data.pipeline.byStage.map((s) => Number(s.value)));
  const maxCount = Math.max(1, ...data.pipeline.byStage.map((s) => s.count));
  // Bars by value, as the frame draws them; a stage of zero-value deals still shows its count.
  const allZero = data.pipeline.byStage.every((s) => Number(s.value) === 0);

  /** Counts and percentages in the reader's own numerals. */
  const n = (v: number) => num(v, lang);
  const pct = (raw: string) => `${raw.replace(/\.0+$/, "")}%`;
  const days = (d: number | null) =>
    d === null ? "—" : ar ? `${n(d)} يومًا` : `${d} days`;
  const monthLabel = monthOptions(month, lang).find((o) => o.value === month)?.label ?? month;
  const sourceLabel = (s: string) => (ar ? (SOURCE_LABELS[s]?.ar ?? s) : (SOURCE_LABELS[s]?.en ?? s));

  const actions = (
    <>
      <MonthChip value={month} onChange={setMonth} lang={lang} testId="rp-month" />
      {!phone && (
        <a
          // A real link rather than a scripted download: the browser handles the file,
          // the Content-Disposition header names it, and it survives JavaScript failing.
          href={`/api/sales/reports?month=${month}&format=csv`}
          download
          data-testid="export-report"
          className="btn"
        >
          <svg className="ico s" viewBox="0 0 24 24" aria-hidden><path d="M12 4v11m0 0-4-4m4 4 4-4M5 19h14" /></svg>
          {ar ? "تصدير CSV" : "Export CSV"}
        </a>
      )}
    </>
  );

  const meta = [
    monthLabel,
    <>{ar ? "النطاق: " : "scope: "}{data.scope === "own" ? (ar ? "أداؤك أنت" : "your own") : (ar ? "كل الفريق" : "the whole team")}</>,
  ];

  // Each report exports on its own (`?report=`), beside its title; the header button keeps the
  // whole month in one file. Desktop only, as the header button (390c: export from the desk).
  const sectionHead = (t: string, report?: string, sub?: string) => (
    <div className="bh">
      <h2 className="bt">{t}</h2>{sub && <span className="sub">{sub}</span>}
      {report && !phone && (
        <a className="lk" download data-testid={`export-report-${report}`}
          href={`/api/sales/reports?month=${month}&format=csv&report=${report}`}
          aria-label={ar ? `تصدير «${t}» CSV` : `Export “${t}” as CSV`}>CSV</a>
      )}
    </div>
  );
  const emptyLine = (t: string) => <p className="sm" style={{ color: "var(--text-muted)", fontSize: 13.5, margin: "6px 0" }}>{t}</p>;
  const line = { display: "flex", justifyContent: "space-between", gap: 12, padding: "7px 0", borderBottom: "1px solid var(--border-subtle)", fontSize: 13.5 } as const;

  const stages = data.pipeline.byStage.length === 0 ? emptyLine(ar ? "لا توجد صفقات مفتوحة." : "No open deals.") : (
    <div data-testid="stage-breakdown">
      {data.pipeline.byStage.map((s) => {
        const w = allZero ? (s.count / maxCount) * 100 : (Number(s.value) / maxValue) * 100;
        const figure = <span className="n">{n(s.count)} · {formatMoney(s.value)}</span>;
        return phone ? (
          <div key={s.stageId} style={{ padding: "6px 0" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13.5, marginBottom: 6 }}>
              <span>{ar ? s.nameAr : s.nameEn}</span>{figure}
            </div>
            <Bar percent={w} />
          </div>
        ) : (
          <div key={s.stageId} style={{ display: "grid", gridTemplateColumns: "110px minmax(0,1fr) 150px", gap: 12, alignItems: "center", padding: "6px 0", fontSize: 13.5 }}>
            <span>{ar ? s.nameAr : s.nameEn}</span>
            <Bar percent={w} />
            {/* `.n` is LTR, so «end» is its right edge, as in the frame. */}
            <span className="n" style={{ textAlign: "end" }}>{n(s.count)} · {formatMoney(s.value)}</span>
          </div>
        );
      })}
    </div>
  );

  const sources = data.leads.bySource.length === 0 ? emptyLine(ar ? "لا يوجد عملاء محتملون هذا الشهر." : "No leads this month.") : (
    <div data-testid="source-breakdown">
      {data.leads.bySource.map((s) => (
        <div key={s.source} style={line}><span>{sourceLabel(s.source)}</span><span className="n">{n(s.count)}</span></div>
      ))}
    </div>
  );

  const lost = data.closed.lostReasons.length === 0 ? emptyLine(ar ? "لم تُخسر صفقات هذا الشهر." : "No deals lost this month.") : (
    <div data-testid="lost-reasons">
      {data.closed.lostReasons.map((r, i) => (
        <div key={i} style={{ ...line, justifyContent: "flex-start", gap: 10 }}>
          <span className="n" style={{ color: "var(--status-danger)", minWidth: 18 }}>{n(r.count)}</span>
          <span style={{ overflowWrap: "anywhere" }}>{r.reason}</span>
        </div>
      ))}
    </div>
  );

  const cycle = data.duration.sampleSize === 0 ? emptyLine(ar ? "لم تُغلق صفقات هذا الشهر." : "No deals closed this month.") : (
    <div data-testid="cycle-stats">
      <dl className="props" style={{ gridTemplateColumns: "90px minmax(0,1fr)" }}>
        <dt>{ar ? "الوسيط" : "Median"}</dt><dd>{days(data.duration.medianDays)}</dd>
        <dt>{ar ? "المتوسط" : "Mean"}</dt><dd>{days(data.duration.meanDays)}</dd>
      </dl>
      <p className="sm" style={{ marginTop: 8, fontSize: 12.5, color: "var(--text-muted)" }}>
        {ar
          ? `من ${n(data.duration.sampleSize)} صفقات أُغلقت هذا الشهر. الوسيط أولًا لأن صفقة واحدة طويلة تجرّ المتوسط إلى رقم لا يعرفه أحد.`
          : `From ${data.duration.sampleSize} deals closed this month. The median leads because one nine-month deal drags an average nobody recognises.`}
      </p>
    </div>
  );

  const headline = (
    <Metrics items={[
      {
        label: ar ? "قيمة المسار المفتوح" : "Open pipeline", testId: "stat-pipeline",
        value: <span className="n">{formatMoney(data.pipeline.openValue)}</span>,
        note: ar ? `${n(data.pipeline.openCount)} صفقات` : `${data.pipeline.openCount} deals`,
      },
      {
        label: ar ? "معدّل الكسب" : "Win rate", testId: "stat-winrate",
        value: <span className="n">{pct(data.closed.winRatePercent)}</span>,
        note: ar ? `${n(data.closed.won)} مكسوبة · ${n(data.closed.lost)} خاسرة` : `${data.closed.won} won · ${data.closed.lost} lost`,
      },
      {
        label: ar ? "وسيط مدة الدورة" : "Median cycle", testId: "stat-cycle",
        value: data.duration.medianDays === null ? "—" : (
          <><span className="n">{n(data.duration.medianDays)}</span><span className="unit">{ar ? "يومًا" : "days"}</span></>
        ),
        note: ar ? "من الإنشاء إلى الإغلاق" : "from creation to close",
      },
      {
        label: ar ? "نسبة التحويل" : "Conversion rate", testId: "stat-conversion",
        value: <span className="n">{pct(data.leads.conversionRatePercent)}</span>,
        note: ar ? `من عميل محتمل إلى صفقة · ${n(data.leads.created)} وصلوا` : `from lead to deal · ${data.leads.created} arrived`,
      },
    ]} />
  );

  const closing = (
    <Metrics items={[
      { label: ar ? "قيمة المكسوب" : "Won value", testId: "stat-won", value: <span className="n">{formatMoney(data.closed.wonValue)}</span> },
      { label: ar ? "قيمة الخاسر" : "Lost value", testId: "stat-lost", value: <span className="n">{formatMoney(data.closed.lostValue)}</span> },
      {
        label: ar ? "عملاء محتملون جدد" : "New leads", testId: "stat-leads",
        value: <span className="n">{n(data.leads.created)}</span>,
        note: ar ? `${n(data.leads.converted)} تحوّلت` : `${data.leads.converted} converted`,
      },
      {
        label: ar ? "عملاء جدد أُنشئوا" : "New customers created", testId: "stat-customers",
        value: <span className="n">{n(data.leads.newCustomersCreated)}</span>,
        note: ar ? "من تحويل العملاء المحتملين" : "from lead conversion",
      },
    ]} />
  );

  const pair = (a: ReactNode, b: ReactNode) => (
    <div className="cols perf-cols" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 48 }}>
      <div>{a}</div><div>{b}</div>
    </div>
  );

  return (
    <div className="pg">
      <PerfHeader ar={ar} title={ar ? "الأداء والعمولات" : "Performance and commissions"}
        phoneTitle={ar ? "تقارير المبيعات" : "Sales reports"} meta={meta} actions={actions} />
      <PerfNotice kind="error" ar={ar} onDismiss={() => setError("")}>{error}</PerfNotice>

      <div style={{ margin: "4px 0 28px" }}>{headline}</div>

      {pair(
        <>{sectionHead(ar ? "المسار حسب المرحلة" : "Pipeline by stage", "stages")}{stages}</>,
        <>{sectionHead(ar ? "مصادر العملاء المحتملين" : "Lead sources", "sources")}{sources}</>,
      )}
      <div className="hr" style={{ margin: "28px 0" }} />
      {pair(
        <>{sectionHead(ar ? "أسباب الخسارة" : "Why deals were lost", "lost")}{lost}</>,
        <>{sectionHead(ar ? "طول دورة البيع" : "Sales cycle", "cycle")}{cycle}</>,
      )}
      <div className="hr" style={{ margin: "28px 0" }} />
      <div style={{ margin: "4px 0 28px" }}>{closing}</div>

      <PerfNote>
        <span>
          {ar
            ? "قيم المسار والمكسوب والخاسر قيم صفقات، لا مبالغ محصّلة. التحصيل الفعلي في «التحصيلات» و«الأهداف»."
            : "Pipeline, won and lost values are deal values, not money collected. What was actually collected is in Collections and Targets."}
        </span>
      </PerfNote>
    </div>
  );
}
