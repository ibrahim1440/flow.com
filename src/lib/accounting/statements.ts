// Accounting A5 — the financial statements, read from the general ledger only (posted entries: POSTED and REVERSED
// with its reversal), by account type, statement group and posting role — never by a hard-coded account number.
//
//   incomeStatement   P&L (by function: revenue, cost of sales → gross profit and margin, operating expenses,
//                     other income / finance costs, zakat → net profit) for a range, with a comparative range.
//                     The year-end CLOSING entry is excluded (a closed year still shows its profit).
//   balanceSheet      as of a day (and a comparative day): assets = liabilities + equity, where equity carries the
//                     profit not yet closed to retained earnings (current year, and earlier years if never closed).
//   cashFlow          indirect method for a range: net profit, non-cash items, working-capital changes, investing,
//                     financing; reconciled to the change in the cash and bank accounts (difference shown).
// Every line names its accounts, so the screen drills line → accounts → general ledger → entry → source document.
// One aggregate query per statement (a hash join; a short range uses the partial JournalEntry_posted_entryDate_idx);
// no N+1. 50,000 lines: ~50 ms per statement (tests/accounting/perf-seed.sql, EXPLAIN in the A5 contract section).
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { Decimal, ZERO, fix2 } from "./money";
import { addDaysUtc, dayText, parseBusinessDay, riyadhDay } from "./dates";
import { refuse } from "./refusals";
import { ACCOUNT_ROLES } from "./roles";
import { acctCsvCell } from "./csv";

import { REPORT_GROUPS, GROUP_LABEL, isReportGroup, type ReportGroup } from "./report-groups";
export { REPORT_GROUPS, GROUP_LABEL, isReportGroup, type ReportGroup };

export type AccountInfo = {
  id: string; code: string; nameAr: string | null; nameEn: string; type: string; normalBalance: string; parentId: string | null;
  controlType: string | null; reportGroup: string | null; allowPosting: boolean; roles: string[];
};

/** The default chart's header codes (src/lib/accounting/coa-template.ts) → their statement group. */
const HEADER_GROUP: Record<string, ReportGroup> = {
  "1100": "CURRENT_ASSET", "1200": "NON_CURRENT_ASSET", "2100": "CURRENT_LIABILITY", "2200": "NON_CURRENT_LIABILITY",
  "3000": "EQUITY", "4000": "REVENUE", "5000": "COST_OF_SALES", "6000": "OPERATING_EXPENSE", "7000": "OTHER_INCOME_EXPENSE", "8000": "ZAKAT",
};
const ROLE_GROUP: Record<string, ReportGroup> = Object.fromEntries(ACCOUNT_ROLES.map((r) => {
  const g: ReportGroup = r.group === "cost" ? "COST_OF_SALES"
    : r.key === "EOSB_PROVISION" ? "NON_CURRENT_LIABILITY"
    : r.types[0] === "ASSET" ? "CURRENT_ASSET"
    : r.types[0] === "LIABILITY" ? "CURRENT_LIABILITY"
    : r.types[0] === "EQUITY" ? "EQUITY"
    : r.types[0] === "REVENUE" ? "REVENUE" : "OPERATING_EXPENSE";
  return [r.key, g];
}));
const TYPE_GROUP: Record<string, ReportGroup> = { ASSET: "CURRENT_ASSET", LIABILITY: "CURRENT_LIABILITY", EQUITY: "EQUITY", REVENUE: "REVENUE", EXPENSE: "OPERATING_EXPENSE" };
/** A group is valid for an account type (an explicit group of the wrong side is ignored). */
const GROUP_TYPES: Record<ReportGroup, string[]> = {
  CURRENT_ASSET: ["ASSET"], NON_CURRENT_ASSET: ["ASSET"], CURRENT_LIABILITY: ["LIABILITY"], NON_CURRENT_LIABILITY: ["LIABILITY"], EQUITY: ["EQUITY"],
  REVENUE: ["REVENUE", "EXPENSE"], COST_OF_SALES: ["EXPENSE", "REVENUE"], OPERATING_EXPENSE: ["EXPENSE", "REVENUE"], OTHER_INCOME_EXPENSE: ["EXPENSE", "REVENUE"], ZAKAT: ["EXPENSE"],
};

/**
 * Pure: the statement group of an account. Order: the account's own reportGroup (if it suits its type); a posting role
 * mapped to it; a fixed-asset control account; the nearest ancestor that is a header of the default chart; its type.
 */
export function reportGroupOf(a: AccountInfo, byId: Map<string, AccountInfo>): ReportGroup {
  if (isReportGroup(a.reportGroup) && GROUP_TYPES[a.reportGroup].includes(a.type)) return a.reportGroup;
  for (const r of a.roles) { const g = ROLE_GROUP[r]; if (g && GROUP_TYPES[g].includes(a.type)) return g; }
  if (a.controlType === "FIXED_ASSET") return "NON_CURRENT_ASSET";
  let p = a.parentId ? byId.get(a.parentId) : undefined;
  for (let guard = 0; p && guard < 20; guard++) {
    if (isReportGroup(p.reportGroup) && GROUP_TYPES[p.reportGroup].includes(a.type)) return p.reportGroup;
    const g = HEADER_GROUP[p.code];
    if (g && GROUP_TYPES[g].includes(a.type)) return g;
    p = p.parentId ? byId.get(p.parentId) : undefined;
  }
  const own = HEADER_GROUP[a.code];
  if (own && GROUP_TYPES[own].includes(a.type)) return own;
  return TYPE_GROUP[a.type] ?? "OPERATING_EXPENSE";
}

export async function loadAccountInfo(): Promise<Map<string, AccountInfo & { group: ReportGroup }>> {
  const [accounts, roles] = await Promise.all([
    prisma.account.findMany({ select: { id: true, code: true, nameAr: true, nameEn: true, type: true, normalBalance: true, parentId: true, controlType: true, reportGroup: true, allowPosting: true } }),
    prisma.accountRole.findMany({ where: { tenantId: "hiqbah" }, select: { role: true, accountId: true } }),
  ]);
  const rolesOf = new Map<string, string[]>();
  for (const r of roles) rolesOf.set(r.accountId, [...(rolesOf.get(r.accountId) ?? []), r.role]);
  const byId = new Map<string, AccountInfo>(accounts.map((a) => [a.id, { ...a, type: String(a.type), roles: rolesOf.get(a.id) ?? [] }]));
  return new Map([...byId.values()].map((a) => [a.id, { ...a, group: reportGroupOf(a, byId) }]));
}

// ── ranges ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type PeriodKind = "month" | "quarter" | "year" | "custom";
export type Range = { from: Date; to: Date; label: string };

/** A month (n 1–12), quarter (n 1–4) or year of a Gregorian (calendar = fiscal, owner decision) year. */
export function periodRange(kind: Exclude<PeriodKind, "custom">, year: number, n = 1): Range {
  if (!Number.isInteger(year) || year < 2000 || year > 2200) throw refuse("BAD_INPUT", "year.");
  if (kind === "year") return { from: new Date(Date.UTC(year, 0, 1)), to: new Date(Date.UTC(year, 11, 31)), label: `${year}` };
  if (kind === "quarter") {
    if (!Number.isInteger(n) || n < 1 || n > 4) throw refuse("BAD_INPUT", "quarter.");
    return { from: new Date(Date.UTC(year, (n - 1) * 3, 1)), to: new Date(Date.UTC(year, n * 3, 0)), label: `${year}-Q${n}` };
  }
  if (!Number.isInteger(n) || n < 1 || n > 12) throw refuse("BAD_INPUT", "month.");
  return { from: new Date(Date.UTC(year, n - 1, 1)), to: new Date(Date.UTC(year, n, 0)), label: `${year}-${String(n).padStart(2, "0")}` };
}

/** The comparative of a range: the period just before it (same length in months when it is whole months), or the same period a year earlier. */
export function comparativeRange(r: Range, mode: "prior" | "lastYear"): Range {
  const f = r.from, t = r.to;
  const wholeMonths = f.getUTCDate() === 1 && addDaysUtc(t, 1).getUTCDate() === 1;
  if (mode === "lastYear") {
    const from = new Date(Date.UTC(f.getUTCFullYear() - 1, f.getUTCMonth(), f.getUTCDate()));
    const to = wholeMonths ? new Date(Date.UTC(t.getUTCFullYear() - 1, t.getUTCMonth() + 1, 0)) : new Date(Date.UTC(t.getUTCFullYear() - 1, t.getUTCMonth(), t.getUTCDate()));
    return { from, to, label: `${dayText(from)}…${dayText(to)}` };
  }
  if (wholeMonths) {
    const months = (t.getUTCFullYear() - f.getUTCFullYear()) * 12 + t.getUTCMonth() - f.getUTCMonth() + 1;
    const from = new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth() - months, 1));
    const to = addDaysUtc(f, -1);
    return { from, to, label: `${dayText(from)}…${dayText(to)}` };
  }
  const days = Math.round((t.getTime() - f.getTime()) / 86_400_000) + 1;
  const to = addDaysUtc(f, -1), from = addDaysUtc(f, -days);
  return { from, to, label: `${dayText(from)}…${dayText(to)}` };
}

/** Parse the query of a statement: kind=month|quarter|year&year&n, or from&to; compare=prior|lastYear|none. */
export function rangeFromQuery(q: { kind?: string | null; year?: string | null; n?: string | null; from?: string | null; to?: string | null }): Range {
  const kind = (q.kind ?? "") as PeriodKind;
  if (kind === "month" || kind === "quarter" || kind === "year") return periodRange(kind, Number(q.year ?? riyadhDay().getUTCFullYear()), Number(q.n ?? 1));
  try {
    const from = parseBusinessDay(q.from ?? ""), to = parseBusinessDay(q.to ?? "");
    if (from > to) throw new RangeError("from > to");
    return { from, to, label: `${dayText(from)}…${dayText(to)}` };
  } catch {
    throw refuse("BAD_INPUT", "kind=month|quarter|year&year&n, or from / to as YYYY-MM-DD.");
  }
}

// ── the aggregate ──────────────────────────────────────────────────────────────────────────────────────────────

const POSTED = Prisma.sql`j."status" IN ('POSTED', 'REVERSED')`;
const endOf = (d: Date) => new Date(d.getTime() + 86_399_999);

/** Σ (debit − credit) per account over [from, to] (from = null: since the beginning), posted only. */
async function netByAccount(ranges: { from: Date | null; to: Date; excludeTypes?: string[] }[]): Promise<Map<string, Decimal[]>> {
  const maxTo = ranges.reduce((m, r) => (r.to > m ? r.to : m), ranges[0].to);
  const cols = ranges.map((r, i) => {
    const conds = [Prisma.sql`j."entryDate" <= ${endOf(r.to)}`];
    if (r.from) conds.push(Prisma.sql`j."entryDate" >= ${r.from}`);
    if (r.excludeTypes?.length) conds.push(Prisma.sql`j."type"::text NOT IN (${Prisma.join(r.excludeTypes)})`);
    return Prisma.sql`coalesce(sum(l."debit" - l."credit") FILTER (WHERE ${Prisma.join(conds, " AND ")}), 0) AS ${Prisma.raw(`"c${i}"`)}`;
  });
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT l."accountId", ${Prisma.join(cols, ", ")}
      FROM "JournalEntryLine" l JOIN "JournalEntry" j ON j."id" = l."journalEntryId"
     WHERE ${POSTED} AND j."entryDate" <= ${endOf(maxTo)}
     GROUP BY l."accountId"`;
  return new Map(rows.map((r) => [r.accountId as string, ranges.map((_, i) => new Decimal(String(r[`c${i}`] ?? 0)))]));
}

export type StatementLine = { accountId: string; code: string; name: string; nameEn: string; amounts: string[]; group: ReportGroup };
export type StatementSection = { key: string; ar: string; en: string; lines: StatementLine[]; totals: string[] };

const nameOf = (a: AccountInfo) => a.nameAr ?? a.nameEn;
const pct = (num: Decimal, den: Decimal) => (den.isZero() ? null : num.times(100).dividedBy(den).toFixed(1));

function section(key: ReportGroup, accounts: Map<string, AccountInfo & { group: ReportGroup }>, net: Map<string, Decimal[]>, cols: number, sign: 1 | -1): StatementSection & { raw: Decimal[] } {
  const lines: StatementLine[] = [];
  const raw = Array.from({ length: cols }, () => ZERO);
  for (const [id, v] of net) {
    const a = accounts.get(id);
    if (!a || a.group !== key) continue;
    const amts = v.slice(0, cols).map((x) => (sign === 1 ? x : x.negated()));
    if (amts.every((x) => x.isZero())) continue;
    amts.forEach((x, i) => { raw[i] = raw[i].plus(x); });
    lines.push({ accountId: id, code: a.code, name: nameOf(a), nameEn: a.nameEn, amounts: amts.map(fix2), group: a.group });
  }
  lines.sort((a, b) => a.code.localeCompare(b.code));
  const [ar, en] = GROUP_LABEL[key];
  return { key, ar, en, lines, totals: raw.map(fix2), raw };
}

// ── income statement ───────────────────────────────────────────────────────────────────────────────────────────

export async function incomeStatement(current: Range, compare: Range | null) {
  const ranges = [current, ...(compare ? [compare] : [])].map((r) => ({ from: r.from, to: r.to, excludeTypes: ["CLOSING"] }));
  const [accounts, net] = await Promise.all([loadAccountInfo(), netByAccount(ranges)]);
  const n = ranges.length;
  const revenue = section("REVENUE", accounts, net, n, -1);
  const cos = section("COST_OF_SALES", accounts, net, n, 1);
  const opex = section("OPERATING_EXPENSE", accounts, net, n, 1);
  const other = section("OTHER_INCOME_EXPENSE", accounts, net, n, 1);
  const zakat = section("ZAKAT", accounts, net, n, 1);
  const col = (f: (i: number) => Decimal) => Array.from({ length: n }, (_, i) => f(i));
  const gross = col((i) => revenue.raw[i].minus(cos.raw[i]));
  const operating = col((i) => gross[i].minus(opex.raw[i]));
  const beforeZakat = col((i) => operating[i].minus(other.raw[i]));
  const netProfit = col((i) => beforeZakat[i].minus(zakat.raw[i]));
  const strip = ({ raw: _raw, ...s }: StatementSection & { raw: Decimal[] }) => s; // eslint-disable-line @typescript-eslint/no-unused-vars
  return {
    columns: [current, ...(compare ? [compare] : [])].map((r) => ({ from: dayText(r.from), to: dayText(r.to), label: r.label })),
    sections: [revenue, cos, opex, other, zakat].map(strip),
    totals: {
      revenue: revenue.raw.map(fix2), costOfSales: cos.raw.map(fix2), grossProfit: gross.map(fix2), grossMarginPct: gross.map((g, i) => pct(g, revenue.raw[i])),
      operatingExpenses: opex.raw.map(fix2), operatingProfit: operating.map(fix2), operatingMarginPct: operating.map((g, i) => pct(g, revenue.raw[i])),
      otherNet: other.raw.map(fix2), profitBeforeZakat: beforeZakat.map(fix2), zakat: zakat.raw.map(fix2), netProfit: netProfit.map(fix2), netMarginPct: netProfit.map((g, i) => pct(g, revenue.raw[i])),
    },
    variance: compare ? { netProfit: fix2(netProfit[0].minus(netProfit[1])), revenue: fix2(revenue.raw[0].minus(revenue.raw[1])), revenuePct: pct(revenue.raw[0].minus(revenue.raw[1]), revenue.raw[1].abs()) } : null,
  };
}

// ── balance sheet ──────────────────────────────────────────────────────────────────────────────────────────────

const PL_GROUPS: ReportGroup[] = ["REVENUE", "COST_OF_SALES", "OPERATING_EXPENSE", "OTHER_INCOME_EXPENSE", "ZAKAT"];

export async function balanceSheet(asOf: Date, compareAsOf: Date | null) {
  const days = [asOf, ...(compareAsOf ? [compareAsOf] : [])];
  // Per day: the cumulative balance (all entry types), and this calendar year's P&L not yet closed (the year's own
  // CLOSING entry, dated 31 December, brings it to zero once the year is closed).
  const ranges = days.flatMap((d) => [{ from: null, to: d }, { from: new Date(Date.UTC(d.getUTCFullYear(), 0, 1)), to: d }]);
  const [accounts, net] = await Promise.all([loadAccountInfo(), netByAccount(ranges)]);
  const n = days.length;
  const cum = new Map([...net].map(([k, v]) => [k, days.map((_, i) => v[2 * i])]));
  const ytd = new Map([...net].map(([k, v]) => [k, days.map((_, i) => v[2 * i + 1])]));
  const ca = section("CURRENT_ASSET", accounts, cum, n, 1);
  const nca = section("NON_CURRENT_ASSET", accounts, cum, n, 1);
  const cl = section("CURRENT_LIABILITY", accounts, cum, n, -1);
  const ncl = section("NON_CURRENT_LIABILITY", accounts, cum, n, -1);
  const eq = section("EQUITY", accounts, cum, n, -1);
  const sumPl = (m: Map<string, Decimal[]>, i: number) => [...m].reduce((s, [id, v]) => (PL_GROUPS.includes(accounts.get(id)?.group as ReportGroup) ? s.plus(v[i]) : s), ZERO).negated();
  const unclosed = days.map((_, i) => sumPl(cum, i));
  const currentYear = days.map((_, i) => sumPl(ytd, i));
  const priorUnclosed = days.map((_, i) => unclosed[i].minus(currentYear[i]));
  const col = (f: (i: number) => Decimal) => Array.from({ length: n }, (_, i) => f(i));
  const assets = col((i) => ca.raw[i].plus(nca.raw[i]));
  const liabilities = col((i) => cl.raw[i].plus(ncl.raw[i]));
  const equity = col((i) => eq.raw[i].plus(unclosed[i]));
  const diff = col((i) => assets[i].minus(liabilities[i]).minus(equity[i]));
  const strip = ({ raw: _raw, ...s }: StatementSection & { raw: Decimal[] }) => s; // eslint-disable-line @typescript-eslint/no-unused-vars
  return {
    columns: days.map((d) => ({ asOf: dayText(d) })),
    sections: [ca, nca, cl, ncl, eq].map(strip),
    earnings: { currentYear: currentYear.map(fix2), priorYearsNotClosed: priorUnclosed.map(fix2) },
    totals: {
      currentAssets: ca.raw.map(fix2), nonCurrentAssets: nca.raw.map(fix2), assets: assets.map(fix2),
      currentLiabilities: cl.raw.map(fix2), nonCurrentLiabilities: ncl.raw.map(fix2), liabilities: liabilities.map(fix2),
      equity: equity.map(fix2), liabilitiesAndEquity: col((i) => liabilities[i].plus(equity[i])).map(fix2),
      workingCapital: col((i) => ca.raw[i].minus(cl.raw[i])).map(fix2),
      currentRatio: col((i) => (cl.raw[i].isZero() ? ZERO : ca.raw[i].dividedBy(cl.raw[i]))).map((x, i) => (cl.raw[i].isZero() ? null : x.toFixed(2))),
    },
    difference: diff.map(fix2),
    balanced: diff.every((d) => d.isZero()),
  };
}

// ── cash flow (indirect) ───────────────────────────────────────────────────────────────────────────────────────

const CASH_ROLES = new Set(["CASH", "BANK"]);
export const isCashAccount = (a: AccountInfo) => a.controlType === "CASH" || a.controlType === "BANK" || a.roles.some((r) => CASH_ROLES.has(r));

/**
 * The indirect cash flow for a range. Movements exclude the OPENING entry (the opening balances are the starting
 * point, not a flow) and the CLOSING entry (P&L → retained earnings is not a flow). For every non-cash account the
 * cash effect is −Δ(debit − credit); grouped: net profit (P&L accounts), non-cash items (accumulated depreciation —
 * a credit-natured non-current asset — and the end-of-service provision), working capital (current, non-cash),
 * investing (non-current assets) and financing (non-current liabilities, equity). The sum is reconciled to the
 * actual change in cash and bank (cash at start includes the opening entry when it falls in the range).
 */
export async function cashFlow(range: Range) {
  const before = addDaysUtc(range.from, -1);
  const [accounts, net] = await Promise.all([
    loadAccountInfo(),
    netByAccount([
      { from: range.from, to: range.to, excludeTypes: ["OPENING", "CLOSING"] },
      { from: null, to: before },
      { from: null, to: range.to },
    ]),
  ]);
  type Line = { accountId: string; code: string; name: string; amount: string };
  const buckets: Record<"profit" | "nonCash" | "workingCapital" | "investing" | "financing", { lines: Line[]; total: Decimal }> = {
    profit: { lines: [], total: ZERO }, nonCash: { lines: [], total: ZERO }, workingCapital: { lines: [], total: ZERO }, investing: { lines: [], total: ZERO }, financing: { lines: [], total: ZERO },
  };
  let cashStart = ZERO, cashEnd = ZERO;
  for (const [id, [delta, open, close]] of net) {
    const a = accounts.get(id);
    if (!a) continue;
    if (isCashAccount(a)) { cashStart = cashStart.plus(open); cashEnd = cashEnd.plus(close); continue; }
    if (delta.isZero()) continue;
    const effect = delta.negated();
    const g = a.group;
    const b = PL_GROUPS.includes(g) ? "profit"
      : (g === "NON_CURRENT_ASSET" && a.normalBalance === "CREDIT") || a.roles.includes("EOSB_PROVISION") ? "nonCash"
      : g === "CURRENT_ASSET" || g === "CURRENT_LIABILITY" ? "workingCapital"
      : g === "NON_CURRENT_ASSET" ? "investing" : "financing";
    buckets[b].total = buckets[b].total.plus(effect);
    if (b !== "profit") buckets[b].lines.push({ accountId: id, code: a.code, name: nameOf(a), amount: fix2(effect) });
  }
  for (const b of Object.values(buckets)) b.lines.sort((x, y) => x.code.localeCompare(y.code));
  // Cash at the start includes the opening entry when it is dated inside the range (it is excluded from the flows).
  const openingInRange = await prisma.$queryRaw<{ v: Prisma.Decimal | null }[]>`
    SELECT coalesce(sum(l."debit" - l."credit"), 0) AS v FROM "JournalEntryLine" l JOIN "JournalEntry" j ON j."id" = l."journalEntryId"
     WHERE ${POSTED} AND j."type"::text = 'OPENING' AND j."entryDate" >= ${range.from} AND j."entryDate" <= ${endOf(range.to)}
       AND l."accountId" IN (${Prisma.join([...accounts.values()].filter(isCashAccount).map((a) => a.id).concat(["-"]))})`;
  cashStart = cashStart.plus(new Decimal(String(openingInRange[0]?.v ?? 0)));
  const operating = buckets.profit.total.plus(buckets.nonCash.total).plus(buckets.workingCapital.total);
  const netChange = operating.plus(buckets.investing.total).plus(buckets.financing.total);
  const actual = cashEnd.minus(cashStart);
  const f = (b: { lines: Line[]; total: Decimal }) => ({ lines: b.lines, total: fix2(b.total) });
  return {
    from: dayText(range.from), to: dayText(range.to), method: "indirect",
    netProfit: fix2(buckets.profit.total), nonCash: f(buckets.nonCash), workingCapital: f(buckets.workingCapital),
    operating: fix2(operating), investing: f(buckets.investing), financing: f(buckets.financing),
    netChange: fix2(netChange), cashStart: fix2(cashStart), cashEnd: fix2(cashEnd), actualChange: fix2(actual),
    difference: fix2(netChange.minus(actual)), reconciled: netChange.equals(actual),
    cashAccounts: [...accounts.values()].filter(isCashAccount).map((a) => ({ accountId: a.id, code: a.code, name: nameOf(a) })),
  };
}

// ── CSV ────────────────────────────────────────────────────────────────────────────────────────────────────────

export const csvRow = (cells: (string | null | undefined)[]) => cells.map(acctCsvCell).join(",");
export const csvBody = (rows: string[]) => "﻿" + rows.join("\n");
