import type { Prisma as PrismaNS } from "@/generated/prisma/client";
import {
  Decimal, ZERO, roundMoney, qualifyingBase, commissionOnCumulativeBase,
  selectPlanVersion, riyadhMonthStart, riyadhMonthEnd,
  type PlanRules,
} from "./engine";

type Tx = PrismaNS.TransactionClient;

/**
 * Turning collections into money somebody is owed.
 *
 * The arithmetic lives in ./engine.ts and is asserted there without a database. This file
 * is the part that has to be right about rows: which plan applied, what was already
 * recorded, and how to add the difference exactly once however many times the caller tries.
 *
 * ── The central rule ──
 * An accrual is never "commission on this payment". It is the difference between the
 * commission owed on EVERYTHING collected so far in the period and what has already been
 * recorded. Per-payment arithmetic gets the first instalment right and then, on the second,
 * re-adds the whole amount; a re-delivered webhook pays twice; and rounding drifts. The
 * cumulative-target-then-difference shape makes all three impossible rather than merely
 * unlikely.
 */

export type AccrualOutcome = {
  employeeId: string;
  planVersionId: string;
  periodStart: Date;
  /** Everything qualifying this employee has collected in the period, after their share. */
  cumulativeBase: PrismaNS.Decimal;
  /** What the rules say is owed on that cumulative base. */
  targetAmount: PrismaNS.Decimal;
  /** What was already recorded before this run. */
  alreadyRecorded: PrismaNS.Decimal;
  /** The difference actually written. Zero for a replay; negative after a refund. */
  delta: PrismaNS.Decimal;
  effectiveRatePercent: PrismaNS.Decimal;

  /**
   * This ONE event's own qualifying base after the employee's share — its marginal
   * contribution to the period, not the period's running total.
   *
   * The distinction is the whole point. The accrual row is per collection event, so
   * storing the cumulative period figure on it made every row in a two-payment month
   * report the same running total: a month with 50 then 100 collected showed rows of
   * 50 and 150, which sum to 200 against a real 150. Anyone adding up their own payslip
   * got a different answer from the ledger, and the ledger was right.
   *
   * Zero when the event has been reversed, because a reversed event contributes nothing.
   */
  eventBase: PrismaNS.Decimal;
  /** The share applied to this event, recorded so the row explains itself. */
  sharePercent: PrismaNS.Decimal;
};

export type CollectionInput = {
  id: string;
  amountGross: PrismaNS.Decimal;
  amountTax: PrismaNS.Decimal;
  amountNonQualifying: PrismaNS.Decimal;
  currency: string;
  collectedAt: Date;
  status: "RECORDED" | "REVERSED";
};

/** Everything a plan version needs to be applied, read once. */
async function loadPlanRules(tx: Tx, planVersionId: string): Promise<PlanRules & { id: string }> {
  const v = await tx.commissionPlanVersion.findUniqueOrThrow({
    where: { id: planVersionId },
    include: { tiers: { orderBy: { position: "asc" } } },
  });
  return {
    id: v.id,
    basis: "NET_COLLECTION",
    tierMode: v.tierMode as PlanRules["tierMode"],
    baseRatePercent: v.baseRatePercent,
    currency: v.currency,
    tiers: v.tiers.map((t) => ({
      fromAmount: t.fromAmount,
      toAmount: t.toAmount,
      ratePercent: t.ratePercent,
    })),
  };
}

/**
 * Which plan governs this employee for money that arrived at `at`.
 *
 * Chosen by the date the CASH arrived, not the date the deal closed or the plan was edited.
 * A rule change is forward-looking; it does not restate what somebody already earned.
 */
export async function planVersionForEmployeeAt(
  tx: Tx,
  employeeId: string,
  at: Date,
): Promise<string | null> {
  const assignments = await tx.commissionAssignment.findMany({
    where: { employeeId },
    select: { planVersionId: true, effectiveFrom: true, effectiveTo: true },
  });
  const chosen = selectPlanVersion(assignments, at);
  return chosen?.planVersionId ?? null;
}

/**
 * Each employee's share of a collection, from the owning opportunity's splits.
 *
 * Splits in force AT THE COLLECTION DATE, so reassigning a deal tomorrow does not reach
 * back and move today's earnings to somebody else. With no split recorded, the deal's
 * single owner takes the whole base.
 */
export async function sharesForCollection(
  tx: Tx,
  collection: { id: string; opportunityId: string | null },
  at: Date,
): Promise<{ employeeId: string; sharePercent: PrismaNS.Decimal }[]> {
  if (!collection.opportunityId) return [];
  const opp = await tx.opportunity.findUnique({
    where: { id: collection.opportunityId },
    select: {
      ownerId: true,
      owners: {
        where: { effectiveFrom: { lte: at } },
        select: { employeeId: true, sharePercent: true },
      },
    },
  });
  if (!opp) return [];
  if (opp.owners.length === 0) {
    return [{ employeeId: opp.ownerId, sharePercent: new Decimal(100) }];
  }
  return opp.owners.map((o) => ({ employeeId: o.employeeId, sharePercent: o.sharePercent }));
}

/**
 * Recompute one employee's accrual for the period a collection belongs to.
 *
 * Idempotent by construction. Re-running it after the same events changes nothing, because
 * the target is a function of the events and the difference against what is recorded is
 * then zero. That is also what makes a refund work: the cumulative base drops, the target
 * drops, and the difference is negative — booked as a reversal rather than by editing
 * anything that was already approved.
 *
 * Must be called inside a transaction that has serialised on the employee's period. The
 * caller does that by taking the row lock in `recordCollectionAndAccrue` below.
 */
export async function recomputeEmployeePeriod(
  tx: Tx,
  employeeId: string,
  at: Date,
  actorId: string | null,
  /**
   * The event whose own marginal base should be reported back. Optional because a
   * period-wide recomputation (a report, a re-approval preview) has no single event in
   * view; the accrual write path always supplies one.
   */
  forEventId?: string,
): Promise<AccrualOutcome | null> {
  const periodStart = riyadhMonthStart(at);
  const periodEnd = riyadhMonthEnd(at);

  const planVersionId = await planVersionForEmployeeAt(tx, employeeId, at);
  if (!planVersionId) return null;
  const rules = await loadPlanRules(tx, planVersionId);

  // Every qualifying collection this employee has a share of, in this period.
  const events = await tx.collectionEvent.findMany({
    where: {
      status: "RECORDED",
      collectedAt: { gte: periodStart, lt: periodEnd },
    },
    select: {
      id: true, opportunityId: true, amountGross: true, amountTax: true,
      amountNonQualifying: true, currency: true, collectedAt: true,
    },
    orderBy: { collectedAt: "asc" },
  });

  let cumulativeBase = ZERO;
  let eventBase = ZERO;
  let eventShare = new Decimal(100);
  for (const e of events) {
    if (e.currency !== rules.currency) {
      // Refused rather than converted. There is no exchange-rate policy in this system to
      // honour, and an invented rate inside somebody's pay is worse than a refusal.
      throw {
        _appCode: 409,
        message:
          `Collection ${e.id} is in ${e.currency} but the plan pays in ${rules.currency}. ` +
          "There is no exchange-rate policy configured, so this cannot be converted.",
      };
    }
    const shares = await sharesForCollection(tx, e, e.collectedAt);
    const mine = shares.find((s) => s.employeeId === employeeId);
    if (!mine) continue;
    const full = qualifyingBase({
      amountGross: e.amountGross,
      amountTax: e.amountTax,
      amountNonQualifying: e.amountNonQualifying,
    });
    const shareOfThis = roundMoney(full.times(mine.sharePercent).dividedBy(100));
    cumulativeBase = cumulativeBase.plus(shareOfThis);
    if (forEventId && e.id === forEventId) {
      eventBase = shareOfThis;
      eventShare = mine.sharePercent;
    }
  }
  cumulativeBase = roundMoney(cumulativeBase);

  const { amount: targetAmount, effectiveRatePercent } = commissionOnCumulativeBase(cumulativeBase, rules);

  // What THIS ENGINE has already written for the employee and period.
  //
  // ACCRUAL and REVERSAL only — deliberately NOT ADJUSTMENT. An adjustment is a human
  // decision recorded ON TOP of what the rules compute: a goodwill payment, a negotiated
  // correction. Counting it here made it part of the engine's own baseline, so the next
  // collection computed a target that already contained it and wrote a smaller delta to
  // compensate. The adjustment silently evaporated the moment the customer paid again, and
  // the only visible symptom was somebody being paid less than they were promised.
  //
  // `periodStatement` has always reported the two separately for exactly this reason; this
  // is the write path finally agreeing with the read path.
  const recorded = await tx.commissionLedgerEntry.aggregate({
    where: {
      employeeId,
      periodStart,
      type: { in: ["ACCRUAL", "REVERSAL"] },
    },
    _sum: { amount: true },
  });
  const alreadyRecorded = roundMoney(recorded._sum.amount ?? ZERO);
  const delta = roundMoney(targetAmount.minus(alreadyRecorded));

  return {
    employeeId, planVersionId, periodStart,
    cumulativeBase, targetAmount, alreadyRecorded, delta, effectiveRatePercent,
    eventBase, sharePercent: eventShare,
  };
}

/**
 * Write the difference, if there is one.
 *
 * A zero delta writes nothing at all — a replay leaves no trace rather than a row saying
 * "zero". A positive delta is an ACCRUAL; a negative one is a REVERSAL, which is how a
 * refund is recorded without touching an approved entry.
 *
 * Two invariants this function is responsible for:
 *
 *  1. **The accrual row is marginal, the ledger is cumulative.** Each accrual carries what
 *     ITS OWN collection event contributed, so the rows of a period sum to the period's
 *     accrued total. Writing the running total onto every row instead made a month with two
 *     payments read 50 and 150 — summing to 200 against a real 150 — and the person reading
 *     their own payslip had no way to tell which figure was wrong.
 *
 *  2. **An approved accrual is never rewritten.** After approval the correction lives
 *     entirely in the append-only ledger and the accrual keeps the figures that were
 *     approved. Upserting over it would silently restate what somebody had already been
 *     told they earned, which is the exact failure the append-only ledger exists to prevent.
 */
export async function postDelta(
  tx: Tx,
  outcome: AccrualOutcome,
  opts: { collectionEventId: string; actorId: string | null; reason?: string },
): Promise<{ posted: boolean; entryId: string | null; accrualFrozen: boolean }> {
  if (outcome.delta.isZero()) return { posted: false, entryId: null, accrualFrozen: false };

  const periodEnd = riyadhMonthEnd(outcome.periodStart);

  const existing = await tx.commissionAccrual.findUnique({
    where: {
      collectionEventId_employeeId_planVersionId: {
        collectionEventId: opts.collectionEventId,
        employeeId: outcome.employeeId,
        planVersionId: outcome.planVersionId,
      },
    },
    select: { id: true, status: true },
  });

  const frozen = existing?.status === "APPROVED" || existing?.status === "PAID";

  if (!existing) {
    await tx.commissionAccrual.create({
      data: {
        collectionEventId: opts.collectionEventId,
        employeeId: outcome.employeeId,
        planVersionId: outcome.planVersionId,
        periodStart: outcome.periodStart,
        periodEnd,
        // This event's own contribution, so the rows of a period add up.
        qualifyingBase: outcome.eventBase,
        sharePercent: outcome.sharePercent,
        // The period's effective rate, which is what explains why the marginal amount is
        // not simply base x base-rate once a tier has been crossed.
        effectiveRatePercent: outcome.effectiveRatePercent,
        amount: outcome.delta,
        status: "ACCRUED",
      },
    });
  } else if (!frozen) {
    await tx.commissionAccrual.update({
      where: { id: existing.id },
      data: {
        qualifyingBase: outcome.eventBase,
        sharePercent: outcome.sharePercent,
        effectiveRatePercent: outcome.effectiveRatePercent,
        // Accumulates rather than replaces: a reversal of this event decrements its own
        // contribution back towards zero instead of overwriting it with a period figure.
        amount: { increment: outcome.delta },
        // A contribution that has gone back to nothing is a reversal, and says so.
        status: outcome.eventBase.isZero() ? "REVERSED" : "ACCRUED",
      },
    });
  }

  const entry = await tx.commissionLedgerEntry.create({
    data: {
      type: outcome.delta.isNegative() ? "REVERSAL" : "ACCRUAL",
      employeeId: outcome.employeeId,
      periodStart: outcome.periodStart,
      amount: outcome.delta,
      reason:
        opts.reason ??
        (frozen
          ? "Correction against an approved period; the approved accrual is unchanged."
          : null),
      actorId: opts.actorId,
    },
    select: { id: true },
  });

  return { posted: true, entryId: entry.id, accrualFrozen: frozen };
}

/**
 * The whole path for one collection event: record it, then accrue for everyone with a share.
 *
 * Serialisation is on the CollectionEvent row rather than on the employee: two different
 * events for the same employee may legitimately be processed at once, and what must not
 * interleave is two processings of the SAME event. The unique key on
 * (sourceSystem, externalRef) is the final arbiter — a duplicate delivery loses the insert
 * race and then reads what the winner wrote instead of racing it.
 */
export async function accrueForCollection(
  tx: Tx,
  collectionEventId: string,
  actorId: string | null,
): Promise<AccrualOutcome[]> {
  // FOR UPDATE on the event, so two deliveries of the same payment queue rather than race.
  const locked = await tx.$queryRaw<{ id: string; opportunityId: string | null; collectedAt: Date; status: string }[]>`
    SELECT "id", "opportunityId", "collectedAt", "status"::text AS status
      FROM "CollectionEvent"
     WHERE "id" = ${collectionEventId}
       FOR UPDATE
  `;
  const event = locked[0];
  if (!event) throw { _appCode: 404, message: "Collection event not found." };

  // A reversal still recomputes: the cumulative base drops and the difference comes out
  // negative, which is exactly the correction that is wanted.
  const shares = await sharesForCollection(tx, event, event.collectedAt);
  const outcomes: AccrualOutcome[] = [];

  for (const share of shares) {
    const outcome = await recomputeEmployeePeriod(
      tx, share.employeeId, event.collectedAt, actorId, collectionEventId,
    );
    if (!outcome) continue;
    await postDelta(tx, outcome, { collectionEventId, actorId });
    outcomes.push(outcome);
  }
  return outcomes;
}

/**
 * Approve accruals for a period. Approved figures become immutable.
 *
 * Deliberately no "un-approve". Once somebody has been told what they earned, changing it
 * is a correction with a reason attached, not an edit — see `adjust` below.
 */
export async function approvePeriod(
  tx: Tx,
  employeeId: string,
  periodStart: Date,
  approverId: string,
): Promise<number> {
  const res = await tx.commissionAccrual.updateMany({
    where: { employeeId, periodStart, status: "ACCRUED" },
    data: { status: "APPROVED", approvedById: approverId, approvedAt: new Date() },
  });
  return res.count;
}

/**
 * A manual correction against an approved or paid period.
 *
 * Never an edit. The original stays exactly as approved and this adds a referenced entry
 * carrying the actor and the reason, so the history reads as what happened rather than as
 * what someone later wished had happened.
 */
export async function adjust(
  tx: Tx,
  input: {
    employeeId: string;
    periodStart: Date;
    amount: PrismaNS.Decimal;
    reason: string;
    correctsEntryId?: string | null;
    actorId: string;
  },
): Promise<string> {
  if (input.reason.trim().length < 3) {
    throw { _appCode: 400, message: "An adjustment needs a reason." };
  }
  if (input.amount.isZero()) {
    throw { _appCode: 400, message: "A zero adjustment records nothing; it is refused rather than stored." };
  }
  const entry = await tx.commissionLedgerEntry.create({
    data: {
      type: "ADJUSTMENT",
      employeeId: input.employeeId,
      periodStart: input.periodStart,
      amount: roundMoney(input.amount),
      reason: input.reason.trim(),
      correctsId: input.correctsEntryId ?? null,
      actorId: input.actorId,
    },
    select: { id: true },
  });
  return entry.id;
}

/** What an employee is owed for a period, as the ledger sees it. */
export async function periodStatement(
  tx: Tx,
  employeeId: string,
  periodStart: Date,
): Promise<{
  periodStart: Date;
  /** Net of reversals — what is actually owed for the period. */
  accrued: PrismaNS.Decimal;
  /** The positive half of `accrued`, before any reversal. */
  accrualEntries: PrismaNS.Decimal;
  /** The negative half. Zero or below, never above. */
  reversals: PrismaNS.Decimal;
  adjustments: PrismaNS.Decimal;
  paid: PrismaNS.Decimal;
  outstanding: PrismaNS.Decimal;
}> {
  const rows = await tx.commissionLedgerEntry.groupBy({
    by: ["type"],
    where: { employeeId, periodStart },
    _sum: { amount: true },
  });
  const by = (t: string) => roundMoney(rows.find((r) => r.type === t)?._sum.amount ?? ZERO);
  // The two halves are returned separately as well as netted. A reviewer reconciling the
  // per-collection accrual rows has to compare them against the POSITIVE half: a reversal
  // deliberately leaves the accrual row it corrects untouched, so the rows can only ever
  // explain what was accrued, never what was later taken back.
  const accrualEntries = by("ACCRUAL");
  const reversals = by("REVERSAL");
  const accrued = roundMoney(accrualEntries.plus(reversals));
  const adjustments = by("ADJUSTMENT");
  const paid = by("PAYOUT");
  return {
    periodStart,
    accrued,
    accrualEntries,
    reversals,
    adjustments,
    paid,
    outstanding: roundMoney(accrued.plus(adjustments).minus(paid)),
  };
}
