// «متابعة إعادة الشراء» — which existing customers are due, late or gone quiet, each against ITS OWN rhythm.
//
// No single number of days fits every account: a café that takes coffee every 14 days is late at 20,
// a distributor on a 60-day cycle is not. So the interval is the customer's own — the agreed one
// (Customer.reorderIntervalDays) when set, otherwise the average gap the business orders show
// (aggregates.ts orderRhythm: cancelled and rejected orders are not purchases, three orders in the
// last year at least) — and the organisation sets only two factors on it:
//
//   DUE       expected date reached (last order + interval)            → «موعد إعادة الطلب»
//   LATE      interval × late factor passed (built-in 1.3)              → «متأخر عن موعده»
//   INACTIVE  interval × inactive factor passed (built-in 2.5)          → «منقطع عن الشراء»
//
// A customer without a usable interval is never flagged: guessing a rhythm is how random reminders
// start. The result is read on «مساحة عملي» as suggestions for the account's owner — a list, never a
// push notification.
import type { PrismaClient } from "@/generated/prisma/client";
import { orderRhythm, type OrderRow } from "./aggregates";

const DAY = 86_400_000;
export const DEFAULT_LATE_FACTOR = 1.3;
export const DEFAULT_INACTIVE_FACTOR = 2.5;

export type ReorderState = "ON_TRACK" | "DUE" | "LATE" | "INACTIVE";
export type ReorderFactors = { late: number; inactive: number };

export type ReorderStatus = {
  state: ReorderState;
  intervalDays: number;
  intervalSource: "AGREED" | "HISTORY";
  lastOrderAt: Date;
  daysSince: number;
  expectedAt: Date;
};

/**
 * One customer's standing, or null when there is nothing to go on (no business order, or neither an
 * agreed interval nor three orders in the last year). Pure: the screen and the tests ask the same question.
 */
export function reorderStatus(orders: OrderRow[], agreedIntervalDays: number | null, factors: ReorderFactors, now: Date): ReorderStatus | null {
  const rhythm = orderRhythm(orders, now);
  if (!rhythm.lastOrder) return null;
  const interval = agreedIntervalDays ?? rhythm.cadenceDays;
  if (!interval || interval < 1) return null;
  const daysSince = rhythm.lastOrder.daysAgo;
  const state: ReorderState =
    daysSince >= interval * factors.inactive ? "INACTIVE"
      : daysSince >= interval * factors.late ? "LATE"
        : daysSince >= interval ? "DUE"
          : "ON_TRACK";
  return {
    state, intervalDays: interval, intervalSource: agreedIntervalDays ? "AGREED" : "HISTORY",
    lastOrderAt: rhythm.lastOrder.createdAt, daysSince,
    expectedAt: new Date(rhythm.lastOrder.createdAt.getTime() + interval * DAY),
  };
}

/** The two factors from the settings row; a missing or unset value is the built-in one. */
export function factorsFrom(row: { reorderLateFactor: { toString(): string } | null; reorderInactiveFactor: { toString(): string } | null } | null): ReorderFactors {
  const late = row?.reorderLateFactor != null ? Number(row.reorderLateFactor.toString()) : DEFAULT_LATE_FACTOR;
  const inactive = row?.reorderInactiveFactor != null ? Number(row.reorderInactiveFactor.toString()) : DEFAULT_INACTIVE_FACTOR;
  return { late, inactive: Math.max(inactive, late) };
}

type Db = Pick<PrismaClient, "customer" | "order" | "systemConfig">;

export type ReorderSuggestion = ReorderStatus & {
  customerId: string; name: string; nameAr: string | null; accountOwnerId: string | null;
  usualItems: string[];
};

/**
 * Who the list is for (batch 24 WP-A scope hardening): ONE account owner's book (`ownerId`), or — only when
 * the caller says so in words — every account (`scope: "all"`, a team-view caller: the sales manager or the
 * admin; the route decides who may). A null / empty owner is refused instead of silently reading the whole
 * book: «a rep with no customers gets an EMPTY result, never the whole book».
 */
export type ReorderScope = { ownerId: string; scope?: undefined } | { scope: "all"; ownerId?: undefined };

export class ReorderScopeError extends Error {
  constructor() { super("reorderSuggestions needs an ownerId, or { scope: 'all' } from a team-view caller."); this.name = "ReorderScopeError"; }
}

/**
 * The customers that need a call, most overdue first. `ownerId` narrows to one account owner's book
 * (a rep's «مساحة عملي», «يومي»); `{ scope: "all" }` reads every account (a manager's list).
 * Only DUE / LATE / INACTIVE come back.
 */
export async function reorderSuggestions(db: Db, opts: ReorderScope & { now?: Date; limit?: number; everyCustomer?: boolean }): Promise<ReorderSuggestion[]> {
  const all = (opts as { scope?: unknown }).scope === "all";
  const owner = (opts as { ownerId?: unknown }).ownerId;
  if (!all && (typeof owner !== "string" || owner.length === 0)) throw new ReorderScopeError();
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - 400 * DAY);
  const [config, customers] = await Promise.all([
    db.systemConfig.findUnique({ where: { id: "singleton" }, select: { reorderLateFactor: true, reorderInactiveFactor: true } }),
    db.customer.findMany({
      where: { ...(all ? {} : { accountOwnerId: owner as string }), orders: { some: {} } },
      select: { id: true, name: true, nameAr: true, accountOwnerId: true, reorderIntervalDays: true },
      // Deterministic, and uncapped for the team overview (`everyCustomer`, council fix round 1): a cap without an order
      // dropped an arbitrary set of customers from «طلبات متأخرة».
      orderBy: { id: "asc" },
      ...(opts.everyCustomer ? {} : { take: 2000 }),
    }),
  ]);
  if (!customers.length) return [];
  const factors = factorsFrom(config);
  const orders = await db.order.findMany({
    where: { customerId: { in: customers.map((c) => c.id) }, createdAt: { gte: since } },
    select: { id: true, orderNumber: true, createdAt: true, status: true, customerId: true, items: { select: { quantityKg: true, beanTypeName: true } } },
  });
  const byCustomer = new Map<string, OrderRow[]>();
  for (const o of orders) {
    const list = byCustomer.get(o.customerId) ?? [];
    list.push({ id: o.id, orderNumber: o.orderNumber, createdAt: o.createdAt, status: o.status, items: o.items.map((i) => ({ quantityKg: i.quantityKg, name: i.beanTypeName ?? "" })) });
    byCustomer.set(o.customerId, list);
  }
  const out: ReorderSuggestion[] = [];
  for (const c of customers) {
    const rows = byCustomer.get(c.id) ?? [];
    const s = reorderStatus(rows, c.reorderIntervalDays, factors, now);
    if (!s || s.state === "ON_TRACK") continue;
    const items = [...new Set(rows.filter((r) => !["Cancelled", "Rejected"].includes(r.status)).flatMap((r) => r.items.map((i) => i.name)).filter(Boolean))].slice(0, 3);
    out.push({ ...s, customerId: c.id, name: c.name, nameAr: c.nameAr, accountOwnerId: c.accountOwnerId, usualItems: items });
  }
  return out.sort((a, b) => (b.daysSince - b.intervalDays) - (a.daysSince - a.intervalDays)).slice(0, opts.limit ?? 50);
}
