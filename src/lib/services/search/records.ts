import { Prisma } from "@/generated/prisma/client";
import { hasModuleAccess, type Permissions } from "@/lib/auth-shared";
import { customersScopedToOwner, seesAllSales } from "@/lib/services/sales/scope";
import { canViewQuotes, quotesSeeAll } from "@/lib/services/sales/quote-access";
import { SQL_FOLD_FROM, SQL_FOLD_TO, foldArabic, phoneDigits } from "./normalize";
import { tiersForCustomers } from "@/lib/services/sales/my-day/tier";
import type { Tier } from "@/lib/services/sales/my-day/rules";

/**
 * Ctrl K record search (batch 24 WP-A): customers, deals, quotations and leads, for GET /api/search.
 *
 * ── Scope (BATCH24-DESIGN «Data scope rule») ──
 * Decided here from the viewer, never from the request:
 *   · customers — the customers module. A rep scoped to their own book (`customersScopedToOwner`) sees
 *     «عملائي» only: `Customer.accountOwnerId = me`, the one definition of the batch. A rep with no
 *     customers gets nothing, never the whole book. Everybody else who may open the customer list sees
 *     every customer, as the list does;
 *   · deals and leads — the sales module; the owner's own unless `seesAllSales` (lead_assign);
 *   · quotations — `canViewQuotes`; through the deal's owner unless `quotesSeeAll` (as GET /api/sales/quotes).
 *
 * ── Matching ──
 * The stored text and the query are folded the same way (./normalize: أ/إ/آ→ا, ة→ه, ى→ي, no tatweel or
 * harakat, lower case), and a phone-like query also matches the digits of the stored phone numbers (the
 * customer's and its contacts', the lead's). Prefix matches rank first, then the most recently touched.
 */
export type SearchViewer = { id: string; role?: string | null; permissions: Permissions | Record<string, unknown> };
export type SearchKind = "customer" | "deal" | "quote" | "lead";
export type SearchHit = {
  kind: SearchKind; id: string; title: string; titleEn: string; sub: string | null; href: string;
  /** The customer the hit belongs to (a customer's own id, a deal's or a quotation's customer). */
  customerId: string | null;
  phone: string | null;
  /** Quotation / deal status words are the page's business; the raw value travels for the pill. */
  status: string | null;
  /** Customers only: the derived tier within the account owner's book (WP-B, «يومي»); absent when the customer has no owner. */
  tier?: Tier | null;
};
export type SearchResult = Record<`${SearchKind}s`, SearchHit[]> & { scope: "own" | "all" };

type Db = { $queryRaw: <T = unknown>(query: Prisma.Sql) => Prisma.PrismaPromise<T> };

const fold = (col: Prisma.Sql) => Prisma.sql`translate(lower(coalesce(${col}, '')), ${SQL_FOLD_FROM}, ${SQL_FOLD_TO})`;
const digits = (col: Prisma.Sql) => Prisma.sql`regexp_replace(coalesce(${col}, ''), '[^0-9]', '', 'g')`;

export const MIN_QUERY = 2;

export async function searchRecords(db: Db, viewer: SearchViewer, rawQ: string, opts: { limit?: number } = {}): Promise<SearchResult> {
  const p = viewer.permissions as Permissions;
  const limit = Math.min(Math.max(opts.limit ?? 6, 1), 20);
  const q = foldArabic(rawQ).slice(0, 80);
  const tel = phoneDigits(rawQ);
  const empty: SearchResult = { customers: [], deals: [], quotes: [], leads: [], scope: seesAllSales(p) ? "all" : "own" };
  if (q.length < MIN_QUERY && !tel) return empty;
  const telCond = (col: Prisma.Sql) => (tel ? Prisma.sql`strpos(${digits(col)}, ${tel}) > 0` : Prisma.sql`false`);
  const has = (col: Prisma.Sql) => Prisma.sql`strpos(${fold(col)}, ${q}) > 0`;
  const starts = (col: Prisma.Sql) => Prisma.sql`strpos(${fold(col)}, ${q}) = 1`;

  const jobs: Promise<void>[] = [];

  // ── Customers ──
  // The tier pill («VIP» / «عادي» / «صغير») is WP-B's derived figure (kg over 90 days, ranked within the account owner's
  // book): one more round-trip for the ≤ limit rows returned (tiersForCustomers), skipped above 10 distinct owners — and
  // only for the rows the viewer may see it on (their own customers, or every one for a viewer who sees all sales).
  if (hasModuleAccess(p, "customers")) {
    const scoped = customersScopedToOwner({ role: viewer.role, permissions: p });
    const scope = scoped ? Prisma.sql`c."accountOwnerId" = ${viewer.id}` : Prisma.sql`true`;
    // Who sees the pill — the same rule as the customer page (council fix round 2, item 12): a sales viewer, on a
    // customer they own, or a viewer who sees every sale. Nobody else gets another rep's ranking.
    const tierAll = hasModuleAccess(p, "sales") && seesAllSales(p);
    const tierOwn = hasModuleAccess(p, "sales");
    let owners = new Map<string, string | null>();
    jobs.push(db.$queryRaw<{ id: string; name: string; nameAr: string | null; phone: string | null; city: string | null; ownerId: string | null }[]>(Prisma.sql`
      SELECT c."id", c."name", c."nameAr", c."phone", c."city", c."accountOwnerId" AS "ownerId"
        FROM "Customer" c
       WHERE ${scope}
         AND (${has(Prisma.sql`c."name"`)} OR ${has(Prisma.sql`c."nameAr"`)} OR ${has(Prisma.sql`c."city"`)}
              OR ${telCond(Prisma.sql`c."phone"`)}
              OR EXISTS (SELECT 1 FROM "CustomerContact" cc WHERE cc."customerId" = c."id"
                          AND (${has(Prisma.sql`cc."name"`)} OR ${telCond(Prisma.sql`cc."phone"`)})))
       ORDER BY (${starts(Prisma.sql`c."nameAr"`)} OR ${starts(Prisma.sql`c."name"`)}) DESC, c."updatedAt" DESC
       LIMIT ${limit}`).then((rows) => {
      owners = new Map(rows.map((r) => [r.id, r.ownerId]));
      empty.customers = rows.map((r) => ({
        kind: "customer", id: r.id, title: r.nameAr || r.name, titleEn: r.name, sub: r.city || null,
        href: `/dashboard/customers/${r.id}`, customerId: r.id, phone: r.phone, status: null,
      }));
    }).then(async () => {
      const may = empty.customers.filter((h) => tierAll || (tierOwn && owners.get(h.id) === viewer.id));
      for (const h of empty.customers) h.tier = null;
      if (!may.length) return;
      const tiers = await tiersForCustomers(db as never, may.map((h) => h.id));
      for (const h of may) h.tier = tiers.get(h.id) ?? null;
    }));
  }

  // ── Deals ──
  if (hasModuleAccess(p, "sales")) {
    const scope = seesAllSales(p) ? Prisma.sql`true` : Prisma.sql`o."ownerId" = ${viewer.id}`;
    jobs.push(db.$queryRaw<{ id: string; title: string; outcome: string; customerId: string | null; cName: string | null; cNameAr: string | null }[]>(Prisma.sql`
      SELECT o."id", o."title", o."outcome"::text AS "outcome", o."customerId", c."name" AS "cName", c."nameAr" AS "cNameAr"
        FROM "Opportunity" o LEFT JOIN "Customer" c ON c."id" = o."customerId"
       WHERE ${scope}
         AND (${has(Prisma.sql`o."title"`)} OR ${has(Prisma.sql`c."name"`)} OR ${has(Prisma.sql`c."nameAr"`)})
       ORDER BY (o."outcome" = 'OPEN') DESC, ${starts(Prisma.sql`o."title"`)} DESC, o."updatedAt" DESC
       LIMIT ${limit}`).then((rows) => {
      empty.deals = rows.map((r) => ({
        kind: "deal", id: r.id, title: r.title, titleEn: r.title, sub: r.cNameAr || r.cName || null,
        href: `/dashboard/sales/deals/${r.id}`, customerId: r.customerId, phone: null, status: r.outcome,
      }));
    }));

    const leadScope = seesAllSales(p) ? Prisma.sql`true` : Prisma.sql`l."ownerId" = ${viewer.id}`;
    jobs.push(db.$queryRaw<{ id: string; companyName: string; companyNameAr: string | null; contactName: string; city: string | null; phone: string | null; status: string }[]>(Prisma.sql`
      SELECT l."id", l."companyName", l."companyNameAr", l."contactName", l."city", l."phone", l."status"::text AS "status"
        FROM "Lead" l
       WHERE ${leadScope}
         AND (${has(Prisma.sql`l."companyName"`)} OR ${has(Prisma.sql`l."companyNameAr"`)} OR ${has(Prisma.sql`l."contactName"`)}
              OR ${telCond(Prisma.sql`l."phone"`)})
       ORDER BY (l."status" <> 'CONVERTED') DESC, ${starts(Prisma.sql`l."companyName"`)} DESC, l."updatedAt" DESC
       LIMIT ${limit}`).then((rows) => {
      empty.leads = rows.map((r) => ({
        kind: "lead", id: r.id, title: r.companyNameAr || r.companyName, titleEn: r.companyName,
        sub: [r.contactName, r.city].filter(Boolean).join(" · ") || null,
        href: `/dashboard/sales/leads/${r.id}`, customerId: null, phone: r.phone, status: r.status,
      }));
    }));
  }

  // ── Quotations (by number or customer) ──
  if (canViewQuotes(p)) {
    const scope = quotesSeeAll(p) ? Prisma.sql`true` : Prisma.sql`o."ownerId" = ${viewer.id}`;
    const num = toNumberQuery(rawQ);
    jobs.push(db.$queryRaw<{ id: string; quoteNumber: string; status: string; customerId: string | null; cName: string | null; cNameAr: string | null }[]>(Prisma.sql`
      SELECT q."id", q."quoteNumber", q."status"::text AS "status", q."customerId", c."name" AS "cName", c."nameAr" AS "cNameAr"
        FROM "Quote" q JOIN "Opportunity" o ON o."id" = q."opportunityId" LEFT JOIN "Customer" c ON c."id" = q."customerId"
       WHERE ${scope} AND q."status" <> 'SUPERSEDED'
         AND (strpos(lower(q."quoteNumber"), ${num}) > 0 OR ${has(Prisma.sql`c."name"`)} OR ${has(Prisma.sql`c."nameAr"`)})
       ORDER BY (strpos(lower(q."quoteNumber"), ${num}) > 0) DESC, q."updatedAt" DESC
       LIMIT ${limit}`).then((rows) => {
      empty.quotes = rows.map((r) => ({
        kind: "quote", id: r.id, title: r.quoteNumber, titleEn: r.quoteNumber, sub: r.cNameAr || r.cName || null,
        href: `/dashboard/sales/quotes/${r.id}`, customerId: r.customerId, phone: null, status: r.status,
      }));
    }));
  }

  await Promise.all(jobs);
  return empty;
}

/** «#1042», «q-1042», «١٠٤٢» → the lower-case text a quotation number contains. */
function toNumberQuery(raw: string): string {
  const t = foldArabic(raw).replace(/^#/, "").trim();
  return t.length ? t : "\u0000";
}
