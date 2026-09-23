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
    cumulativeBase = cumulativeBase.plus(roundMoney(full.times(mine.sharePercent).dividedBy(100)));
  }
  cumulativeBase = roundMoney(cumulativeBase);

  const { amount: targetAmount, effectiveRatePercent } = commissionOnCumulativeBase(cumulativeBase, rules);

  // What is already on the books for this employee, period and plan version.
  const recorded = await tx.commissionLedgerEntry.aggregate({
    where: {
      employeeId,
      periodStart,
      type: { in: ["ACCRUAL", "ADJUSTMENT", "REVERSAL"] },
    },
    _sum: { amount: true },
  });
  const alreadyRecorded = roundMoney(recorded._sum.amount ?? ZERO);
  const delta = roundMoney(targetAmount.minus(alreadyRecorded));

  return {
    employeeId, planVersionId, periodStart,
    cumulativeBase, targetAmount, alreadyRecorded, delta, effectiveRatePercent,
  };
}

/**
 * Write the difference, if there is one.
 *
 * A zero delta writes nothing at all — a replay leaves no trace rather than a row saying
 * "zero". A positive delta is an ACCRUAL; a negative one is a REVERSAL, which is how a
 * refund is recorded without touching an approved entry.
 */
export async function postDelta(
  tx: Tx,
  outcome: AccrualOutcome,
  opts: { collectionEventId: string; actorId: string | null; reason?: string },
): Promise<{ posted: boolean; entryId: string | null }> {
  if (outcome.delta.isZero()) return { posted: false, entryId: null };

  const periodEnd = riyadhMonthEnd(outcome.periodStart);

  // The accrual row carries the explanation: the base, the share and the rate that produced
  // the figure, so a payslip question is answerable without re-running the engine.
  await tx.commissionAccrual.upsert({
    where: {
      collectionEventId_employeeId_planVersionId: {
        collectionEventId: opts.collectionEventId,
        employeeId: outcome.employeeId,
        planVersionId: outcome.planVersionId,
      },
    },
    create: {
      collectionEventId: opts.collectionEventId,
      employeeId: outcome.employeeId,
      planVersionId: outcome.planVersionId,
      periodStart: outcome.periodStart,
      periodEnd,
      qualifyingBase: outcome.cumulativeBase,
      effectiveRatePercent: outcome.effectiveRatePercent,
      amount: outcome.targetAmount,
      status: "ACCRUED",
    },
    update: {
      qualifyingBase: outcome.cumulativeBase,
      effectiveRatePercent: outcome.effectiveRatePercent,
      amount: outcome.targetAmount,
    },
  });

  const entry = await tx.commissionLedgerEntry.create({
    data: {
      type: outcome.delta.isNegative() ? "REVERSAL" : "ACCRUAL",
      employeeId: outcome.employeeId,
      periodStart: outcome.periodStart,
      amount: outcome.delta,
      reason: opts.reason ?? null,
      actorId: opts.actorId,
    },
    select: { id: true },
  });

  return { posted: true, entryId: entry.id };
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
    const outcome = await recomputeEmployeePeriod(tx, share.employeeId, event.collectedAt, actorId);
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
  accrued: PrismaNS.Decimal;
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
  const accrued = roundMoney(by("ACCRUAL").plus(by("REVERSAL")));
  const adjustments = by("ADJUSTMENT");
  const paid = by("PAYOUT");
  return {
    periodStart,
    accrued,
    adjustments,
    paid,
    outstanding: roundMoney(accrued.plus(adjustments).minus(paid)),
  };
}
