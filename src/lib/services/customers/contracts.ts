// «العقود» — contracts and price agreements with an end date (batch 24 WP-C, migration
// 20261206100000_customer_contract_validity). The rules of a date are ./contract-rules.ts (pure); this
// file is the database half:
//
//   expiringContracts  the contracts ending soon (and those ended in the last 30 days) of ONE account owner's
//                      customers — «يومي»'s card «عقود قريبة تنتهي» and the team overview. Scope-safe: an owner is
//                      required, unless the caller says `{ scope: "all" }` (a team-view caller only — the route
//                      decides that, as for every manager list). "My customers" = Customer.accountOwnerId = me,
//                      nothing else, so a rep with no customers gets an empty list, never the book.
//   contractNoticeRun  the daily in-app notice to the account owner when a contract enters its notice window
//                      (the file's own notice days, else the company default, else 45). Idempotent: one
//                      notification per contract per window — the dedupe key is the file and its end date, so a
//                      second run the same day (or the next day) adds nothing, and a NEW end date is a new window.
//   mayEditValidity    who may change the dates: the customer's account owner or a sales manager (team view).
//
// A contract replaced by a later one (same customer, same category, a later end date) is "renewed": it is
// left off both lists and never notified, so a rep who already uploaded the new contract hears nothing.
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import type { Permissions } from "@/lib/auth-shared";
import { notify } from "@/lib/notifications/notify";
import { seesTeamReports } from "../sales/scope";
import { DEFAULT_RENEWAL_NOTICE_DAYS, EXPIRED_VISIBLE_DAYS, daysBetween, dateText, displayDate, riyadhToday, toDateOnly } from "./contract-rules";

type Db = Pick<PrismaClient, "$queryRaw">;

export type ExpiringContract = {
  customerId: string;
  customerName: string;
  fileId: string;
  title: string;
  category: string;
  validUntil: Date;
  /** Whole days from today (Riyadh) to the end date; negative once it has ended. */
  daysLeft: number;
  /** The customer's account owner (the rep whose book it is). */
  ownerId: string | null;
};

const DAY = 86_400_000;

/**
 * Contracts ending within `withinDays` of today, plus those that ended in the last 30 days, soonest first.
 * `ownerId` is required unless `scope: "all"` — a missing owner is a programming error, never "everyone".
 */
export async function expiringContracts(
  db: Db,
  opts: { ownerId?: string | null; withinDays: number; scope?: "all"; now?: Date; limit?: number },
): Promise<ExpiringContract[]> {
  const all = opts.scope === "all";
  if (!opts.ownerId && !all) throw new Error("expiringContracts: ownerId is required (or scope: 'all' for a team-view caller)");
  const within = Math.max(0, Math.min(3650, Math.floor(Number(opts.withinDays) || 0)));
  const today = riyadhToday(opts.now);
  const lo = dateText(new Date(today.getTime() - EXPIRED_VISIBLE_DAYS * DAY));
  const hi = dateText(new Date(today.getTime() + within * DAY));
  const owner = opts.ownerId ? Prisma.sql`AND c."accountOwnerId" = ${opts.ownerId}` : Prisma.empty;
  const rows = await db.$queryRaw<{ id: string; customerId: string; name: string; title: string; category: string; validUntil: Date; accountOwnerId: string | null }[]>`
    SELECT f."id", f."customerId", c."name", f."title", f."category", f."validUntil", c."accountOwnerId"
      FROM "CustomerFile" f JOIN "Customer" c ON c."id" = f."customerId"
     WHERE f."validUntil" IS NOT NULL
       AND f."validUntil" BETWEEN ${lo}::date AND ${hi}::date
       AND f."category" IN ('CONTRACT', 'PRICE_AGREEMENT')
       ${owner}
       AND NOT EXISTS (SELECT 1 FROM "CustomerFile" o
                        WHERE o."customerId" = f."customerId" AND o."category" = f."category" AND o."validUntil" > f."validUntil")
     ORDER BY f."validUntil", c."name", f."id"
     LIMIT ${Math.max(1, Math.min(2000, opts.limit ?? 500))}`;
  return rows.map((r) => {
    const until = toDateOnly(r.validUntil) ?? r.validUntil;
    return {
      customerId: r.customerId, customerName: r.name, fileId: r.id, title: r.title, category: r.category,
      validUntil: until, daysLeft: daysBetween(today, until), ownerId: r.accountOwnerId,
    };
  });
}

/**
 * May this person change a file's validity dates? The design rule (council fix round 3, MED-1): the customer's ACCOUNT
 * OWNER (whatever their customers level), or a team-view manager / the admin. Nobody else — customers «edit» alone does
 * not do it (a colleague who holds a deal on the customer must not move its contract dates), and an unowned customer is
 * a manager's.
 */
export function mayEditValidity(
  user: { id: string; role?: string | null; permissions: Permissions | Record<string, unknown>; scope?: unknown },
  customer: { accountOwnerId: string | null },
): boolean {
  if (user.scope === "STATION") return false;
  if (customer.accountOwnerId && customer.accountOwnerId === user.id) return true;
  return seesTeamReports(user.permissions, user.role ?? null);
}

/**
 * The daily notice (its own job: GET /api/cron/contract-notices). For every contract whose end date is today or within
 * its notice window: one in-app notification, at most once per contract per end date — to the account owner, or, for a
 * customer with NO account owner, to the sales managers (council fix round 1: nobody's contract ends unannounced).
 */
export async function contractNoticeRun(db: PrismaClient, now: Date = new Date()): Promise<{ inWindow: number; notified: number }> {
  const today = riyadhToday(now);
  const cfg = await db.systemConfig.findUnique({ where: { id: "singleton" }, select: { contractRenewalNoticeDays: true } }).catch(() => null);
  const fallback = cfg?.contractRenewalNoticeDays ?? DEFAULT_RENEWAL_NOTICE_DAYS;
  const t = dateText(today);
  const rows = await db.$queryRaw<{ id: string; customerId: string; name: string; title: string; category: string; validUntil: Date; accountOwnerId: string | null }[]>`
    SELECT f."id", f."customerId", c."name", f."title", f."category", f."validUntil", c."accountOwnerId"
      FROM "CustomerFile" f JOIN "Customer" c ON c."id" = f."customerId"
     WHERE f."validUntil" IS NOT NULL
       AND f."validUntil" >= ${t}::date
       AND f."validUntil" <= ${t}::date + 365
       AND f."validUntil" - ${t}::date <= coalesce(f."renewalNoticeDays", ${fallback}::int)
       AND f."category" IN ('CONTRACT', 'PRICE_AGREEMENT')
       AND NOT EXISTS (SELECT 1 FROM "CustomerFile" o
                        WHERE o."customerId" = f."customerId" AND o."category" = f."category" AND o."validUntil" > f."validUntil")
     ORDER BY f."validUntil", f."id"
     LIMIT 1000`;
  let notified = 0;
  for (const r of rows) {
    const until = toDateOnly(r.validUntil) ?? r.validUntil;
    const res = await notify(db, {
      event: r.accountOwnerId ? "sales.contract_expiring" : "sales.contract_expiring_unassigned",
      dedupeKey: `${r.id}:${dateText(until)}`,
      people: r.accountOwnerId ? { customerOwner: r.accountOwnerId } : {},
      entity: { type: "CustomerFile", id: r.id },
      facts: {
        customerId: r.customerId, customerName: r.name, title: r.title, category: r.category,
        daysLeft: daysBetween(today, until), endsOn: displayDate(until),
      },
    });
    notified += res.inserted;
  }
  return { inWindow: rows.length, notified };
}
