import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { NON_BUSINESS_ORDER_STATUSES } from "@/lib/services/customers/aggregates";
import { DAY, TIER_WINDOW_DAYS, classifyTiers, settingsFrom, type Tier } from "./rules";

/**
 * The tier pill («VIP» / «عادي» / «صغير» / «بدون طلبات حديثة») of a few customers, outside «يومي» (the customer page,
 * Ctrl K).
 *
 * The SAME derived figure «يومي» shows (BATCH24-DESIGN «Owner decisions»): a tier is relative to the account owner's own
 * book, so each customer is classified within EVERY customer of its owner by kg ordered in the last 90 days
 * (`classifyTiers`, the admin's thresholds). Never stored. A customer with no account owner has no book and so no tier.
 *
 * Cost (council fix round 1, P1): an owner's book is classified ONCE and kept for `TIER_CACHE_MS` in this server
 * instance, so typing in Ctrl K (a request every 150 ms) costs one primary-key read per keystroke, not a book. The book
 * read is one GROUP BY over the owners' orders of the window. The caller decides who may see which customers; this
 * returns a tier for the asked ids only — no other customer's figure leaves.
 */
type Db = Pick<PrismaClient, "$queryRaw">;

/** Above this many distinct owners the pill is skipped (a manager's search across the whole team). */
export const MAX_OWNERS_FOR_TIERS = 10;
export const TIER_CACHE_MS = 60_000;

const cache = new Map<string, { at: number; tiers: Map<string, Tier> }>();

/** Forget the cached books (tests; a settings change takes effect within TIER_CACHE_MS anyway). */
export function clearTierCache(): void { cache.clear(); }

export async function tiersForCustomers(db: Db, customerIds: readonly string[], now: Date = new Date()): Promise<Map<string, Tier>> {
  const out = new Map<string, Tier>();
  const ids = [...new Set(customerIds.filter(Boolean))];
  if (!ids.length) return out;
  const owners = await db.$queryRaw<{ id: string; ownerId: string | null }[]>(Prisma.sql`
    SELECT c."id", c."accountOwnerId" AS "ownerId" FROM "Customer" c WHERE c."id" = ANY(${ids}::text[])`);
  const ownerIds = [...new Set(owners.map((o) => o.ownerId).filter((x): x is string => !!x))];
  if (!ownerIds.length || ownerIds.length > MAX_OWNERS_FOR_TIERS) return out;
  const fresh = (o: string) => { const c = cache.get(o); return !!c && c.at <= now.getTime() && now.getTime() - c.at < TIER_CACHE_MS; };
  const missing = ownerIds.filter((o) => !fresh(o));
  if (missing.length) {
    const since = new Date(now.getTime() - TIER_WINDOW_DAYS * DAY);
    const rows = await db.$queryRaw<{ config: Record<string, unknown> | null; book: { id: string; ownerId: string; kg: number }[] | null }[]>(Prisma.sql`
      WITH kg AS (
        SELECT o."customerId", sum(i."quantityKg")::float8 AS kg
          FROM "Order" o JOIN "OrderItem" i ON i."orderId" = o."id" JOIN "Customer" c ON c."id" = o."customerId"
         WHERE c."accountOwnerId" = ANY(${missing}::text[])
           AND o."createdAt" >= ${since} AND o."createdAt" <= ${now}
           AND o."status" NOT IN (${Prisma.join([...NON_BUSINESS_ORDER_STATUSES])})
         GROUP BY o."customerId"
      )
      SELECT (SELECT row_to_json(x) FROM (SELECT "tierVipTopPct", "tierVipMinKgMonth", "tierSmallMaxKgMonth", "growthMinPct", "growthMinKgMonth",
                     "contactDaysVip", "contactDaysRegular", "contactDaysSmall", "contactDaysNew"
                FROM "SystemConfig" WHERE "id" = 'singleton') x) AS config,
             (SELECT json_agg(json_build_object('id', c."id", 'ownerId', c."accountOwnerId", 'kg', coalesce(kg.kg, 0)))
                FROM "Customer" c LEFT JOIN kg ON kg."customerId" = c."id"
               WHERE c."accountOwnerId" = ANY(${missing}::text[])) AS book`);
    const r = rows[0];
    const settings = settingsFrom(r?.config as never);
    const byOwner = new Map<string, { id: string; kg90: number }[]>(missing.map((o) => [o, []]));
    for (const b of r?.book ?? []) byOwner.get(b.ownerId)?.push({ id: b.id, kg90: Number(b.kg) || 0 });
    for (const [o, book] of byOwner) cache.set(o, { at: now.getTime(), tiers: classifyTiers(book, settings) });
  }
  for (const c of owners) {
    if (!c.ownerId) continue;
    const t = cache.get(c.ownerId)?.tiers.get(c.id);
    if (t) out.set(c.id, t);
  }
  return out;
}
