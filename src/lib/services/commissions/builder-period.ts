import type { Prisma as PrismaNS } from "@/generated/prisma/client";
import { Decimal, roundMoney, qualifyingBase, riyadhMonthStart, riyadhMonthEnd, selectPlanVersion } from "./engine";
import {
  addDuration, classifyClientHistory, computePeriod, readComponents,
  type ClientHistory, type ClientRules, type ClientStatus, type Components, type Decision, type PeriodComputation, type PeriodLine,
} from "./builder";
import { effectiveClientRules, getCommissionSettings } from "./settings";

type Tx = PrismaNS.TransactionClient;

/**
 * The database side of a COMPONENTS plan: which collections an employee shares in a month, which
 * order of its client each one is, whether the client counts as new, the month's target and any
 * management decision — then the pure arithmetic of ./builder.ts.
 *
 * Read-only. Writing the difference to the ledger stays where it always was (./accrual.ts
 * recomputeEmployeePeriod → postDelta), so a COMPONENTS month moves money through the same
 * append-only movements, approval, payout and payroll bridge as a tiered one.
 *
 * ── Definitions (decisions recorded in docs/sales/COMMISSION_BUILDER.md) ──
 *  - The base of a collection is the existing qualifying base (net of tax and non-qualifying),
 *    times this employee's share of the deal at the collection date — the existing linkage.
 *  - An "order" is the document the money was collected against: the accepted quotation of the
 *    SalesCollection, else the deal, else the order, else the event itself (sandbox).
 *  - Order sequence is per CLIENT, across months and reps: orders ranked by their first
 *    recorded (not reversed) collection.
 *  - Acquisition is the client's first recorded collection. The client is NEW unless it is
 *    flagged «مستثنى من عمولة العميل الجديد», or it bought (a non-cancelled order not born of a
 *    collected deal) within the plan's window before acquisition. After the eligibility
 *    duration, its orders pay the existing-client rate.
 */

export type BuilderPeriod = {
  components: Components;
  planVersionId: string;
  periodStart: Date;
  periodEnd: Date;
  computation: PeriodComputation;
  /** Per collection: what the screens explain. */
  detail: {
    ref: string; customerId: string | null; customerName: string | null; orderKey: string | null;
    collectedAt: string | null; base: string; status: ClientStatus; sequence: number | null;
    ratePercent: string; amount: string; projected?: boolean;
  }[];
  decision: { id: string; kind: string; amount: string; reason: string; bracketIndex: number; decidedAt: Date; decidedById: string; applies: boolean } | null;
  /** The activation date in force; null = commissions not activated (nothing is computed). */
  activationDate: Date | null;
  rules: ClientRules;
};

/** A collection that does not exist yet, folded in for a projection (the finance queue's estimate). */
export type ProjectedEvent = { customerId: string | null; orderKey: string | null; base: Decimal; at: Date };

const orderKeyOf = (e: { id: string; opportunityId: string | null; orderId: string | null; salesCollection: { quoteId: string | null } | null }) =>
  e.salesCollection?.quoteId ? `q:${e.salesCollection.quoteId}` : e.opportunityId ? `o:${e.opportunityId}` : e.orderId ? `r:${e.orderId}` : `e:${e.id}`;

export async function isComponentsVersion(tx: Tx, planVersionId: string): Promise<boolean> {
  const v = await tx.commissionPlanVersion.findUnique({ where: { id: planVersionId }, select: { components: true } });
  return !!v && v.components !== null;
}

/**
 * Which plan version governs a COMPONENTS month. A month is one computation, so one version:
 * the assignment in force at the month's last instant, else the latest-starting assignment that
 * overlaps the month. Returns null when that assignment is a tiered version (the tiered
 * selection by collection date then stands, unchanged).
 */
export async function componentsVersionForPeriod(tx: Tx, employeeId: string, at: Date): Promise<string | null> {
  const periodStart = riyadhMonthStart(at);
  const periodEnd = riyadhMonthEnd(at);
  const overlapping = await tx.commissionAssignment.findMany({
    where: { employeeId, effectiveFrom: { lt: periodEnd }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: periodStart } }] },
    select: { planVersionId: true, effectiveFrom: true, effectiveTo: true, planVersion: { select: { components: true } } },
  });
  if (overlapping.length === 0) return null;
  const atEnd = selectPlanVersion(overlapping, new Date(periodEnd.getTime() - 1));
  const pick = atEnd ?? [...overlapping].sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0];
  return pick.planVersion.components !== null ? pick.planVersionId : null;
}

/** The live management decision for the month, if any. */
export async function liveDecision(tx: Tx, employeeId: string, periodStart: Date) {
  return tx.commissionBonusDecision.findFirst({
    where: { employeeId, periodStart, supersededAt: null },
    select: { id: true, kind: true, amount: true, reason: true, bracketIndex: true, planVersionId: true, decidedAt: true, decidedById: true },
  });
}

async function sharesAt(tx: Tx, opportunityId: string | null, at: Date): Promise<{ employeeId: string; sharePercent: Decimal }[]> {
  if (!opportunityId) return [];
  const opp = await tx.opportunity.findUnique({
    where: { id: opportunityId },
    select: { ownerId: true, owners: { where: { effectiveFrom: { lte: at } }, select: { employeeId: true, sharePercent: true } } },
  });
  if (!opp) return [];
  if (opp.owners.length === 0) return [{ employeeId: opp.ownerId, sharePercent: new Decimal(100) }];
  return opp.owners.map((o) => ({ employeeId: o.employeeId, sharePercent: new Decimal(o.sharePercent.toString()) }));
}

type ClientFacts = { name: string | null; history: ClientHistory };

/**
 * One client's relationship under the rules: which epoch (acquisition / re-acquisition after a
 * lapse) each collection belongs to, its order number and its status — see classifyClientHistory.
 * Only collections on or after the activation date are sequenced; earlier ones count only as
 * earlier purchases (for the window and the lapse tests).
 */
async function clientFacts(tx: Tx, customerId: string, rules: ClientRules, activation: Date, projected?: ProjectedEvent): Promise<ClientFacts> {
  const customer = await tx.customer.findUnique({
    where: { id: customerId },
    select: { name: true, newClientCommissionExcluded: true, commissionPriorOrders: true, createdAt: true },
  });
  const all = await tx.collectionEvent.findMany({
    where: { customerId, status: "RECORDED" },
    orderBy: [{ collectedAt: "asc" }, { id: "asc" }],
    select: { id: true, opportunityId: true, orderId: true, collectedAt: true, salesCollection: { select: { quoteId: true } } },
  });
  const timeline = all.map((e) => ({ ref: e.id, at: e.collectedAt, orderKey: orderKeyOf(e), opportunityId: e.opportunityId }));
  if (projected && projected.customerId === customerId) {
    timeline.push({ ref: "projected", at: projected.at, orderKey: projected.orderKey ?? "projected", opportunityId: null });
  }
  const after = timeline.filter((t) => t.at.getTime() >= activation.getTime());
  const before = timeline.filter((t) => t.at.getTime() < activation.getTime());
  const orders = await tx.order.findMany({
    where: { customerId, status: { notIn: ["Cancelled", "Rejected"] } },
    select: { createdAt: true, opportunityLinks: { select: { opportunityId: true } } },
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  const preExisting = !!customer && customer.createdAt.getTime() < activation.getTime();
  const lastBefore = [
    ...before.map((t) => t.at),
    ...orders.filter((o) => o.createdAt.getTime() < activation.getTime()).map((o) => o.createdAt),
  ].sort((x, y) => y.getTime() - x.getTime())[0] ?? null;

  const history = classifyClientHistory({
    events: after.map((t) => ({ ref: t.ref, at: t.at, orderKey: t.orderKey })),
    excluded: customer?.newClientCommissionExcluded ?? false,
    preExisting,
    priorOrders: customer?.commissionPriorOrders ?? null,
    lastPurchaseBefore: lastBefore,
    boughtWithinWindowBefore: (at, epochKeys) => {
      const from = rules.window ? addDuration(at, rules.window, -1).getTime() : -Infinity;
      const inWindow = (d: Date) => d.getTime() < at.getTime() && d.getTime() >= from;
      const epochDeals = new Set(timeline.filter((t) => epochKeys.has(t.orderKey)).map((t) => t.opportunityId).filter((x): x is string => !!x));
      // An earlier collection of another order, or an order not born of this epoch's deals.
      if (timeline.some((t) => inWindow(t.at) && !epochKeys.has(t.orderKey))) return true;
      return orders.some((o) => inWindow(o.createdAt) && !o.opportunityLinks.some((l) => epochDeals.has(l.opportunityId)));
    },
  }, rules);
  return { name: customer?.name ?? null, history };
}

/**
 * Compute one employee's COMPONENTS month. `planVersionId` must be a COMPONENTS version.
 * `projected`, when given, is folded in as one more collection (nothing is written).
 */
export async function computeBuilderPeriod(
  tx: Tx,
  input: { employeeId: string; planVersionId: string; at: Date; projected?: ProjectedEvent },
): Promise<BuilderPeriod> {
  const periodStart = riyadhMonthStart(input.at);
  const periodEnd = riyadhMonthEnd(input.at);
  const version = await tx.commissionPlanVersion.findUniqueOrThrow({ where: { id: input.planVersionId }, select: { components: true, currency: true } });
  const components = readComponents(version.components);
  const settings = await getCommissionSettings(tx);
  const rules = effectiveClientRules(components, settings);
  // No commission before the activation date; nothing at all until it is set.
  const activation = settings.activationDate;

  const events = await tx.collectionEvent.findMany({
    where: activation
      ? { status: "RECORDED", collectedAt: { gte: activation.getTime() > periodStart.getTime() ? activation : periodStart, lt: periodEnd } }
      : { id: "∅-not-activated" },
    orderBy: [{ collectedAt: "asc" }, { id: "asc" }],
    select: {
      id: true, opportunityId: true, orderId: true, customerId: true, currency: true, collectedAt: true,
      amountGross: true, amountTax: true, amountNonQualifying: true, salesCollection: { select: { quoteId: true } },
    },
  });

  const facts = new Map<string, ClientFacts>();
  const factsFor = async (customerId: string | null) => {
    if (!customerId) return null;
    if (!activation) return null;
    if (!facts.has(customerId)) facts.set(customerId, await clientFacts(tx, customerId, rules, activation, input.projected));
    return facts.get(customerId)!;
  };

  const lines: PeriodLine[] = [];
  const meta: { collectedAt: Date; orderKey: string; projected?: boolean }[] = [];
  for (const e of events) {
    if (e.currency !== version.currency) {
      throw {
        _appCode: 409,
        message: `Collection ${e.id} is in ${e.currency} but the plan pays in ${version.currency}. There is no exchange-rate policy configured, so this cannot be converted.`,
      };
    }
    const mine = (await sharesAt(tx, e.opportunityId, e.collectedAt)).find((s) => s.employeeId === input.employeeId);
    if (!mine) continue;
    const full = qualifyingBase({
      amountGross: new Decimal(e.amountGross.toString()),
      amountTax: new Decimal(e.amountTax.toString()),
      amountNonQualifying: new Decimal(e.amountNonQualifying.toString()),
    });
    const base = roundMoney(full.times(mine.sharePercent).dividedBy(100));
    const f = await factsFor(e.customerId);
    const key = orderKeyOf(e);
    const h = f?.history.get(e.id);
    lines.push({ ref: e.id, customerId: e.customerId, base, status: h?.status ?? "UNKNOWN", sequence: h?.sequence ?? null });
    meta.push({ collectedAt: e.collectedAt, orderKey: key });
  }
  if (input.projected && activation && input.projected.at.getTime() >= activation.getTime()) {
    const f = await factsFor(input.projected.customerId);
    const key = input.projected.orderKey ?? "projected";
    const h = f?.history.get("projected");
    lines.push({ ref: "projected", customerId: input.projected.customerId, base: input.projected.base, status: h?.status ?? "UNKNOWN", sequence: h?.sequence ?? null });
    meta.push({ collectedAt: input.projected.at, orderKey: key, projected: true });
  }

  const target = await tx.salesTarget.findUnique({
    where: { employeeId_periodStart: { employeeId: input.employeeId, periodStart } },
    select: { targetAmount: true },
  });
  const live = await liveDecision(tx, input.employeeId, periodStart);
  const decision: Decision = live && live.planVersionId === input.planVersionId
    ? { bracketIndex: live.bracketIndex, kind: live.kind === "OVERRIDE" ? "OVERRIDE" : "DISCRETIONARY", amount: new Decimal(live.amount.toString()) }
    : null;

  const computation = computePeriod({
    components,
    target: target ? new Decimal(target.targetAmount.toString()) : null,
    lines,
    decision,
  });

  const applies = !!(decision && computation.decisionStatus === "DECIDED");
  return {
    components, planVersionId: input.planVersionId, periodStart, periodEnd, computation, activationDate: activation, rules,
    detail: computation.lines.map((l, i) => ({
      ref: l.ref,
      customerId: l.customerId,
      customerName: l.customerId ? facts.get(l.customerId)?.name ?? null : null,
      orderKey: meta[i].orderKey,
      collectedAt: meta[i].collectedAt.toISOString(),
      base: l.base.toFixed(2),
      status: l.status,
      sequence: l.sequence,
      ratePercent: l.ratePercent.toString(),
      amount: roundMoney(l.amount).toFixed(2),
      ...(meta[i].projected ? { projected: true } : {}),
    })),
    decision: live ? {
      id: live.id, kind: live.kind, amount: new Decimal(live.amount.toString()).toFixed(2), reason: live.reason,
      bracketIndex: live.bracketIndex, decidedAt: live.decidedAt, decidedById: live.decidedById, applies,
    } : null,
  };
}

const s2 = (d: Decimal | null) => (d === null ? null : roundMoney(d).toFixed(2));
const s6 = (d: Decimal | null) => (d === null ? null : d.toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toFixed(6));

/** The JSON shape the screens read, from a computation (also stored as the result's breakdown). */
export function serializePeriod(p: BuilderPeriod) {
  const c = p.computation;
  return {
    planVersionId: p.planVersionId,
    periodStart: p.periodStart,
    periodEnd: p.periodEnd,
    target: s2(c.target),
    collectedBase: s2(c.collectedBase),
    qualifiedBase: s2(c.qualifiedBase),
    achievementPercent: s6(c.achievementPercent),
    diffAmount: s2(c.diffAmount),
    diffPercent: s6(c.diffPercent),
    clientCommission: c.clientCommission.toFixed(2),
    targetBonus: c.targetBonus.toFixed(2),
    overTargetIncentive: c.overTargetIncentive.toFixed(2),
    totalVariable: c.totalVariable.toFixed(2),
    bracket: c.bracket ? { index: c.bracket.index, kind: c.bracket.kind, fromPercent: c.bracket.fromPercent, toPercent: c.bracket.toPercent, planAmount: c.bracket.planAmount.toFixed(2), overridable: c.bracket.overridable } : null,
    decisionStatus: c.decisionStatus,
    decision: p.decision,
    rows: c.rows.map((r) => ({ row: r.row, ratePercent: r.ratePercent, base: s2(r.base), amount: s2(r.amount) })),
    existing: { ratePercent: c.existing.ratePercent, base: s2(c.existing.base), amount: s2(c.existing.amount) },
    bands: c.bands.map((b) => ({ fromPercent: b.fromPercent, toPercent: b.toPercent, ratePercent: b.ratePercent, excess: s2(b.excess), amount: s2(b.amount) })),
    lines: p.detail,
    components: { orderSequence: p.components.orderSequence.enabled, targetBonus: p.components.targetBonus.enabled, overTarget: p.components.overTarget.enabled },
    activationDate: p.activationDate,
    rules: p.rules,
  };
}

/** Rewrite the month's projection. Called after every recomputation that may have posted. */
export async function upsertPeriodResult(tx: Tx, employeeId: string, p: BuilderPeriod, actorId: string | null): Promise<void> {
  const c = p.computation;
  const data = {
    periodEnd: p.periodEnd,
    planVersionId: p.planVersionId,
    targetAmount: c.target ? roundMoney(c.target) : null,
    qualifiedBase: roundMoney(c.qualifiedBase),
    collectedBase: roundMoney(c.collectedBase),
    achievementPercent: c.achievementPercent ? c.achievementPercent.toDecimalPlaces(6, Decimal.ROUND_HALF_UP) : null,
    diffAmount: c.diffAmount ? roundMoney(c.diffAmount) : null,
    diffPercent: c.diffPercent ? c.diffPercent.toDecimalPlaces(6, Decimal.ROUND_HALF_UP) : null,
    clientCommission: c.clientCommission,
    targetBonus: c.targetBonus,
    overTargetIncentive: c.overTargetIncentive,
    totalVariable: c.totalVariable,
    bracketIndex: c.bracket?.index ?? null,
    bracketKind: c.bracket?.kind ?? null,
    decisionStatus: c.decisionStatus,
    breakdown: JSON.parse(JSON.stringify(serializePeriod(p))) as PrismaNS.InputJsonValue,
    computedAt: new Date(),
    computedById: actorId,
  };
  await tx.commissionPeriodResult.upsert({
    where: { employeeId_periodStart: { employeeId, periodStart: p.periodStart } },
    create: { employeeId, periodStart: p.periodStart, ...data },
    update: data,
  });
}

