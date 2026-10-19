"use client";

import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  ResponsiveContainer, ComposedChart, Bar as RBar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from "recharts";
import { Select } from "@/components/ui/Select";
import { useLang, api, num, formatMoney, monthOptions } from "../_components/ui";
import {
  PerfHeader, MonthChip, Bar, PerfNote, PerfNotice, PerfSandbox, PerfLoading, Metrics, useInitialMonth, usePerfOwnView,
} from "../_components/perf";
import { usePhone } from "@/components/shell/page-context";
import { useUser } from "../../user-context";
import { routeAllowed } from "@/lib/nav/registry";
import { seesTeamReports } from "@/lib/services/sales/scope";

/**
 * «لوحة الأداء» — the first tab of «الأداء والعمولات» (GX perf_tabs «dash», the rep's
 * «أهدافي وعمولاتي» too). The frames draw the tab but no body for it; this page is built from
 * the family's own pieces (the metric strips, the stage bars and the closing note of the
 * reports and targets frames) and the approved cumulative/paired chart of the kit.
 *
 * Every figure comes from GET /api/sales/performance; the formulas are written once, in
 * lib/services/sales/performance.ts, and summarised in the note at the foot of the page.
 * A rep sees themselves; whoever sees all sales sees the team, each rep, and can narrow to one.
 */

type Progress = { target: string | null; achieved: string; percent: string | null; remaining: string | null; met: boolean | null };
type Figures = {
  netCollected: string; target: Progress; bonus: string | null;
  won: number; wonValue: string; lost: number; lostValue: string; winRatePercent: string | null;
  openCount: number; openValue: string;
  leadsCreated: number; leadsConverted: number; conversionPercent: string | null;
  quotesIssued: number; quotesAccepted: number; acceptedValue: string;
  commissionAccrued: string | null;
};
type Rep = Figures & { employeeId: string; name: string; active: boolean };
type Payload = {
  month: string; scope: "all" | "own"; teamView: boolean; viewerId: string; commissionVisible: boolean;
  totals: Figures; reps: Rep[];
  pipelineByStage: { stageId: string; code: string; nameEn: string; nameAr: string; count: number; value: string }[];
  trend: { month: string; netCollected: string; target: string | null }[];
  notice: string | null;
};

const TOKEN_DEFAULTS = { primary: "#5c5c38", soft: "#e3dccb", grid: "#efe9dc", muted: "#6e6a61", plan: "#b0662c" };
/** Recharts draws SVG attributes, which cannot read CSS variables: the token values are read
 *  once from the page (the hex values are only the fallback before mount). */
const readTokens = (): string => {
  const cs = getComputedStyle(document.querySelector(".d21") ?? document.documentElement);
  const v = (n: string, d: string) => cs.getPropertyValue(n).trim() || d;
  return JSON.stringify({
    primary: v("--action-primary", TOKEN_DEFAULTS.primary), soft: v("--border-strong", TOKEN_DEFAULTS.soft),
    grid: v("--border-subtle", TOKEN_DEFAULTS.grid), muted: v("--text-muted", TOKEN_DEFAULTS.muted),
    plan: v("--brand-signature", TOKEN_DEFAULTS.plan),
  });
};
function useChartTokens(): typeof TOKEN_DEFAULTS {
  const key = useSyncExternalStore(() => () => {}, readTokens, () => JSON.stringify(TOKEN_DEFAULTS));
  return useMemo(() => JSON.parse(key) as typeof TOKEN_DEFAULTS, [key]);
}

export default function PerformancePage() {
  const lang = useLang();
  const ar = lang === "ar";
  const phone = usePhone();
  const user = useUser();
  const own = usePerfOwnView();
  const tk = useChartTokens();
  const viewer = user ? { permissions: user.permissions, role: user.role } : null;
  const can = (href: string) => !!viewer && routeAllowed(viewer, href);

  const initialMonth = useInitialMonth();
  const askedRep = useSearchParams().get("employeeId");
  const [month, setMonth] = useState(initialMonth);
  const [rep, setRep] = useState<string>(askedRep ?? "");
  const [data, setData] = useState<Payload | null>(null);
  const [team, setTeam] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const q = `month=${month}${rep ? `&employeeId=${encodeURIComponent(rep)}` : ""}`;
      const res = await api<Payload>(`/api/sales/performance?${q}`);
      if (cancelled) return;
      if (res.ok) {
        setData(res.data);
        setError("");
        // The rep picker lists the team as the unfiltered view found it this month.
        if (res.data.teamView && !rep) setTeam(res.data.reps.map((r) => ({ id: r.employeeId, name: r.name })));
      } else {
        setError(res.data.error ?? (ar ? "تعذّر التحميل." : "Could not load."));
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [month, rep, ar]);

  if (loading) return <PerfLoading ar={ar} />;
  if (!data) return <div className="pg"><PerfNotice kind="error" ar={ar}>{error}</PerfNotice></div>;

  const t = data.totals;
  const n = (v: number) => num(v, lang);
  const pct = (raw: string | null) => (raw === null ? "—" : `${raw.replace(/\.0$/, "")}%`);
  const sar = ar ? "ر.س" : "SAR";
  const monthLabel = monthOptions(month, lang).find((o) => o.value === month)?.label ?? month;
  const narrowed = data.teamView && !!rep;
  const repName = narrowed ? (data.reps[0]?.name ?? team.find((x) => x.id === rep)?.name ?? "") : null;
  const scopeText = !data.teamView
    ? (ar ? "أداؤك أنت" : "your own")
    : narrowed ? repName : (ar ? "كل الفريق" : "the whole team");

  const actions = (
    <>
      <MonthChip value={month} onChange={(v) => { setLoading(true); setMonth(v); }} lang={lang} testId="pf-month" />
      {data.teamView && (
        <label className="chip perf-chip">
          <span>{ar ? "المندوب" : "Rep"}</span>
          <Select value={rep} onChange={(e) => { setLoading(true); setRep(e.target.value); }}
            aria-label={ar ? "المندوب" : "Rep"} data-testid="pf-rep">
            <option value="">{ar ? "كل الفريق" : "Whole team"}</option>
            {team.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            {rep && !team.some((x) => x.id === rep) && <option value={rep}>{repName || rep}</option>}
          </Select>
        </label>
      )}
    </>
  );
  const meta = [monthLabel, <>{ar ? "النطاق: " : "scope: "}{scopeText}</>];

  // ── The headline: net collected against the target ──
  const prog = t.target;
  const progressCaption = prog.target === null
    ? (ar ? "لا هدف مسجّل لهذا الشهر" : "No target set for this month")
    : prog.met
      ? (ar ? `تحقّق ${pct(prog.percent)} · فوق الهدف` : `${pct(prog.percent)} achieved · above target`)
      : (ar ? `تحقّق ${pct(prog.percent)} · المتبقي ${formatMoney(prog.remaining ?? "0")} ${sar}` : `${pct(prog.percent)} achieved · ${formatMoney(prog.remaining ?? "0")} ${sar} to go`);

  const link = (href: string, text: string, testId: string, cls = "lk") =>
    can(href.split("?")[0]) ? <Link className={cls} href={href} data-testid={testId}>{text}</Link> : null;

  const hero = (
    <div className="cols perf-cols" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1.6fr)", gap: 48, alignItems: "end", marginBottom: 28 }}>
      <div data-testid="pf-collected">
        <div className="lbl" style={{ fontSize: 13, color: "var(--text-secondary)" }}>{ar ? "صافي المحصَّل هذا الشهر" : "Net collected this month"}</div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, margin: "10px 0 12px" }}>
          <span className="big n">{formatMoney(t.netCollected)}</span><span className="unit">{sar}</span>
        </div>
        <Bar percent={Number(prog.percent ?? 0)} testId="pf-progress"
          label={prog.target === null ? undefined : `${ar ? "تحقّق" : "Achieved"} ${pct(prog.percent)}`} />
        <div className="sm" style={{ display: "flex", justifyContent: "space-between", gap: 12, marginTop: 6, fontSize: 12.5, color: "var(--text-muted)", flexWrap: "wrap" }}>
          <span data-testid="pf-progress-caption">{progressCaption}</span>
          {prog.target !== null && <span>{ar ? "الهدف" : "Target"} <span className="n">{formatMoney(prog.target)}</span></span>}
        </div>
      </div>
      <Metrics items={[
        {
          label: ar ? "صفقات مكسوبة" : "Deals won", testId: "pf-won",
          value: <span className="n">{n(t.won)}</span>,
          note: <span className="n">{formatMoney(t.wonValue)}</span>,
        },
        {
          label: ar ? "صفقات خاسرة" : "Deals lost", testId: "pf-lost",
          value: <span className="n">{n(t.lost)}</span>,
          note: <span className="n">{formatMoney(t.lostValue)}</span>,
        },
        {
          label: ar ? "معدّل الكسب" : "Win rate", testId: "pf-winrate",
          value: <span className="n">{pct(t.winRatePercent)}</span>,
          note: ar ? "من الصفقات المغلقة هذا الشهر" : "of the deals closed this month",
        },
        {
          label: ar ? "العمولة المستحقة" : "Commission accrued", testId: "pf-commission",
          value: t.commissionAccrued === null ? "—" : <span className="n">{formatMoney(t.commissionAccrued)}</span>,
          note: t.commissionAccrued === null
            ? (ar ? "لا تظهر بصلاحياتك" : "not shown with your access")
            : (ar ? "من سجلّ العمولات" : "from the commission ledger"),
        },
      ]} />
    </div>
  );

  const second = (
    <Metrics items={[
      {
        label: ar ? "قيمة المسار المفتوح" : "Open pipeline", testId: "pf-pipeline",
        value: <span className="n">{formatMoney(t.openValue)}</span>,
        note: ar ? `${n(t.openCount)} صفقات · الآن` : `${t.openCount} deals · now`,
      },
      {
        label: ar ? "نسبة التحويل" : "Conversion rate", testId: "pf-conversion",
        value: <span className="n">{pct(t.conversionPercent)}</span>,
        note: ar ? `${n(t.leadsConverted)} من ${n(t.leadsCreated)} عملاء محتملين` : `${t.leadsConverted} of ${t.leadsCreated} leads`,
      },
      {
        label: ar ? "عروض أسعار صادرة" : "Quotations issued", testId: "pf-quotes-issued",
        value: <span className="n">{n(t.quotesIssued)}</span>,
        note: ar ? "أُصدرت هذا الشهر" : "issued this month",
      },
      {
        label: ar ? "عروض مقبولة" : "Quotations accepted", testId: "pf-quotes-accepted",
        value: <span className="n">{n(t.quotesAccepted)}</span>,
        note: <span className="n">{formatMoney(t.acceptedValue)}</span>,
      },
    ]} />
  );

  // ── Charts ──
  const monthShort = (key: string) => {
    const [y, m] = key.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString(ar ? "ar-SA-u-ca-gregory-nu-latn" : "en-GB", { month: "short", timeZone: "UTC" });
  };
  const trend = data.trend.map((p) => ({
    label: monthShort(p.month),
    collected: Number(p.netCollected),
    target: p.target === null ? null : Number(p.target),
  }));
  const hasTrend = trend.some((p) => p.collected > 0 || (p.target ?? 0) > 0);
  const moneyTick = (v: number) => (Math.abs(v) >= 1000 ? `${Math.round(v / 1000)}k` : String(v));
  const trendChart = !hasTrend ? (
    <p className="sm" style={{ color: "var(--text-muted)", fontSize: 13.5, margin: "6px 0" }}>{ar ? "لا تحصيل ولا أهداف في الأشهر الستة الأخيرة." : "No collections or targets in the last six months."}</p>
  ) : (
    <div style={{ height: phone ? 200 : 240 }} data-testid="pf-trend" role="img"
      aria-label={ar ? "صافي المحصّل مقابل الهدف في آخر ستة أشهر" : "Net collected against target, last six months"}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={trend} margin={{ top: 8, right: 4, left: 4, bottom: 0 }}>
          <CartesianGrid stroke={tk.grid} vertical={false} />
          <XAxis dataKey="label" reversed={ar} tick={{ fontSize: 12, fill: tk.muted }} axisLine={false} tickLine={false} />
          <YAxis orientation={ar ? "right" : "left"} tickFormatter={moneyTick} tick={{ fontSize: 12, fill: tk.muted }} axisLine={false} tickLine={false} width={40} />
          <Tooltip formatter={(v) => formatMoney(Number(v).toFixed(2))} cursor={{ fill: tk.grid }} />
          <Legend iconSize={10} wrapperStyle={{ fontSize: 12.5 }} />
          <RBar name={ar ? "صافي المحصّل" : "Net collected"} dataKey="collected" fill={tk.primary} radius={[3, 3, 0, 0]} maxBarSize={28} />
          <Line name={ar ? "الهدف" : "Target"} dataKey="target" stroke={tk.plan} strokeWidth={1.5} strokeDasharray="5 4" dot={{ r: 3 }} connectNulls={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );

  const maxValue = Math.max(1, ...data.pipelineByStage.map((s) => Number(s.value)));
  const maxCount = Math.max(1, ...data.pipelineByStage.map((s) => s.count));
  const allZero = data.pipelineByStage.every((s) => Number(s.value) === 0);
  const stages = data.pipelineByStage.length === 0 ? (
    <p className="sm" style={{ color: "var(--text-muted)", fontSize: 13.5, margin: "6px 0" }}>{ar ? "لا توجد صفقات مفتوحة." : "No open deals."}</p>
  ) : (
    <div data-testid="pf-stages">
      {data.pipelineByStage.map((s) => {
        const w = allZero ? (s.count / maxCount) * 100 : (Number(s.value) / maxValue) * 100;
        return phone ? (
          <div key={s.stageId} style={{ padding: "6px 0" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13.5, marginBottom: 6 }}>
              <span>{ar ? s.nameAr : s.nameEn}</span><span className="n">{n(s.count)} · {formatMoney(s.value)}</span>
            </div>
            <Bar percent={w} />
          </div>
        ) : (
          <div key={s.stageId} style={{ display: "grid", gridTemplateColumns: "110px minmax(0,1fr) 150px", gap: 12, alignItems: "center", padding: "6px 0", fontSize: 13.5 }}>
            <span>{ar ? s.nameAr : s.nameEn}</span>
            <Bar percent={w} />
            <span className="n" style={{ textAlign: "end" }}>{n(s.count)} · {formatMoney(s.value)}</span>
          </div>
        );
      })}
    </div>
  );

  const sectionHead = (title: string, sub?: string, extra?: ReactNode) => (
    <div className="bh"><h2 className="bt">{title}</h2>{sub && <span className="sub">{sub}</span>}{extra}</div>
  );
  const pipelineHref = `/dashboard/sales/pipeline${narrowed ? `?owner=${encodeURIComponent(rep)}` : ""}`;

  // ── The team, rep by rep ──
  const repRows = data.teamView && !narrowed && data.reps.length > 0 ? data.reps : [];
  const repProgress = (r: Rep) => r.target.target === null ? (ar ? "بلا هدف" : "no target") : `${pct(r.target.percent)}`;
  const narrow = (r: Rep) => (
    <button type="button" className="perf-who" onClick={() => { setLoading(true); setRep(r.employeeId); }} data-testid={`pf-rep-${r.employeeId}`}>
      <bdi>{r.name}</bdi>
    </button>
  );
  const repTable = repRows.length === 0 ? null : phone ? (
    <div data-testid="pf-reps">
      {repRows.map((r) => (
        <div key={r.employeeId} className="mrow">
          <span className="who">{narrow(r)}</span>
          <span className="n">{formatMoney(r.netCollected)}</span>
          {r.target.target !== null && <Bar percent={Number(r.target.percent ?? 0)} />}
          <div className="r2">
            <span style={{ flex: 1 }}>{repProgress(r)}{r.target.target !== null && <> · {ar ? "الهدف" : "target"} <span className="n">{formatMoney(r.target.target)}</span></>}</span>
          </div>
          <div className="r2">
            <span style={{ flex: 1 }}>
              {ar ? `${n(r.won)} مكسوبة · ${n(r.lost)} خاسرة · المسار ` : `${r.won} won · ${r.lost} lost · pipeline `}
              <span className="n">{formatMoney(r.openValue)}</span>
            </span>
          </div>
        </div>
      ))}
    </div>
  ) : (
    <div className="perf-scroll">
      <table className="t" data-testid="pf-reps">
        <thead><tr>
          <th scope="col">{ar ? "المندوب" : "Rep"}</th>
          <th scope="col" className="num">{ar ? "صافي المحصّل" : "Net collected"}</th>
          <th scope="col">{ar ? "التقدّم نحو الهدف" : "Progress to target"}</th>
          <th scope="col" className="num">{ar ? "مكسوبة · خاسرة" : "Won · lost"}</th>
          <th scope="col" className="num hide-c">{ar ? "المسار المفتوح" : "Open pipeline"}</th>
          <th scope="col" className="num hide-c">{ar ? "التحويل" : "Conversion"}</th>
          <th scope="col" className="num hide-c">{ar ? "العروض صادرة · مقبولة" : "Quotes issued · accepted"}</th>
          {data.commissionVisible && <th scope="col" className="num">{ar ? "العمولة المستحقة" : "Commission"}</th>}
        </tr></thead>
        <tbody>
          {repRows.map((r) => (
            <tr key={r.employeeId} data-testid={`pf-row-${r.employeeId}`}>
              <td style={{ paddingBlock: 4 }}>
                <div className="who">{narrow(r)}</div>
                {!r.active && <span className="perf-sub">{ar ? "غير نشط" : "inactive"}</span>}
              </td>
              <td className="num">{formatMoney(r.netCollected)}</td>
              <td>
                <div style={{ display: "grid", gap: 4, minWidth: 160 }}>
                  {r.target.target !== null && <Bar percent={Number(r.target.percent ?? 0)} label={`${ar ? "تحقّق" : "Achieved"} ${repProgress(r)}`} />}
                  <span className="sm">
                    {repProgress(r)}
                    {r.target.target !== null && <> · {ar ? "من" : "of"} <span className="n">{formatMoney(r.target.target)}</span></>}
                  </span>
                </div>
              </td>
              <td className="num"><span className="n">{n(r.won)} · {n(r.lost)}</span></td>
              <td className="num hide-c">
                {r.openCount > 0 && can("/dashboard/sales/pipeline")
                  ? <Link className="perf-link" style={{ fontSize: "inherit" }} href={`/dashboard/sales/pipeline?owner=${encodeURIComponent(r.employeeId)}`}>{formatMoney(r.openValue)}</Link>
                  : formatMoney(r.openValue)}
              </td>
              <td className="num hide-c">{pct(r.conversionPercent)}</td>
              <td className="num hide-c"><span className="n">{n(r.quotesIssued)} · {n(r.quotesAccepted)}</span></td>
              {data.commissionVisible && <td className="num">{r.commissionAccrued === null ? "—" : formatMoney(r.commissionAccrued)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  // Drill-downs to the pages behind the figures, only where the viewer may go.
  const commissionHref = data.teamView && can("/dashboard/commissions/review")
    ? `/dashboard/commissions/review?month=${month}` : `/dashboard/sales/my-commissions?month=${month}`;
  const drills = [
    link(`/dashboard/sales/targets?month=${month}`, ar ? "الأهداف" : "Targets", "pf-go-targets", "perf-link pf-drill"),
    // The team's reports are the manager's and the admin's only (as GET /api/sales/reports).
    user && seesTeamReports(user.permissions, user.role)
      ? link(`/dashboard/sales/reports?month=${month}`, ar ? "تقارير المبيعات" : "Sales reports", "pf-go-reports", "perf-link pf-drill")
      : null,
    link(pipelineHref, ar ? "مسار الصفقات" : "Pipeline", "pf-go-pipeline", "perf-link pf-drill"),
    link("/dashboard/sales/quotes", ar ? "عروض الأسعار" : "Quotations", "pf-go-quotes", "perf-link pf-drill"),
    data.commissionVisible ? link(commissionHref, own || !data.teamView ? (ar ? "عمولاتي" : "My commissions") : (ar ? "مراجعة العمولات" : "Commission review"), "pf-go-commission", "perf-link pf-drill") : null,
  ].filter(Boolean);

  return (
    <div className="pg">
      <PerfHeader ar={ar} title={ar ? "الأداء والعمولات" : "Performance and commissions"}
        phoneTitle={ar ? "لوحة الأداء" : "Performance dashboard"} meta={meta} actions={actions} />
      <PerfSandbox notice={data.notice} ar={ar} />
      <PerfNotice kind="error" ar={ar} onDismiss={() => setError("")}>{error}</PerfNotice>

      {narrowed && (
        <p className="sm" style={{ margin: "0 0 16px", fontSize: 13, color: "var(--text-secondary)" }} data-testid="pf-narrowed">
          {ar ? "تعرض أداء " : "Showing "}<b style={{ fontWeight: 600 }}><bdi>{repName}</bdi></b>{ar ? " وحده. " : " only. "}
          <button type="button" className="perf-link" onClick={() => { setLoading(true); setRep(""); }}>{ar ? "عرض كل الفريق" : "Show the whole team"}</button>
        </p>
      )}

      {hero}
      <div style={{ margin: "0 0 28px" }}>{second}</div>

      <div className="cols perf-cols" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 48 }}>
        <div>{sectionHead(ar ? "المحصّل مقابل الهدف" : "Collected against target", ar ? "آخر ستة أشهر" : "last six months")}{trendChart}</div>
        <div>{sectionHead(ar ? "المسار حسب المرحلة" : "Pipeline by stage", ar ? "الصفقات المفتوحة الآن" : "open deals now",
          link(pipelineHref, ar ? "فتح المسار" : "Open the pipeline", "pf-stage-link"))}{stages}</div>
      </div>

      {repTable && (
        <>
          <div className="hr" style={{ margin: "28px 0" }} />
          {sectionHead(ar ? "أداء المندوبين" : "Rep by rep", ar ? "الأعلى تحصيلًا أولًا · اختر اسمًا لعرض أدائه وحده" : "highest collected first · pick a name to see it alone")}
          {repTable}
        </>
      )}

      {drills.length > 0 && (
        <div className="bh" style={{ margin: "24px 0 12px", flexWrap: "wrap", gap: "6px 16px" }} data-testid="pf-drills">
          <span className="sub">{ar ? "التفاصيل في:" : "Details in:"}</span>
          {drills.map((d, i) => <span key={i} style={{ display: "contents" }}>{d}</span>)}
        </div>
      )}

      <PerfNote testId="pf-formulas">
        <span>
          <b style={{ fontWeight: 600 }}>{ar ? "كيف تُحسب الأرقام. " : "How the figures are computed. "}</b>
          {ar
            ? "صافي المحصّل = المبالغ المحصّلة المسجّلة في الشهر بعد الضريبة وغير المؤهَّل، موزّعة على ملّاك الصفقة بنسبهم كما يحسبها «الأهداف» ومحرك العمولات. المكسوبة والخاسرة = صفقات أُغلقت في الشهر بقيمتها قبل الضريبة. معدّل الكسب = المكسوبة ÷ (المكسوبة + الخاسرة). المسار المفتوح لقطة للصفقات المفتوحة الآن. نسبة التحويل = من العملاء المحتملين الذين وصلوا في الشهر، كم تحوّل إلى صفقة. العروض = ما صدر وما قُبل في الشهر. العمولة المستحقة = قيود الاستحقاق والعكس في سجلّ العمولات لهذا الشهر."
            : "Net collected = collections recorded in the month, net of tax and non-qualifying amounts, split across the deal's owners as Targets and the commission engine split them. Won and lost = deals closed in the month, at their pre-tax value. Win rate = won ÷ (won + lost). Open pipeline is a snapshot of the deals open now. Conversion = of the leads that arrived in the month, how many became a deal. Quotations = issued and accepted in the month. Commission accrued = the month's accrual and reversal entries in the commission ledger."}
        </span>
      </PerfNote>
    </div>
  );
}
