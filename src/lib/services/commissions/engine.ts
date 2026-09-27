// Decimal comes from the Prisma runtime, NOT from the generated client.
//
// The generated client is a large, schema-shaped module that drags the whole data layer in
// with it. This file has no business knowing what tables exist — it is arithmetic — and
// depending on the client would also make it uncompilable on its own, which is exactly how
// the worked examples below get asserted without a database. The runtime path is a real
// node_modules entry that resolves identically inside Next.js and in plain Node.
import { Decimal } from "@prisma/client/runtime/client";

/** Re-exported so a caller constructs the same Decimal this engine computes with. */
export { Decimal };

/**
 * Commission calculation — pure domain, no database and no HTTP.
 *
 * Kept callable with plain values so the arithmetic can be asserted directly against the
 * worked examples the business gave us, rather than inferred from what the database
 * happens to contain. Everything that touches rows lives in ./accrual.ts.
 *
 * ── Money ──
 * Decimal throughout, never `number`. The existing accounting models already state
 * this rule in the schema and the reason applies with more force here: a commission is
 * someone's pay, and 0.1 + 0.2 is not a question a wage may depend on. Rates are Decimal
 * too — a percentage multiplied by a float base reintroduces exactly the error the Decimal
 * base was chosen to avoid.
 */

/**
 * Decimal.Value is not exported as a namespace member in Prisma 7, so the accepted input
 * types are spelled out. Notably NOT `number` for anything derived from money — a numeric
 * literal is fine for a constant like 100, and a string is what any real amount should
 * arrive as.
 */
type DecimalInput = string | number | Decimal;
const D = (v: DecimalInput) => new Decimal(v);
export const ZERO = D(0);
const HUNDRED = D(100);

/** Half-up to two decimal places — the smallest unit of Saudi currency in practice. */
export function roundMoney(v: Decimal): Decimal {
  return v.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

export type TierMode = "INCREMENTAL" | "RETROACTIVE";

export type Tier = {
  /** Inclusive lower bound of the band. */
  fromAmount: Decimal;
  /** Exclusive upper bound; null means "and above". */
  toAmount: Decimal | null;
  /**
   * Percentage POINTS added to the base rate for the portion of base inside this band.
   *
   * Points, not a replacement rate. "0.5 more on the slice between 100k and 120k" is how
   * the business stated it, and storing it as a final rate instead would silently drop the
   * base rate the moment someone edited one of the two numbers.
   */
  ratePercent: Decimal;
};

export type PlanRules = {
  basis: "NET_COLLECTION";
  tierMode: TierMode;
  /** Flat rate applied to the whole base, as a percentage. 1.5 means 1.5%. */
  baseRatePercent: Decimal;
  tiers: Tier[];
  currency: string;
};

export type PlanRulesProblem = { code: string; message: string };

/**
 * Reject a plan we cannot honour, before it can be assigned to anybody.
 *
 * RETROACTIVE is named in the type and refused here. Shipping it half-working would be
 * worse than not shipping it: the two modes differ by thousands of riyals on the same
 * numbers, and a plan that silently computed the wrong one is the kind of error people
 * only find in their own payslip.
 */
export function validatePlanRules(rules: PlanRules): PlanRulesProblem[] {
  const problems: PlanRulesProblem[] = [];

  if (rules.basis !== "NET_COLLECTION") {
    problems.push({ code: "BASIS_UNSUPPORTED", message: `Unsupported commission basis "${rules.basis}".` });
  }
  if (rules.tierMode === "RETROACTIVE") {
    problems.push({
      code: "RETROACTIVE_TIERS_UNSUPPORTED",
      message:
        "Retroactive tiers are not implemented. A retroactive tier applies the reached rate to " +
        "the whole base and pays very differently from an incremental one, so it is refused " +
        "rather than approximated. Use incremental tiers.",
    });
  }
  if (rules.currency !== "SAR") {
    problems.push({
      code: "CURRENCY_UNSUPPORTED",
      message:
        `Commission is only calculated in SAR; this plan says ${rules.currency}. There is no ` +
        "exchange-rate policy in this system to convert against, so a figure would have to be " +
        "invented.",
    });
  }
  if (rules.baseRatePercent.lessThan(0) || rules.baseRatePercent.greaterThan(HUNDRED)) {
    problems.push({ code: "BASE_RATE_RANGE", message: "The base rate must be between 0% and 100%." });
  }

  // Bands must be ordered, non-overlapping and non-empty. Overlapping bands would let the
  // same riyal be paid twice, which no amount of downstream rounding can undo.
  const sorted = [...rules.tiers].sort((a, b) => a.fromAmount.comparedTo(b.fromAmount));
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i];
    if (t.toAmount !== null && t.toAmount.lessThanOrEqualTo(t.fromAmount)) {
      problems.push({
        code: "TIER_EMPTY",
        message: `Tier starting at ${t.fromAmount.toFixed(2)} ends at or before it starts.`,
      });
    }
    if (t.ratePercent.lessThan(0)) {
      problems.push({ code: "TIER_RATE_NEGATIVE", message: "A tier rate cannot be negative." });
    }
    const prev = sorted[i - 1];
    if (prev && prev.toAmount === null) {
      problems.push({
        code: "TIER_AFTER_OPEN_BAND",
        message: "A tier cannot follow an open-ended band; nothing can sit above \"and above\".",
      });
    }
    if (prev && prev.toAmount !== null && t.fromAmount.lessThan(prev.toAmount)) {
      problems.push({
        code: "TIER_OVERLAP",
        message: `Tiers overlap around ${t.fromAmount.toFixed(2)}; the same amount would be paid twice.`,
      });
    }
  }

  return problems;
}

/**
 * The qualifying base of one collection.
 *
 * Commission is owed on money actually received, excluding tax — the roastery collects VAT
 * on behalf of the state and never earns it — and excluding whatever the plan does not
 * qualify. Computed here rather than by the caller so every path agrees on what "net
 * qualified collection" means.
 */
export function qualifyingBase(input: {
  amountGross: Decimal;
  amountTax: Decimal;
  amountNonQualifying: Decimal;
}): Decimal {
  const base = input.amountGross.minus(input.amountTax).minus(input.amountNonQualifying);
  return roundMoney(base.isNegative() ? ZERO : base);
}

/**
 * Commission on a cumulative base, under one plan version.
 *
 * Deliberately a function of the CUMULATIVE base rather than of a single payment. Tiers are
 * defined against how much an employee has collected over the period, so asking "what is
 * owed on this one payment" has no answer that stays correct once a second payment arrives.
 * The caller computes the difference against what is already accrued — see accrual.ts.
 */
export function commissionOnCumulativeBase(
  cumulativeBase: Decimal,
  rules: PlanRules,
): { amount: Decimal; effectiveRatePercent: Decimal } {
  if (cumulativeBase.lessThanOrEqualTo(0)) {
    return { amount: ZERO, effectiveRatePercent: rules.baseRatePercent };
  }

  // The base rate applies to everything.
  let amount = cumulativeBase.times(rules.baseRatePercent).dividedBy(HUNDRED);

  // Then each band adds its own points, but only on the slice of base inside it. A band
  // that the base has not reached contributes nothing; a band it has passed straight
  // through contributes on its full width, not on the whole base.
  if (rules.tierMode === "INCREMENTAL") {
    for (const tier of rules.tiers) {
      const bandFrom = tier.fromAmount;
      if (cumulativeBase.lessThanOrEqualTo(bandFrom)) continue;
      const bandTo = tier.toAmount === null ? cumulativeBase : Decimal.min(cumulativeBase, tier.toAmount);
      const slice = bandTo.minus(bandFrom);
      if (slice.lessThanOrEqualTo(0)) continue;
      amount = amount.plus(slice.times(tier.ratePercent).dividedBy(HUNDRED));
    }
  }

  const rounded = roundMoney(amount);
  // Reported so a payslip can be explained without re-running the engine. Derived from the
  // rounded amount so the rate shown and the money paid agree.
  const effectiveRatePercent = cumulativeBase.isZero()
    ? rules.baseRatePercent
    : rounded.dividedBy(cumulativeBase).times(HUNDRED).toDecimalPlaces(6, Decimal.ROUND_HALF_UP);

  return { amount: rounded, effectiveRatePercent };
}

/**
 * Apply an ownership share to a base.
 *
 * Applied to the BASE, not to the finished commission. With tiers the two differ: splitting
 * a tiered result gives each person a share of someone else's tier progress, whereas
 * splitting the base is what "60% of this deal is mine" actually means.
 */
export function shareOfBase(base: Decimal, sharePercent: Decimal): Decimal {
  return roundMoney(base.times(sharePercent).dividedBy(HUNDRED));
}

export type SplitProblem = { code: string; message: string };

/** Splits must be positive and total exactly 100 — no silent normalising. */
export function validateSplits(splits: { employeeId: string; sharePercent: Decimal }[]): SplitProblem[] {
  const problems: SplitProblem[] = [];
  if (splits.length === 0) return problems;

  const seen = new Set<string>();
  let total = ZERO;
  for (const s of splits) {
    if (seen.has(s.employeeId)) {
      problems.push({ code: "SPLIT_DUPLICATE", message: "The same employee appears twice in the split." });
    }
    seen.add(s.employeeId);
    if (s.sharePercent.lessThanOrEqualTo(0)) {
      problems.push({ code: "SPLIT_NON_POSITIVE", message: "Every share must be greater than zero." });
    }
    total = total.plus(s.sharePercent);
  }
  if (!total.equals(HUNDRED)) {
    problems.push({
      code: "SPLIT_TOTAL",
      message: `Ownership shares total ${total.toFixed(2)}%, not 100%. Rounding them here would decide ` +
        "somebody's pay by accident.",
    });
  }
  return problems;
}

// ─── Periods ─────────────────────────────────────────────────────────────────────
//
// The business runs on Asia/Riyadh months. Riyadh is UTC+03:00 with no daylight saving,
// which is why a fixed offset is correct here and a timezone library would add a
// dependency without adding accuracy. Stored as UTC instants so two servers in different
// regions agree on which month a collection fell in.

const RIYADH_OFFSET_HOURS = 3;

/** The UTC instant of the first moment of the Riyadh month containing `at`. */
export function riyadhMonthStart(at: Date): Date {
  const riyadh = new Date(at.getTime() + RIYADH_OFFSET_HOURS * 3600_000);
  const y = riyadh.getUTCFullYear();
  const m = riyadh.getUTCMonth();
  return new Date(Date.UTC(y, m, 1, 0, 0, 0, 0) - RIYADH_OFFSET_HOURS * 3600_000);
}

/** The UTC instant of the first moment of the NEXT Riyadh month — an exclusive end. */
export function riyadhMonthEnd(at: Date): Date {
  const riyadh = new Date(at.getTime() + RIYADH_OFFSET_HOURS * 3600_000);
  const y = riyadh.getUTCFullYear();
  const m = riyadh.getUTCMonth();
  return new Date(Date.UTC(y, m + 1, 1, 0, 0, 0, 0) - RIYADH_OFFSET_HOURS * 3600_000);
}

/** Which plan version governs a collection, by the date the money arrived. */
export function selectPlanVersion<T extends { effectiveFrom: Date; effectiveTo: Date | null }>(
  versions: T[],
  at: Date,
): T | null {
  const applicable = versions.filter(
    (v) => v.effectiveFrom.getTime() <= at.getTime() && (v.effectiveTo === null || v.effectiveTo.getTime() > at.getTime()),
  );
  if (applicable.length === 0) return null;
  // Latest start wins, so a correction issued later governs without deleting history.
  return applicable.sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0];
}

/** Assignments must not overlap for one employee — two live plans have no defined answer. */
export function findOverlappingAssignment<T extends { effectiveFrom: Date; effectiveTo: Date | null }>(
  existing: T[],
  candidate: { effectiveFrom: Date; effectiveTo: Date | null },
): T | null {
  const cFrom = candidate.effectiveFrom.getTime();
  const cTo = candidate.effectiveTo?.getTime() ?? Number.POSITIVE_INFINITY;
  for (const a of existing) {
    const aFrom = a.effectiveFrom.getTime();
    const aTo = a.effectiveTo?.getTime() ?? Number.POSITIVE_INFINITY;
    if (cFrom < aTo && aFrom < cTo) return a;
  }
  return null;
}
