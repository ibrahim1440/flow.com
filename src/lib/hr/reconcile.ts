// Native HR — payroll reconciliation in whole halalas (F2 / finding 5). Pure: no database.
//
// Every amount is converted to an exact integer number of halalas (decimal arithmetic, never
// floating point, no rounding of its own), so the comparison is deterministic. It only DETECTS: a mismatch is
// reported with both sides and the difference; nothing is corrected, and approved totals are
// never touched. Which rounding the engine should use is a policy choice (docs/hr/P2-CORRECTIONS.md).
//
//   per line:  Σ EARNING items = gross · Σ DEDUCTION items = deductions ·
//              gross − deductions = net · Σ EMPLOYER items = employer
//   per run:   Σ line gross / deductions / net / employer = the run's totals ·
//              posted accrual journal debit = the debit its items call for · Σ payments ≤ net
import { D, ZERO, type Decimal } from "./money";

type Amount = Decimal | string | number | { toString(): string };

/** Exact halalas of an amount with at most two decimals; refuses anything finer. */
export function halalas(v: Amount): Decimal {
  const d = D(v.toString());
  const h = d.times(100);
  if (!h.isInteger()) throw new RangeError(`Not a whole number of halalas: ${d.toString()}`);
  return h;
}

const sar = (h: Decimal) => h.dividedBy(100).toFixed(2);

export type ReconLine = {
  id: string;
  label: string;
  gross: Amount;
  deductions: Amount;
  net: Amount;
  employer: Amount;
  items: { kind: string; amount: Amount }[];
};
export type ReconRun = {
  totalGross: Amount; totalDeductions: Amount; totalNet: Amount; totalEmployer: Amount; lines: ReconLine[];
  /** Recorded payments: their sum never exceeds the net. */
  paid?: Amount;
  /** When the accrual journal is posted: what its debit side should be (from the items) and what it is. */
  journal?: { expectedDebit: Amount; postedDebit: Amount } | null;
};

export type Mismatch = { scope: "LINE" | "RUN"; lineId: string | null; label: string | null; check: string; expected: string; actual: string; differenceHalalas: number };
export type Reconciliation = { ok: boolean; checkedLines: number; mismatches: Mismatch[] };

export function reconcileRun(run: ReconRun): Reconciliation {
  const mismatches: Mismatch[] = [];
  const cmp = (scope: Mismatch["scope"], line: ReconLine | null, check: string, expected: Decimal, actual: Decimal) => {
    if (!expected.equals(actual)) mismatches.push({ scope, lineId: line?.id ?? null, label: line?.label ?? null, check, expected: sar(expected), actual: sar(actual), differenceHalalas: actual.minus(expected).toNumber() });
  };
  let g = ZERO, dd = ZERO, n = ZERO, e = ZERO;
  for (const l of run.lines) {
    const sumKind = (k: string) => l.items.filter((i) => i.kind === k).reduce((s, i) => s.plus(halalas(i.amount)), ZERO);
    const lg = halalas(l.gross), ld = halalas(l.deductions), ln = halalas(l.net), le = halalas(l.employer);
    cmp("LINE", l, "EARNING_ITEMS = GROSS", sumKind("EARNING"), lg);
    cmp("LINE", l, "DEDUCTION_ITEMS = DEDUCTIONS", sumKind("DEDUCTION"), ld);
    cmp("LINE", l, "GROSS - DEDUCTIONS = NET", lg.minus(ld), ln);
    cmp("LINE", l, "EMPLOYER_ITEMS = EMPLOYER", sumKind("EMPLOYER"), le);
    g = g.plus(lg); dd = dd.plus(ld); n = n.plus(ln); e = e.plus(le);
  }
  cmp("RUN", null, "LINES_GROSS = RUN_GROSS", g, halalas(run.totalGross));
  cmp("RUN", null, "LINES_DEDUCTIONS = RUN_DEDUCTIONS", dd, halalas(run.totalDeductions));
  cmp("RUN", null, "LINES_NET = RUN_NET", n, halalas(run.totalNet));
  cmp("RUN", null, "LINES_EMPLOYER = RUN_EMPLOYER", e, halalas(run.totalEmployer));
  if (run.journal) cmp("RUN", null, "JOURNAL_DEBIT = ITEMS_DEBIT", halalas(run.journal.expectedDebit), halalas(run.journal.postedDebit));
  if (run.paid !== undefined) {
    const paid = halalas(run.paid), net = halalas(run.totalNet);
    if (paid.greaterThan(net)) mismatches.push({ scope: "RUN", lineId: null, label: null, check: "PAYMENTS <= NET", expected: sar(net), actual: sar(paid), differenceHalalas: paid.minus(net).toNumber() });
  }
  return { ok: mismatches.length === 0, checkedLines: run.lines.length, mismatches };
}
