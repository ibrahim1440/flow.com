"use client";

// Accounting A5 — the dashboard part of «نظرة عامة» (Figma ACC-01 «المركز حتى اليوم» / «تحتاج إجراء»): the KPI strip
// (the A3 metric strip: label, figure, basis), one chart — revenue by month, a single series in the brand action
// colour (one series: no legend box, the title names it; the tooltip carries gross profit and margin; the table view
// is the P&L) — and the issues panel: the close-checklist items that fail or need review, each linking to its fix.
// Recharts draws SVG attributes, so the token value is read from the page's computed style (as the finance board).
import Link from "next/link";
import { useMemo, useSyncExternalStore, type ReactNode } from "react";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, LabelList } from "recharts";
import { OpsLoading } from "@/components/ops/ui";
import { Term, money, useApi, useLang } from "./shell";
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

function Kpi({ k, v, s, testId, bad }: { k: ReactNode; v: string; s?: string; testId: string; bad?: boolean }) {
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
      <InventorySummary />
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

type InvRec = {
  asOf: string;
  inventory: { role: string; account: { code: string; name: string } | null; subLedger: string; gl: string; unexplained: string; status: string }[];
  totals: { subLedger: string; gl: string; difference: string };
  grni: { account: { code: string } | null; gl: string; openReceipts: string; count: number; noInvoice: { count: number; value: string }; awaitingApproval: { count: number; value: string } };
};
const INV_ROLE: Record<string, [string, string]> = {
  INVENTORY_GREEN: ["البن الأخضر", "Green coffee"], INVENTORY_PACKAGING: ["مواد التغليف", "Packaging"], INVENTORY_CAFE: ["مواد المقهى", "Café consumables"],
  INVENTORY_ROASTED: ["البن المحمص", "Roasted coffee"], INVENTORY_PACKED: ["المنتجات المعبأة", "Packed goods"],
};

/**
 * Unified inventory phase 4 — «ملخص المخزون للمحاسب»: the inventory value per account (the cost ledger, and the general
 * ledger beside it), what is left unreconciled, and the goods received whose invoice is not posted (no invoice / awaiting approval). One read of the A3 reconciliation;
 * the detail is «تقييم المخزون».
 */
export function InventorySummary() {
  const { L } = useLang();
  const r = useApi<InvRec>("/api/accounting/inventory/reconciliation");
  if (r.error) return null;
  if (!r.data) return <OpsLoading rows={2} />;
  const d = r.data;
  const unexplained = d.inventory.reduce((s, x) => s + Number(x.unexplained), 0);
  const rows = d.inventory.filter((x) => Number(x.subLedger) || Number(x.gl));
  return (
    <section className="acct-card" data-testid="acct-inventory-summary">
      <div className="acct-foot" style={{ borderTop: 0, paddingTop: 0 }}>
        <h2>{L("ملخص المخزون للمحاسب", "Inventory summary for the accountant")}</h2>
        <Link className="hr-btn is-sm" href="/dashboard/accounting/inventory">{L("تقييم المخزون", "Inventory valuation")}</Link>
      </div>
      <div className="acct-metrics">
        <Kpi testId="inv-sum-total" k={L("قيمة المخزون بالتكلفة", "Inventory value at cost")} v={money(d.totals.subLedger)} s={L(`دفتر الأستاذ ${money(d.totals.gl)}`, `General ledger ${money(d.totals.gl)}`)} />
        <Kpi testId="inv-sum-unexplained" k={L("فرق غير مسوّى", "Unreconciled difference")} v={money(unexplained)} bad={Math.abs(unexplained) > 0.004} s={Math.abs(unexplained) > 0.004 ? L("يُبحث قبل إقفال الفترة", "Investigate before the period close") : L(`الفرق الكلي ${money(d.totals.difference)} مفسَّر`, `Total difference ${money(d.totals.difference)}, explained`)} />
        <Kpi testId="inv-sum-grni" k={<Term tech="GRNI">{L("بضاعة مستلمة لم تُرحَّل فاتورتها", "Received, not yet billed in the books")}</Term>} v={money(d.grni.gl)} s={L(`بلا فاتورة ${d.grni.noInvoice.count} (${money(d.grni.noInvoice.value)}) · بانتظار الاعتماد ${d.grni.awaitingApproval.count} (${money(d.grni.awaitingApproval.value)})`, `No invoice ${d.grni.noInvoice.count} (${money(d.grni.noInvoice.value)}) · awaiting approval ${d.grni.awaitingApproval.count} (${money(d.grni.awaitingApproval.value)})`)} />
      </div>
      {rows.length ? (
        <div className="hr-tablewrap">
          <table className="hr-table is-dense" data-testid="inv-sum-accounts">
            <thead><tr><th>{L("حساب المخزون", "Inventory account")}</th><th className="num">{L("سجل التكلفة", "Cost ledger")}</th><th className="num">{L("دفتر الأستاذ", "General ledger")}</th></tr></thead>
            <tbody>
              {rows.map((x) => (
                <tr key={x.role}>
                  <td>{x.account ? <><span className="acct-code">{x.account.code}</span> {x.account.name}</> : L(INV_ROLE[x.role]?.[0] ?? x.role, INV_ROLE[x.role]?.[1] ?? x.role)}</td>
                  <td className="num hr-num">{money(x.subLedger)}</td><td className={`num hr-num${Number(x.unexplained) ? " acct-bad" : ""}`}>{money(x.gl)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
