/**
 * «جاهزية البن الأخضر للتحميص» — warn the supervisor BEFORE roasting (roasting-station plan, item 4).
 *
 * Over today and the next two days (Riyadh), the roast demand per coffee and day — the planned green of the schedule's
 * live slots, and today also the live queue (orders, and roast-to-stock production orders — the station's own two
 * sources: roasted kilograms still to roast ÷ (1 − the coffee's expected loss)) — is
 * checked with the SAME choice the roast makes (pickFromFacts at the production site). When the production site lacks
 * the green but another site holds it (AT_OTHER_SITE), the holders of inventory › receive / adjust and the production
 * schedule managers get ONE notification per (coffee, day) in «مساحة عملي» with the prefilled transfer (lot, quantity,
 * from → to). Nothing is moved automatically: the supervisor confirms the transfer with one tap.
 *
 * Idempotent: a NotificationWatch «green-transfer:<productId>:<day>» holds what was last alerted — the lot, the site it
 * comes from and the shortfall in 5-kg buckets (council F3), then the exact figure. The same state sends nothing; a
 * changed one updates the existing rows' text instead of adding rows, and marks them unread again ONLY when the lot or
 * the site changed or the shortfall grew past its bucket; a resolved one clears the watch silently. The watch is claimed
 * and the rows written in ONE transaction (council F5): a failed notify leaves the watch as it was, so the next run
 * retries. Runs from the daily workspace job, on demand when «مساحة عملي» or the station queue loads for someone the
 * alert is for (council F8), and from POST /api/production/green-readiness — one 5-minute throttle per instance for all
 * of them (council F2; production crons are daily, never minute-level). Never throws.
 */
import { after } from "next/server";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { greenSourceFacts, pickFromFacts } from "./green-source";
import { roasterSiteId } from "./stock-locations";
import { roastQueue } from "./roast-queue";
import { productionProgressMany } from "./production-planning";
import { addDays, riyadhKey, riyadhMidnight } from "./schedule/planner";
import { eventDef } from "@/lib/notifications/catalog";
import { notify } from "@/lib/notifications/notify";
import type { Permissions } from "@/lib/auth-shared";
import { alertIsNews, alertState, canReceiveGreenAlert } from "@/lib/green-readiness-rules";

type Db = PrismaClient | Prisma.TransactionClient;
const EVENT = "production.green_transfer_needed";
const r2 = (n: number) => Math.round(n * 100) / 100;

export type GreenShortage = {
  productId: string; productNameAr: string | null; productNameEn: string; day: string; needKg: number;
  lotId: string; lotName: string; lotNameEn: string; lotCode: string | null; serial: string;
  siteId: string; siteName: string; siteNameEn: string; atSiteKg: number; shortKg: number;
  /** What the suggested transfer moves (min(shortfall, the source site's balance)) and what is still needed from others. */
  transferKg: number; restKg: number; others: { name: string; nameEn: string; qty: number }[];
  fromId: string | null; fromName: string | null; fromNameEn: string | null; transferHref: string;
};

/** The demand per coffee and day (kg of green), today and the next `days − 1` days. */
export async function greenDemand(db: Db, now = new Date(), days = 3): Promise<Map<string, { productId: string; day: string; kg: number }>> {
  const today = riyadhKey(now);
  const out = new Map<string, { productId: string; day: string; kg: number }>();
  const add = (productId: string, day: string, kg: number, mode: "sum" | "max" = "sum") => {
    if (!(kg > 0)) return;
    const k = `${productId}:${day}`;
    const cur = out.get(k);
    if (!cur) out.set(k, { productId, day, kg });
    else cur.kg = mode === "sum" ? cur.kg + kg : Math.max(cur.kg, kg);
  };
  const slots = await db.scheduledSlot.findMany({
    where: { status: { in: ["PLANNED", "IN_PROGRESS"] }, batch: null, startsAt: { gte: new Date(riyadhMidnight(today)), lt: new Date(riyadhMidnight(addDays(today, days))) } },
    select: { productId: true, startsAt: true, plannedGreenKg: true },
  });
  for (const s of slots) add(s.productId, riyadhKey(s.startsAt), Number(s.plannedGreenKg));
  // Today's live queue (orders still to roast): the green it needs, unless today's slots already plan more.
  for (const c of await roastQueue(db)) {
    if (!(c.demandKg > 0)) continue;
    const loss = Math.min(90, Math.max(0, c.expectedRoastLoss ?? 15));
    add(c.productId, today, c.demandKg / (1 - loss / 100), "max");
  }
  // Today's live roast-to-stock production orders (the station queue's second source), per coffee.
  const pos = await db.productionOrder.findMany({
    where: { status: { in: ["PENDING", "IN_PRODUCTION"] }, sourceOrderItemId: null },
    select: { id: true, targetUnits: true, targetWeightKg: true, productSku: { select: { productId: true, product: { select: { expectedRoastLoss: true } } } } },
  });
  const progress = await productionProgressMany(db as Prisma.TransactionClient, pos);
  const stockKg = new Map<string, number>();
  for (const po of pos) {
    const left = progress.get(po.id)?.remainingKg ?? 0;
    if (!(left > 0)) continue;
    const loss = Math.min(90, Math.max(0, po.productSku.product.expectedRoastLoss ?? 15));
    stockKg.set(po.productSku.productId, (stockKg.get(po.productSku.productId) ?? 0) + left / (1 - loss / 100));
  }
  for (const [productId, kg] of stockKg) add(productId, today, kg, "max");
  for (const v of out.values()) v.kg = Math.round(v.kg * 1000) / 1000;
  return out;
}

/** Every (coffee, day) whose green is enough in the company but not at the production site. */
export async function greenShortages(db: Db, now = new Date()): Promise<GreenShortage[]> {
  const demand = await greenDemand(db, now);
  const out: GreenShortage[] = [];
  const facts = new Map<string, Awaited<ReturnType<typeof greenSourceFacts>>>();
  // The roasting site the readiness is about (20261117090000, owner decision 5): the default roaster's location (or its
  // station's), else the production site.
  const def = await db.roaster.findFirst({ where: { isDefault: true, status: { not: "RETIRED" } }, select: { id: true } });
  const siteId = await roasterSiteId(db, def?.id ?? null);
  for (const d of [...demand.values()].sort((a, b) => a.day.localeCompare(b.day) || a.productId.localeCompare(b.productId))) {
    if (!facts.has(d.productId)) facts.set(d.productId, await greenSourceFacts(db, { productId: d.productId, siteId }));
    const f = facts.get(d.productId) ?? null;
    const pick = pickFromFacts(f, d.kg);
    if (pick.ok || pick.reason !== "AT_OTHER_SITE") continue;
    out.push({
      productId: d.productId, productNameAr: f?.productNameAr ?? null, productNameEn: f?.productNameEn ?? d.productId, day: d.day, needKg: d.kg,
      lotId: pick.lot.id, lotName: pick.lot.beanTypeAr || pick.lot.beanType, lotNameEn: pick.lot.beanType, lotCode: pick.lot.labelCode ?? null, serial: pick.lot.serialNumber,
      siteId: pick.site.id, siteName: pick.site.nameAr, siteNameEn: pick.site.nameEn || pick.site.nameAr, atSiteKg: r2(pick.lot.siteKg ?? 0), shortKg: r2(pick.shortKg),
      transferKg: r2(pick.transferKg), restKg: r2(pick.restKg), others: pick.others.map((o) => ({ name: o.nameAr, nameEn: o.nameEn || o.nameAr, qty: r2(o.qty) })),
      fromId: pick.from?.locationId ?? null, fromName: pick.from?.nameAr ?? null, fromNameEn: pick.from?.nameEn || pick.from?.nameAr || null, transferHref: pick.transferHref,
    });
  }
  return out;
}

export { alertIsNews, alertState, canReceiveGreenAlert };

const factsOf = (g: GreenShortage) => ({
  productName: g.productNameAr || g.productNameEn, productNameEn: g.productNameEn, day: g.day, needKg: r2(g.needKg), atSiteKg: g.atSiteKg, shortKg: g.transferKg,
  restKg: g.restKg, othersAr: g.others.map((o) => `«${o.name}» (${o.qty} كغ)`).join("، "), othersEn: g.others.map((o) => `«${o.nameEn}» (${o.qty} kg)`).join(", "),
  lotName: `${g.lotName} (${g.serial})`, lotNameEn: `${g.lotNameEn} (${g.serial})`, lotCode: g.lotCode ?? "", siteName: g.siteName, siteNameEn: g.siteNameEn,
  fromName: g.fromName ?? "", fromNameEn: g.fromNameEn ?? "", transferHref: g.transferHref,
});

/** Alert (or update the alert of) every shortage; clear the watches of the ones resolved. Returns the counts. */
export async function checkGreenReadiness(db: PrismaClient, now = new Date()): Promise<{ shortages: number; notified: number; updated: number; cleared: number }> {
  const res = { shortages: 0, notified: 0, updated: 0, cleared: 0 };
  try {
    const list = await greenShortages(db, now);
    res.shortages = list.length;
    const live = new Set<string>();
    for (const g of list) {
      const key = `green-transfer:${g.productId}:${g.day}`;
      live.add(key);
      const state = alertState(g);
      const prev = await db.notificationWatch.findUnique({ where: { key } });
      if (prev?.state === state) continue;
      const news = alertIsNews(prev?.state, state);
      // Claim the change and write the rows in ONE transaction: only the writer that moved the watch from its last state
      // alerts (concurrent loads alert once), and a failed notify rolls the claim back (the next run retries).
      const done = await db.$transaction(async (tx) => {
        const claimed = prev
          ? (await tx.notificationWatch.updateMany({ where: { key, state: prev.state }, data: { state } })).count === 1
          : (await tx.notificationWatch.createMany({ data: [{ key, state }], skipDuplicates: true })).count === 1;
        if (!claimed) return null;
        const r = await notify(tx, { event: EVENT, dedupeKey: `${g.productId}:${g.day}`, facts: factsOf(g), entity: { type: "CoffeeProduct", id: g.productId } });
        // Rows already there (an earlier shortage of the same coffee and day): their text follows, never a second row.
        const t = eventDef(EVENT)!.render(factsOf(g));
        const u = await tx.notification.updateMany({
          where: { dedupeKey: r.dedupeKey, kind: EVENT },
          data: { titleAr: t.titleAr.slice(0, 300), titleEn: t.titleEn.slice(0, 300), bodyAr: t.bodyAr.slice(0, 2000), bodyEn: t.bodyEn.slice(0, 2000), link: t.link ?? null, ...(news ? { readAt: null } : {}) },
        });
        return { inserted: r.inserted, updated: Math.max(0, u.count - r.inserted) };
      });
      if (!done) continue;
      res.notified += done.inserted;
      res.updated += done.updated;
    }
    // Resolved since: the watch is cleared silently (the row stays in the bell, as a record).
    const open = await db.notificationWatch.findMany({ where: { key: { startsWith: "green-transfer:" }, NOT: { state: "OK" } } });
    for (const w of open) {
      if (live.has(w.key)) continue;
      res.cleared += (await db.notificationWatch.updateMany({ where: { key: w.key, state: w.state }, data: { state: "OK" } })).count;
    }
  } catch (e) {
    console.error("[green-readiness] check failed:", (e as Error)?.name ?? "error", (e as Error)?.message?.slice(0, 200));
  }
  return res;
}

// ─── The one throttle (council F2): page loads and the supervisor's POST share it, per instance ─────────────────
export const READINESS_MIN_INTERVAL_MS = 5 * 60_000;
type RunResult = Awaited<ReturnType<typeof checkGreenReadiness>>;
let lastRun = 0;
let lastResult: (RunResult & { at: string }) | null = null;

/** Run now unless a run started within the throttle (then the last result, `throttled: true`). `force`: the admin's own. */
export async function runGreenReadiness(opts: { force?: boolean } = {}): Promise<RunResult & { at: string | null; throttled: boolean }> {
  const now = Date.now();
  if (!opts.force && now - lastRun < READINESS_MIN_INTERVAL_MS) {
    return { ...(lastResult ?? { shortages: 0, notified: 0, updated: 0, cleared: 0, at: null }), throttled: true };
  }
  lastRun = now;
  const { prisma } = await import("@/lib/db");
  const r = await checkGreenReadiness(prisma);
  lastResult = { ...r, at: new Date().toISOString() };
  return { ...lastResult, throttled: false };
}

/**
 * On demand (a page load) for someone the alert is for (council F8), after the response, within the one throttle.
 */
export function checkGreenReadinessSoon(user: { permissions: Permissions }): void {
  if (!canReceiveGreenAlert(user)) return;
  if (Date.now() - lastRun < READINESS_MIN_INTERVAL_MS) return;
  const run = async () => { await runGreenReadiness(); };
  try {
    after(run);
  } catch {
    void run();
  }
}
