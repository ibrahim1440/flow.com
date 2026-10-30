// «يومي» — the page's reads. SIX SQL round-trips (the contract notice period, then WP-C's contracts query), whatever the size
// of the book and whatever the commission plan (design §WP-B 9: ≤ 6 with 500 customers per rep; measured by
// tests/sales/db/b24-myday-roundtrips.test.ts):
//   1. meta         settings, the rep, the targets, the month's accrued commission, the plan in force and — only when the
//                   commission card is visible — the month's STORED qualified base (CommissionPeriodResult, one PK row);
//   2. book         the rep's customers with their business orders of the last 400 days (kg per order), the last
//                   contact and its type, the first order date and the viewer's snooze;
//   3. deals        the rep's open deals (stage purpose, follow-up) and the samples sent without feedback;
//   4. collections  recorded collections of the last 12 months on deals the rep owns or shares;
//   5. notice days  SystemConfig.contractRenewalNoticeDays (NULL = 45), then
//   6. contracts    expiringContracts (WP-C) within that many days.
//
// SCOPE: everything is read for ONE `ownerId` the caller resolved on the server (`resolveMyDayOwner`). "My customers" is
// Customer.accountOwnerId = ownerId — nothing else (design «Data scope rule»). A rep with no customers gets an empty book.
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { Decimal, ZERO, roundMoney } from "@/lib/services/commissions/engine";
import { readComponents } from "@/lib/services/commissions/builder";
import { attributeCollections, targetProgress, type DealOwners } from "@/lib/services/sales/performance";
import { factorsFrom } from "@/lib/services/customers/reorder";
import { expiringContracts } from "@/lib/services/customers/contracts";
import { kgBetween, riyadhMonthStartAt, settingsFrom, classifyTiers, customerFacts, buildCallList, weeklyStreak,
  estimateAtTarget, daysLeftInMonth, DAY, TIER_WINDOW_DAYS,
  type BookCustomer, type DealRow, type SampleRow, type PlanForEstimate, type Tier, type MyDaySettings } from "./rules";
import type { OrderRow } from "@/lib/services/customers/aggregates";

type Db = Pick<PrismaClient, "$queryRaw">;

/** The contacts that count as «تواصل» (a completed one, and not «لا رد» / a bare note). */
export const CONTACT_ACTIVITY_TYPES = ["CALL", "VISIT", "MEETING", "WHATSAPP", "EMAIL"] as const;
/** Stage purposes the «صفقات في التفاوض» card shows. */
export const NEGOTIATING_PURPOSES = ["NEGOTIATION", "QUOTATION"] as const;
export const CONTRACT_WINDOW_DAYS = 45;

const dec = (v: unknown) => (v === null || v === undefined ? ZERO : new Decimal(String(v)));

export type MyDay = Awaited<ReturnType<typeof loadMyDay>>;

export async function loadMyDay(db: Db, opts: {
  ownerId: string; viewerId: string; now?: Date;
  /** Whether the commission figures may be returned (decided by the caller from the commission permissions). */
  commissionVisible: boolean;
}) {
  const now = opts.now ?? new Date();
  const owner = opts.ownerId;
  const monthStart = new Date(riyadhMonthStartAt(now, 0));
  const monthEnd = new Date(riyadhMonthStartAt(now, 1));
  const twelveBack = new Date(riyadhMonthStartAt(now, -12));
  const ordersSince = new Date(now.getTime() - 400 * DAY);
  const contactTypes = Prisma.join([...CONTACT_ACTIVITY_TYPES]);

  const [metaRows, bookRows, dealRows, collectionRows, contracts] = await Promise.all([
    // 1 ── meta
    db.$queryRaw<{ config: Record<string, unknown> | null; rep: { id: string; name: string } | null; targets: { periodStart: string; amount: string }[] | null; accrued: unknown; plan: Record<string, unknown> | null;
      period: { planVersionId: string; qualifiedBase: string } | null }[]>`
      SELECT
        (SELECT row_to_json(x) FROM (SELECT "tierVipTopPct", "tierVipMinKgMonth", "tierSmallMaxKgMonth", "growthMinPct", "growthMinKgMonth",
                "contactDaysVip", "contactDaysRegular", "contactDaysSmall", "contactDaysNew", "reorderLateFactor", "reorderInactiveFactor", "callAwaitDays"
           FROM "SystemConfig" WHERE "id" = 'singleton') x) AS config,
        (SELECT json_build_object('id', e."id", 'name', e."name") FROM "Employee" e WHERE e."id" = ${owner}) AS rep,
        (SELECT json_agg(json_build_object('periodStart', t."periodStart", 'amount', t."targetAmount"))
           FROM "SalesTarget" t WHERE t."employeeId" = ${owner} AND t."periodStart" >= ${twelveBack}) AS targets,
        (SELECT coalesce(sum(l."amount"), 0) FROM "CommissionLedgerEntry" l
          WHERE l."employeeId" = ${owner} AND l."periodStart" = ${monthStart} AND l."type"::text IN ('ACCRUAL', 'REVERSAL')) AS accrued,
        (SELECT json_build_object('id', v."id", 'components', v."components", 'baseRatePercent', v."baseRatePercent", 'tierMode', v."tierMode", 'currency', v."currency",
                  'tiers', (SELECT json_agg(json_build_object('fromAmount', ct."fromAmount", 'toAmount', ct."toAmount", 'ratePercent', ct."ratePercent") ORDER BY ct."position")
                              FROM "CommissionTier" ct WHERE ct."planVersionId" = v."id"))
           FROM "CommissionAssignment" a JOIN "CommissionPlanVersion" v ON v."id" = a."planVersionId"
          WHERE a."employeeId" = ${owner} AND a."effectiveFrom" < ${monthEnd} AND (a."effectiveTo" IS NULL OR a."effectiveTo" > ${monthStart})
          ORDER BY a."effectiveFrom" DESC LIMIT 1) AS plan,
        (SELECT json_build_object('planVersionId', r."planVersionId", 'qualifiedBase', r."qualifiedBase") FROM "CommissionPeriodResult" r
          WHERE ${opts.commissionVisible} AND r."employeeId" = ${owner} AND r."periodStart" = ${monthStart}) AS period`,
    // 2 ── book
    db.$queryRaw<{ id: string; name: string; nameAr: string | null; phone: string | null; city: string | null; createdAt: Date;
      reorderIntervalDays: number | null; orders: [string, string, number, number][] | null; firstOrderAt: Date | null;
      lastContactAt: Date | null; lastContactType: string | null; snoozedUntil: Date | null }[]>`
      SELECT c."id", c."name", c."nameAr", c."phone", c."city", c."createdAt", c."reorderIntervalDays",
             (SELECT json_agg(json_build_array(o."createdAt", o."status", o."orderNumber",
                       coalesce((SELECT sum(i."quantityKg") FROM "OrderItem" i WHERE i."orderId" = o."id"), 0)) ORDER BY o."createdAt")
                FROM "Order" o WHERE o."customerId" = c."id" AND o."createdAt" >= ${ordersSince}) AS orders,
             (SELECT min(o."createdAt") FROM "Order" o WHERE o."customerId" = c."id" AND o."status" NOT IN ('Cancelled', 'Rejected')) AS "firstOrderAt",
             lc."completedAt" AS "lastContactAt", lc."type" AS "lastContactType",
             (SELECT s."until" FROM "SalesCallSnooze" s WHERE s."employeeId" = ${opts.viewerId} AND s."customerId" = c."id") AS "snoozedUntil"
        FROM "Customer" c
        LEFT JOIN LATERAL (
          SELECT a."completedAt", a."type"::text AS "type" FROM "Activity" a
           WHERE a."customerId" = c."id" AND a."completedAt" IS NOT NULL AND a."type"::text IN (${contactTypes})
             AND (a."outcome" IS NULL OR a."outcome"::text NOT IN ('NO_ANSWER', 'NOTE_ONLY'))
           ORDER BY a."completedAt" DESC LIMIT 1) lc ON true
       WHERE c."accountOwnerId" = ${owner}`,
    // 3 ── deals (kind DEAL) and samples without feedback (kind SAMPLE), the rep's own deals only
    db.$queryRaw<{ kind: "DEAL" | "SAMPLE"; id: string; dealId: string; title: string; amount: unknown; customerId: string | null;
      customerName: string | null; customerNameAr: string | null; customerPhone: string | null; nextFollowUpAt: Date | null;
      purpose: string | null; stageAr: string | null; stageEn: string | null; sentAt: Date | null }[]>`
      SELECT 'DEAL' AS kind, o."id", o."id" AS "dealId", o."title", o."amount", o."customerId", c."name" AS "customerName", c."nameAr" AS "customerNameAr",
             c."phone" AS "customerPhone", o."nextFollowUpAt", st."purpose"::text AS purpose, st."nameAr" AS "stageAr", st."nameEn" AS "stageEn", NULL::timestamp AS "sentAt"
        FROM "Opportunity" o JOIN "PipelineStage" st ON st."id" = o."stageId" LEFT JOIN "Customer" c ON c."id" = o."customerId"
       WHERE o."ownerId" = ${owner} AND o."outcome"::text = 'OPEN'
      UNION ALL
      SELECT 'SAMPLE', s."id", s."opportunityId", s."description", NULL, o."customerId", c."name", c."nameAr", c."phone", NULL, NULL, NULL, NULL, s."sentAt"
        FROM "SampleShipment" s JOIN "Opportunity" o ON o."id" = s."opportunityId" LEFT JOIN "Customer" c ON c."id" = o."customerId"
       WHERE o."ownerId" = ${owner} AND s."status"::text = 'SENT' AND s."feedbackAt" IS NULL AND s."sentAt" IS NOT NULL`,
    // 4 ── collections (12 months) on deals the rep owns or shares, attributed below exactly as the targets screen does
    db.$queryRaw<{ amountGross: unknown; amountTax: unknown; amountNonQualifying: unknown; collectedAt: Date; opportunityId: string;
      ownerId: string; owners: { employeeId: string; sharePercent: string; effectiveFrom: string }[] | null }[]>`
      SELECT e."amountGross", e."amountTax", e."amountNonQualifying", e."collectedAt", e."opportunityId", o."ownerId",
             (SELECT json_agg(json_build_object('employeeId', w."employeeId", 'sharePercent', w."sharePercent", 'effectiveFrom', w."effectiveFrom"))
                FROM "OpportunityOwner" w WHERE w."opportunityId" = o."id") AS owners
        FROM "CollectionEvent" e JOIN "Opportunity" o ON o."id" = e."opportunityId"
       WHERE e."status"::text = 'RECORDED' AND e."collectedAt" >= ${twelveBack} AND e."collectedAt" < ${monthEnd}
         AND (o."ownerId" = ${owner} OR EXISTS (SELECT 1 FROM "OpportunityOwner" w WHERE w."opportunityId" = o."id" AND w."employeeId" = ${owner}))`,
    // 5 + 6 ── the company's contract notice period (sales settings, NULL = 45), then the contracts inside it (WP-C)
    db.$queryRaw<{ d: number | null }[]>`SELECT "contractRenewalNoticeDays" AS d FROM "SystemConfig" WHERE "id" = 'singleton'`
      .then(async (r) => {
        const within = r[0]?.d ?? CONTRACT_WINDOW_DAYS;
        return { within, rows: await expiringContracts(db as never, { ownerId: owner, withinDays: within }) };
      }),
  ]);

  const meta = metaRows[0];
  const settings: MyDaySettings = settingsFrom(meta?.config as never);
  const factors = factorsFrom((meta?.config ?? null) as never);

  // ── The book ──
  const book: BookCustomer[] = bookRows.map((r) => ({
    id: r.id, name: r.name, nameAr: r.nameAr, phone: r.phone, city: r.city, createdAt: r.createdAt,
    reorderIntervalDays: r.reorderIntervalDays,
    orders: (r.orders ?? []).map(([at, status, orderNumber, kg], i): OrderRow => ({
      id: `${r.id}:${i}`, orderNumber: Number(orderNumber), createdAt: new Date(at), status, items: [{ quantityKg: Number(kg), name: "" }],
    })),
    firstOrderAt: r.firstOrderAt, lastContactAt: r.lastContactAt, lastContactType: r.lastContactType, snoozedUntil: r.snoozedUntil,
  }));
  const since90 = now.getTime() - TIER_WINDOW_DAYS * DAY;
  const kg90 = new Map(book.map((c) => [c.id, kgBetween(c.orders, since90, now.getTime() + 1).kg]));
  const tiers = classifyTiers(book.map((c) => ({ id: c.id, kg90: kg90.get(c.id)! })), settings);
  const facts = book.map((c) => customerFacts(c, tiers.get(c.id)!, kg90.get(c.id)!, settings, factors, now));

  // ── Deals and samples ──
  const deals: DealRow[] = dealRows.filter((d) => d.kind === "DEAL").map((d) => ({
    id: d.id, title: d.title, amount: roundMoney(dec(d.amount)).toFixed(2), customerId: d.customerId, customerName: d.customerName,
    customerNameAr: d.customerNameAr, customerPhone: d.customerPhone, nextFollowUpAt: d.nextFollowUpAt, purpose: d.purpose,
    stageAr: d.stageAr ?? "", stageEn: d.stageEn ?? "",
  }));
  const samples: SampleRow[] = dealRows.filter((d) => d.kind === "SAMPLE" && d.sentAt).map((d) => ({
    id: d.id, dealId: d.dealId, customerId: d.customerId, sentAt: d.sentAt!, description: d.title,
  }));
  const callList = buildCallList(facts, deals, samples, now, settings.callAwaitDays);
  const negotiating = deals
    .filter((d) => (NEGOTIATING_PURPOSES as readonly string[]).includes(d.purpose ?? ""))
    .sort((a, b) => Number(b.amount) - Number(a.amount));

  // ── Tiers card: counts and share of the book's kg (90 days) ──
  const totalKg = facts.reduce((a, f) => a + f.kg90, 0);
  const share = (kg: number) => (totalKg > 0 ? Math.round((kg / totalKg) * 1000) / 10 : 0);
  const tierGroups = (["VIP", "REGULAR", "SMALL", "QUIET"] as Tier[]).map((t) => {
    const list = facts.filter((f) => f.tier === t).sort((a, b) => b.kg90 - a.kg90);
    const kg = list.reduce((a, f) => a + f.kg90, 0);
    return {
      tier: t, count: list.length, kg: Math.round(kg * 10) / 10, share: share(kg),
      customers: list.map((f) => ({ id: f.id, name: f.name, nameAr: f.nameAr, kgPerMonth: f.kgPerMonth, share: share(f.kg90) })),
    };
  });

  // ── «ينمون معك» ──
  const growing = facts.filter((f) => f.growth?.growing)
    .map((f) => ({ id: f.id, name: f.name, nameAr: f.nameAr, pct: f.growth!.pct, lastKg: f.growth!.lastKg, prevKg: f.growth!.prevKg }))
    .sort((a, b) => b.pct - a.pct);

  // ── «عملائي» counts ──
  const negotiatingCustomers = new Set(negotiating.map((d) => d.customerId).filter((x): x is string => !!x && tiers.has(x)));
  const counts = {
    total: facts.length,
    active: facts.filter((f) => f.active).length,
    negotiating: negotiatingCustomers.size,
    stopped: facts.filter((f) => f.reorder?.state === "INACTIVE").length,
  };

  // ── Target and commission (SAR, collections) ──
  const dealOwners = new Map<string, DealOwners>();
  for (const r of collectionRows) {
    if (!dealOwners.has(r.opportunityId)) {
      dealOwners.set(r.opportunityId, {
        id: r.opportunityId, ownerId: r.ownerId,
        owners: (r.owners ?? []).map((o) => ({ employeeId: o.employeeId, sharePercent: new Decimal(String(o.sharePercent)), effectiveFrom: new Date(o.effectiveFrom) })),
      });
    }
  }
  const events = collectionRows.map((r) => ({
    amountGross: dec(r.amountGross), amountTax: dec(r.amountTax), amountNonQualifying: dec(r.amountNonQualifying),
    collectedAt: r.collectedAt, opportunityId: r.opportunityId,
  }));
  const mine = (from: number, to: number) =>
    attributeCollections(events.filter((e) => e.collectedAt.getTime() >= from && e.collectedAt.getTime() < to), [...dealOwners.values()]).get(owner) ?? ZERO;
  const targetsBy = new Map((meta?.targets ?? []).map((t) => [new Date(t.periodStart).getTime(), new Decimal(String(t.amount))]));
  const target = targetsBy.get(monthStart.getTime()) ?? null;
  const collected = roundMoney(mine(monthStart.getTime(), monthEnd.getTime()));
  const progress = targetProgress(target, collected);
  // Personal bests: the best of the 12 complete months before this one.
  const months = Array.from({ length: 12 }, (_, i) => riyadhMonthStartAt(now, -12 + i));
  const history = months.map((m, i) => ({ start: m, amount: roundMoney(mine(m, months[i + 1] ?? monthStart.getTime())) }));
  const best = history.reduce<{ start: number; amount: Decimal } | null>((b, h) => (h.amount.greaterThan(0) && (!b || h.amount.greaterThan(b.amount)) ? h : b), null);
  // The weekly streak: per-event attributed amounts (attribution is linear, so one event at a time is exact).
  const perEvent = events.map((e) => ({ at: e.collectedAt, amount: Number(attributeCollections([e], [...dealOwners.values()]).get(owner) ?? 0) }));
  const streakWeeks = weeklyStreak(perEvent, (m) => (targetsBy.has(m) ? Number(targetsBy.get(m)) : null), now);

  const accrued = roundMoney(dec(meta?.accrued));
  let plan: PlanForEstimate = null;
  const p = meta?.plan;
  if (p) {
    if (p.components) plan = { kind: "COMPONENTS", components: readComponents(p.components) };
    else plan = { kind: "TIERED", rules: {
      basis: "NET_COLLECTION", tierMode: (p.tierMode as "INCREMENTAL") ?? "INCREMENTAL", baseRatePercent: dec(p.baseRatePercent), currency: String(p.currency ?? "SAR"),
      tiers: ((p.tiers as { fromAmount: string; toAmount: string | null; ratePercent: string }[] | null) ?? []).map((t) => ({
        fromAmount: dec(t.fromAmount), toAmount: t.toAmount === null ? null : dec(t.toAmount), ratePercent: dec(t.ratePercent) })),
    } };
  }
  // A COMPONENTS plan (H2, fix round 2 — no engine run on the page): the month's QUALIFIED base exactly as the commission
  // engine last wrote it (CommissionPeriodResult, rewritten by every accrual — the same run that wrote `accrued`), read in
  // the meta query above. No stored row (or one of another plan version) means no accrual this month: the estimate then
  // stays on the aggregated collections of read 4 (`collected` when everything counts, nothing new-client otherwise) —
  // the conservative default. Only when the card is visible.
  let qualifiedNow: Decimal | null = null;
  const stored = meta?.period;
  if (opts.commissionVisible && plan?.kind === "COMPONENTS" && stored && p?.id && stored.planVersionId === String(p.id)) {
    qualifiedNow = dec(stored.qualifiedBase);
  }
  const estimate = opts.commissionVisible ? estimateAtTarget(plan, target, collected, accrued, qualifiedNow) : null;

  return {
    rep: meta?.rep ?? null,
    generatedAt: now,
    settings,
    target: {
      month: `${new Date(monthStart.getTime() + 3 * 3_600_000).getUTCFullYear()}-${String(new Date(monthStart.getTime() + 3 * 3_600_000).getUTCMonth() + 1).padStart(2, "0")}`,
      ...progress,
      daysLeft: daysLeftInMonth(now),
      streakWeeks,
      personalBest: best ? { month: new Date(best.start + 3 * 3_600_000).toISOString().slice(0, 7), amount: best.amount.toFixed(2) } : null,
      newBest: !!best && collected.greaterThan(best.amount),
      commissionVisible: opts.commissionVisible,
      accrued: opts.commissionVisible ? accrued.toFixed(2) : null,
      estimate: opts.commissionVisible && estimate ? estimate.amount.toFixed(2) : null,
      estimateDiscretionary: opts.commissionVisible && !!estimate?.discretionary,
      hasPlan: !!plan,
    },
    callList: callList.map((c) => ({ ...c })),
    deals: negotiating.map((d) => ({ id: d.id, title: d.title, amount: d.amount, customerId: d.customerId, customerName: d.customerName, customerNameAr: d.customerNameAr, stageAr: d.stageAr, stageEn: d.stageEn, purpose: d.purpose })),
    openDeals: deals.length,
    growing,
    tiers: { totalKg: Math.round(totalKg * 10) / 10, groups: tierGroups, percentile: facts.filter((f) => f.kg90 > 0).length >= 8 },
    counts,
    contracts: contracts.rows.map((c) => ({ ...c, validUntil: c.validUntil.toISOString() })),
    contractWindowDays: contracts.within,
  };
}
