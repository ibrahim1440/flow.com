"use client";

// Accounting A5 — the financial statements on the «التقارير» page (Direction 2.1; Figma ACC-27 قائمة الدخل,
// ACC-28 المركز المالي, ACC-85 التدفقات النقدية): the statement on the start side, «تعريف التقرير» and the checks
// on the end side. Every account row opens its general ledger for the same range (line → accounts → GL → entry →
// source document). Read-only: the API computes everything from posted entries.
import Link from "next/link";
import { OpsLoading } from "@/components/ops/ui";
import { money, useApi, useLang } from "./shell";

type Line = { accountId: string; code: string; name: string; nameEn: string; amounts: string[] };
type Section = { key: string; ar: string; en: string; lines: Line[]; totals: string[] };
type Pl = {
  columns: { from: string; to: string; label: string }[]; sections: Section[];
  totals: Record<"revenue" | "costOfSales" | "grossProfit" | "operatingExpenses" | "operatingProfit" | "otherNet" | "profitBeforeZakat" | "zakat" | "netProfit", string[]> & Record<"grossMarginPct" | "operatingMarginPct" | "netMarginPct", (string | null)[]>;
  variance: { netProfit: string; revenue: string; revenuePct: string | null } | null;
};
type Bs = {
  columns: { asOf: string }[]; sections: Section[]; earnings: { currentYear: string[]; priorYearsNotClosed: string[] };
  totals: Record<"currentAssets" | "nonCurrentAssets" | "assets" | "currentLiabilities" | "nonCurrentLiabilities" | "liabilities" | "equity" | "liabilitiesAndEquity" | "workingCapital", string[]> & { currentRatio: (string | null)[] };
  difference: string[]; balanced: boolean;
};
type CfLine = { accountId: string; code: string; name: string; amount: string };
type Cf = { from: string; to: string; netProfit: string; nonCash: { lines: CfLine[]; total: string }; workingCapital: { lines: CfLine[]; total: string }; operating: string; investing: { lines: CfLine[]; total: string }; financing: { lines: CfLine[]; total: string }; netChange: string; cashStart: string; cashEnd: string; actualChange: string; difference: string; reconciled: boolean; cashAccounts: { code: string; name: string }[] };

const gl = (accountId: string, from: string, to: string) => `/dashboard/accounting/reports?view=ledger&accountId=${encodeURIComponent(accountId)}&from=${from}&to=${to}`;
const pctText = (v: string | null | undefined) => (v === null || v === undefined ? "—" : `${v}%`);

function SideCard({ title, rows, children }: { title: string; rows: [string, React.ReactNode][]; children?: React.ReactNode }) {
  return (
    <section className="acct-side">
      <h3>{title}</h3>
      <dl className="acct-kv">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      {children}
    </section>
  );
}

function Rows({ s, cols, from, to, testId }: { s: Section; cols: number; from: string; to: string; testId?: string }) {
  const { L } = useLang();
  return (
    <>
      <tr className="is-header" data-testid={testId}><td colSpan={cols + 1}>{L(s.ar, s.en)}</td></tr>
      {s.lines.length === 0 ? <tr className="is-muted"><td colSpan={cols + 1}>{L("لا حركة", "No movement")}</td></tr> : s.lines.map((l) => (
        <tr key={l.accountId} className="is-clickable">
          <td><Link href={gl(l.accountId, from, to)} data-testid={`st-line-${l.code}`}><span className="acct-code">{l.code}</span> {L(l.name, l.nameEn)}</Link></td>
          {l.amounts.map((a, i) => <td key={i} className={`num hr-num${i > 0 ? " acct-hide-m" : ""}`}>{money(a)}</td>)}
        </tr>
      ))}
      <tr className="is-total"><td>{L(`مجموع ${s.ar}`, `Total ${s.en.toLowerCase()}`)}</td>{s.totals.map((t, i) => <td key={i} className={`num hr-num${i > 0 ? " acct-hide-m" : ""}`}>{money(t)}</td>)}</tr>
    </>
  );
}

function SumRow({ label, values, strong, testId, pct }: { label: string; values: (string | null)[]; strong?: boolean; testId?: string; pct?: boolean }) {
  return (
    <tr className={strong ? "is-total is-grand" : "is-sub"} data-testid={testId}>
      <td>{label}</td>
      {values.map((v, i) => <td key={i} className={`num hr-num${i > 0 ? " acct-hide-m" : ""}`}>{pct ? pctText(v) : money(v ?? "0")}</td>)}
    </tr>
  );
}

export function IncomeStatement({ query }: { query: string }) {
  const { L } = useLang();
  const r = useApi<Pl>(`/api/accounting/statements/income?${query}`);
  if (r.error) return <p role="alert" className="hr-err">{r.error}</p>;
  if (!r.data) return <OpsLoading />;
  const d = r.data, c = d.columns, cols = c.length, from = c[0].from, to = c[0].to;
  const sec = (k: string) => d.sections.find((s) => s.key === k)!;
  return (
    <div className="acct-split">
      <div className="hr-tablewrap">
        <table className="hr-table is-dense acct-statement" data-testid="pl-table">
          <thead><tr><th>{L("الحساب", "Account")}</th>{c.map((x, i) => <th key={i} className={`num${i > 0 ? " acct-hide-m" : ""}`}>{i === 0 ? L("المبلغ · ر.س", "Amount · SAR") : L("المقارنة", "Comparative")}<span className="acct-th-sub hr-num">{x.from} – {x.to}</span></th>)}</tr></thead>
          <tbody>
            <Rows s={sec("REVENUE")} cols={cols} from={from} to={to} testId="pl-revenue" />
            <Rows s={sec("COST_OF_SALES")} cols={cols} from={from} to={to} />
            <SumRow label={L("مجمل الربح", "Gross profit")} values={d.totals.grossProfit} testId="pl-gross" />
            <SumRow label={L("هامش مجمل الربح", "Gross margin")} values={d.totals.grossMarginPct} pct testId="pl-gross-margin" />
            <Rows s={sec("OPERATING_EXPENSE")} cols={cols} from={from} to={to} />
            <SumRow label={L("الربح التشغيلي", "Operating profit")} values={d.totals.operatingProfit} />
            {sec("OTHER_INCOME_EXPENSE").lines.length ? <Rows s={sec("OTHER_INCOME_EXPENSE")} cols={cols} from={from} to={to} /> : null}
            {sec("ZAKAT").lines.length ? <><SumRow label={L("الربح قبل الزكاة", "Profit before zakat")} values={d.totals.profitBeforeZakat} /><Rows s={sec("ZAKAT")} cols={cols} from={from} to={to} /></> : null}
            <SumRow label={L("صافي الربح (الخسارة)", "Net profit (loss)")} values={d.totals.netProfit} strong testId="pl-net" />
          </tbody>
        </table>
      </div>
      <aside className="acct-aside">
        <SideCard title={L("تعريف التقرير", "About this report")} rows={[
          [L("الفترة", "Period"), <span key="p" className="hr-num">{from} – {to}</span>],
          [L("المصدر", "Source"), L("القيود المرحّلة والمعكوسة فقط", "Posted and reversed entries only")],
          [L("المقارنة", "Comparative"), cols > 1 ? <span key="c" className="hr-num">{c[1].from} – {c[1].to}</span> : L("بلا مقارنة", "None")],
          [L("العرض", "Layout"), L("حسب الوظيفة (المعيار الدولي للمنشآت الصغيرة والمتوسطة)", "By function (IFRS for SMEs)")],
        ]} />
        <SideCard title={L("المؤشرات", "Ratios")} rows={[
          [L("هامش مجمل الربح", "Gross margin"), <span key="g" className="hr-num" data-testid="pl-gm-side">{pctText(d.totals.grossMarginPct[0])}</span>],
          [L("الهامش التشغيلي", "Operating margin"), <span key="o" className="hr-num">{pctText(d.totals.operatingMarginPct[0])}</span>],
          [L("صافي الهامش", "Net margin"), <span key="n" className="hr-num">{pctText(d.totals.netMarginPct[0])}</span>],
          ...(d.variance ? [[L("تغيّر الإيرادات", "Revenue change"), <span key="v" className="hr-num">{money(d.variance.revenue)} · {pctText(d.variance.revenuePct)}</span>] as [string, React.ReactNode]] : []),
        ]} />
        <p className="acct-hint">{L("صف الحساب يفتح دفتر الأستاذ للفترة نفسها، ومنه القيد ثم المستند المصدر. قيد إقفال السنة لا يدخل قائمة الدخل.", "An account row opens its ledger for the same period, then the entry and its source document. The year-end closing entry is left out of the P&L.")}</p>
        <p className="acct-hint" data-testid="pl-cogs-basis">{L("الإيراد يُثبت عند إصدار الفاتورة وتكلفة المبيعات عند التسليم: إن صدرت الفاتورة في شهر والتسليم في آخر يتأثر الهامش، فاجعل نقطة الفوترة «عند التسليم».", "Revenue is recognised when the invoice is issued and its cost when the goods are delivered: an invoice and its delivery in different months move the margin — set the invoicing point to «on delivery».")}</p>
      </aside>
    </div>
  );
}

export function BalanceSheet({ query }: { query: string }) {
  const { L } = useLang();
  const r = useApi<Bs>(`/api/accounting/statements/balance-sheet?${query}`);
  if (r.error) return <p role="alert" className="hr-err">{r.error}</p>;
  if (!r.data) return <OpsLoading />;
  const d = r.data, cols = d.columns.length, asOf = d.columns[0].asOf, from = `${asOf.slice(0, 4)}-01-01`;
  const sec = (k: string) => d.sections.find((s) => s.key === k)!;
  return (
    <div className="acct-split">
      <div className="hr-tablewrap">
        <p className={`acct-balanced ${d.balanced ? "is-ok" : "is-bad"}`} data-testid="bs-balanced">
          {L("الأصول", "Assets")} <span className="hr-num">{money(d.totals.assets[0])}</span> = {L("الالتزامات وحقوق الملكية", "Liabilities and equity")} <span className="hr-num">{money(d.totals.liabilitiesAndEquity[0])}</span> · {d.balanced ? L("● متوازنة", "● Balances") : L(`● فرق ${d.difference[0]}`, `● Difference ${d.difference[0]}`)}
        </p>
        <table className="hr-table is-dense acct-statement" data-testid="bs-table">
          <thead><tr><th>{L("الحساب", "Account")}</th>{d.columns.map((x, i) => <th key={i} className={`num${i > 0 ? " acct-hide-m" : ""}`}>{L("كما في", "As of")} <span className="hr-num">{x.asOf}</span></th>)}</tr></thead>
          <tbody>
            <Rows s={sec("CURRENT_ASSET")} cols={cols} from={from} to={asOf} />
            <Rows s={sec("NON_CURRENT_ASSET")} cols={cols} from={from} to={asOf} />
            <SumRow label={L("مجموع الأصول", "Total assets")} values={d.totals.assets} strong testId="bs-assets" />
            <Rows s={sec("CURRENT_LIABILITY")} cols={cols} from={from} to={asOf} />
            <Rows s={sec("NON_CURRENT_LIABILITY")} cols={cols} from={from} to={asOf} />
            <SumRow label={L("مجموع الالتزامات", "Total liabilities")} values={d.totals.liabilities} />
            <Rows s={sec("EQUITY")} cols={cols} from={from} to={asOf} />
            <SumRow label={L("أرباح السنة الحالية غير المقفلة", "Current-year profit (not yet closed)")} values={d.earnings.currentYear} testId="bs-current-earnings" />
            {d.earnings.priorYearsNotClosed.some((x) => x !== "0.00") ? <SumRow label={L("أرباح سنوات سابقة لم تُقفل", "Earlier years' profit not closed")} values={d.earnings.priorYearsNotClosed} /> : null}
            <SumRow label={L("مجموع حقوق الملكية", "Total equity")} values={d.totals.equity} />
            <SumRow label={L("مجموع الالتزامات وحقوق الملكية", "Total liabilities and equity")} values={d.totals.liabilitiesAndEquity} strong testId="bs-le" />
          </tbody>
        </table>
      </div>
      <aside className="acct-aside">
        <SideCard title={L("تعريف التقرير", "About this report")} rows={[
          [L("كما في", "As of"), <span key="a" className="hr-num">{asOf}</span>],
          [L("المقارنة", "Comparative"), cols > 1 ? <span key="c" className="hr-num">{d.columns[1].asOf}</span> : L("بلا مقارنة", "None")],
          [L("المصدر", "Source"), L("أرصدة الأستاذ العام التراكمية", "Cumulative general-ledger balances")],
        ]} />
        <SideCard title={L("السيولة", "Liquidity")} rows={[
          [L("رأس المال العامل", "Working capital"), <span key="w" className="hr-num">{money(d.totals.workingCapital[0])}</span>],
          [L("نسبة التداول", "Current ratio"), <span key="r" className="hr-num">{d.totals.currentRatio[0] ?? "—"}</span>],
        ]} />
        <p className="acct-hint">{L("أرباح السنة تبقى في «أرباح السنة الحالية» حتى قيد إقفال السنة الذي ينقلها إلى الأرباح المبقاة.", "The year's profit stays in «current-year profit» until the year-end closing entry moves it to retained earnings.")}</p>
      </aside>
    </div>
  );
}

function CfBlock({ title, b, from, to }: { title: string; b: { lines: CfLine[]; total: string }; from: string; to: string }) {
  const { L } = useLang();
  return (
    <>
      <tr className="is-header"><td colSpan={2}>{title}</td></tr>
      {b.lines.map((l) => <tr key={l.accountId}><td><Link href={gl(l.accountId, from, to)}><span className="acct-code">{l.code}</span> {l.name}</Link></td><td className="num hr-num">{money(l.amount)}</td></tr>)}
      <tr className="is-sub"><td>{L(`صافي ${title}`, `Net ${title}`)}</td><td className="num hr-num">{money(b.total)}</td></tr>
    </>
  );
}

export function CashFlow({ query }: { query: string }) {
  const { L } = useLang();
  const r = useApi<Cf>(`/api/accounting/statements/cash-flow?${query}`);
  if (r.error) return <p role="alert" className="hr-err">{r.error}</p>;
  if (!r.data) return <OpsLoading />;
  const d = r.data;
  return (
    <div className="acct-split">
      <div className="hr-tablewrap">
        <p className={`acct-balanced ${d.reconciled ? "is-ok" : "is-bad"}`} data-testid="cf-reconciled">
          {L("صافي التغير", "Net change")} <span className="hr-num">{money(d.netChange)}</span> = {L("تغير النقد الفعلي", "actual change in cash")} <span className="hr-num">{money(d.actualChange)}</span> · {d.reconciled ? L("● مطابق", "● Reconciled") : L(`● فرق ${d.difference}`, `● Difference ${d.difference}`)}
        </p>
        <table className="hr-table is-dense acct-statement" data-testid="cf-table">
          <thead><tr><th>{L("البند", "Item")}</th><th className="num">{L("المبلغ · ر.س", "Amount · SAR")}</th></tr></thead>
          <tbody>
            <tr className="is-header"><td colSpan={2}>{L("الأنشطة التشغيلية", "Operating activities")}</td></tr>
            <tr><td>{L("صافي الربح", "Net profit")}</td><td className="num hr-num">{money(d.netProfit)}</td></tr>
            {d.nonCash.lines.map((l) => <tr key={l.accountId}><td><Link href={gl(l.accountId, d.from, d.to)}>{L("بند غير نقدي", "Non-cash")}: <span className="acct-code">{l.code}</span> {l.name}</Link></td><td className="num hr-num">{money(l.amount)}</td></tr>)}
            {d.workingCapital.lines.map((l) => <tr key={l.accountId}><td><Link href={gl(l.accountId, d.from, d.to)}>{L("تغير", "Change in")} <span className="acct-code">{l.code}</span> {l.name}</Link></td><td className="num hr-num">{money(l.amount)}</td></tr>)}
            <tr className="is-sub" data-testid="cf-operating"><td>{L("صافي النقد من الأنشطة التشغيلية", "Net cash from operating activities")}</td><td className="num hr-num">{money(d.operating)}</td></tr>
            <CfBlock title={L("الأنشطة الاستثمارية", "investing activities")} b={d.investing} from={d.from} to={d.to} />
            <CfBlock title={L("الأنشطة التمويلية", "financing activities")} b={d.financing} from={d.from} to={d.to} />
            <tr className="is-total is-grand"><td>{L("صافي التغير في النقد", "Net change in cash")}</td><td className="num hr-num">{money(d.netChange)}</td></tr>
            <tr><td>{L("النقد أول المدة", "Cash at the start")}</td><td className="num hr-num">{money(d.cashStart)}</td></tr>
            <tr className="is-total"><td>{L("النقد آخر المدة", "Cash at the end")}</td><td className="num hr-num" data-testid="cf-cash-end">{money(d.cashEnd)}</td></tr>
          </tbody>
        </table>
      </div>
      <aside className="acct-aside">
        <SideCard title={L("تعريف التقرير", "About this report")} rows={[
          [L("الفترة", "Period"), <span key="p" className="hr-num">{d.from} – {d.to}</span>],
          [L("الطريقة", "Method"), L("غير المباشرة: من صافي الربح وتغيرات رأس المال العامل", "Indirect: from net profit and working-capital changes")],
          [L("النقد", "Cash"), d.cashAccounts.map((a) => a.code).join("، ") || "—"],
        ]} />
        <p className="acct-hint">{L("قيد الأرصدة الافتتاحية نقطة البداية لا تدفق، وقيد إقفال السنة ليس تدفقًا. التصنيف حسب مجموعة الحساب في القوائم.", "The opening entry is the starting point, not a flow; the year-end closing entry is not a flow. Classified by each account's statement group.")}</p>
      </aside>
    </div>
  );
}
