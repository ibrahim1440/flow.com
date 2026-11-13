// «يومي» — the page's reads. SIX SQL round-trips (the contract notice period, then WP-C's contracts query), whatever the size
// of the book and whatever the commission plan (design §WP-B 9: ≤ 6 with 500 customers per rep; measured by
// tests/sales/db/b24-myday-roundtrips.test.ts):
//   1. meta         settings, the rep, the targets, the month's accrued commission, the plan in force and (D11) the
//                   documents of the rep's deals the sales bar needs: the month's sales, the open invoices, the drafts;
//   2. book         the rep's customers with their business orders of the last 400 days (kg per order), the last
//                   contact and its type, the first order date and the viewer's snooze;
//   3. deals        the rep's open deals (stage purpose, follow-up) and the samples sent without feedback;
//   4. collections  recorded collections of the last 12 months on deals the rep owns or shares (this month's with where
//                   their receipt's money went, for the breakdown of collected);
//   5. notice days  SystemConfig.contractRenewalNoticeDays (NULL = 45), then
//   6. contracts    expiringContracts (WP-C) within that many days.
//
// SCOPE: everything is read for ONE `ownerId` the caller resolved on the server (`resolveMyDayOwner`). "My customers" is
// Customer.accountOwnerId = ownerId — nothing else (design «Data scope rule»). A rep with no customers gets an empty book.
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { Decimal, ZERO, roundMoney } from "@/lib/services/commissions/engine";
import { readComponents, type Components } from "@/lib/services/commissions/builder";
import { attributeCollections, targetProgress, type DealOwners } from "@/lib/services/sales/performance";
import { factorsFrom } from "@/lib/services/customers/reorder";
import { expiringContracts } from "@/lib/services/customers/contracts";
import { kgBetween, riyadhMonthStartAt, settingsFrom, classifyTiers, customerFacts, buildCallList, weeklyStreak,
  daysLeftInMonth, DAY, TIER_WINDOW_DAYS,
  type BookCustomer, type DealRow, type SampleRow, type Tier, type MyDaySettings } from "./rules";
import { barState, breakdownOf, draftsOf, owedOf, salesOf, type DocRow } from "./sales-bar";
import type { OrderRow } from "@/lib/services/customers/aggregates";
import { dealNextStep } from "../next-step";
import type { StagePurpose } from "../stages";
import { discountApprovalState } from "../quotes";
import { DISCOUNT_APPROVAL_THRESHOLD } from "../discount-limits";
import { sampleApprovalState } from "../sample-rules";

type Db = Pick<PrismaClient, "$queryRaw">;

/** The contacts that count as «تواصل» (a completed one, and not «لا رد» / a bare note). */
export const CONTACT_ACTIVITY_TYPES = ["CALL", "VISIT", "MEETING", "WHATSAPP", "EMAIL"] as const;
/** Stage purposes the «صفقات في التفاوض» card shows. */
// Pipeline v2: «صفقات في عرض السعر والتفاوض» — the QUOTATION stage; the legacy NEGOTIATION is kept harmlessly until
// migration 20261217090000_pipeline_v2 has run everywhere (it retires that purpose). Also feeds BookRow «يتفاوض».
export const NEGOTIATING_PURPOSES = ["QUOTATION", "NEGOTIATION"] as const;
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
  // The Riyadh month as calendar dates (SalesInvoice.issueDate is a DATE).
  const dayOf = (t: number) => new Date(t + 3 * 3_600_000).toISOString().slice(0, 10);
  const monthDay = dayOf(monthStart.getTime());
  const nextMonthDay = dayOf(monthEnd.getTime());

  const [metaRows, bookRows, dealRows, collectionRows, contracts] = await Promise.all([
    // 1 ── meta
    db.$queryRaw<{ config: Record<string, unknown> | null; rep: { id: string; name: string } | null; targets: { periodStart: string; amount: string }[] | null; accrued: unknown; plan: Record<string, unknown> | null;
      docs: DocRow[] | null }[]>`
      SELECT
        (SELECT row_to_json(x) FROM (SELECT "tierVipTopPct", "tierVipMinKgMonth", "tierSmallMaxKgMonth", "growthMinPct", "growthMinKgMonth",
                "contactDaysVip", "contactDaysRegular", "contactDaysSmall", "contactDaysNew", "reorderLateFactor", "reorderInactiveFactor", "callAwaitDays",
                "quoteDiscountApprovalPercent"
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
        -- D11: the documents of the rep's deals (owned or shared) the sales bar needs, in this SAME round trip — the month's
        -- issued invoices / debit / credit notes (sales), the issued invoices still open (owed) and the drafts of live orders
        -- («بانتظار المحاسب»). A document belongs to the EARLIEST deal link of its order (a note: of its original's), else
        -- to its quotation's deal; open = total − its credit notes' unapplied part − APPLIED ArApplications.
        (WITH d AS (
           SELECT o."id", o."ownerId",
                  (SELECT json_agg(json_build_object('employeeId', w."employeeId", 'sharePercent', w."sharePercent")) FROM "OpportunityOwner" w WHERE w."opportunityId" = o."id") AS owners
             FROM "Opportunity" o
            WHERE o."ownerId" = ${owner} OR EXISTS (SELECT 1 FROM "OpportunityOwner" w WHERE w."opportunityId" = o."id" AND w."employeeId" = ${owner})),
         ords AS (SELECT DISTINCT ol."orderId" FROM "OpportunityOrder" ol WHERE ol."opportunityId" IN (SELECT "id" FROM d)),
         qts AS (SELECT q."id" FROM "Quote" q WHERE q."opportunityId" IN (SELECT "id" FROM d)),
         inv AS (
           SELECT i."id", i."kind", i."status", i."number", i."customerId", i."issueDate", i."dueDate", i."taxableTotal", i."grandTotal",
                  coalesce(i."orderId", oi."orderId") AS "orderId", coalesce(i."quoteId", oi."quoteId") AS "quoteId"
             FROM "SalesInvoice" i LEFT JOIN "SalesInvoice" oi ON oi."id" = i."originalInvoiceId"
            WHERE (coalesce(i."orderId", oi."orderId") IN (SELECT "orderId" FROM ords) OR coalesce(i."quoteId", oi."quoteId") IN (SELECT "id" FROM qts))
              AND (i."status" = 'ISSUED' OR (i."status" = 'DRAFT' AND i."kind" = 'INVOICE'))),
         res AS (
           SELECT inv.*,
                  coalesce((SELECT ol."opportunityId" FROM "OpportunityOrder" ol WHERE ol."orderId" = inv."orderId" ORDER BY ol."createdAt", ol."id" LIMIT 1),
                           (SELECT q."opportunityId" FROM "Quote" q WHERE q."id" = inv."quoteId")) AS deal,
                  (inv."issueDate" >= ${monthDay}::date AND inv."issueDate" < ${nextMonthDay}::date) AS "inMonth",
                  coalesce((SELECT sum(a."amount") FROM "ArApplication" a WHERE a."invoiceId" = inv."id" AND a."status" = 'APPLIED'), 0) AS applied,
                  coalesce((SELECT sum(cn."grandTotal" - coalesce((SELECT sum(a."amount") FROM "ArApplication" a WHERE a."creditNoteId" = cn."id" AND a."status" = 'APPLIED'), 0))
                              FROM "SalesInvoice" cn WHERE cn."originalInvoiceId" = inv."id" AND cn."kind" = 'CREDIT_NOTE' AND cn."status" = 'ISSUED'), 0) AS "notesOpen",
                  (inv."status" = 'DRAFT' AND EXISTS (SELECT 1 FROM "Order" od WHERE od."id" = inv."orderId"
                      AND od."status" NOT IN ('Cancelled', 'Rejected') AND od."discountApprovalStatus" NOT IN ('PENDING', 'REJECTED'))) AS "draftLive"
             FROM inv)
         SELECT json_agg(json_build_object('id', res."id", 'kind', res."kind", 'status', res."status", 'number', res."number", 'customerId', res."customerId",
                  'customerName', c."name", 'customerNameAr', c."nameAr", 'customerPhone', c."phone", 'issueDate', res."issueDate", 'dueDate', res."dueDate",
                  'taxableTotal', res."taxableTotal", 'grandTotal', res."grandTotal", 'applied', res.applied, 'notesOpen', res."notesOpen",
                  'inMonth', coalesce(res."inMonth", false), 'draftLive', res."draftLive", 'dealOwnerId', d."ownerId", 'owners', d.owners))
           FROM res JOIN d ON d."id" = res.deal LEFT JOIN "Customer" c ON c."id" = res."customerId"
          WHERE (res."status" = 'ISSUED' AND res."inMonth")
             OR (res."status" = 'ISSUED' AND res."kind" IN ('INVOICE', 'DEBIT_NOTE') AND res."grandTotal" - res."notesOpen" - res.applied > 0)
             OR res."draftLive") AS docs`,
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
      purpose: string | null; stageAr: string | null; stageEn: string | null; sentAt: Date | null;
      stageCode: string | null; businessType: string | null; needSummary: string | null; agreedNextStep: string | null;
      quote: { id: string; status: string; revision: number; issuedAt: string | null; validUntil: string | null; subtotal: string; discountTotal: string;
        discountApprovedById: string | null; discountApprovedPercent: string | null; discountRejectedAt: string | null; orderLinks: number;
        approvalRequired?: boolean | null; approvalBasisPercent?: string | null } | null;
      liveSamples: { id: string; status: string; fromStock: boolean; approvalRequired: boolean; approvedAt: string | null; declinedAt: string | null; sentAt: string | null }[] | null }[]>`
      SELECT 'DEAL' AS kind, o."id", o."id" AS "dealId", o."title", o."amount", o."customerId", c."name" AS "customerName", c."nameAr" AS "customerNameAr",
             c."phone" AS "customerPhone", o."nextFollowUpAt", st."purpose"::text AS purpose, st."nameAr" AS "stageAr", st."nameEn" AS "stageEn", NULL::timestamp AS "sentAt",
             -- Pipeline v2: what the next-step engine needs, in the SAME round trip (the deal's current quotation and its
             -- live samples), so «صفقات في عرض السعر والتفاوض» says what is required now, as the deal page does.
             st."code" AS "stageCode", o."businessType", o."needSummary", o."agreedNextStep",
             (SELECT json_build_object('id', q."id", 'status', q."status", 'revision', q."revision", 'issuedAt', q."issuedAt", 'validUntil', q."validUntil",
                       'subtotal', q."subtotal", 'discountTotal', q."discountTotal", 'discountApprovedById', q."discountApprovedById",
                       'discountApprovedPercent', q."discountApprovedPercent", 'discountRejectedAt', q."discountRejectedAt",
                       'approvalRequired', q."approvalRequired", 'approvalBasisPercent', q."approvalBasisPercent",
                       'orderLinks', (SELECT count(*) FROM "OpportunityOrder" ol WHERE ol."quoteId" = q."id"))
                FROM "Quote" q WHERE q."opportunityId" = o."id" AND q."status"::text <> 'SUPERSEDED'
               ORDER BY (q."status"::text = 'ACCEPTED') DESC, q."revision" DESC, q."createdAt" DESC LIMIT 1) AS "quote",
             (SELECT json_agg(json_build_object('id', x."id", 'status', x."status", 'fromStock', x."fromStock", 'approvalRequired', x."approvalRequired",
                       'approvedAt', x."approvedAt", 'declinedAt', x."declinedAt", 'sentAt', x."sentAt"))
                FROM "SampleShipment" x WHERE x."opportunityId" = o."id" AND x."status"::text <> 'CANCELLED') AS "liveSamples"
        FROM "Opportunity" o JOIN "PipelineStage" st ON st."id" = o."stageId" LEFT JOIN "Customer" c ON c."id" = o."customerId"
       WHERE o."ownerId" = ${owner} AND o."outcome"::text = 'OPEN'
      UNION ALL
      SELECT 'SAMPLE', s."id", s."opportunityId", s."description", NULL, o."customerId", c."name", c."nameAr", c."phone", NULL, NULL, NULL, NULL, s."sentAt",
             NULL, NULL, NULL, NULL, NULL::json, NULL::json
        FROM "SampleShipment" s JOIN "Opportunity" o ON o."id" = s."opportunityId" LEFT JOIN "Customer" c ON c."id" = o."customerId"
       WHERE o."ownerId" = ${owner} AND s."status"::text = 'SENT' AND s."feedbackAt" IS NULL AND s."sentAt" IS NOT NULL`,
    // 4 ── collections (12 months) on deals the rep owns or shares, attributed below exactly as the targets screen does
    // D11 sheet F: for this month's events, where the receipt's money went (SalesCollection → APPLIED ArApplication →
    // invoice.issueDate), VAT included. A Sales event's externalRef is its receipt's id; an accountant receipt's is
    // `${collectionId}:${dealId}[:n]` and only its applications to THAT deal's invoices count (decision 6).
    db.$queryRaw<{ amountGross: unknown; amountTax: unknown; amountNonQualifying: unknown; collectedAt: Date; opportunityId: string;
      ownerId: string; owners: { employeeId: string; sharePercent: string; effectiveFrom: string }[] | null;
      accountant: boolean; fromMonth: unknown; fromBefore: unknown }[]>`
      SELECT e."amountGross", e."amountTax", e."amountNonQualifying", e."collectedAt", e."opportunityId", o."ownerId",
             (SELECT json_agg(json_build_object('employeeId', w."employeeId", 'sharePercent', w."sharePercent", 'effectiveFrom', w."effectiveFrom"))
                FROM "OpportunityOwner" w WHERE w."opportunityId" = o."id") AS owners,
             (position(':' in e."externalRef") > 0) AS accountant, p."fromMonth", p."fromBefore"
        FROM "CollectionEvent" e JOIN "Opportunity" o ON o."id" = e."opportunityId"
        LEFT JOIN LATERAL (
          SELECT coalesce(sum(a."amount") FILTER (WHERE i."issueDate" IS NULL OR i."issueDate" >= ${monthDay}::date), 0) AS "fromMonth",
                 coalesce(sum(a."amount") FILTER (WHERE i."issueDate" < ${monthDay}::date), 0) AS "fromBefore"
            FROM "SalesCollection" sc
            JOIN "ArApplication" a ON a."collectionId" = sc."id" AND a."status" = 'APPLIED'
            JOIN "SalesInvoice" i ON i."id" = a."invoiceId"
           WHERE e."collectedAt" >= ${monthStart} AND sc."id" = split_part(e."externalRef", ':', 1)
             AND (position(':' in e."externalRef") = 0 OR e."opportunityId" = coalesce(
                   (SELECT ol."opportunityId" FROM "OpportunityOrder" ol WHERE ol."orderId" = i."orderId" ORDER BY ol."createdAt", ol."id" LIMIT 1),
                   (SELECT q."opportunityId" FROM "Quote" q WHERE q."id" = i."quoteId")))) p ON true
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
  // The discount-approval threshold, from the same settings row (no extra round trip): the stored one, else the built-in.
  const storedThreshold = (meta?.config as { quoteDiscountApprovalPercent?: unknown } | null)?.quoteDiscountApprovalPercent;
  const threshold = new Decimal(storedThreshold === null || storedThreshold === undefined ? DISCOUNT_APPROVAL_THRESHOLD : String(storedThreshold));
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
    nextStep: dealNextStep({
      outcome: "OPEN", hasCustomer: !!d.customerId, stagePurpose: d.purpose as StagePurpose | null, stageCode: d.stageCode ?? "",
      businessType: d.businessType, needSummary: d.needSummary, agreedNextStep: d.agreedNextStep,
      samples: (d.liveSamples ?? []).map((x) => ({ id: x.id, status: x.status, fromStock: x.fromStock, approval: sampleApprovalState(x), sentAt: x.sentAt })),
      quotes: d.quote ? [{
        id: d.quote.id, status: d.quote.status, revision: d.quote.revision, issuedAt: d.quote.issuedAt, validUntil: d.quote.validUntil,
        orderLinks: Number(d.quote.orderLinks), discountApproval: discountApprovalState({ ...d.quote, subtotal: d.quote.subtotal ?? "0", discountTotal: d.quote.discountTotal ?? "0" }, threshold),
      }] : [],
    }, now),
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

  // ── «عملائي» as the rep's book (owner, 3 Nov 2026): ONE row per customer with the same facts as the cards above,
  // so a number on «يومي» and the list it opens on «عملائي» are the same customers. One status per customer, by
  // priority: متوقف → يتفاوض → نشط → بلا طلبات حديثة; growth / decline and a contract in the notice window are flags.
  const contractDaysBy = new Map<string, number>();
  for (const k of contracts.rows) {
    const prev = contractDaysBy.get(k.customerId);
    if (prev === undefined || k.daysLeft < prev) contractDaysBy.set(k.customerId, k.daysLeft);
  }
  const bookRowsOut = facts.map((f) => ({
    id: f.id, name: f.name, nameAr: f.nameAr, phone: f.phone, city: f.city, tier: f.tier, kgPerMonth: f.kgPerMonth,
    lastOrderAt: f.lastOrderAt ? f.lastOrderAt.toISOString() : null,
    status: (f.reorder?.state === "INACTIVE" ? "STOPPED" : negotiatingCustomers.has(f.id) ? "NEGOTIATING" : f.active ? "ACTIVE" : "QUIET") as "STOPPED" | "NEGOTIATING" | "ACTIVE" | "QUIET",
    growthPct: f.growth ? f.growth.pct : null,
    growing: !!f.growth?.growing, declining: !!f.growth?.declining,
    contractDaysLeft: contractDaysBy.get(f.id) ?? null,
  }));
  const bookCounts = {
    growing: bookRowsOut.filter((b) => b.growing).length,
    declining: bookRowsOut.filter((b) => b.declining).length,
    contracts: bookRowsOut.filter((b) => b.contractDaysLeft !== null).length,
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
  // The plan's target-bonus brackets label the bar's stages (a COMPONENTS plan; a tiered plan has none).
  const p = meta?.plan;
  const components: Components | null = p?.components ? readComponents(p.components) : null;

  // ── D11: sales, owed, drafts and the breakdown of collected ──
  const docs = meta?.docs ?? [];
  const sales = salesOf(docs, owner);
  const owed = owedOf(docs, dayOf(now.getTime()), owner);
  const drafts = draftsOf(docs, owner);
  const owners = [...dealOwners.values()];
  const breakdown = breakdownOf(collectionRows
    .filter((r) => r.collectedAt.getTime() >= monthStart.getTime() && r.collectedAt.getTime() < monthEnd.getTime())
    .map((r) => {
      const e = { amountGross: dec(r.amountGross), amountTax: dec(r.amountTax), amountNonQualifying: dec(r.amountNonQualifying), collectedAt: r.collectedAt, opportunityId: r.opportunityId };
      return { mine: attributeCollections([e], owners).get(owner) ?? ZERO, gross: e.amountGross, fromMonth: dec(r.fromMonth), fromBefore: dec(r.fromBefore), accountant: !!r.accountant };
    }));
  const [yy, mm] = [new Date(monthStart.getTime() + 3 * 3_600_000).getUTCFullYear(), new Date(monthStart.getTime() + 3 * 3_600_000).getUTCMonth()];
  const monthDays = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
  const daysLeft = daysLeftInMonth(now);
  const bar = target && target.greaterThan(0) ? barState({ target, collected, sales, daysLeft, monthDays, components }) : null;

  return {
    rep: meta?.rep ?? null,
    generatedAt: now,
    settings,
    target: {
      month: `${new Date(monthStart.getTime() + 3 * 3_600_000).getUTCFullYear()}-${String(new Date(monthStart.getTime() + 3 * 3_600_000).getUTCMonth() + 1).padStart(2, "0")}`,
      ...progress,
      daysLeft,
      streakWeeks,
      personalBest: best ? { month: new Date(best.start + 3 * 3_600_000).toISOString().slice(0, 7), amount: best.amount.toFixed(2) } : null,
      newBest: !!best && collected.greaterThan(best.amount),
      commissionVisible: opts.commissionVisible,
      accrued: opts.commissionVisible ? accrued.toFixed(2) : null,
      hasPlan: !!p,
      // D11 — the sales bar (sales-bar.ts). Stages, «met» and the celebration follow COLLECTED only.
      sales: sales.toFixed(2),
      // Bonus amounts are commission figures: only to whoever may read them.
      bar: bar ? { ...bar, reachedBonus: opts.commissionVisible ? bar.reachedBonus : null, next: bar.next ? { ...bar.next, bonus: opts.commissionVisible ? bar.next.bonus : null } : null } : null,
      owed,
      drafts,
      breakdown,
    },
    callList: callList.map((c) => ({ ...c })),
    deals: negotiating.map((d) => ({ id: d.id, title: d.title, amount: d.amount, customerId: d.customerId, customerName: d.customerName, customerNameAr: d.customerNameAr, stageAr: d.stageAr, stageEn: d.stageEn, purpose: d.purpose,
      // Pipeline v2: the card says what is required now and the one action (the deal page's own `nextStep`).
      quoteState: d.nextStep?.quoteState ?? null, quoteStateLabel: d.nextStep?.quoteStateLabel ?? null,
      requiredNow: d.nextStep?.requiredNow[0] ?? null, nextAction: d.nextStep?.nextAction ? { key: d.nextStep.nextAction.key, ar: d.nextStep.nextAction.ar, en: d.nextStep.nextAction.en, quoteId: d.nextStep.nextAction.quoteId ?? null } : null })),
    openDeals: deals.length,
    growing,
    tiers: { totalKg: Math.round(totalKg * 10) / 10, groups: tierGroups, percentile: facts.filter((f) => f.kg90 > 0).length >= 8 },
    counts: { ...counts, ...bookCounts },
    book: bookRowsOut,
    contracts: contracts.rows.map((c) => ({ ...c, validUntil: c.validUntil.toISOString() })),
    contractWindowDays: contracts.within,
  };
}
