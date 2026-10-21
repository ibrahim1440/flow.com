import { NextResponse } from "@/lib/api-response";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { seesAllSales } from "@/lib/services/sales/scope";
import { normalizeQuery, type Target } from "@/lib/services/sales/activity-targets";

/**
 * GET /api/sales/activities/targets — the records an activity can be logged on (D6.3).
 *
 * READ-ONLY. Nothing here writes; the activity itself is still posted to
 * `/api/sales/activities`, which applies the business rules and the scope check again.
 *
 * Two shapes:
 *   - no `q`: the two default groups of the picker — «متأخرة أو مستحقة اليوم» (one row per
 *     record, from its earliest open follow-up due by the end of today in Riyadh) and
 *     «سجّلتَ عليها مؤخرًا» (the records the caller last logged on — server-derived, never the
 *     browser's history).
 *   - `q`: leads and deals whose name matches, grouped by type with a count each.
 *
 * Only records the caller may see are returned: a rep sees what they own, and seeing the
 * team's records is the same privilege that widens every other sales read. The scope is in
 * the WHERE clause, never applied after the fetch.
 *
 * Eligible records are the ones a follow-up is still being worked on: an open lead (not
 * converted, not unqualified) or an open deal. A converted lead's record is its deal.
 */

const OPEN_LEAD = ["NEW", "CONTACTED", "QUALIFIED"];
const SCOPES = ["all", "leads", "deals"] as const;
const SEARCH_LIMIT = 8;
const DUE_LIMIT = 50;
const RECENT_LIMIT = 5;

/** The same normalisation in SQL, so the comparison is one rule on both sides. */
const norm = (col: string) =>
  Prisma.raw(`lower(translate(regexp_replace(coalesce(${col}, ''), '[\\u064B-\\u0652\\u0640]', '', 'g'), 'أإآىة', 'ااايه'))`);

const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

type LeadRow = {
  id: string; companyName: string; companyNameAr: string | null; contactName: string;
  subject: string | null; dueAt: Date | null;
};
type DealRow = {
  id: string; title: string; customerName: string | null; customerNameAr: string | null;
  stageEn: string; stageAr: string; subject: string | null; dueAt: Date | null;
};
type GroupRow = {
  leadId: string | null; opportunityId: string | null; subject: string; dueAt: Date | null; createdAt: Date;
  companyName: string | null; companyNameAr: string | null; contactName: string | null;
  title: string | null; customerName: string | null; customerNameAr: string | null;
  stageEn: string | null; stageAr: string | null;
};

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function fromGroupRow(r: GroupRow): Target {
  if (r.opportunityId) {
    return {
      kind: "deal", id: r.opportunityId, name: r.title ?? "", nameAr: null,
      customer: r.customerName ? { name: r.customerName, nameAr: r.customerNameAr } : null,
      stage: r.stageEn ? { nameEn: r.stageEn, nameAr: r.stageAr ?? r.stageEn } : null,
      subject: r.subject, dueAt: iso(r.dueAt),
    };
  }
  return {
    kind: "lead", id: r.leadId ?? "", name: r.companyName ?? "", nameAr: r.companyNameAr,
    customer: null, stage: null, subject: r.subject, dueAt: iso(r.dueAt),
  };
}

export async function GET(request: Request) {
  const { user, error } = await requireModule("sales");
  if (error) return error;

  const url = new URL(request.url);
  const q = normalizeQuery(url.searchParams.get("q") ?? "");
  const scopeRaw = url.searchParams.get("scope") ?? "all";
  if (!(SCOPES as readonly string[]).includes(scopeRaw)) {
    return NextResponse.json({ error: "scope must be one of: " + SCOPES.join(", ") }, { status: 400 });
  }
  const scope = scopeRaw as (typeof SCOPES)[number];

  const all = seesAllSales(user.permissions);
  const uid = user.id;
  // `(ownerId = uid OR all)`: the owner test is skipped only for someone who sees everyone's.
  const leadScope = Prisma.sql`(l."ownerId" = ${uid} OR ${all})`;
  const dealScope = Prisma.sql`(o."ownerId" = ${uid} OR ${all})`;
  const openLead = Prisma.sql`l.status::text IN (${Prisma.join(OPEN_LEAD)})`;

  try {
    if (q) {
      const pat = likePattern(q);
      const wantLeads = scope !== "deals";
      const wantDeals = scope !== "leads";

      const leadWhere = Prisma.sql`${openLead} AND ${leadScope} AND (
        ${norm('l."companyName"')} LIKE ${pat} OR ${norm('l."companyNameAr"')} LIKE ${pat} OR ${norm('l."contactName"')} LIKE ${pat})`;
      const dealWhere = Prisma.sql`o.outcome = 'OPEN' AND ${dealScope} AND (
        ${norm("o.title")} LIKE ${pat} OR ${norm("c.name")} LIKE ${pat} OR ${norm('c."nameAr"')} LIKE ${pat})`;

      const [leads, leadCount, deals, dealCount] = await Promise.all([
        wantLeads ? prisma.$queryRaw<LeadRow[]>`
          SELECT l.id, l."companyName", l."companyNameAr", l."contactName", f.subject, f."dueAt"
          FROM "Lead" l
          LEFT JOIN LATERAL (
            SELECT a.subject, a."dueAt" FROM "Activity" a
            WHERE a."leadId" = l.id AND a."completedAt" IS NULL
            ORDER BY a."dueAt" ASC NULLS LAST, a."createdAt" ASC LIMIT 1) f ON true
          WHERE ${leadWhere}
          ORDER BY l."nextFollowUpAt" ASC NULLS LAST, l."companyName" ASC
          LIMIT ${SEARCH_LIMIT}` : Promise.resolve([] as LeadRow[]),
        wantLeads ? prisma.$queryRaw<{ n: bigint }[]>`SELECT COUNT(*) n FROM "Lead" l WHERE ${leadWhere}` : Promise.resolve([{ n: BigInt(0) }]),
        wantDeals ? prisma.$queryRaw<DealRow[]>`
          SELECT o.id, o.title, c.name AS "customerName", c."nameAr" AS "customerNameAr",
                 s."nameEn" AS "stageEn", s."nameAr" AS "stageAr", f.subject, f."dueAt"
          FROM "Opportunity" o
          LEFT JOIN "Customer" c ON c.id = o."customerId"
          JOIN "PipelineStage" s ON s.id = o."stageId"
          LEFT JOIN LATERAL (
            SELECT a.subject, a."dueAt" FROM "Activity" a
            WHERE a."opportunityId" = o.id AND a."completedAt" IS NULL
            ORDER BY a."dueAt" ASC NULLS LAST, a."createdAt" ASC LIMIT 1) f ON true
          WHERE ${dealWhere}
          ORDER BY o."nextFollowUpAt" ASC NULLS LAST, o."expectedCloseAt" ASC NULLS LAST, o.title ASC
          LIMIT ${SEARCH_LIMIT}` : Promise.resolve([] as DealRow[]),
        wantDeals ? prisma.$queryRaw<{ n: bigint }[]>`
          SELECT COUNT(*) n FROM "Opportunity" o LEFT JOIN "Customer" c ON c.id = o."customerId" WHERE ${dealWhere}`
          : Promise.resolve([{ n: BigInt(0) }]),
      ]);

      return NextResponse.json({
        mode: "search",
        scope,
        leads: {
          total: Number(leadCount[0]?.n ?? 0),
          rows: leads.map<Target>((l) => ({
            kind: "lead", id: l.id, name: l.companyName, nameAr: l.companyNameAr,
            customer: null, stage: null, subject: l.subject, dueAt: iso(l.dueAt),
          })),
        },
        deals: {
          total: Number(dealCount[0]?.n ?? 0),
          rows: deals.map<Target>((d) => ({
            kind: "deal", id: d.id, name: d.title, nameAr: null,
            customer: d.customerName ? { name: d.customerName, nameAr: d.customerNameAr } : null,
            stage: { nameEn: d.stageEn, nameAr: d.stageAr }, subject: d.subject, dueAt: iso(d.dueAt),
          })),
        },
      });
    }

    // «اليوم» is Riyadh's today, as the follow-up list counts it.
    const now = new Date();
    const riyadhNow = new Date(now.getTime() + 3 * 3600_000);
    const endOfRiyadhToday = new Date(
      Date.UTC(riyadhNow.getUTCFullYear(), riyadhNow.getUTCMonth(), riyadhNow.getUTCDate(), 21, 0, 0, 0),
    );

    // One row per record: the record is the key, its earliest open follow-up the subject.
    const eligible = Prisma.sql`(
      (a."opportunityId" IS NOT NULL AND o.outcome = 'OPEN')
      OR (a."opportunityId" IS NULL AND a."leadId" IS NOT NULL AND ${openLead}))`;
    const scopeKind = scope === "leads" ? Prisma.sql`AND a."opportunityId" IS NULL`
      : scope === "deals" ? Prisma.sql`AND a."opportunityId" IS NOT NULL` : Prisma.empty;
    // Scoped by the RECORD's owner, exactly as search is — never by the activity's owner. An
    // activity a rep logged on a record since reassigned away is still theirs to read, but the
    // record is not theirs to log on any more, and the picker offers only what the POST accepts.
    const recordScope = Prisma.sql`(
      (a."opportunityId" IS NOT NULL AND ${dealScope})
      OR (a."opportunityId" IS NULL AND ${leadScope}))`;
    const dueFilter = Prisma.sql`a."completedAt" IS NULL AND a."dueAt" <= ${endOfRiyadhToday}
      AND ${recordScope} AND ${eligible} ${scopeKind}`;
    const recentFilter = Prisma.sql`a."ownerId" = ${uid} AND ${recordScope} AND ${eligible} ${scopeKind}`;

    const detail = Prisma.sql`
      d."leadId", d."opportunityId", d.subject, d."dueAt", d."createdAt",
      l."companyName", l."companyNameAr", l."contactName",
      o.title, c.name AS "customerName", c."nameAr" AS "customerNameAr",
      s."nameEn" AS "stageEn", s."nameAr" AS "stageAr"
      FROM d
      LEFT JOIN "Lead" l ON l.id = d."leadId" AND d."opportunityId" IS NULL
      LEFT JOIN "Opportunity" o ON o.id = d."opportunityId"
      LEFT JOIN "Customer" c ON c.id = o."customerId"
      LEFT JOIN "PipelineStage" s ON s.id = o."stageId"`;

    const [due, dueCount, recent] = await Promise.all([
      prisma.$queryRaw<GroupRow[]>`
        WITH d AS (
          SELECT DISTINCT ON (coalesce(a."opportunityId", a."leadId"))
            a."leadId", a."opportunityId", a.subject, a."dueAt", a."createdAt"
          FROM "Activity" a
          LEFT JOIN "Lead" l ON l.id = a."leadId"
          LEFT JOIN "Opportunity" o ON o.id = a."opportunityId"
          WHERE ${dueFilter}
          ORDER BY coalesce(a."opportunityId", a."leadId"), a."dueAt" ASC, a."createdAt" ASC)
        SELECT ${detail}
        ORDER BY d."dueAt" ASC, d."createdAt" ASC
        LIMIT ${DUE_LIMIT}`,
      prisma.$queryRaw<{ n: bigint }[]>`
        SELECT COUNT(DISTINCT coalesce(a."opportunityId", a."leadId")) n
        FROM "Activity" a
        LEFT JOIN "Lead" l ON l.id = a."leadId"
        LEFT JOIN "Opportunity" o ON o.id = a."opportunityId"
        WHERE ${dueFilter}`,
      prisma.$queryRaw<GroupRow[]>`
        WITH d AS (
          SELECT DISTINCT ON (coalesce(a."opportunityId", a."leadId"))
            a."leadId", a."opportunityId", a.subject, a."dueAt", a."createdAt"
          FROM "Activity" a
          LEFT JOIN "Lead" l ON l.id = a."leadId"
          LEFT JOIN "Opportunity" o ON o.id = a."opportunityId"
          WHERE ${recentFilter}
          ORDER BY coalesce(a."opportunityId", a."leadId"), a."createdAt" DESC)
        SELECT ${detail}
        ORDER BY d."createdAt" DESC
        LIMIT ${RECENT_LIMIT + DUE_LIMIT}`,
    ]);

    const dueRows = due.map(fromGroupRow);
    const seen = new Set(dueRows.map((t) => `${t.kind}:${t.id}`));
    // A record already in the due group is not repeated under «مؤخرًا»; the recent row keeps
    // the subject of what was logged, not a due date.
    const recentRows = recent.map(fromGroupRow)
      .filter((t) => !seen.has(`${t.kind}:${t.id}`))
      .slice(0, RECENT_LIMIT)
      .map((t) => ({ ...t, dueAt: null }));

    return NextResponse.json({
      mode: "default",
      scope,
      due: { total: Number(dueCount[0]?.n ?? 0), rows: dueRows },
      recent: { rows: recentRows },
    });
  } catch (err) {
    return handlePrismaError(err);
  }
}
