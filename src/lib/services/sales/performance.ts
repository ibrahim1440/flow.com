import type { PrismaClient } from "@/generated/prisma/client";
import {
  Decimal, ZERO, roundMoney, riyadhMonthStart, riyadhMonthEnd, qualifyingBase,
} from "@/lib/services/commissions/engine";

/**
 * «لوحة الأداء» — the monthly performance figures of a rep and of the team, computed from the
 * records the rest of Sales already keeps. Nothing here is stored, estimated or projected: every
 * figure is a count or a sum over existing rows, and each one is defined below so the screen,
 * the tests and a reader of this file mean the same thing by it.
 *
 * Periods are Riyadh calendar months (`riyadhMonthStart` / `riyadhMonthEnd`), the periods of
 * targets and commission. "In the month" means `start <= t < end`.
 *
 * ── The formulas ──
 *
 *  netCollected   Σ qualifying base of every RECORDED collection event collected in the month,
 *                 attributed to employees exactly as the targets screen and the accrual engine
 *                 attribute it: through the deal's split owners in effect at `collectedAt`
 *                 (base × share ÷ 100, each rounded to 0.01), else wholly to the deal's owner.
 *                 Qualifying base = gross − tax − non-qualifying, never below zero
 *                 (`qualifyingBase`). Events without a deal are attributed to nobody.
 *  target         SalesTarget.targetAmount for (employee, month); the team's is the sum.
 *  targetPercent  netCollected × 100 ÷ target, one decimal; null when there is no target or it
 *                 is zero. remaining = max(0, target − netCollected). met = netCollected ≥ target.
 *  won / lost     Deals (Opportunity.ownerId) whose outcome is WON / LOST and `closedAt` is in
 *                 the month; value = Σ amount (pre-tax deal value).
 *  winRate        won × 100 ÷ (won + lost), one decimal; null with no closed deal.
 *  open pipeline  Deals whose outcome is OPEN NOW, by stage: count and Σ amount. A snapshot of
 *                 today — the system keeps no history of a deal's value, so a past month cannot
 *                 be reconstructed and is not pretended.
 *  conversion     Of the leads (Lead.ownerId) CREATED in the month, how many have a
 *                 LeadConversion — whenever it happened; × 100 ÷ leads, one decimal; null with
 *                 no lead. The cohort rate of the sales reports.
 *  quotes         issued = quotations of the person's deals with `issuedAt` in the month (every
 *                 issued revision counts); accepted = those with `acceptedAt` in the month,
 *                 acceptedValue = Σ (grandTotal − taxTotal) of the accepted ones: excluding VAT,
 *                 the basis of every other value on this screen (collected net, won/lost, the
 *                 pipeline) and of the customer file's 12-month sales (customers/aggregates.ts).
 *                 It used to add the VAT-inclusive total next to net figures.
 *  commission     The ledger's accrued figure for the month — Σ ACCRUAL + Σ REVERSAL entries
 *                 with that `periodStart` — the same `accrued` the commission statement shows.
 *                 Shown only to whoever may read it (view_own for oneself, view_team for others).
 */

export type Split = { employeeId: string; sharePercent: Decimal; effectiveFrom: Date };
export type DealOwners = { id: string; ownerId: string; owners: Split[] };
export type CollectedEvent = {
  amountGross: Decimal;
  amountTax: Decimal;
  amountNonQualifying: Decimal;
  collectedAt: Date;
  opportunityId: string | null;
};

/**
 * Net collected per employee: each event's qualifying base, split as the accrual engine splits
 * it. Pure, so the arithmetic is asserted directly (tests/sales/unit/performance.test.ts).
 */
export function attributeCollections(
  events: CollectedEvent[],
  deals: DealOwners[],
): Map<string, Decimal> {
  const byId = new Map(deals.map((d) => [d.id, d]));
  const out = new Map<string, Decimal>();
  const add = (employeeId: string, amount: Decimal) =>
    out.set(employeeId, roundMoney((out.get(employeeId) ?? ZERO).plus(amount)));
  for (const e of events) {
    if (!e.opportunityId) continue;
    const deal = byId.get(e.opportunityId);
    if (!deal) continue;
    const base = qualifyingBase(e);
    const live = deal.owners.filter((o) => o.effectiveFrom.getTime() <= e.collectedAt.getTime());
    if (live.length === 0) add(deal.ownerId, base);
    else for (const o of live) add(o.employeeId, roundMoney(base.times(o.sharePercent).dividedBy(100)));
  }
  return out;
}

/** n × 100 ÷ d to one decimal, as a string ("50.0"); null when d is zero. */
export function percent(n: Decimal | number, d: Decimal | number): string | null {
  const den = new Decimal(d);
  if (den.isZero()) return null;
  return new Decimal(n).times(100).dividedBy(den).toDecimalPlaces(1, Decimal.ROUND_HALF_UP).toFixed(1);
}

export type Progress = {
  target: string | null;
  achieved: string;
  percent: string | null;
  remaining: string | null;
  met: boolean | null;
};

/** A target's progress, as the targets screen states it. */
export function targetProgress(target: Decimal | null, achieved: Decimal): Progress {
  if (!target) return { target: null, achieved: achieved.toFixed(2), percent: null, remaining: null, met: null };
  return {
    target: target.toFixed(2),
    achieved: achieved.toFixed(2),
    percent: target.isZero() ? null : percent(achieved, target),
    remaining: roundMoney(Decimal.max(ZERO, target.minus(achieved))).toFixed(2),
    met: achieved.greaterThanOrEqualTo(target),
  };
}

/** "2026-09" → the Riyadh month around the 15th; null when unreadable. No value = this month. */
export function monthPeriod(month: string | null, now: Date = new Date()): { start: Date; end: Date; month: string } | null {
  if (month !== null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return null;
  const at = month ? new Date(`${month}-15T00:00:00Z`) : now;
  if (Number.isNaN(at.getTime())) return null;
  const start = riyadhMonthStart(at);
  return { start, end: riyadhMonthEnd(at), month: monthKey(start) };
}

/** A Riyadh month start as "YYYY-MM" (the month it begins in Riyadh). */
export function monthKey(riyadhStart: Date): string {
  const r = new Date(riyadhStart.getTime() + 3 * 3600_000);
  return `${r.getUTCFullYear()}-${String(r.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The `count` Riyadh month starts ending with `start`, oldest first. */
export function previousMonths(start: Date, count: number): Date[] {
  const out: Date[] = [];
  let cur = start;
  for (let i = 0; i < count; i++) {
    out.unshift(cur);
    cur = riyadhMonthStart(new Date(cur.getTime() - 24 * 3600_000));
  }
  return out;
}

type Db = Pick<PrismaClient,
  "collectionEvent" | "opportunity" | "salesTarget" | "lead" | "quote" | "commissionLedgerEntry" | "pipelineStage" | "employee">;

/** RECORDED collection events in [from, to) and the deals they belong to, attributed. */
async function collectedIn(db: Db, from: Date, to: Date) {
  const events = await db.collectionEvent.findMany({
    where: { status: "RECORDED", collectedAt: { gte: from, lt: to } },
    select: {
      amountGross: true, amountTax: true, amountNonQualifying: true, collectedAt: true,
      opportunityId: true, sourceSystem: true,
    },
  });
  const ids = [...new Set(events.map((e) => e.opportunityId).filter((x): x is string => !!x))];
  const deals = ids.length
    ? await db.opportunity.findMany({
        where: { id: { in: ids } },
        select: { id: true, ownerId: true, owners: { select: { employeeId: true, sharePercent: true, effectiveFrom: true } } },
      })
    : [];
  return { events, deals };
}

/** Net collected per employee in [start, end) — the targets screen's "achieved". */
export async function netCollectedByEmployee(db: Db, start: Date, end: Date): Promise<Map<string, Decimal>> {
  const { events, deals } = await collectedIn(db, start, end);
  return attributeCollections(events, deals);
}

export type Figures = {
  netCollected: string;
  target: Progress;
  bonus: string | null;
  won: number; wonValue: string;
  lost: number; lostValue: string;
  winRatePercent: string | null;
  openCount: number; openValue: string;
  leadsCreated: number; leadsConverted: number; conversionPercent: string | null;
  quotesIssued: number; quotesAccepted: number; acceptedValue: string;
  commissionAccrued: string | null;
};

export type PerformanceSummary = {
  month: string;
  periodStart: Date;
  periodEnd: Date;
  scope: "all" | "own";
  commissionVisible: boolean;
  totals: Figures;
  reps: (Figures & { employeeId: string; name: string; active: boolean })[];
  pipelineByStage: { stageId: string; code: string; nameEn: string; nameAr: string; count: number; value: string }[];
  trend: { month: string; netCollected: string; target: string | null }[];
  collectionSources: string[];
  sandbox: boolean;
};

const money = (v: Decimal) => roundMoney(v).toFixed(2);
const dec = (v: Decimal | null | undefined) => (v ? new Decimal(v) : ZERO);

/**
 * The month's figures for one employee (`ownerId`) or for everybody (`ownerId` null).
 * `commission` says whose commission the caller may read: "all", "own" (only `selfId`'s) or
 * "none"; anything else is returned as null.
 */
export async function performanceSummary(db: Db, opts: {
  start: Date; end: Date; month: string;
  ownerId: string | null;
  selfId: string;
  commission: "all" | "own" | "none";
  trendMonths?: number;
}): Promise<PerformanceSummary> {
  const { start, end, ownerId } = opts;
  const mine = ownerId ? { ownerId } : {};
  const trendStarts = previousMonths(start, opts.trendMonths ?? 6);
  const trendFrom = trendStarts[0];

  const [
    collected, targets, won, lost, open, leads, quotes, ledger, stages, trendTargets,
  ] = await Promise.all([
    collectedIn(db, trendFrom, end),
    db.salesTarget.findMany({
      where: { periodStart: start, ...(ownerId ? { employeeId: ownerId } : {}) },
      select: { employeeId: true, targetAmount: true, bonusAmount: true },
    }),
    db.opportunity.findMany({
      where: { ...mine, outcome: "WON", closedAt: { gte: start, lt: end } },
      select: { ownerId: true, amount: true },
    }),
    db.opportunity.findMany({
      where: { ...mine, outcome: "LOST", closedAt: { gte: start, lt: end } },
      select: { ownerId: true, amount: true },
    }),
    db.opportunity.findMany({
      where: { ...mine, outcome: "OPEN" },
      select: { ownerId: true, amount: true, stageId: true },
    }),
    db.lead.findMany({
      where: { ...mine, createdAt: { gte: start, lt: end } },
      select: { ownerId: true, conversion: { select: { id: true } } },
    }),
    db.quote.findMany({
      where: {
        OR: [{ issuedAt: { gte: start, lt: end } }, { acceptedAt: { gte: start, lt: end } }],
        ...(ownerId ? { opportunity: { ownerId } } : {}),
      },
      select: { status: true, issuedAt: true, acceptedAt: true, grandTotal: true, taxTotal: true, opportunity: { select: { ownerId: true } } },
    }),
    opts.commission === "none"
      ? Promise.resolve([] as { employeeId: string; type: string; _sum: { amount: Decimal | null } }[])
      : db.commissionLedgerEntry.groupBy({
          by: ["employeeId", "type"],
          where: {
            periodStart: start,
            type: { in: ["ACCRUAL", "REVERSAL"] },
            ...(opts.commission === "own" ? { employeeId: opts.selfId } : ownerId ? { employeeId: ownerId } : {}),
          },
          _sum: { amount: true },
        }),
    db.pipelineStage.findMany({
      orderBy: { position: "asc" },
      select: { id: true, code: true, nameEn: true, nameAr: true, position: true },
    }),
    db.salesTarget.findMany({
      where: { periodStart: { in: trendStarts }, ...(ownerId ? { employeeId: ownerId } : {}) },
      select: { periodStart: true, targetAmount: true },
    }),
  ]);

  // Net collected: this month for the figures, and per month for the trend.
  const inMonth = collected.events.filter((e) => e.collectedAt >= start && e.collectedAt < end);
  const byEmployee = attributeCollections(inMonth, collected.deals);
  const trend = trendStarts.map((s) => {
    const e = riyadhMonthEnd(s);
    const attributed = attributeCollections(
      collected.events.filter((x) => x.collectedAt >= s && x.collectedAt < e), collected.deals);
    const sum = ownerId ? (attributed.get(ownerId) ?? ZERO) : [...attributed.values()].reduce((a, b) => a.plus(b), ZERO);
    const t = trendTargets.filter((x) => x.periodStart.getTime() === s.getTime());
    return {
      month: monthKey(s),
      netCollected: money(sum),
      target: t.length ? money(t.reduce((a, x) => a.plus(x.targetAmount), ZERO)) : null,
    };
  });

  // Accrued commission per employee (ACCRUAL + REVERSAL, as `periodStatement`).
  const accrued = new Map<string, Decimal>();
  for (const r of ledger) accrued.set(r.employeeId, roundMoney((accrued.get(r.employeeId) ?? ZERO).plus(dec(r._sum.amount))));

  // Whose rows: everyone with a figure this month (or only the one asked about).
  const ids = new Set<string>();
  if (ownerId) ids.add(ownerId);
  else {
    for (const k of byEmployee.keys()) ids.add(k);
    for (const t of targets) ids.add(t.employeeId);
    for (const d of [...won, ...lost, ...open, ...leads]) ids.add(d.ownerId);
    for (const q of quotes) ids.add(q.opportunity.ownerId);
    for (const k of accrued.keys()) ids.add(k);
  }
  const people = ids.size
    ? await db.employee.findMany({ where: { id: { in: [...ids] } }, select: { id: true, name: true, active: true } })
    : [];

  const commissionFor = (id: string | null): string | null => {
    if (opts.commission === "none") return null;
    if (opts.commission === "own" && id !== opts.selfId) return null;
    if (id === null) return money([...accrued.values()].reduce((a, b) => a.plus(b), ZERO));
    return money(accrued.get(id) ?? ZERO);
  };

  const figures = (id: string | null): Figures => {
    const is = <T extends { ownerId: string }>(r: T) => id === null || r.ownerId === id;
    const w = won.filter(is), l = lost.filter(is), o = open.filter(is), ld = leads.filter(is);
    const q = quotes.filter((x) => id === null || x.opportunity.ownerId === id);
    const issued = q.filter((x) => x.issuedAt && x.issuedAt >= start && x.issuedAt < end);
    const accepted = q.filter((x) => x.status === "ACCEPTED" && x.acceptedAt && x.acceptedAt >= start && x.acceptedAt < end);
    const tg = targets.filter((t) => id === null || t.employeeId === id);
    const net = id === null ? [...byEmployee.values()].reduce((a, b) => a.plus(b), ZERO) : (byEmployee.get(id) ?? ZERO);
    const target = tg.length ? tg.reduce((a, t) => a.plus(t.targetAmount), ZERO) : null;
    const sum = (rows: { amount: Decimal }[]) => money(rows.reduce((a, r) => a.plus(r.amount), ZERO));
    const converted = ld.filter((x) => x.conversion !== null).length;
    return {
      netCollected: money(net),
      target: targetProgress(target, roundMoney(net)),
      bonus: tg.length ? money(tg.reduce((a, t) => a.plus(t.bonusAmount), ZERO)) : null,
      won: w.length, wonValue: sum(w),
      lost: l.length, lostValue: sum(l),
      winRatePercent: percent(w.length, w.length + l.length),
      openCount: o.length, openValue: sum(o),
      leadsCreated: ld.length, leadsConverted: converted, conversionPercent: percent(converted, ld.length),
      quotesIssued: issued.length, quotesAccepted: accepted.length,
      acceptedValue: money(accepted.reduce((a, x) => a.plus(new Decimal(x.grandTotal.toString()).minus(x.taxTotal.toString())), ZERO)),
      commissionAccrued: commissionFor(id),
    };
  };

  const byStage = new Map<string, { count: number; value: Decimal }>();
  for (const d of open) {
    const cur = byStage.get(d.stageId) ?? { count: 0, value: ZERO };
    byStage.set(d.stageId, { count: cur.count + 1, value: cur.value.plus(d.amount) });
  }

  const sources = [...new Set(inMonth.map((e) => e.sourceSystem))];
  const reps = people
    .map((p) => ({ employeeId: p.id, name: p.name, active: p.active, ...figures(p.id) }))
    .sort((a, b) => new Decimal(b.netCollected).comparedTo(a.netCollected) || a.name.localeCompare(b.name));

  return {
    month: opts.month,
    periodStart: start,
    periodEnd: end,
    scope: ownerId ? "own" : "all",
    commissionVisible: opts.commission !== "none",
    totals: ownerId ? figures(ownerId) : figures(null),
    reps,
    pipelineByStage: stages
      .filter((s) => byStage.has(s.id))
      .map((s) => ({ stageId: s.id, code: s.code, nameEn: s.nameEn, nameAr: s.nameAr, count: byStage.get(s.id)!.count, value: money(byStage.get(s.id)!.value) })),
    trend,
    collectionSources: sources,
    sandbox: sources.length > 0 && sources.every((s) => s === "SANDBOX"),
  };
}
