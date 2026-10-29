"use client";

// «لوحة المتابعة» — the accountant workspace's landing page (Qoyod-parity program, phase 1). Qoyod's widgets, in
// Qoyod's order, from our real data: GET /api/accounting/home (src/lib/accounting/accountant-home.ts names the report
// each figure ties to; every widget links to it). A widget the viewer may not read is not drawn.
import Link from "next/link";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, LineChart, Line, PieChart, Pie, Cell,
} from "recharts";
import { OpsLoading, OpsRoot } from "@/components/ops/ui";
import { DateRange, FilterCard, MultiPick, Section, TablePager, useFilters, usePaging, type PickOption } from "@/components/chrome";
import { money, useApi, useLang } from "../_ui/shell";
import "@/components/hr/hr.css";
import "../_ui/accounting.css";
import "./home.css";

type Party = { id: string; name: string; nameEn: string | null; amount: string; overdue: string };
type Monthly = { month: string; created: string; paid: string; due: string };
type Side = { asOf: string; open: string; overdue: string; notDue: string; top: Party[]; monthly: Monthly[] };
type Home = {
  range: { from: string; to: string };
  months: string[];
  ar: Side | null;
  ap: Side | null;
  gl: { active: boolean; accounts: number; rows: { month: string; revenue: string; expenses: string; netProfit: string }[] } | null;
  stock: {
    locations: { id: string; nameAr: string; nameEn: string | null; value?: number }[];
    low: { locationId: string; location: string; locationEn: string | null; kind: string; code: string; name: string; nameEn: string; unit: string; qty: number; reorderPoint: number; out: boolean }[];
    costShown: boolean;
  } | null;
  activity: { at: string; kind: string; ref: string; amount: string | null; href: string | null; party: string | null }[];
  /** «قوالب التأجيل»'s backlog (council F6): an alert when months before the current one wait for recognition. */
  deferrals: { overdueCount: number; overdueAmount: string; stoppedAt: { month: string; reason: "PERIOD_CLOSED" | "PERIOD_SOFT_CLOSED" | "NOT_RUN" } | null; scheduler?: "NOT_AUTHORISED" | "AUTHORISED" } | null;
};

// GET /api/accounting/recurring/widget (src/lib/accounting/recurring/widget.ts; APIS.md, qc-recurring).
type RecTab = "ALL" | "SALES_INVOICE" | "PURCHASE_INVOICE" | "SIMPLE_BILL";
type RecWidget = {
  tab: RecTab;
  tabs: { key: RecTab; ar: string; en: string; supported: boolean; count: number }[];
  rows: { id: string; ref: string; name: string; createdAt: string; nextRunDate: string | null; overdue: boolean; status: "ACTIVE" | "PAUSED" | "COMPLETED" | "CANCELLED"; statusLabel: { ar: string; en: string }; failedRuns: number; links: { view: string; history: string } }[];
  total: number; take: number; skip: number;
  notSupported: { ar: string; en: string } | null;
  dueNow: number;
  failedRuns: number;
};
const REC_TONE: Record<RecWidget["rows"][number]["status"], string> = { ACTIVE: "success", PAUSED: "warning", COMPLETED: "neutral", CANCELLED: "cancelled" };

const FALLBACK = JSON.stringify({ a: "#5c5c38", b: "#bd7d47", c: "#3b6385", grid: "#efeadf", muted: "#6e6a61", danger: "#b42318" });
const readTokens = () => {
  const cs = getComputedStyle(document.querySelector(".d21") ?? document.documentElement);
  const v = (n: string, d: string) => cs.getPropertyValue(n).trim() || d;
  return JSON.stringify({ a: v("--action-primary", "#5c5c38"), b: v("--brand-signature", "#bd7d47"), c: v("--status-info", "#3b6385"), grid: v("--border-subtle", "#efeadf"), muted: v("--text-muted", "#6e6a61"), danger: v("--status-danger", "#b42318") });
};
function useTokens() {
  const key = useSyncExternalStore(() => () => {}, readTokens, () => FALLBACK);
  return useMemo(() => JSON.parse(key) as Record<"a" | "b" | "c" | "grid" | "muted" | "danger", string>, [key]);
}

const today = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
const yearStart = () => `${today().slice(0, 4)}-01-01`;
const compact = (v: number) => new Intl.NumberFormat("en-US", { notation: "compact" }).format(v);
const MONTH_AR = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
const MONTH_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const ACT: Record<string, [string, string]> = {
  SALES_INVOICE: ["فاتورة مبيعات", "Sales invoice"], SALES_CREDIT_NOTE: ["إشعار دائن", "Credit note"], SALES_DEBIT_NOTE: ["إشعار مدين", "Debit note"],
  RECEIPT: ["سند عميل", "Customer receipt"], SUPPLIER_INVOICE: ["فاتورة مشتريات", "Purchase invoice"], SUPPLIER_PAYMENT: ["سند مورد", "Supplier voucher"],
};

export default function AccountantHome() {
  const { L, ar } = useLang();
  const tk = useTokens();
  const f = useFilters({ locations: [] as string[], from: yearStart(), to: today() });
  const q = useMemo(() => {
    const p = new URLSearchParams({ from: f.applied.from, to: f.applied.to });
    for (const l of f.applied.locations) p.append("location", l);
    return `/api/accounting/home?${p}`;
  }, [f.applied]);
  const r = useApi<Home>(q);
  const [locations, setLocations] = useState<PickOption[]>([]);
  useEffect(() => {
    let off = false;
    fetch("/api/inventory/locations").then((x) => (x.ok ? x.json() : null)).then((j: { locations?: { id: string; nameAr: string; nameEn: string | null; isTransit?: boolean }[] } | null) => {
      if (!off && j?.locations) setLocations(j.locations.filter((l) => !l.isTransit).map((l) => ({ value: l.id, label: ar ? l.nameAr : l.nameEn || l.nameAr })));
    }).catch(() => undefined);
    return () => { off = true; };
  }, [ar]);
  const d = r.data;
  const mLabel = (m: string) => { const i = Number(m.slice(5, 7)) - 1; return ar ? MONTH_AR[i] : MONTH_EN[i]; };

  return (
    <OpsRoot className="acct">
    <div className="hr-page qa-home" data-testid="acct-home">
      <h1 className="qc-sr">{L("لوحة المتابعة", "Dashboard")}</h1>
      <FilterCard variant="dashboard" onApply={f.apply} onReset={f.reset} busy={r.loading}>
        <MultiPick label={L("الموقع", "Location")} options={locations} value={f.draft.locations} onChange={(v) => f.set("locations", v)} allLabel={L("كل المواقع", "All locations")} testId="home-locations" />
        <DateRange from={f.draft.from} to={f.draft.to} onChange={({ from, to }) => f.setDraft({ ...f.draft, from, to })} testId="home-range" />
      </FilterCard>
      <p className="qa-scope" data-testid="home-scope">
        {L("الأرصدة المفتوحة كما في نهاية الفترة · الرسوم الشهرية لأشهر الفترة (آخر 12 شهرًا) · فلتر الموقع يطبَّق على حالة المخزون وعلى الإيرادات والمصروفات (حسب فرع الموقع)؛ أرصدة العملاء والموردين على مستوى المنشأة.",
          "Open balances as at the end of the period · monthly charts for the period's months (last 12) · the location filter applies to the stock status and to revenue and expenses (by the site's branch); customer and supplier balances are company-wide.")}
      </p>
      {r.error ? <p role="alert" className="hr-err">{r.error}</p> : null}
      {!d ? <OpsLoading rows={6} /> : (
        <div aria-busy={r.loading || undefined}>
          {d.stock ? <StockSection s={d.stock} /> : null}

          <div className="qa-grid">
            {d.ar || d.ap ? (
              <Section title={L("حالة الدفعات", "Payment status")} testId="w-payments">
                <div className="qa-donuts">
                  {d.ar ? <Donut title={L("فواتير المبيعات", "Sales invoices")} side={d.ar} tk={tk} href="/dashboard/sales/receivables" testId="w-pay-sales" /> : null}
                  {d.ap ? <Donut title={L("فواتير المشتريات", "Purchase invoices")} side={d.ap} tk={tk} href="/dashboard/accounting/ap?view=aging" testId="w-pay-purchases" /> : null}
                </div>
                <p className="qa-src">{L(`كما في ${d.range.to} · من «أعمار الذمم» و«أعمار الدائنين».`, `As at ${d.range.to} · from AR aging and AP aging.`)}</p>
              </Section>
            ) : null}
            {d.gl ? (
              <Section title={L("الإيرادات والمصروفات", "Revenue and expenses")} testId="w-pl">
                {!d.gl.active ? <p className="qa-note" data-testid="w-pl-inactive">{d.gl.accounts === 0 ? L("لم يُنشأ دليل الحسابات بعد؛ تظهر الأرقام بعد تفعيل المحاسبة وترحيل القيود.", "No chart of accounts yet; figures appear once accounting is active and entries post.") : L("المحاسبة غير مفعّلة بعد: لا تُرحَّل قيود من العمليات، فالأرقام صفر حتى التفعيل.", "Accounting is not active yet: operations post nothing, so the figures stay zero until activation.")}</p> : null}
                <div className="qa-chart" role="img" aria-label={L("الإيرادات والمصروفات لكل شهر", "Revenue and expenses per month")}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={d.gl.rows.map((x) => ({ m: mLabel(x.month), rev: Number(x.revenue), exp: Number(x.expenses) }))} margin={{ top: 10, right: 8, left: 8, bottom: 0 }}>
                      <CartesianGrid vertical={false} stroke={tk.grid} />
                      <XAxis dataKey="m" reversed={ar} tick={{ fill: tk.muted, fontSize: 12 }} axisLine={false} tickLine={false} />
                      <YAxis orientation={ar ? "right" : "left"} tick={{ fill: tk.muted, fontSize: 12 }} axisLine={false} tickLine={false} width={56} tickFormatter={compact} />
                      <Tooltip formatter={(v) => money(Number(v))} />
                      <Legend />
                      <Bar dataKey="rev" name={L("إيرادات", "Revenue")} fill={tk.a} radius={[3, 3, 0, 0]} isAnimationActive={false} />
                      <Bar dataKey="exp" name={L("مصروفات", "Expenses")} fill={tk.b} radius={[3, 3, 0, 0]} isAnimationActive={false} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <DataTable caption={L("الإيرادات والمصروفات (جدول)", "Revenue and expenses (table)")} head={[L("الشهر", "Month"), L("إيرادات", "Revenue"), L("مصروفات", "Expenses"), L("صافي الربح", "Net profit")]}
                  rows={d.gl.rows.map((x) => [x.month, money(x.revenue), money(x.expenses), money(x.netProfit)])} />
                <p className="qa-src">{L("كل شهر = «قائمة الدخل» للشهر؛ المصروفات = الإيرادات − صافي الربح.", "Each month = that month's income statement; expenses = revenue − net profit.")} <Link href="/dashboard/accounting/reports?view=income">{L("قائمة الدخل ←", "Income statement →")}</Link></p>
              </Section>
            ) : null}
          </div>

          {d.deferrals && d.deferrals.overdueCount > 0 ? <DeferralAlert b={d.deferrals} /> : null}

          <RecurringSection />

          <div className="qa-grid">
            {d.ar ? <PartySection title={L("العملاء", "Customers")} topTitle={L("أعلى 5 عملاء عليهم مستحقات", "Top 5 customers with dues")} nameHead={L("اسم العميل", "Customer")} side={d.ar} tk={tk} mLabel={mLabel} testId="w-customers" link="/dashboard/sales/receivables" partyHref={(id) => `/dashboard/sales/receivables/${id}`} /> : null}
            {d.ap ? <PartySection title={L("الموردين", "Suppliers")} topTitle={L("أعلى 5 موردين لهم مستحقات", "Top 5 suppliers owed")} nameHead={L("اسم المورد", "Supplier")} side={d.ap} tk={tk} mLabel={mLabel} testId="w-suppliers" link="/dashboard/accounting/ap?view=aging" partyHref={null} /> : null}
          </div>

          <ActivitySection items={d.activity} />
        </div>
      )}
    </div>
    </OpsRoot>
  );
}

/** «قوالب التأجيل»: «N أشهر مستحقة، متوقف عند YYYY-MM (السبب)» (APIS.md, council F6) — read-only, links to the page. */
function DeferralAlert({ b }: { b: NonNullable<Home["deferrals"]> }) {
  const { L } = useLang();
  const why = b.stoppedAt?.reason === "PERIOD_CLOSED" ? L("الفترة مقفلة", "period closed") : b.stoppedAt?.reason === "PERIOD_SOFT_CLOSED" ? L("الفترة مقفلة مؤقتًا", "period soft-closed") : L("لم يُشغَّل", "not run");
  return (
    <p role="alert" className="hr-err" data-testid="w-deferral-backlog">
      {L(`قوالب التأجيل: ${b.overdueCount} ${b.overdueCount === 1 ? "شهر مستحق" : "أشهر مستحقة"} (${money(b.overdueAmount)} ر.س)`, `Deferral templates: ${b.overdueCount} month(s) due (SAR ${money(b.overdueAmount)})`)}
      {b.stoppedAt ? L(`، متوقف عند ${b.stoppedAt.month} (${why})`, `, stopped at ${b.stoppedAt.month} (${why})`) : null}
      {b.scheduler === "NOT_AUTHORISED" ? <span data-testid="w-deferral-scheduler">{L(" · لا تعترف الجدولة التلقائية بالمؤجلات (NOT_AUTHORISED): شغّلها من «تشغيل المستحق الآن»", " · The scheduler does not recognise deferrals (NOT_AUTHORISED): run them with «Run due now»")}</span>
        : b.scheduler === "AUTHORISED" ? <span data-testid="w-deferral-scheduler">{L(" · الجدولة التلقائية مفوّضة بالاعتراف (تفويض دائم)", " · The scheduler is authorised to recognise them (standing authorisation)")}</span> : null}
      {" "}<Link href="/dashboard/accounting/deferrals">{L("قوالب التأجيل ←", "Deferral templates →")}</Link>
    </p>
  );
}

/** «تفاصيل المعاملات المتكررة» — Qoyod's tabs, columns and «السابق / التالي»; the failed-runs badge (council F6). */
function RecurringSection() {
  const { L, ar } = useLang();
  const [tab, setTab] = useState<RecTab>("ALL");
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(10);
  const r = useApi<RecWidget>(`/api/accounting/recurring/widget?tab=${tab}&take=${size}&skip=${(page - 1) * size}`);
  const w = r.data;
  const day = (iso: string) => new Date(new Date(iso).getTime() + 3 * 3600_000).toISOString().slice(0, 10);
  return (
    <Section title={L("تفاصيل المعاملات المتكررة", "Recurring transactions")} testId="w-recurring"
      actions={<Link href="/dashboard/accounting/recurring" className="qa-link">{L("المعاملات المتكررة ←", "Recurring transactions →")}</Link>}>
      {w?.failedRuns ? <p role="status" className="acct-hint" data-testid="w-recurring-failed"><span className="hr-dot tone-danger"><span>{L(`${w.failedRuns} تشغيل فاشل ينتظر «إعادة المحاولة»`, `${w.failedRuns} failed run(s) waiting for «Retry»`)}</span></span></p> : null}
      {w?.dueNow ? <p role="status" className="acct-hint" data-testid="w-recurring-due">{L(`${w.dueNow} مستحقة الآن — «تشغيل المستحق الآن» في صفحة المعاملات المتكررة.`, `${w.dueNow} due now — «Run due now» on the recurring page.`)}</p> : null}
      <div className="hr-tabs is-underline" role="tablist" aria-label={L("أنواع المعاملات", "Transaction types")}>
        {(w?.tabs ?? [{ key: "ALL" as RecTab, ar: "الكل", en: "All", supported: true, count: 0 }]).map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={`hr-tab${tab === t.key ? " is-active" : ""}`} onClick={() => { setTab(t.key); setPage(1); }} data-testid={`w-recurring-tab-${t.key}`}>
            {ar ? t.ar : t.en}{t.supported ? <span className="hr-count">{t.count}</span> : null}
          </button>
        ))}
      </div>
      {r.error ? <p role="alert" className="hr-err">{r.error}</p> : !w ? <OpsLoading rows={3} /> : w.notSupported ? (
        <p className="qa-note" data-testid="w-recurring-phase2">{ar ? w.notSupported.ar : w.notSupported.en}</p>
      ) : w.rows.length === 0 ? <p className="qa-note" data-testid="w-recurring-none">{L("لا معاملات متكررة.", "No recurring transactions.")}</p> : (
        <div className="hr-tablewrap">
          <table className="hr-table is-dense" data-testid="w-recurring-table">
            <thead><tr><th>{L("المرجع", "Reference")}</th><th>{L("الإسم", "Name")}</th><th>{L("تاريخ الإنشاء", "Created")}</th><th>{L("تاريخ التكرار التالي", "Next run")}</th><th>{L("الحالة", "Status")}</th><th>{L("الخيارات", "Options")}</th></tr></thead>
            <tbody>
              {w.rows.map((x) => (
                <tr key={x.id}>
                  <td><bdi className="acct-code">{x.ref}</bdi></td>
                  <td>{x.name}{x.failedRuns ? <span className="hr-dot tone-danger" title={L("تشغيل فاشل", "Failed run")}><span>{x.failedRuns}</span></span> : null}</td>
                  <td className="hr-num">{day(x.createdAt)}</td>
                  <td className={`hr-num${x.overdue ? " is-bad" : ""}`}>{x.nextRunDate ?? "—"}</td>
                  <td><span className={`hr-dot tone-${REC_TONE[x.status]}`}><span>{ar ? x.statusLabel.ar : x.statusLabel.en}</span></span></td>
                  <td><Link href={x.links.view}>{L("عرض", "View")}</Link> · <Link href={x.links.history}>{L("السجل", "History")}</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {w && !w.notSupported ? <TablePager page={page} pageSize={size} total={w.total} onPage={setPage} onPageSize={(n: number) => { setSize(n); setPage(1); }} sizes={[10, 25, 50]} noun={L("المعاملات", "transactions")} testId="w-recurring-pager" /> : null}
    </Section>
  );
}

function Donut({ title, side, tk, href, testId }: { title: string; side: Side; tk: ReturnType<typeof useTokens>; href: string; testId: string }) {
  const { L } = useLang();
  const notDue = Math.max(0, Number(side.notDue)), overdue = Math.max(0, Number(side.overdue));
  const empty = notDue + overdue === 0;
  const data = empty ? [{ k: "none", v: 1 }] : [{ k: "notDue", v: notDue }, { k: "overdue", v: overdue }];
  return (
    <div className="qa-donut" data-testid={testId}>
      <h3>{title}</h3>
      <div className="qa-donut-chart" aria-hidden>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} dataKey="v" innerRadius="78%" outerRadius="94%" startAngle={90} endAngle={-270} isAnimationActive={false} stroke="none">
              {data.map((x) => <Cell key={x.k} fill={x.k === "overdue" ? tk.danger : x.k === "notDue" ? tk.a : tk.grid} />)}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="qa-donut-mid">
          <span>{L("معلقة", "Outstanding")}</span><b className="hr-num" data-testid={`${testId}-open`}>{money(side.open)}</b>
          <span>{L("متأخرة", "Overdue")}</span><b className="hr-num is-bad" data-testid={`${testId}-overdue`}>{money(side.overdue)}</b>
        </div>
      </div>
      <dl className="qa-legend">
        <div><dt><i style={{ background: tk.a }} />{L("غير مستحقة بعد", "Not yet due")}</dt><dd className="hr-num">{money(side.notDue)}</dd></div>
        <div><dt><i style={{ background: tk.danger }} />{L("متأخرة", "Overdue")}</dt><dd className="hr-num">{money(side.overdue)}</dd></div>
        <div><dt>{L("إجمالي المعلقة", "Total outstanding")}</dt><dd className="hr-num">{money(side.open)} <small>{L("ر.س", "SAR")}</small></dd></div>
      </dl>
      <Link href={href} className="qa-link">{L("التفاصيل ←", "Details →")}</Link>
    </div>
  );
}

function PartySection({ title, topTitle, nameHead, side, tk, mLabel, testId, link, partyHref }: {
  title: string; topTitle: string; nameHead: string; side: Side; tk: ReturnType<typeof useTokens>; mLabel: (m: string) => string; testId: string; link: string; partyHref: ((id: string) => string) | null;
}) {
  const { L, ar } = useLang();
  return (
    <Section title={title} testId={testId}>
      <div className="qa-chart" role="img" aria-label={L(`${title}: الفواتير المنشأة والمدفوعة والمستحقة لكل شهر`, `${title}: invoices created, paid and due per month`)}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={side.monthly.map((x) => ({ m: mLabel(x.month), c: Number(x.created), p: Number(x.paid), d: Number(x.due) }))} margin={{ top: 10, right: 8, left: 8, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke={tk.grid} />
            <XAxis dataKey="m" reversed={ar} tick={{ fill: tk.muted, fontSize: 12 }} axisLine={false} tickLine={false} />
            <YAxis orientation={ar ? "right" : "left"} tick={{ fill: tk.muted, fontSize: 12 }} axisLine={false} tickLine={false} width={56} tickFormatter={compact} />
            <Tooltip formatter={(v) => money(Number(v))} />
            <Legend />
            <Line dataKey="c" name={L("فواتير أنشئت", "Invoices created")} stroke={tk.c} strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
            <Line dataKey="p" name={L("فواتير دفعت", "Invoices paid")} stroke={tk.b} strokeWidth={2} strokeDasharray="5 3" dot={{ r: 3 }} isAnimationActive={false} />
            <Line dataKey="d" name={L("فواتير مستحقة", "Invoices due")} stroke={tk.a} strokeWidth={2} dot={{ r: 3, strokeWidth: 0 }} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <DataTable caption={L(`${title} لكل شهر (جدول)`, `${title} per month (table)`)} head={[L("الشهر", "Month"), L("أنشئت", "Created"), L("دفعت", "Paid"), L("مستحقة", "Due")]}
        rows={side.monthly.map((x) => [x.month, money(x.created), money(x.paid), money(x.due)])} />
      <p className="qa-src">{L("أنشئت: قيمة فواتير الشهر · دفعت: السندات المسجلة في الشهر · مستحقة: المتبقي اليوم من فواتير يستحق سدادها في الشهر.", "Created: the month's invoices · paid: vouchers recorded in the month · due: what is still open of invoices due that month.")}</p>
      <div className="qa-top" data-testid={`${testId}-top`}>
        <div className="qc-bar is-mid"><h3>{topTitle}</h3></div>
        {side.top.length === 0 ? <p className="qa-note">{L("لا مستحقات مفتوحة.", "Nothing outstanding.")}</p> : (
          <table className="hr-table is-dense">
            <thead><tr><th>{nameHead}</th><th className="num">{L("القيمة", "Amount")}</th><th className="num">{L("منها متأخر", "Of which overdue")}</th></tr></thead>
            <tbody>
              {side.top.map((p) => (
                <tr key={p.id}>
                  <td>{partyHref ? <Link href={partyHref(p.id)}>{ar ? p.name : p.nameEn || p.name}</Link> : (ar ? p.name : p.nameEn || p.name)}</td>
                  <td className="num hr-num">{money(p.amount)}</td>
                  <td className="num hr-num">{money(p.overdue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Link href={link} className="qa-link">{L("الكشف الكامل ←", "Full aging →")}</Link>
      </div>
    </Section>
  );
}

function StockSection({ s }: { s: NonNullable<Home["stock"]> }) {
  const { L, ar } = useLang();
  const { pageRows, pager } = usePaging(s.low, 10);
  return (
    <Section title={L("حالة مخزون المنتج", "Product stock status")} testId="w-stock">
      {s.costShown && s.locations.length ? (
        <ul className="qa-locs" data-testid="w-stock-values">
          {s.locations.map((l) => <li key={l.id}><span>{ar ? l.nameAr : l.nameEn || l.nameAr}</span><b className="hr-num">{money(l.value ?? 0)}</b><small>{L("بالتكلفة", "at cost")}</small></li>)}
        </ul>
      ) : null}
      <TablePager {...pager} noun={L("الأصناف", "items")} testId="w-stock-pager" />
      {s.low.length === 0 ? <p className="qa-note" data-testid="w-stock-none">{L("لا أصناف عند حد إعادة الطلب أو تحته.", "No item at or below its reorder point.")}</p> : (
        <div className="hr-tablewrap">
          <table className="hr-table is-dense">
            <thead><tr><th>{L("الصنف", "Item")}</th><th>{L("الموقع", "Location")}</th><th className="num">{L("الكمية الحالية", "Current quantity")}</th><th className="num">{L("نقطة إعادة الطلب", "Reorder point")}</th><th>{L("الحالة", "Status")}</th></tr></thead>
            <tbody>
              {pageRows.map((x) => (
                <tr key={`${x.locationId}-${x.kind}-${x.code}`}>
                  <td><bdi className="acct-code">{x.code}</bdi> {ar ? x.name : x.nameEn}</td>
                  <td>{ar ? x.location : x.locationEn || x.location}</td>
                  <td className="num hr-num">{x.qty.toLocaleString("en-US", { maximumFractionDigits: 3 })} <small>{x.unit === "KG" ? L("كغ", "kg") : x.unit === "UNIT" ? L("وحدة", "units") : x.unit}</small></td>
                  <td className="num hr-num">{x.reorderPoint.toLocaleString("en-US")}</td>
                  <td><span className={`qa-pill ${x.out ? "is-out" : "is-low"}`}>{x.out ? L("نفد", "Out of stock") : L("تحت حد الطلب", "Below reorder point")}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="qa-src">{L("من «تحت حد إعادة الطلب» لكل موقع.", "From «below reorder point» per location.")} <Link href="/dashboard/inventory">{L("المخزون ←", "Inventory →")}</Link></p>
    </Section>
  );
}

function ActivitySection({ items }: { items: Home["activity"] }) {
  const { L } = useLang();
  const { pageRows, pager } = usePaging(items, 10);
  const kind = (k: string) => {
    const e = ACT[k];
    if (e) return L(e[0], e[1]);
    if (k.startsWith("JOURNAL_")) return L("قيد مرحّل", "Journal posted");
    return k;
  };
  return (
    <Section title={L("سجل النشاطات", "Activity log")} testId="w-activity">
      {items.length === 0 ? <p className="qa-note">{L("لا نشاط بعد.", "No activity yet.")}</p> : (
        <>
          <div className="hr-tablewrap">
            <table className="hr-table is-dense">
              <thead><tr><th>{L("الوقت", "When")}</th><th>{L("النشاط", "Activity")}</th><th>{L("المرجع", "Reference")}</th><th>{L("الطرف", "Party")}</th><th className="num">{L("المبلغ", "Amount")}</th></tr></thead>
              <tbody>
                {pageRows.map((a, i) => (
                  <tr key={`${a.kind}-${a.ref}-${i}`}>
                    <td className="hr-num">{new Date(a.at).toLocaleString("en-GB", { timeZone: "Asia/Riyadh", dateStyle: "short", timeStyle: "short" })}</td>
                    <td>{kind(a.kind)}</td>
                    <td>{a.href ? <Link href={a.href}><bdi>{a.ref}</bdi></Link> : <bdi>{a.ref}</bdi>}</td>
                    <td>{a.party ?? "—"}</td>
                    <td className="num hr-num">{a.amount ? money(a.amount) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <TablePager {...pager} noun={L("النشاطات", "entries")} testId="w-activity-pager" />
        </>
      )}
    </Section>
  );
}

/** The chart's figures as a table (accessible alternative; collapsed by default). */
function DataTable({ caption, head, rows }: { caption: string; head: string[]; rows: string[][] }) {
  return (
    <details className="qa-data">
      <summary>{caption}</summary>
      <table className="hr-table is-dense">
        <thead><tr>{head.map((h, i) => <th key={h} className={i ? "num" : undefined}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r) => <tr key={r[0]}>{r.map((c, i) => <td key={i} className={i ? "num hr-num" : "hr-num"}>{c}</td>)}</tr>)}</tbody>
      </table>
    </details>
  );
}
