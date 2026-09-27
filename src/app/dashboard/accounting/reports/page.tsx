"use client";

// Figma: ACC-07 (trial balance → general ledger drill-down) and ACC-08 (statements).
// Every figure comes from posted journal lines via the report API; a trial-balance row opens
// that account's ledger, and a ledger line opens its journal entry.
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { Download } from "lucide-react";
import { Badge, Button, Card, CardTitle, EmptyState, ErrorState, Field, INPUT, LoadingState, Notice, Segmented, Table, Td, Th, useApi, useL } from "../../finance/_components/ui";
import { Pager, SOURCE_LABEL, riyadhToday, useAutoText, useDay } from "../_components/kit";

type View = "tb" | "is" | "bs" | "gl" | "com";
type TBLine = { accountId: string; code: string; nameEn: string; nameAr: string | null; openingDebit: number; openingCredit: number; periodDebit: number; periodCredit: number; closingDebit: number; closingCredit: number };
type TB = { lines: TBLine[]; totals: Omit<TBLine, "accountId" | "code" | "nameEn" | "nameAr">; balanced: boolean; provisionalEntries: number };
type Section = { key: string; en: string; ar: string; lines: { accountId: string; code: string; nameEn: string; nameAr: string | null; amount: number }[]; total: number };
type IS = { revenue: Section[]; expenses: Section[]; totalRevenue: number; totalExpenses: number; netIncome: number; provisionalEntries: number };
type BS = { assets: Section[]; liabilities: Section[]; equity: Section[]; currentEarnings: number; totalAssets: number; totalLiabilities: number; totalEquity: number; balanced: boolean; provisionalEntries: number };
type GL = { account: { code: string; nameEn: string; nameAr: string | null; debitNormal: boolean }; opening: number; closing: number; periodDebit: number; periodCredit: number; page: number; pageSize: number; total: number;
  lines: { id: string; entryId: string; entryNo: number; entryDate: string; description: string | null; debit: number; credit: number; balance: number; sourceModule: string; isProvisional: boolean }[] };
type Rec = { account: { code: string; nameEn: string; nameAr: string | null } | null; rows: { employeeId: string; name: string; ledgerBalance: number; subledgerPosted: number; difference: number; waitingAmount: number; waitingCount: number; beforeCutoverOrSkipped: number; withoutEventCount: number }[]; totals: { ledgerBalance: number; subledgerPosted: number; difference: number }; reconciled: boolean };
type Acc = { id: string; code: string; nameEn: string; nameAr: string | null; allowPosting: boolean };

export default function ReportsPage() {
  const { L, money, name } = useL();
  const day = useDay();
  const auto = useAutoText();
  const y = new Date().getUTCFullYear();
  const sp = useSearchParams();
  const [view, setView] = useState<View>(() => (sp.get("view") === "gl" ? "gl" : "tb"));
  const [from, setFrom] = useState(`${y}-01-01`);
  const [to, setTo] = useState(riyadhToday);
  const [prov, setProv] = useState<"include" | "exclude">("include");
  const [accountId, setAccountIdRaw] = useState(() => sp.get("accountId") ?? "");
  const [page, setPage] = useState(1);
  const setAccountId = (v: string) => { setAccountIdRaw(v); setPage(1); };
  const qs = `from=${from}&to=${to}&provisional=${prov}`;
  const tb = useApi<TB>(view === "tb" ? `/api/accounting/reports/trial-balance?${qs}` : null);
  const is = useApi<IS>(view === "is" ? `/api/accounting/reports/income-statement?${qs}` : null);
  const bs = useApi<BS>(view === "bs" ? `/api/accounting/reports/balance-sheet?${qs}` : null);
  const gl = useApi<GL>(view === "gl" && accountId ? `/api/accounting/reports/general-ledger?${qs}&accountId=${accountId}&page=${page}` : null);
  const rec = useApi<Rec>(view === "com" ? "/api/accounting/reports/commission-reconciliation" : null);
  const accounts = useApi<Acc[]>(view === "gl" ? "/api/accounting/coa" : null);

  const exportTb = () => {
    if (!tb.data) return;
    const f = (m: number) => (m / 100).toFixed(2);
    const rows = [["code", "account", "opening_debit", "opening_credit", "period_debit", "period_credit", "closing_debit", "closing_credit"],
      ...tb.data.lines.map((l) => [l.code, name(l), f(l.openingDebit), f(l.openingCredit), f(l.periodDebit), f(l.periodCredit), f(l.closingDebit), f(l.closingCredit)])];
    const csv = "﻿" + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })); a.download = `trial-balance_${from}_${to}.csv`; a.click();
  };
  const drill = (id: string) => { setAccountId(id); setView("gl"); };
  const provNote = (n: number) => n > 0 ? <Notice tone="warn">{L(`يشمل ${n} قيداً مؤقتاً (قاعدة اختبار معزولة) — استبعدها من المفتاح أعلاه للمقارنة.`, `Includes ${n} provisional entries (isolated test database) — exclude them with the switch above to compare.`)}</Notice> : null;

  const statement = (sections: Section[], title: string) => sections.flatMap((s) => [
    <tr key={s.key} className="bg-[#fafafa] font-bold"><Td>{title === "type" ? s.en : L(s.ar, s.en)}</Td><Td num>{money(s.total)}</Td></tr>,
    ...s.lines.map((l) => <tr key={l.accountId} className="hover:bg-cream/40 cursor-pointer" onClick={() => drill(l.accountId)}><Td><span className="ps-4">{l.code} · {name(l)}</span></Td><Td num>{money(l.amount)}</Td></tr>),
  ]);

  return (
    <Card>
      <div className="flex items-end gap-3 flex-wrap">
        <Segmented<View> value={view} onChange={setView} options={[{ value: "tb", label: L("ميزان المراجعة", "Trial balance") }, { value: "is", label: L("قائمة الدخل", "Income statement") }, { value: "bs", label: L("المركز المالي", "Balance sheet") }, { value: "gl", label: L("دفتر الأستاذ", "General ledger") }, { value: "com", label: L("مطابقة العمولات", "Commission reconciliation") }]} />
        {view !== "com" && <>
          {view !== "bs" && <Field label={L("من", "From")}><input type="date" className={INPUT} value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} /></Field>}
          <Field label={view === "bs" ? L("كما في", "As of") : L("إلى", "To")}><input type="date" className={INPUT} value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} /></Field>
          <Segmented<"include" | "exclude"> value={prov} onChange={(v) => { setProv(v); setPage(1); }} options={[{ value: "include", label: L("يشمل المؤقت", "Include provisional") }, { value: "exclude", label: L("يستبعده", "Exclude") }]} />
        </>}
        {view === "tb" && <Button icon={Download} onClick={exportTb} disabled={!tb.data?.lines.length}>{L("تصدير CSV", "Export CSV")}</Button>}
      </div>

      {view === "tb" && (tb.error ? <ErrorState error={tb.error} onRetry={tb.reload} /> : !tb.data ? <LoadingState /> : tb.data.lines.length === 0 ? <EmptyState title={L("لا توجد حركات مرحّلة في هذه الفترة", "No posted activity in this range")} /> : <>
        {provNote(tb.data.provisionalEntries)}
        <Table>
          <thead><tr><Th>{L("الرمز", "Code")}</Th><Th>{L("الحساب", "Account")}</Th><Th num>{L("أول المدة مدين", "Opening Dr")}</Th><Th num>{L("أول المدة دائن", "Opening Cr")}</Th><Th num>{L("حركة مدين", "Period Dr")}</Th><Th num>{L("حركة دائن", "Period Cr")}</Th><Th num>{L("آخر المدة مدين", "Closing Dr")}</Th><Th num>{L("آخر المدة دائن", "Closing Cr")}</Th></tr></thead>
          <tbody>
            {tb.data.lines.map((l) => (
              <tr key={l.accountId} className="hover:bg-cream/40 cursor-pointer" onClick={() => drill(l.accountId)} tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") drill(l.accountId); }}>
                <Td className="tabular-nums">{l.code}</Td><Td>{name(l)}</Td>
                {[l.openingDebit, l.openingCredit, l.periodDebit, l.periodCredit, l.closingDebit, l.closingCredit].map((v, i) => <Td key={i} num>{v ? money(v) : ""}</Td>)}
              </tr>
            ))}
            <tr className="bg-cream-dark font-bold"><Td></Td><Td>{L("المجموع (ر.س)", "Total (SAR)")}</Td>
              {[tb.data.totals.openingDebit, tb.data.totals.openingCredit, tb.data.totals.periodDebit, tb.data.totals.periodCredit, tb.data.totals.closingDebit, tb.data.totals.closingCredit].map((v, i) => <Td key={i} num>{money(v)}</Td>)}</tr>
          </tbody>
        </Table>
        <div className="flex items-center gap-2">{tb.data.balanced ? <Badge tone="ok">{L("متوازن ✓", "Balanced ✓")}</Badge> : <Badge tone="bad">{L("غير متوازن — أبلغ مسؤول النظام", "Not balanced — report to the administrator")}</Badge>}<span className="text-xs text-brown">{L("اضغط على أي حساب لفتح دفتر الأستاذ", "Select any account to open its ledger")}</span></div>
      </>)}

      {view === "is" && (is.error ? <ErrorState error={is.error} onRetry={is.reload} /> : !is.data ? <LoadingState /> : <>
        {provNote(is.data.provisionalEntries)}
        <Table>
          <thead><tr><Th>{L("البند", "Line")}</Th><Th num>{L("المبلغ (ر.س)", "Amount (SAR)")}</Th></tr></thead>
          <tbody>
            <tr className="font-extrabold"><Td>{L("الإيرادات", "Revenue")}</Td><Td num>{money(is.data.totalRevenue)}</Td></tr>
            {statement(is.data.revenue, "")}
            <tr className="font-extrabold"><Td>{L("المصروفات", "Expenses")}</Td><Td num>{money(is.data.totalExpenses)}</Td></tr>
            {statement(is.data.expenses, "")}
            <tr className="bg-cream-dark font-extrabold"><Td>{L("صافي الربح (الخسارة)", "Net profit (loss)")}</Td><Td num className={is.data.netIncome < 0 ? "text-red-700" : ""}>{is.data.netIncome < 0 ? `(${money(-is.data.netIncome)})` : money(is.data.netIncome)}</Td></tr>
          </tbody>
        </Table>
      </>)}

      {view === "bs" && (bs.error ? <ErrorState error={bs.error} onRetry={bs.reload} /> : !bs.data ? <LoadingState /> : <>
        {provNote(bs.data.provisionalEntries)}
        <Table>
          <thead><tr><Th>{L("البند", "Line")}</Th><Th num>{L("المبلغ (ر.س)", "Amount (SAR)")}</Th></tr></thead>
          <tbody>
            <tr className="font-extrabold"><Td>{L("الأصول", "Assets")}</Td><Td num>{money(bs.data.totalAssets)}</Td></tr>
            {statement(bs.data.assets, "")}
            <tr className="font-extrabold"><Td>{L("الالتزامات", "Liabilities")}</Td><Td num>{money(bs.data.totalLiabilities)}</Td></tr>
            {statement(bs.data.liabilities, "")}
            <tr className="font-extrabold"><Td>{L("حقوق الملكية", "Equity")}</Td><Td num>{money(bs.data.totalEquity)}</Td></tr>
            {statement(bs.data.equity, "")}
            <tr><Td><span className="ps-4">{L("أرباح (خسائر) السنة غير المقفلة", "Unclosed current earnings")}</span></Td><Td num className={bs.data.currentEarnings < 0 ? "text-red-700" : ""}>{money(bs.data.currentEarnings)}</Td></tr>
            <tr className="bg-cream-dark font-extrabold"><Td>{L("الالتزامات + حقوق الملكية", "Liabilities + equity")}</Td><Td num>{money(bs.data.totalLiabilities + bs.data.totalEquity)}</Td></tr>
          </tbody>
        </Table>
        <div className="flex items-center gap-2">{bs.data.balanced ? <Badge tone="ok">{L("الأصول = الالتزامات + حقوق الملكية ✓", "Assets = liabilities + equity ✓")}</Badge> : <Badge tone="bad">{L("غير متوازن", "Not balanced")}</Badge>}</div>
        <Notice tone="warn">{L("قائمة التدفقات النقدية ليست في هذا الإصدار: تحتاج ربط الحسابات البنكية بدفتر الأستاذ. التوقعات النقدية في وحدة المالية ليست قائمة تدفقات تاريخية.", "The cash-flow statement is not in this release: it needs bank accounts linked to the ledger. Finance's cash forecast is not a historical cash-flow statement.")}</Notice>
      </>)}

      {view === "gl" && <>
        <Field label={L("الحساب", "Account")}>
          <select className={`${INPUT} max-w-md`} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">{L("اختر حساباً…", "Choose an account…")}</option>
            {accounts.data?.filter((a) => a.allowPosting).map((a) => <option key={a.id} value={a.id}>{a.code} · {name(a)}</option>)}
          </select>
        </Field>
        {!accountId ? <EmptyState title={L("اختر حساباً لعرض دفتر أستاذه", "Choose an account to see its ledger")} /> : gl.error ? <ErrorState error={gl.error} onRetry={gl.reload} /> : !gl.data ? <LoadingState /> : <>
          <CardTitle title={`${L("دفتر الأستاذ", "General ledger")} — ${gl.data.account.code} ${name(gl.data.account)}`} sub={`${day(from)} – ${day(to)} · ${gl.data.account.debitNormal ? L("مدين بطبيعته", "Debit-normal") : L("دائن بطبيعته", "Credit-normal")}`} />
          <Table>
            <thead><tr><Th>{L("التاريخ", "Date")}</Th><Th>{L("القيد", "Entry")}</Th><Th>{L("الوصف", "Description")}</Th><Th>{L("المصدر", "Source")}</Th><Th num>{L("مدين", "Debit")}</Th><Th num>{L("دائن", "Credit")}</Th><Th num>{L("الرصيد", "Balance")}</Th></tr></thead>
            <tbody>
              <tr className="font-bold"><Td>{day(from)}</Td><Td></Td><Td>{L("رصيد أول المدة", "Opening balance")}</Td><Td></Td><Td num></Td><Td num></Td><Td num>{money(gl.data.opening)}</Td></tr>
              {gl.data.lines.map((l) => (
                <tr key={l.id}>
                  <Td className="whitespace-nowrap">{day(l.entryDate)}</Td>
                  <Td><a className="font-bold text-orange hover:underline" href={`/dashboard/accounting/journals/${l.entryId}`}>#{l.entryNo}</a></Td>
                  <Td>{auto(l.description)}{l.isProvisional && <span className="ms-1 text-[11px] font-bold text-amber-700">{L("(مؤقت)", "(provisional)")}</span>}</Td>
                  <Td><Badge tone={l.sourceModule === "manual" ? "info" : "brand"}>{SOURCE_LABEL[l.sourceModule] ? L(...SOURCE_LABEL[l.sourceModule]) : l.sourceModule}</Badge></Td>
                  <Td num>{l.debit ? money(l.debit) : ""}</Td><Td num>{l.credit ? money(l.credit) : ""}</Td><Td num>{money(l.balance)}</Td>
                </tr>
              ))}
              <tr className="bg-cream-dark font-bold"><Td></Td><Td></Td><Td>{L("الرصيد الختامي", "Closing balance")}</Td><Td></Td><Td num>{money(gl.data.periodDebit)}</Td><Td num>{money(gl.data.periodCredit)}</Td><Td num>{money(gl.data.closing)}</Td></tr>
            </tbody>
          </Table>
          {gl.data.total > gl.data.pageSize && <Pager page={gl.data.page} pageSize={gl.data.pageSize} total={gl.data.total} onPage={setPage} />}
        </>}
      </>}

      {view === "com" && (rec.error ? <ErrorState error={rec.error} onRetry={rec.reload} /> : !rec.data ? <LoadingState /> : <>
        <CardTitle title={L("مطابقة العمولات المستحقة مع دفتر العمولات", "Commissions payable vs the commission ledger")} sub={rec.data.account ? `${rec.data.account.code} · ${name(rec.data.account)}` : L("لم يُربط حساب العمولات المستحقة", "Commissions payable is not mapped")} />
        <Table>
          <thead><tr><Th>{L("الموظف", "Employee")}</Th><Th num>{L("رصيد الدفتر العام", "Ledger balance")}</Th><Th num>{L("دفتر العمولات (المرحّل)", "Commission ledger (posted)")}</Th><Th num>{L("الفرق", "Difference")}</Th><Th num>{L("بانتظار الترحيل", "Waiting")}</Th><Th num>{L("قبل بداية الدفتر", "Before cutover")}</Th></tr></thead>
          <tbody>
            {rec.data.rows.map((r) => (
              <tr key={r.employeeId}>
                <Td>{r.name}</Td><Td num>{money(r.ledgerBalance)}</Td><Td num>{money(r.subledgerPosted)}</Td>
                <Td num className={r.difference ? "font-bold text-red-700" : ""}>{money(r.difference)}</Td>
                <Td num>{r.waitingCount ? `${money(r.waitingAmount)} (${r.waitingCount})` : "—"}</Td><Td num>{r.beforeCutoverOrSkipped ? money(r.beforeCutoverOrSkipped) : "—"}</Td>
              </tr>
            ))}
            <tr className="bg-cream-dark font-bold"><Td>{L("المجموع", "Total")}</Td><Td num>{money(rec.data.totals.ledgerBalance)}</Td><Td num>{money(rec.data.totals.subledgerPosted)}</Td><Td num>{money(rec.data.totals.difference)}</Td><Td></Td><Td></Td></tr>
          </tbody>
        </Table>
        <div className="flex items-center gap-2">{rec.data.reconciled ? <Badge tone="ok">{L("مطابق ✓", "Reconciled ✓")}</Badge> : <Badge tone="bad">{L("يوجد فرق", "Difference found")}</Badge>}<span className="text-xs text-brown">{L("الرصيد السالب يعني أن الموظف مدين للشركة (مثلاً: مرتجع بعد صرف العمولة).", "A negative balance means the employee owes the company (e.g. a return after the commission was paid).")}</span></div>
      </>)}
    </Card>
  );
}
