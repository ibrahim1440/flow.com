import { Decimal, ZERO, roundMoney, riyadhMonthStart } from "./engine";

/**
 * Year-end clawback of commission on a credit note left UNUSED — the pure rule (owner decision,
 * 29 Oct 2026; docs/sales/COMMISSION_RULES.md §10). No database and no HTTP: the job that reads the
 * rows and writes the ledger lives in ./credit-clawback.ts, and the arithmetic is asserted here
 * directly in tests/sales/unit/commission-clawback.test.ts.
 *
 * ── Why at year end, and only the unused part ──
 * Commission is owed on NET CASH COLLECTED, and that does not change: a credit note the customer
 * later spends on another invoice is a discount on future cash, and the commission on that future
 * cash is already smaller by exactly that much. Only a credit that is never spent — the customer
 * left with a balance in hand — means the collection the rep was paid on was, in substance, handed
 * back. Whether that has happened is not knowable on the day the note is issued; 31 December is the
 * point the owner chose to call it. One look, once, per credit note.
 *
 * ── What is clawed back ──
 *   unused gross = grand total − what was applied from the note on or before 31 Dec
 *   unused net   = unused gross × (grand total − VAT) / grand total            (VAT was never commissioned)
 *   claw base    = min(unused net, the qualifying base of the collections the note relates to)
 * and each collection's slice of that base (pro rata to its own base) is charged back to the people
 * who earned on it, at THEIR share and THEIR effective rate on it. A credit note larger than what was
 * ever collected on its invoice cannot take back commission that was never paid — hence the cap.
 *
 * ── Money ──
 * Decimal throughout, unrounded until the very end, then half-up to two places once per person, so
 * a split across many collections does not drift by a halala per slice.
 */

const HUNDRED = new Decimal(100);

/** The reason prefix that makes a clawback findable — and therefore writable only once — per credit note. */
export const CLAWBACK_REASON_PREFIX = "CREDIT_NOTE_CLAWBACK:";
export const clawbackMarker = (creditNoteId: string) => `${CLAWBACK_REASON_PREFIX}${creditNoteId}:`;

/**
 * The Riyadh calendar year as instants and as day strings. The accounting module's fiscal year is the
 * Gregorian year (lib/accounting/fiscal-years.ts ensureFiscalYear: twelve monthly periods, January to
 * December) and commission months are Riyadh months, so the two agree with no fiscal-year lookup.
 */
export function riyadhYearBounds(year: number): { start: Date; end: Date; firstDay: string; lastDay: string } {
  return {
    start: riyadhMonthStart(new Date(Date.UTC(year, 0, 15))),
    end: riyadhMonthStart(new Date(Date.UTC(year + 1, 0, 15))),
    firstDay: `${year}-01-01`,
    lastDay: `${year}-12-31`,
  };
}

/** The last calendar year that has fully ended in Riyadh at `now`. */
export function lastEndedRiyadhYear(now: Date): number {
  return new Date(now.getTime() + 3 * 3600_000).getUTCFullYear() - 1;
}

export type ClawbackCreditNote = {
  grandTotal: Decimal;
  taxTotal: Decimal;
  /** Applied from the note to invoices on or before 31 December of the year being closed. */
  applied: Decimal;
};

/** A person who earned on one collection, as the accrual recorded it. */
export type ClawbackEarner = {
  employeeId: string;
  /** The split in force at the collection date (sharesForCollection), as stored on the accrual. */
  sharePercent: Decimal;
  /** The effective rate the engine applied to the collection's month, as stored on the accrual. */
  effectiveRatePercent: Decimal;
};

/** One collection the credit note relates to: its qualifying base (pre-split) on the original invoice. */
export type ClawbackCollection = {
  collectionEventId: string;
  base: Decimal;
  earners: ClawbackEarner[];
};

export type ClawbackLine = {
  employeeId: string;
  /** This person's share of the claw base, rounded. */
  base: Decimal;
  /** The weighted rate actually charged (|amount| / base), for the explanation only. */
  ratePercent: Decimal;
  /** NEGATIVE: what is taken back. Never zero (a zero line is not returned). */
  amount: Decimal;
  collectionEventIds: string[];
};

export type ClawbackResult = {
  unusedGross: Decimal;
  unusedNet: Decimal;
  /** The qualifying base of every related collection — the cap. */
  collectedBase: Decimal;
  /** min(unusedNet, collectedBase): the part commission was actually paid on. */
  clawbackBase: Decimal;
  lines: ClawbackLine[];
};

/** What is left of a credit note, gross and net of its own VAT. Never negative. */
export function unusedCredit(cn: ClawbackCreditNote): { unusedGross: Decimal; unusedNet: Decimal } {
  const unusedGross = Decimal.max(roundMoney(cn.grandTotal.minus(cn.applied)), ZERO);
  if (unusedGross.isZero() || cn.grandTotal.lessThanOrEqualTo(0)) return { unusedGross, unusedNet: ZERO };
  const netShare = cn.grandTotal.minus(cn.taxTotal).dividedBy(cn.grandTotal);
  return { unusedGross, unusedNet: roundMoney(Decimal.max(unusedGross.times(netShare), ZERO)) };
}

export function computeCreditClawback(cn: ClawbackCreditNote, collections: ClawbackCollection[]): ClawbackResult {
  const { unusedGross, unusedNet } = unusedCredit(cn);
  const counted = collections.filter((c) => c.base.greaterThan(0));
  const collectedBase = roundMoney(counted.reduce((s, c) => s.plus(c.base), ZERO));
  const clawbackBase = Decimal.min(unusedNet, collectedBase);
  if (clawbackBase.lessThanOrEqualTo(0)) return { unusedGross, unusedNet, collectedBase, clawbackBase: ZERO, lines: [] };

  const per = new Map<string, { base: Decimal; amount: Decimal; events: Set<string> }>();
  for (const c of counted) {
    // This collection's slice of the claw base, pro rata to its own base — unrounded on purpose.
    const slice = clawbackBase.times(c.base).dividedBy(collectedBase);
    for (const e of c.earners) {
      if (e.sharePercent.lessThanOrEqualTo(0)) continue;
      const mine = slice.times(e.sharePercent).dividedBy(HUNDRED);
      const row = per.get(e.employeeId) ?? { base: ZERO, amount: ZERO, events: new Set<string>() };
      row.base = row.base.plus(mine);
      row.amount = row.amount.plus(mine.times(Decimal.max(e.effectiveRatePercent, ZERO)).dividedBy(HUNDRED));
      row.events.add(c.collectionEventId);
      per.set(e.employeeId, row);
    }
  }

  const lines: ClawbackLine[] = [];
  for (const [employeeId, row] of [...per.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const amount = roundMoney(row.amount);
    if (amount.isZero()) continue;
    const base = roundMoney(row.base);
    lines.push({
      employeeId,
      base,
      ratePercent: base.isZero() ? ZERO : amount.dividedBy(base).times(HUNDRED).toDecimalPlaces(6, Decimal.ROUND_HALF_UP),
      amount: amount.negated(),
      collectionEventIds: [...row.events].sort(),
    });
  }
  return { unusedGross, unusedNet, collectedBase, clawbackBase: roundMoney(clawbackBase), lines };
}
