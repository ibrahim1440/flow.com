"use client";

// «التقارير» (Figma ACC-24 trial balance, ACC-25 general ledger; A5: ACC-27 income statement, ACC-28 balance sheet,
// ACC-85 cash flow, and the auditor's SoD exceptions): any range, posted entries only. A trial balance or statement row
// opens that account's ledger for the same range (kept in the URL); the ledger opens the entry, the entry its source.
import Link from "next/link";
import { Suspense, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { OpsLoading } from "@/components/ops/ui";
import { Select } from "@/components/ui/Select";
import { SOURCE_DOC, plain, sourceDocHref } from "@/lib/accounting/source-links";
import { AcctShell, money, todayRiyadh, useApi, useLang, type Setup } from "../_ui/shell";
import { BalanceSheet, CashFlow, IncomeStatement } from "../_ui/statements";
import { SodExceptions } from "../_ui/close";

type View = "tb" | "ledger" | "income" | "balance" | "cashflow" | "sod";
const VIEWS: View[] = ["tb", "ledger", "income", "balance", "cashflow", "sod"];

type Tb = { from: string; to: string; balanced: boolean; rows: { accountId: string; code: string; nameAr: string | null; nameEn: string; openingDebit: string; openingCredit: string; periodDebit: string; periodCredit: string; closingDebit: string; closingCredit: string }[]; totals: Record<string, string> };
type Gl = { account: { id: string; code: string; nameAr: string | null; nameEn: string; normalBalance: string; controlType: string | null }; from: string; to: string; opening: string; closing: string; periodDebit: string; periodCredit: string; total: number;
  lines: { entryId: string; ref: string; entryDate: string; memo: string | null; lineMemo: string | null; sourceModule?: string | null; sourceType: string | null; sourceId: string | null; debit: string; credit: string; balance: string; partyType: string | null; partyId: string | null }[] };
type Acc = { id: string; code: string; nameAr: string | null; nameEn: string };

function Reports() {
  const { L, lang } = useLang();
  const router = useRouter();
  const path = usePathname();
  const sp = useSearchParams();
  const view: View = (VIEWS as string[]).includes(sp.get("view") ?? "") ? (sp.get("view") as View) : "tb";
  const yearStart = `${todayRiyadh().slice(0, 4)}-01-01`;
  const from = sp.get("from") ?? yearStart;
  const to = sp.get("to") ?? todayRiyadh();
  const accountId = sp.get("accountId") ?? "";
  const zero = sp.get("zero") === "1";
  const go = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) { if (v === null || v === "") p.delete(k); else p.set(k, v); }
    router.replace(`${path}?${p}`);
  };
  const setup = useApi<Setup>("/api/accounting/setup");
  const tb = useApi<Tb>(view === "tb" ? `/api/accounting/trial-balance?from=${from}&to=${to}${zero ? "&includeZero=1" : ""}` : null);
  const gl = useApi<Gl>(view === "ledger" && accountId ? `/api/accounting/ledger?accountId=${encodeURIComponent(accountId)}&from=${from}&to=${to}` : null);
  const coa = useApi<Acc[]>(view === "ledger" ? "/api/accounting/coa" : null);
  // A5 statements: a month / quarter / year (or a custom range) with a comparative; the balance sheet as of a day.
  const kind = sp.get("kind") ?? (view === "cashflow" ? "year" : "month");
  const year = sp.get("year") ?? todayRiyadh().slice(0, 4);
  const n = sp.get("n") ?? (kind === "quarter" ? String(Math.floor((Number(todayRiyadh().slice(5, 7)) - 1) / 3) + 1) : todayRiyadh().slice(5, 7).replace(/^0/, ""));
  const compare = sp.get("compare") ?? "prior";
  const asOf = sp.get("asOf") ?? todayRiyadh();
  const compareAsOf = sp.get("compareAsOf") ?? `${Number(asOf.slice(0, 4)) - 1}-12-31`;
  const periodQuery = kind === "custom" ? `from=${from}&to=${to}` : `kind=${kind}&year=${year}&n=${n}`;
  const stQuery = view === "income" ? `${periodQuery}&compare=${compare}` : view === "balance" ? `asOf=${asOf}&compareAsOf=${compareAsOf}` : periodQuery;
  const api: Partial<Record<View, string>> = { income: "/api/accounting/statements/income", balance: "/api/accounting/statements/balance-sheet", cashflow: "/api/accounting/statements/cash-flow" };
  const csv = useMemo(() => (view === "tb" ? `/api/accounting/trial-balance?from=${from}&to=${to}&format=csv`
    : view === "ledger" ? (accountId ? `/api/accounting/ledger?accountId=${encodeURIComponent(accountId)}&from=${from}&to=${to}&format=csv` : null)
    : view === "sod" ? `/api/accounting/sod/exceptions?from=${from}&to=${to}&format=csv`
    : `${api[view]}?${stQuery}&format=csv`), [view, from, to, accountId, stQuery]); // eslint-disable-line react-hooks/exhaustive-deps
  const print = view === "income" || view === "balance" || view === "cashflow" ? `/dashboard/accounting/reports/print?report=${view}&${stQuery}` : null;
  const name = (a: { nameAr: string | null; nameEn: string }) => L(a.nameAr ?? a.nameEn, a.nameEn);

  return (
    <AcctShell setup={setup.data} actions={<span className="acct-actions">
      {print ? <Link className="hr-btn" href={print} data-testid="report-print">{L("طباعة / PDF", "Print / PDF")}</Link> : null}
      {csv ? <a className="hr-btn" href={csv} data-testid="report-csv">{L("تصدير CSV", "Export CSV")}</a> : null}
    </span>}>
      <div className="acct-row">
        <div className="acct-seg" role="group" aria-label={L("التقرير", "Report")}>
          <button type="button" aria-pressed={view === "tb"} onClick={() => go({ view: null })} data-testid="view-tb">{L("ميزان المراجعة", "Trial balance")}</button>
          <button type="button" aria-pressed={view === "ledger"} onClick={() => go({ view: "ledger" })} data-testid="view-ledger">{L("دفتر الأستاذ", "General ledger")}</button>
          <button type="button" aria-pressed={view === "income"} onClick={() => go({ view: "income" })} data-testid="view-income">{L("قائمة الدخل", "Income statement")}</button>
          <button type="button" aria-pressed={view === "balance"} onClick={() => go({ view: "balance" })} data-testid="view-balance">{L("المركز المالي", "Balance sheet")}</button>
          <button type="button" aria-pressed={view === "cashflow"} onClick={() => go({ view: "cashflow" })} data-testid="view-cashflow">{L("التدفقات النقدية", "Cash flow")}</button>
          <button type="button" aria-pressed={view === "sod"} onClick={() => go({ view: "sod" })} data-testid="view-sod">{L("استثناءات فصل المهام", "SoD exceptions")}</button>
        </div>
      </div>
      {view === "income" || view === "cashflow" ? (
        <div className="acct-row">
          <label className="hr-field"><span className="hr-label">{L("الفترة", "Period")}</span>
            <Select value={kind} onChange={(e) => go({ kind: e.target.value, n: null })} data-testid="st-kind">
              <option value="month">{L("شهر", "Month")}</option><option value="quarter">{L("ربع سنة", "Quarter")}</option><option value="year">{L("سنة", "Year")}</option><option value="custom">{L("فترة مخصصة", "Custom range")}</option>
            </Select></label>
          {kind !== "custom" ? <label className="hr-field"><span className="hr-label">{L("السنة", "Year")}</span><input className="hr-input" dir="ltr" inputMode="numeric" value={year} onChange={(e) => /^\d{4}$/.test(e.target.value) && go({ year: e.target.value })} data-testid="st-year" /></label> : null}
          {kind === "month" || kind === "quarter" ? <label className="hr-field"><span className="hr-label">{kind === "month" ? L("الشهر", "Month") : L("الربع", "Quarter")}</span>
            <Select value={n} onChange={(e) => go({ n: e.target.value })} data-testid="st-n">
              {Array.from({ length: kind === "month" ? 12 : 4 }, (_, i) => <option key={i} value={String(i + 1)}>{kind === "month" ? String(i + 1).padStart(2, "0") : `Q${i + 1}`}</option>)}
            </Select></label> : null}
          {view === "income" ? <label className="hr-field"><span className="hr-label">{L("المقارنة", "Compare with")}</span>
            <Select value={compare} onChange={(e) => go({ compare: e.target.value })} data-testid="st-compare">
              <option value="prior">{L("الفترة السابقة", "The previous period")}</option><option value="lastYear">{L("الفترة نفسها من العام الماضي", "The same period last year")}</option><option value="none">{L("بلا مقارنة", "None")}</option>
            </Select></label> : null}
        </div>
      ) : view === "balance" ? (
        <div className="acct-row">
          <label className="hr-field"><span className="hr-label">{L("كما في", "As of")}</span><input type="date" className="hr-input" value={asOf} onChange={(e) => e.target.value && go({ asOf: e.target.value })} data-testid="bs-asof" /></label>
          <label className="hr-field"><span className="hr-label">{L("مقارنة بـ", "Compare with")}</span><input type="date" className="hr-input" value={compareAsOf === "none" ? "" : compareAsOf} onChange={(e) => go({ compareAsOf: e.target.value || "none" })} data-testid="bs-compare" /></label>
        </div>
      ) : null}
      {view === "tb" || view === "ledger" || view === "sod" || ((view === "income" || view === "cashflow") && kind === "custom") ? (
      <div className="acct-row">
        <label className="hr-field"><span className="hr-label">{L("من", "From")}</span><input type="date" className="hr-input" value={from} onChange={(e) => e.target.value && go({ from: e.target.value })} data-testid="report-from" /></label>
        <label className="hr-field"><span className="hr-label">{L("إلى", "To")}</span><input type="date" className="hr-input" value={to} onChange={(e) => e.target.value && go({ to: e.target.value })} data-testid="report-to" /></label>
        {view === "ledger" ? (
          <label className="hr-field acct-grow"><span className="hr-label">{L("الحساب", "Account")}</span>
            <Select value={accountId} onChange={(e) => go({ accountId: e.target.value })} placeholder={L("اختر الحساب", "Choose the account")} data-testid="ledger-account">
              <option value="">{L("اختر الحساب", "Choose the account")}</option>
              {(coa.data ?? []).map((a) => <option key={a.id} value={a.id}>{`${a.code} · ${name(a)}`}</option>)}
            </Select></label>
        ) : (
          view === "tb" ? <label className="hr-field"><span className="hr-label"><input type="checkbox" checked={zero} onChange={(e) => go({ zero: e.target.checked ? "1" : null })} /> {L("إظهار الحسابات الصفرية", "Show zero accounts")}</span></label> : null
        )}
      </div>) : null}
      {view === "income" ? <IncomeStatement query={stQuery} /> : view === "balance" ? <BalanceSheet query={stQuery} /> : view === "cashflow" ? <CashFlow query={stQuery} /> : null}
      {view === "sod" ? <SodExceptions from={from} to={to} /> : view !== "tb" && view !== "ledger" ? null : view === "tb" ? (
        tb.error ? <p role="alert" className="hr-err">{tb.error}</p> : !tb.data ? <OpsLoading /> : (
          <>
            <p className={`acct-balanced ${tb.data.balanced ? "is-ok" : "is-bad"}`} data-testid="tb-balanced">
              {L("آخر المدة: مدين", "Closing: debit")} <span className="hr-num">{money(tb.data.totals.closingDebit)}</span> = {L("دائن", "credit")} <span className="hr-num">{money(tb.data.totals.closingCredit)}</span> · {tb.data.balanced ? L("● متوازن", "● Balanced") : L("● غير متوازن", "● Not balanced")}
              <span className="acct-hint"> · {tb.data.rows.length} {L("حسابًا", "accounts")}{zero ? "" : L(" · الحسابات التي كل أعمدتها صفر لا تظهر", " · all-zero accounts hidden")}</span>
            </p>
            <div className="hr-tablewrap">
              <table className="hr-table is-dense" data-testid="tb-table">
                <thead><tr><th>{L("الرمز", "Code")}</th><th>{L("الحساب", "Account")}</th><th className="num acct-hide-m">{L("أول المدة مدين", "Opening Dr")}</th><th className="num acct-hide-m">{L("أول المدة دائن", "Opening Cr")}</th><th className="num acct-hide-m">{L("حركة مدين", "Movement Dr")}</th><th className="num acct-hide-m">{L("حركة دائن", "Movement Cr")}</th><th className="num">{L("آخر المدة مدين", "Closing Dr")}</th><th className="num">{L("آخر المدة دائن", "Closing Cr")}</th></tr></thead>
                <tbody>
                  {tb.data.rows.map((r) => (
                    <tr key={r.accountId} className="is-clickable" onClick={() => go({ view: "ledger", accountId: r.accountId })}>
                      <td className="acct-code">{r.code}</td>
                      <td><Link href={`${path}?view=ledger&accountId=${r.accountId}&from=${from}&to=${to}`} onClick={(e) => e.stopPropagation()}>{name(r)}</Link></td>
                      <td className="num hr-num acct-hide-m">{money(r.openingDebit, true)}</td><td className="num hr-num acct-hide-m">{money(r.openingCredit, true)}</td>
                      <td className="num hr-num acct-hide-m">{money(r.periodDebit, true)}</td><td className="num hr-num acct-hide-m">{money(r.periodCredit, true)}</td>
                      <td className="num hr-num">{money(r.closingDebit, true)}</td><td className="num hr-num">{money(r.closingCredit, true)}</td>
                    </tr>
                  ))}
                  <tr className="is-total">
                    <td /><td>{L("المجموع (ر.س)", "Total (SAR)")}</td>
                    <td className="num hr-num acct-hide-m">{money(tb.data.totals.openingDebit)}</td><td className="num hr-num acct-hide-m">{money(tb.data.totals.openingCredit)}</td>
                    <td className="num hr-num acct-hide-m">{money(tb.data.totals.periodDebit)}</td><td className="num hr-num acct-hide-m">{money(tb.data.totals.periodCredit)}</td>
                    <td className="num hr-num" data-testid="tb-closing-debit">{money(tb.data.totals.closingDebit)}</td><td className="num hr-num" data-testid="tb-closing-credit">{money(tb.data.totals.closingCredit)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="acct-hint">{L("صف الحساب يفتح دفتر الأستاذ للفترة نفسها. القيود غير المرحّلة لا تدخل التقرير أبدًا.", "A row opens the account's ledger for the same range. Unposted entries never enter the report.")}</p>
          </>
        )
      ) : !accountId ? <p className="acct-hint">{L("اختر حسابًا لعرض دفتر الأستاذ.", "Choose an account to see its ledger.")}</p> : gl.error ? <p role="alert" className="hr-err">{gl.error}</p> : !gl.data ? <OpsLoading /> : (
        <>
          <p className="acct-hint"><Link href={`${path}?from=${from}&to=${to}`}>→ {L(`رجوع إلى ميزان المراجعة · ${from} – ${to}`, `Back to the trial balance · ${from} – ${to}`)}</Link> · {gl.data.account.normalBalance === "CREDIT" ? L("دائن بطبيعته", "Credit-normal") : L("مدين بطبيعته", "Debit-normal")}{gl.data.account.controlType ? L(" · حساب مراقبة", " · control account") : ""}</p>
          <div className="hr-tablewrap">
            <table className="hr-table is-dense" data-testid="gl-table">
              <thead><tr><th>{L("التاريخ", "Date")}</th><th>{L("القيد", "Entry")}</th><th>{L("الوصف", "Description")}</th><th className="acct-hide-m">{L("المصدر", "Source")}</th><th className="num">{L("مدين", "Debit")}</th><th className="num">{L("دائن", "Credit")}</th><th className="num">{L("الرصيد", "Balance")}</th></tr></thead>
              <tbody>
                <tr className="is-header"><td className="hr-num">{gl.data.from}</td><td /><td>{L("رصيد أول المدة", "Opening balance")}</td><td className="acct-hide-m" /><td /><td /><td className="num hr-num" data-testid="gl-opening">{money(gl.data.opening)}</td></tr>
                {gl.data.lines.map((l, i) => (
                  <tr key={`${l.entryId}-${i}`}>
                    <td className="hr-num">{l.entryDate}</td>
                    <td><Link className="acct-code" href={`/dashboard/accounting/journals/${l.entryId}`}>{l.ref}</Link></td>
                    <td>{l.lineMemo ?? l.memo ?? "—"}</td>
                    <td className="acct-hide-m" title={l.sourceType ? `${l.sourceType} · ${l.sourceId}` : undefined}>{l.sourceType ? (sourceDocHref(l.sourceType, l.sourceId, {}, l.sourceModule) ? <Link href={sourceDocHref(l.sourceType, l.sourceId, {}, l.sourceModule)!}>{plain(SOURCE_DOC, l.sourceType, lang)}</Link> : plain(SOURCE_DOC, l.sourceType, lang)) : "—"}</td>
                    <td className="num hr-num">{money(l.debit, true)}</td><td className="num hr-num">{money(l.credit, true)}</td><td className="num hr-num">{money(l.balance)}</td>
                  </tr>
                ))}
                <tr className="is-total"><td className="hr-num">{gl.data.to}</td><td /><td>{L("الرصيد الختامي", "Closing balance")}</td><td className="acct-hide-m" /><td className="num hr-num">{money(gl.data.periodDebit)}</td><td className="num hr-num">{money(gl.data.periodCredit)}</td><td className="num hr-num" data-testid="gl-closing">{money(gl.data.closing)}</td></tr>
              </tbody>
            </table>
          </div>
          {gl.data.total > gl.data.lines.length ? <p className="acct-hint">{L(`يُعرض أول ${gl.data.lines.length} من ${gl.data.total} سطرًا؛ صدّر CSV للكل.`, `Showing the first ${gl.data.lines.length} of ${gl.data.total} lines; export CSV for all.`)}</p> : null}
        </>
      )}
    </AcctShell>
  );
}

export default function ReportsPage() {
  return <Suspense fallback={<OpsLoading />}><Reports /></Suspense>;
}
