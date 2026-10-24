"use client";

// Accounting A5 — the dashboard part of «نظرة عامة» (Figma ACC-01 «المركز حتى اليوم» / «تحتاج إجراء»): the KPI strip
// (the A3 metric strip: label, figure, basis), one chart — revenue by month, a single series in the brand action
// colour (one series: no legend box, the title names it; the tooltip carries gross profit and margin; the table view
// is the P&L) — and the issues panel: the close-checklist items that fail or need review, each linking to its fix.
// Recharts draws SVG attributes, so the token value is read from the page's computed style (as the finance board).
import Link from "next/link";
import { useMemo, useSyncExternalStore } from "react";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, LabelList } from "recharts";
import { OpsLoading } from "@/components/ops/ui";
import { money, useApi, useLang } from "./shell";
import { CheckStatus, type Check } from "./close";

type Dash = {
  asOf: string; month: string;
  kpis: { cash: string; ar: string; ap: string; inventory: string; vatPayable: string; overdueAr: string; overdueCustomers: number; revenue: string; grossProfit: string; grossMarginPct: string | null; netProfit: string; roastCostPerKg: string | null; roastedKg: string | null; roastLossPct: string | null };
  trend: { month: string; revenue: string; grossProfit: string; grossMarginPct: string | null }[];
  issues: (Check & { period: string; periodId: string })[];
};

const FALLBACK = JSON.stringify({ bar: "#5c5c38", grid: "#efe9dc", muted: "#6e6a61" });
const readTokens = () => {
  const cs = getComputedStyle(document.querySelector("[data-hr-root]") ?? document.documentElement);
  const v = (n: string, d: string) => cs.getPropertyValue(n).trim() || d;
  return JSON.stringify({ bar: v("--action-primary", "#5c5c38"), grid: v("--border-subtle", "#efe9dc"), muted: v("--text-muted", "#6e6a61") });
};
function useTokens() {
  const key = useSyncExternalStore(() => () => {}, readTokens, () => FALLBACK);
  return useMemo(() => JSON.parse(key) as { bar: string; grid: string; muted: string }, [key]);
}

function Kpi({ k, v, s, testId, bad }: { k: string; v: string; s?: string; testId: string; bad?: boolean }) {
  return <div className="acct-metric" data-testid={testId}><span className="k">{k}</span><span className={`v${bad ? " is-bad" : ""}`}>{v}</span>{s ? <span className="s">{s}</span> : null}</div>;
}

export function AccountingDashboard() {
  const { L, ar } = useLang();
  const tk = useTokens();
  const r = useApi<Dash>("/api/accounting/dashboard");
  if (r.error) return <p role="alert" className="hr-err">{r.error}</p>;
  if (!r.data) return <OpsLoading rows={3} />;
  const d = r.data, k = d.kpis;
  const chart = d.trend.map((t) => ({ ...t, rev: Number(t.revenue), label: t.grossMarginPct === null ? "" : `${t.grossMarginPct}%` }));
  const pct = (v: string | null) => (v === null ? "—" : `${v}%`);
  return (
    <>
      <section className="acct-card" data-testid="acct-dashboard">
        <div className="acct-foot" style={{ borderTop: 0, paddingTop: 0 }}>
          <h2>{L("المركز حتى اليوم", "Position today")}</h2>
          <span className="acct-hint">{L(`من القيود المرحّلة فقط · ر.س · ${d.asOf}`, `Posted entries only · SAR · ${d.asOf}`)}</span>
        </div>
        <div className="acct-metrics">
          <Kpi testId="kpi-cash" k={L("النقد والبنوك", "Cash and bank")} v={money(k.cash)} bad={Number(k.cash) < 0} />
          <Kpi testId="kpi-ar" k={L("الذمم المدينة", "Receivables")} v={money(k.ar)} s={L(`متأخر ${money(k.overdueAr)} · ${k.overdueCustomers} عميل`, `Overdue ${money(k.overdueAr)} · ${k.overdueCustomers} customers`)} />
          <Kpi testId="kpi-ap" k={L("الذمم الدائنة", "Payables")} v={money(k.ap)} />
          <Kpi testId="kpi-inventory" k={L("قيمة المخزون", "Inventory value")} v={money(k.inventory)} s={L("أخضر ومحمص ومعبأ ومواد", "Green, roasted, packed, materials")} />
        </div>
        <div className="acct-metrics">
          <Kpi testId="kpi-revenue" k={L(`إيرادات ${d.month}`, `${d.month} revenue`)} v={money(k.revenue)} s={L(`صافي الربح ${money(k.netProfit)}`, `Net profit ${money(k.netProfit)}`)} />
          <Kpi testId="kpi-gm" k={L("هامش مجمل الربح", "Gross margin")} v={pct(k.grossMarginPct)} s={L(`مجمل الربح ${money(k.grossProfit)}`, `Gross profit ${money(k.grossProfit)}`)} />
          <Kpi testId="kpi-vat" k={L("ضريبة مستحقة (تقدير)", "VAT payable (estimate)")} v={money(k.vatPayable)} s={L("المخرجات − المدخلات · ليس إقرارًا", "Output − input · not a return")} />
          <Kpi testId="kpi-roast" k={L("تكلفة الكيلو المحمص", "Roasted cost per kg")} v={k.roastCostPerKg ? money(k.roastCostPerKg) : "—"} s={k.roastedKg ? L(`${k.roastedKg} كغ هذا الشهر · فاقد ${pct(k.roastLossPct)}`, `${k.roastedKg} kg this month · loss ${pct(k.roastLossPct)}`) : L("لا تحميص هذا الشهر", "No roasting this month")} />
        </div>
      </section>
      <div className="acct-split">
        <section className="acct-card" data-testid="acct-trend">
          <h2>{L("الإيرادات حسب الشهر · آخر ستة أشهر", "Revenue by month · last six months")}</h2>
          <div className="acct-chart" role="img" aria-label={L("الإيرادات حسب الشهر مع هامش مجمل الربح فوق كل عمود", "Revenue by month with the gross margin above each bar")}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chart} margin={{ top: 20, right: 8, left: 8, bottom: 0 }} barCategoryGap="30%">
                <CartesianGrid vertical={false} stroke={tk.grid} />
                <XAxis dataKey="month" reversed={ar} tick={{ fill: tk.muted, fontSize: 12 }} axisLine={false} tickLine={false} />
                <YAxis orientation={ar ? "right" : "left"} tick={{ fill: tk.muted, fontSize: 12 }} axisLine={false} tickLine={false} width={64} tickFormatter={(v: number) => new Intl.NumberFormat("en-US", { notation: "compact" }).format(v)} />
                <Tooltip cursor={{ fill: tk.grid }} formatter={(_v, _n, p) => { const x = p.payload as (typeof chart)[number]; return [`${money(x.revenue)} · ${L("مجمل الربح", "gross profit")} ${money(x.grossProfit)} · ${pct(x.grossMarginPct)}`, L("الإيرادات", "Revenue")]; }} />
                <Bar dataKey="rev" fill={tk.bar} radius={[4, 4, 0, 0]} isAnimationActive={false}>
                  <LabelList dataKey="label" position="top" style={{ fill: tk.muted, fontSize: 11 }} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="acct-hint">{L("الرقم فوق العمود هامش مجمل الربح. التفصيل في «التقارير › قائمة الدخل».", "The figure above each bar is the gross margin. The detail is in Reports › Income statement.")} <Link href="/dashboard/accounting/reports?view=income">{L("قائمة الدخل ←", "Income statement →")}</Link></p>
        </section>
        <section className="acct-card" data-testid="acct-issues">
          <h2>{L("تحتاج إجراء", "Needs action")}</h2>
          {d.issues.length === 0 ? <p className="acct-hint" data-testid="acct-issues-none">{L("لا بنود في قوائم إقفال الأشهر المفتوحة.", "Nothing in the close checklists of the open months.")}</p> : (
            <ul className="acct-issues">
              {d.issues.map((i, n) => (
                <li key={n} data-check={i.key}>
                  <CheckStatus s={i.status} />
                  <span><span className="hr-num">{i.period}</span> · {L(i.ar, i.en)}</span>
                  <Link className="hr-btn is-sm" href={i.href}>{L("فتح", "Open")}</Link>
                </li>
              ))}
            </ul>
          )}
          <p className="acct-hint"><Link href="/dashboard/accounting/periods">{L("قوائم الإقفال في «الفترات» ←", "Close checklists in Periods →")}</Link></p>
        </section>
      </div>
    </>
  );
}
