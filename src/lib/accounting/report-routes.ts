// Accounting A5 — what the statement / VAT routes share: the query → range parsing and the CSV answers (UTF-8 with
// a BOM so Excel reads the Arabic). Every report is read-only and needs the accounting module (the routes check it).
import { NextResponse } from "@/lib/api-response";
import { parseBusinessDay, riyadhDay, dayText } from "./dates";
import { refuse } from "./refusals";
import { balanceSheet, cashFlow, comparativeRange, csvBody, csvRow, incomeStatement, incomeStatementByLocation, rangeFromQuery } from "./statements";
import { parseBranchFilter } from "./locations";
import { vatReturn, quarterOf } from "./vat-return";

const sp = (request: Request) => new URL(request.url).searchParams;

export function csvResponse(name: string, rows: string[]): NextResponse {
  return new NextResponse(csvBody(rows), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}.csv"` } });
}

const day = (v: string | null, fallback: Date) => {
  if (!v) return fallback;
  try { return parseBusinessDay(v); } catch { throw refuse("BAD_INPUT", "dates are YYYY-MM-DD."); }
};

export async function incomeFromRequest(request: Request) {
  const q = sp(request);
  const range = rangeFromQuery({ kind: q.get("kind") ?? (q.get("from") ? null : "month"), year: q.get("year"), n: q.get("n") ?? String(riyadhDay().getUTCMonth() + 1), from: q.get("from"), to: q.get("to") });
  // «الموقع» (WP-B): by=location → one column per location + «غير محدد» + «الإجمالي» (no comparative); otherwise a
  // location filter (branches=a,b,none) narrows the statement to those locations' lines.
  if (q.get("by") === "location") return incomeStatementByLocation(range);
  const cmp = q.get("compare") ?? "prior";
  return incomeStatement(range, cmp === "none" ? null : comparativeRange(range, cmp === "lastYear" ? "lastYear" : "prior"), { branches: parseBranchFilter(q) });
}

export async function balanceFromRequest(request: Request) {
  const q = sp(request);
  const asOf = day(q.get("asOf"), riyadhDay());
  const cmpRaw = q.get("compareAsOf");
  const compare = cmpRaw === "none" ? null : cmpRaw ? day(cmpRaw, asOf) : new Date(Date.UTC(asOf.getUTCFullYear() - 1, 11, 31));
  return balanceSheet(asOf, compare);
}

export async function cashFlowFromRequest(request: Request) {
  const q = sp(request);
  return cashFlow(rangeFromQuery({ kind: q.get("kind") ?? (q.get("from") ? null : "year"), year: q.get("year"), n: q.get("n"), from: q.get("from"), to: q.get("to") }));
}

export async function vatFromRequest(request: Request) {
  const q = sp(request);
  const today = riyadhDay();
  const year = Number(q.get("year") ?? today.getUTCFullYear());
  const quarter = Number(q.get("q") ?? quarterOf(today));
  return vatReturn(year, quarter);
}

type Pl = Awaited<ReturnType<typeof incomeStatement>>;
export function incomeCsv(pl: Pl): string[] {
  const head = ["section", "code", "account", ...pl.columns.map((c) => ("labelEn" in c ? String((c as { labelEn: string }).labelEn) : `${c.from}..${c.to}`))];
  const rows = [csvRow(head)];
  for (const s of pl.sections) {
    for (const l of s.lines) rows.push(csvRow([s.en, l.code, l.name, ...l.amounts]));
    rows.push(csvRow([`${s.en} total`, "", "", ...s.totals]));
  }
  const t = pl.totals;
  for (const [k, v] of [["Gross profit", t.grossProfit], ["Gross margin %", t.grossMarginPct], ["Operating profit", t.operatingProfit], ["Profit before zakat", t.profitBeforeZakat], ["Net profit", t.netProfit]] as const) rows.push(csvRow([k, "", "", ...v.map((x) => x ?? "")]));
  return rows;
}

type Bs = Awaited<ReturnType<typeof balanceSheet>>;
export function balanceCsv(bs: Bs): string[] {
  const rows = [csvRow(["section", "code", "account", ...bs.columns.map((c) => c.asOf)])];
  for (const s of bs.sections) {
    for (const l of s.lines) rows.push(csvRow([s.en, l.code, l.name, ...l.amounts]));
    rows.push(csvRow([`${s.en} total`, "", "", ...s.totals]));
  }
  rows.push(csvRow(["Current-year profit not closed", "", "", ...bs.earnings.currentYear]));
  rows.push(csvRow(["Earlier years' profit not closed", "", "", ...bs.earnings.priorYearsNotClosed]));
  rows.push(csvRow(["Total assets", "", "", ...bs.totals.assets]));
  rows.push(csvRow(["Total liabilities and equity", "", "", ...bs.totals.liabilitiesAndEquity]));
  rows.push(csvRow(["Difference", "", "", ...bs.difference]));
  return rows;
}

type Cf = Awaited<ReturnType<typeof cashFlow>>;
export function cashFlowCsv(cf: Cf): string[] {
  const rows = [csvRow(["section", "code", "account", `${cf.from}..${cf.to}`]), csvRow(["Net profit", "", "", cf.netProfit])];
  for (const [k, b] of [["Non-cash items", cf.nonCash], ["Working capital", cf.workingCapital]] as const) { for (const l of b.lines) rows.push(csvRow([k, l.code, l.name, l.amount])); rows.push(csvRow([`${k} total`, "", "", b.total])); }
  rows.push(csvRow(["Operating activities", "", "", cf.operating]));
  for (const [k, b] of [["Investing activities", cf.investing], ["Financing activities", cf.financing]] as const) { for (const l of b.lines) rows.push(csvRow([k, l.code, l.name, l.amount])); rows.push(csvRow([`${k} total`, "", "", b.total])); }
  for (const [k, v] of [["Net change in cash", cf.netChange], ["Cash at start", cf.cashStart], ["Cash at end", cf.cashEnd], ["Actual change", cf.actualChange], ["Difference", cf.difference]] as const) rows.push(csvRow([k, "", "", v]));
  return rows;
}

type Vat = Awaited<ReturnType<typeof vatReturn>>;
export function vatCsv(v: Vat): string[] {
  const rows = [csvRow(["box", "description_ar", "description_en", "amount", "adjustment", "vat", "note"])];
  for (const b of [...v.sales, ...v.purchases]) rows.push(csvRow([String(b.box), b.ar, b.en, b.amount, b.adjustment, b.vat, b.note?.en ?? ""]));
  rows.push(csvRow(["13", "إجمالي ضريبة القيمة المضافة المستحقة عن الفترة", "Total VAT due for the period", "", "", v.summary.totalVatDue, ""]));
  rows.push(csvRow(["14", "تصحيحات من فترات سابقة", "Corrections from previous periods", "", "", v.summary.corrections, "not captured"]));
  rows.push(csvRow(["15", "رصيد دائن مرحّل من فترات سابقة", "VAT credit carried forward", "", "", v.summary.creditCarriedForward, "not captured"]));
  rows.push(csvRow(["16", "صافي الضريبة المستحقة", "Net VAT due", "", "", v.summary.netVatDue, ""]));
  const r = v.reconciliation;
  rows.push(csvRow(["recon", "المخرجات: المستندات المرحّلة مقابل الأستاذ", "Output: posted documents vs GL", r.output.postedDocuments, r.output.glFromDocuments, r.output.difference, `unposted ${r.output.unposted.count} (${r.output.unposted.vat}); other GL ${r.output.glOther}`]));
  rows.push(csvRow(["recon", "المدخلات: المستندات المرحّلة مقابل الأستاذ", "Input: posted documents vs GL", r.input.postedDocuments, r.input.glFromDocuments, r.input.difference, `unposted ${r.input.unposted.count} (${r.input.unposted.vat}); other GL ${r.input.glOther}`]));
  rows.push(csvRow(["zatca", "معتمدة / مُبلّغ عنها لدى الهيئة", "Cleared / reported by ZATCA", String(r.zatca.accepted.count), "", r.zatca.accepted.vat, `pending ${r.zatca.pending.count}, rejected ${r.zatca.rejected.count}, not e-invoiced ${r.zatca.notEInvoiced.count}; return − accepted ${r.zatca.returnVsAccepted}`]));
  rows.push(csvRow(["note", v.disclaimer.ar, v.disclaimer.en, "", "", "", ""]));
  return rows;
}

export const stamp = (d = riyadhDay()) => dayText(d);
