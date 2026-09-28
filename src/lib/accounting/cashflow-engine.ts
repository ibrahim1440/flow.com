// Transaction-aware cash-flow statement (no database access; unit-testable).
//
// The statement is built entry by entry, not from account movements:
//   1. An entry's cash (the sum of its CASH-class lines) is allocated to the counterpart lines on
//      the other side of the entry, in proportion to their amounts. Only allocated cash is a cash
//      flow. An entry with no cash lines, or with cash lines only (an internal transfer), has no
//      cash flow at all.
//   2. P&L lines in an entry that also has investing (or else financing) lines belong to that
//      transaction: a gain or loss on disposal, depreciation against accumulated depreciation, a
//      fee withheld from a loan. Their cash share is shown in that section, and the indirect
//      method removes them from profit.
//   3. A payment of a supplier bill is attributed to investing in proportion to the bill's
//      fixed-asset lines (net of VAT) — `attribution` on the payables line. The bill is the open
//      item recorded on the posted line (see cashflow.ts), so later corrections cannot change it.
//   4. The part of an entry not settled in cash (its "residual") that acquires investing or
//      financing items against liabilities or equity is disclosed as a non-cash transaction.
// Operating cash is computed twice — directly (sum of allocated cash) and by the indirect method
// (profit, adjustments, working-capital changes) — and the two must agree.
// Classification of accounts is the accountant's decision (DECISION_PACK §7); the defaults are
// provisional. Allocation rules 1–4 are recorded there too.
import { Prisma, type CashFlowClass } from "@/generated/prisma/client";

const Z = new Prisma.Decimal(0);
type D = Prisma.Decimal;
export type Section = "OPERATING" | "INVESTING" | "FINANCING" | "EXCLUDED";

export type CfAccount = { id: string; code: string; nameAr: string | null; nameEn: string; type: string; cls: CashFlowClass | null; defaulted: boolean };
export type CfLine = {
  accountId: string; debit: D; credit: D;
  /** Payables line settling a supplier bill: share of its cash that is investing, by bill-line account. */
  attribution?: { accountId: string; share: D }[];
};
export type CfEntry = { id: string; entryNo: number; entryDate: Date; description: string | null; lines: CfLine[] };

type Row = { accountId: string; code: string; nameAr: string | null; nameEn: string; amount: string; defaulted: boolean };
export type Adjustment = Row & { kind: "NON_CASH_PL" | "WORKING_CAPITAL" | "ATTRIBUTED" };
export type NonCash = { entryId: string; entryNo: number; entryDate: Date; description: string | null; amount: string; accounts: string[] };

const round2 = (d: D) => d.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

/** Allocate `cash` over lines in proportion to |weights|, to the cent, exactly (largest remainder to the largest line). */
export function allocate(cash: D, weights: D[]): D[] {
  const tot = weights.reduce((s, w) => s.add(w.abs()), Z);
  if (tot.isZero() || cash.isZero()) return weights.map(() => Z);
  const out = weights.map((w) => round2(cash.mul(w.abs()).div(tot)));
  const diff = cash.sub(out.reduce((s, x) => s.add(x), Z));
  if (!diff.isZero()) {
    let k = 0; weights.forEach((w, i) => { if (w.abs().gt(weights[k].abs())) k = i; });
    out[k] = out[k].add(diff);
  }
  return out;
}

export function buildCashFlow(entries: CfEntry[], accounts: Map<string, CfAccount>) {
  const acc = (id: string) => accounts.get(id)!;
  const flows: Record<Section, Map<string, D>> = { OPERATING: new Map(), INVESTING: new Map(), FINANCING: new Map(), EXCLUDED: new Map() };
  const add = (m: Map<string, D>, k: string, v: D) => { if (!v.isZero()) m.set(k, (m.get(k) ?? Z).add(v)); };
  const plAffiliated = new Map<string, D>();   // P&L movements belonging to investing/financing transactions
  const wc = new Map<string, D>();             // −movement of operating balance-sheet accounts, net of non-cash investing/financing
  const attributed = new Map<string, D>();     // operating cash moved to investing (supplier bills for fixed assets)
  const nonCash: NonCash[] = [];
  let profit = Z, cashChange = Z, directOperating = Z;

  for (const e of entries) {
    const ls = e.lines.map((l) => {
      const a = acc(l.accountId);
      const m = new Prisma.Decimal(l.debit).sub(l.credit);
      const pl = a.type === "REVENUE" || a.type === "EXPENSE";
      return { l, a, m, pl, cls: pl ? null : a.cls };
    });
    const hasInv = ls.some((x) => x.cls === "INVESTING");
    const hasFin = ls.some((x) => x.cls === "FINANCING");
    const plSection: Section = hasInv ? "INVESTING" : hasFin ? "FINANCING" : "OPERATING";
    const cash = ls.filter((x) => x.cls === "CASH").reduce((s, x) => s.add(x.m), Z);
    cashChange = cashChange.add(cash);
    const others = ls.filter((x) => x.cls !== "CASH");
    const side = others.filter((x) => !cash.isZero() && !x.m.isZero() && x.m.isNegative() === cash.isPositive());
    const f = allocate(cash, side.map((x) => x.m));
    const flowOf = new Map(side.map((x, i) => [x, f[i]]));

    let ifResidual = false;
    let debitIF = Z, creditLE = Z;
    const touched: string[] = [];
    for (const x of others) {
      const fx = flowOf.get(x) ?? Z;
      const r = x.m.add(fx);                                  // part of the movement not settled in cash
      const section: Section = x.pl ? plSection : ((x.cls ?? "OPERATING") as Section);
      if (x.pl) {
        profit = profit.sub(x.m);
        if (section !== "OPERATING") add(plAffiliated, x.a.id, x.m);
      }
      if (section === "OPERATING") {
        directOperating = directOperating.add(fx);
        // payment of a supplier bill for a fixed asset: move the investing share of the cash
        if (x.l.attribution?.length && !fx.isZero()) {
          for (const p of x.l.attribution) {
            const moved = round2(fx.mul(p.share));
            add(flows.INVESTING, p.accountId, moved);
            add(attributed, x.a.id, moved);
          }
        }
        add(flows.OPERATING, x.a.id, fx);
      } else add(flows[section], x.a.id, fx);
      if (!x.pl && x.cls === "OPERATING") add(wc, x.a.id, x.m.neg());
      if (!r.isZero() && section !== "OPERATING") ifResidual = true;
      if (!x.pl && (x.cls === "INVESTING" || x.cls === "FINANCING") && r.isPositive()) debitIF = debitIF.add(r);
      if ((x.a.type === "LIABILITY" || x.a.type === "EQUITY") && r.isNegative()) creditLE = creditLE.add(r.neg());
      if (!r.isZero()) touched.push(x.a.code);
    }
    // Residuals of operating accounts in an entry that is (partly) a non-cash investing/financing
    // transaction are not working-capital movements (e.g. the payable on a fixed-asset bill).
    if (ifResidual) {
      for (const x of others) {
        if (x.pl || x.cls !== "OPERATING") continue;
        const r = x.m.add(flowOf.get(x) ?? Z);
        add(wc, x.a.id, r);
      }
    }
    const disclosed = Prisma.Decimal.min(debitIF, creditLE);
    if (disclosed.gt(0)) nonCash.push({ entryId: e.id, entryNo: e.entryNo, entryDate: e.entryDate, description: e.description, amount: disclosed.toFixed(2), accounts: [...new Set(touched)].sort() });
  }

  // Attributed cash leaves operating (it was counted there above).
  let movedTotal = Z;
  for (const [id, v] of attributed) { add(flows.OPERATING, id, v.neg()); movedTotal = movedTotal.add(v); }
  directOperating = directOperating.sub(movedTotal);

  const row = (id: string, v: D): Row => { const a = acc(id); return { accountId: id, code: a.code, nameAr: a.nameAr, nameEn: a.nameEn, amount: v.toFixed(2), defaulted: a.defaulted }; };
  const rows = (m: Map<string, D>) => [...m].filter(([, v]) => !v.isZero()).map(([id, v]) => row(id, v)).sort((a, b) => a.code.localeCompare(b.code));
  const adjustments: Adjustment[] = [
    ...[...plAffiliated].filter(([, v]) => !v.isZero()).map(([id, v]) => ({ ...row(id, v), kind: "NON_CASH_PL" as const })),
    ...[...wc].filter(([, v]) => !v.isZero()).map(([id, v]) => ({ ...row(id, v), kind: "WORKING_CAPITAL" as const })),
    ...[...attributed].filter(([, v]) => !v.isZero()).map(([id, v]) => ({ ...row(id, v.neg()), kind: "ATTRIBUTED" as const })),
  ].sort((a, b) => a.kind.localeCompare(b.kind) || a.code.localeCompare(b.code));
  const indirectOperating = adjustments.reduce((s, a) => s.add(a.amount), profit);
  const total = (m: Map<string, D>) => [...m.values()].reduce((s, v) => s.add(v), Z);
  const investing = total(flows.INVESTING), financing = total(flows.FINANCING), excluded = total(flows.EXCLUDED);
  const checks = {
    indirectEqualsDirect: indirectOperating.equals(directOperating),
    sectionsEqualCashChange: directOperating.add(investing).add(financing).add(excluded).equals(cashChange),
    excludedIsZero: excluded.isZero(),
  };
  return {
    netProfit: profit.toFixed(2),
    operating: { adjustments, total: directOperating.toFixed(2), indirectTotal: indirectOperating.toFixed(2), direct: rows(flows.OPERATING) },
    investing: { lines: rows(flows.INVESTING), total: investing.toFixed(2) },
    financing: { lines: rows(flows.FINANCING), total: financing.toFixed(2) },
    excluded: { lines: rows(flows.EXCLUDED), total: excluded.toFixed(2) },
    nonCash: nonCash.sort((a, b) => a.entryNo - b.entryNo),
    netChange: cashChange.toFixed(2),
    checks,
    reconciled: checks.indirectEqualsDirect && checks.sectionsEqualCashChange && checks.excludedIsZero,
  };
}
