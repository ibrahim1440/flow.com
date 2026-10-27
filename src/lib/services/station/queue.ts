import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { hasSubPrivilege, type Permissions } from "@/lib/auth-shared";
import { roastQueue } from "@/lib/services/roast-queue";
import { productionProgressMany } from "@/lib/services/production-planning";
import { greenSourceFacts, pickFromFacts } from "@/lib/services/green-source";
import { greenRefusal, sackRange } from "@/lib/green-source";
import { readStationSettings } from "@/lib/services/settings/sections";
import { ROASTING_STATION } from "@/lib/station/shared";
import { assignedRoasterIds } from "@/lib/services/roaster-operators";
import { todaySlotsFor } from "@/lib/services/schedule/schedule-db";
import { claimStates, toClaimView, type ClaimView } from "./claims";

/**
 * GET /api/station/roasting/queue — what the roasting station shows (R1, R5), computed on the
 * server from the ERP's own sources; the station guesses nothing (H12).
 *
 * First, today's slots of the roasting schedule «جدول التحميص» (RM6–RM8) for the station's roaster:
 * the signed-in operator's own (an administrator sees every operator's), with their time and planned
 * green (todaySlotsFor — the schedule's own read; Figma R1 649:258). Starting one claims the coffee
 * and starts the slot in one transaction (station/claims.ts startRoast); the roast recorded from it
 * links the batch to the slot (POST /api/roasting-batches scheduledSlotId).
 *
 * Then the live demand the production screen already computes — no second source of truth:
 *   · one entry per coffee with roasted kilograms still to roast (roastQueue: open order units −
 *     shelf free − pipeline), oldest order first, exactly the production page's «التحميص» cards;
 *   · one entry per live roast-to-stock production order (no order line behind it) with output
 *     still to produce (productionProgressMany, the production-orders screen's numbers).
 *
 * Each entry says whether it can start now, and if not, why (R5): the order is not released for
 * production, the green is short for the roaster's usual charge (J-13), stock roasting is not in
 * the caller's role, or a colleague is working on it.
 */

type Actor = { id: string; name: string; role: string; permissions: Permissions };

export type StationRoaster = {
  id: string; name: string; status: string; statusReason: string | null; isDefault: boolean;
  nominalKg: number; defaultTargetKg: number; minKg: number; maxKg: number; cycleMinutes: number;
  /** The caller is an assigned RoasterOperator of it. */
  assigned: boolean;
};

export type QueueItem = {
  key: string;
  itemType: "RoastCoffee" | "ProductionOrder";
  itemId: string;
  productId: string;
  nameAr: string | null;
  nameEn: string;
  /** Order numbers the roast is attributed to, oldest first (empty for a stock roast). */
  orders: { orderNumber: number; customerName: string }[];
  productionNumber: string | null;
  forStock: boolean;
  /** Roasted kilograms still needed. */
  needKg: number;
  /** The roaster's usual charge (default target), when a roaster is selected. Reference only. */
  plannedGreenKg: number | null;
  expectedLossPct: number;
  /**
   * «اسحب من»: the lot the roast will draw on — the SAME choice the roast POST makes (pickFromFacts at the production
   * site): its label code, the site, and the sacks to open when they are known.
   */
  green: {
    lotId: string; serial: string; nameAr: string | null; nameEn: string; availableKg: number; fallback: boolean;
    code: string | null; siteNameAr: string | null; siteNameEn: string | null; sacks: { from: number; to: number; of: number } | null;
  } | null;
  greenAvailableKg: number;
  /**
   * Why the green is not ready, in both languages (AWAITING_TRANSFER: enough in the company, not at the production site;
   * GREEN_SHORT / NO_GREEN_SOURCE: ask the supervisor). `transferHref` only for a viewer who may move stock.
   */
  greenWait: { ar: string; en: string; transferHref: string | null } | null;
  /** null when it can start; otherwise the reason code (R5). */
  blocked: null | "GREEN_SHORT" | "NO_GREEN_SOURCE" | "AWAITING_TRANSFER" | "WAITING_ORDER" | "STOCK_NOT_ALLOWED" | "CLAIMED";
  claim: ClaimView | null;
  /** A row of today's schedule (key `Slot:<id>`): the slot it starts. Absent on a demand row. */
  slot?: StationSlot | null;
};

/** A slot of today's roasting schedule, as the station shows and starts it. */
export type StationSlot = {
  id: string; roasterId: string; operatorId: string; operatorName: string | null;
  startsAt: string; endsAt: string; status: "PLANNED" | "IN_PROGRESS"; plannedGreenKg: number;
};

export type StationQueue = {
  serverTime: string;
  version: string;
  roasters: StationRoaster[];
  roaster: StationRoaster | null;
  /** Today's slots on the roaster (the caller's own; every operator's for an administrator), by start time. */
  slots: QueueItem[];
  items: QueueItem[];
  /** The caller's active roast; `slot` is the slot it was started from (IN_PROGRESS), if any. */
  mine: (ClaimView & { item: QueueItem | null; slot: StationSlot | null }) | null;
  today: { batches: number; rejected: number; greenKg: number; roastedKg: number };
  /** «تأكيد الكيس بالمسح» (Settings › Production, 20261116090000_station_lot_scan): off → the station shows no scan. */
  lotScan: boolean;
};

const r3 = (n: number) => +n.toFixed(3);

/** Production roasters in service, with whether the caller is an assigned operator (station and ERP sheet). */
export async function stationRoasters(user: { id: string }): Promise<StationRoaster[]> {
  const roasterRows = await prisma.roaster.findMany({
    where: { type: "PRODUCTION", status: { not: "RETIRED" } },
    orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    select: {
      id: true, name: true, status: true, statusReason: true, isDefault: true, nominalCapacityKg: true, defaultTargetKg: true,
      minBatchKg: true, maxBatchKg: true, cycleMinutes: true,
    },
  });
  const mine = await assignedRoasterIds(prisma, user.id);
  return roasterRows.map((r) => ({
    id: r.id, name: r.name, status: r.status, statusReason: r.statusReason, isDefault: r.isDefault,
    nominalKg: Number(r.nominalCapacityKg), defaultTargetKg: Number(r.defaultTargetKg), minKg: Number(r.minBatchKg), maxKg: Number(r.maxBatchKg),
    cycleMinutes: r.cycleMinutes, assigned: mine.has(r.id),
  }));
}

export async function stationQueue(user: Actor, opts: { roasterId?: string | null; fixedRoaster?: boolean } = {}): Promise<StationQueue> {
  // fixedRoaster (a paired station device, W2): the station's own roaster and no other — never a
  // fallback to another roaster when it is missing or retired.
  const all = await stationRoasters(user);
  const roasters = opts.fixedRoaster ? all.filter((r) => r.id === opts.roasterId) : all;
  const roaster = roasters.find((r) => r.id === opts.roasterId) ?? (opts.fixedRoaster ? null : roasters[0] ?? null);
  const plannedGreenKg = roaster ? roaster.defaultTargetKg : null;

  const canStock = hasSubPrivilege(user.permissions, "production", "roast_to_stock");
  const canMove = hasSubPrivilege(user.permissions, "inventory", "receive") || hasSubPrivilege(user.permissions, "inventory", "adjust");
  const [coffees, stockPos, claims] = await Promise.all([
    roastQueue(prisma),
    prisma.productionOrder.findMany({
      where: { status: { in: ["PENDING", "IN_PRODUCTION"] }, sourceOrderItemId: null },
      orderBy: { createdAt: "asc" },
      select: { id: true, productionNumber: true, targetUnits: true, targetWeightKg: true, productSku: { select: { productId: true, product: { select: { productNameEn: true, productNameAr: true, expectedRoastLoss: true } } } } },
    }),
    prisma.workItemClaim.findMany({ where: { stationType: ROASTING_STATION, status: "ACTIVE" } }),
  ]);
  const states = await claimStates(prisma, claims.map((c) => c.id));
  const claimByRef = new Map(claims.map((c) => [c.itemRef, toClaimView(c, states.get(c.id))]));
  const progress = await productionProgressMany(prisma, stockPos);

  // Green for the usual charge, per coffee (the same choice the roast will make).
  const greenFor = async (productId: string, chargeKg: number | null = plannedGreenKg) => {
    const facts = await greenSourceFacts(prisma, { productId });
    const kg = chargeKg ?? 0;
    const pick = pickFromFacts(facts, kg);
    if (pick.ok) {
      const at = pick.site ? pick.lot.siteKg ?? 0 : pick.lot.quantityKg;
      return {
        green: {
          lotId: pick.lot.id, serial: pick.lot.serialNumber, nameAr: pick.lot.beanTypeAr ?? null, nameEn: pick.lot.beanType, availableKg: at, fallback: pick.source === "fifo_fallback",
          code: pick.lot.labelCode ?? null, siteNameAr: pick.site?.nameAr ?? null, siteNameEn: pick.site?.nameEn ?? null, sacks: sackRange(pick.lot, kg),
        },
        availableKg: at, reason: null, wait: null,
      };
    }
    const m = greenRefusal(pick, kg);
    const wait = { ar: m.ar, en: m.en, transferHref: pick.reason === "AT_OTHER_SITE" && canMove ? pick.transferHref : null };
    return { green: null, availableKg: pick.availableKg, reason: pick.reason === "NO_DEFAULT" ? ("NO_GREEN_SOURCE" as const) : pick.reason === "AT_OTHER_SITE" ? ("AWAITING_TRANSFER" as const) : ("GREEN_SHORT" as const), wait };
  };

  const items: QueueItem[] = [];
  for (const c of coffees.filter((x) => x.demandKg > 0)) {
    const ref = `RoastCoffee:${c.productId}`;
    const g = await greenFor(c.productId);
    const claim = claimByRef.get(ref) ?? null;
    const blocked: QueueItem["blocked"] = claim && claim.claimedById !== user.id ? "CLAIMED"
      : !c.allocateTo ? "WAITING_ORDER"
      : g.reason;
    items.push({
      key: ref, itemType: "RoastCoffee", itemId: c.productId, productId: c.productId,
      nameAr: c.productNameAr, nameEn: c.productNameEn,
      orders: c.orders.map((o) => ({ orderNumber: o.orderNumber, customerName: o.customerName })),
      productionNumber: null, forStock: false, needKg: c.demandKg, plannedGreenKg, expectedLossPct: c.expectedRoastLoss,
      green: g.green, greenAvailableKg: r3(g.availableKg), greenWait: g.wait, blocked, claim,
    });
  }
  for (const po of stockPos) {
    const remaining = progress.get(po.id)?.remainingKg ?? 0;
    if (remaining <= 0) continue;
    const ref = `ProductionOrder:${po.id}`;
    const g = await greenFor(po.productSku.productId);
    const claim = claimByRef.get(ref) ?? null;
    const blocked: QueueItem["blocked"] = claim && claim.claimedById !== user.id ? "CLAIMED" : !canStock ? "STOCK_NOT_ALLOWED" : g.reason;
    items.push({
      key: ref, itemType: "ProductionOrder", itemId: po.id, productId: po.productSku.productId,
      nameAr: po.productSku.product.productNameAr, nameEn: po.productSku.product.productNameEn,
      orders: [], productionNumber: po.productionNumber, forStock: true, needKg: remaining, plannedGreenKg,
      expectedLossPct: po.productSku.product.expectedRoastLoss, green: g.green, greenAvailableKg: r3(g.availableKg), greenWait: g.wait, blocked, claim,
    });
  }
  // Startable first (in the queue's own order), then the blocked ones.
  items.sort((a, b) => Number(!!a.blocked) - Number(!!b.blocked));

  // ── Today's slots (the schedule), before the demand ─────────────────────────────────────────
  const isAdmin = user.role === "admin";
  const slotRows = roaster ? await todaySlotsFor(prisma, { roasterId: roaster.id, operatorId: isAdmin ? undefined : user.id }) : [];
  const slotProducts = new Map((await prisma.coffeeProduct.findMany({
    where: { id: { in: [...new Set(slotRows.map((s) => s.productId))] } }, select: { id: true, expectedRoastLoss: true },
  })).map((p) => [p.id, p.expectedRoastLoss]));
  // The slot the caller's active roast was started from: their slot (or one they started) of this
  // coffee, still IN_PROGRESS with no batch yet.
  const mineClaim = claims.find((c) => c.claimedById === user.id) ?? null;
  const mineProductId = mineClaim
    ? mineClaim.itemType === "RoastCoffee" ? mineClaim.itemId
      : (await prisma.productionOrder.findUnique({ where: { id: mineClaim.itemId }, select: { productSku: { select: { productId: true } } } }))?.productSku.productId ?? null
    : null;
  const mineSlotRow = mineProductId
    ? await prisma.scheduledSlot.findFirst({
        where: { status: "IN_PROGRESS", productId: mineProductId, batch: null, OR: [{ startedById: user.id }, { operatorId: user.id }], startsAt: { gte: new Date(Date.now() - 86_400_000) } },
        orderBy: { startedAt: "desc" },
        select: { id: true, roasterId: true, operatorId: true, startsAt: true, endsAt: true, plannedGreenKg: true },
      })
    : null;
  const slots: QueueItem[] = [];
  for (const s of slotRows) {
    if (s.id === mineSlotRow?.id) continue; // shown as the caller's active roast
    const demand = items.find((i) => i.itemType === "RoastCoffee" && i.productId === s.productId) ?? null;
    const plannedKg = Number(s.plannedGreenKg);
    const g = await greenFor(s.productId, plannedKg);
    const ref = `RoastCoffee:${s.productId}`;
    const claim = claimByRef.get(ref) ?? null;
    const forStock = !demand;
    const blocked: QueueItem["blocked"] = claim && claim.claimedById !== user.id ? "CLAIMED"
      : demand?.blocked === "WAITING_ORDER" ? "WAITING_ORDER"
      : forStock && !canStock ? "STOCK_NOT_ALLOWED"
      : g.reason;
    slots.push({
      key: `Slot:${s.id}`, itemType: "RoastCoffee", itemId: s.productId, productId: s.productId,
      nameAr: s.product.ar, nameEn: s.product.en, orders: demand?.orders ?? [], productionNumber: null, forStock,
      needKg: demand?.needKg ?? 0, plannedGreenKg: plannedKg, expectedLossPct: demand?.expectedLossPct ?? slotProducts.get(s.productId) ?? 15,
      green: g.green, greenAvailableKg: r3(g.availableKg), greenWait: g.wait, blocked, claim,
      slot: { id: s.id, roasterId: s.roasterId, operatorId: s.operatorId, operatorName: s.operatorName, startsAt: s.startsAt, endsAt: s.endsAt, status: s.status as StationSlot["status"], plannedGreenKg: plannedKg },
    });
  }

  const mineView = mineClaim ? toClaimView(mineClaim, states.get(mineClaim.id)) : null;
  // Somebody's own claim on work that left the queue (covered meanwhile) is still shown to them.
  let mineItem = mineClaim ? items.find((i) => i.key === mineClaim.itemRef) ?? null : null;
  if (mineClaim && !mineItem) {
    // The work was covered meanwhile (another batch, a cancelled order): describe it from its product.
    const productId = mineClaim.itemType === "RoastCoffee"
      ? mineClaim.itemId
      : (await prisma.productionOrder.findUnique({ where: { id: mineClaim.itemId }, select: { productSku: { select: { productId: true } } } }))?.productSku.productId ?? null;
    const p = productId ? await prisma.coffeeProduct.findUnique({ where: { id: productId }, select: { id: true, productNameEn: true, productNameAr: true, expectedRoastLoss: true } }) : null;
    if (p) {
      const g = await greenFor(p.id);
      mineItem = {
        key: mineClaim.itemRef, itemType: mineClaim.itemType as QueueItem["itemType"], itemId: mineClaim.itemId, productId: p.id,
        nameAr: p.productNameAr, nameEn: p.productNameEn, orders: [], productionNumber: null, forStock: mineClaim.itemType === "ProductionOrder",
        needKg: 0, plannedGreenKg, expectedLossPct: p.expectedRoastLoss, green: g.green, greenAvailableKg: r3(g.availableKg), greenWait: g.wait, blocked: null, claim: mineView,
      };
    }
  }
  const mineSlot: StationSlot | null = mineSlotRow
    ? { id: mineSlotRow.id, roasterId: mineSlotRow.roasterId, operatorId: mineSlotRow.operatorId, operatorName: user.name, startsAt: mineSlotRow.startsAt.toISOString(), endsAt: mineSlotRow.endsAt.toISOString(), status: "IN_PROGRESS", plannedGreenKg: Number(mineSlotRow.plannedGreenKg) }
    : null;
  // Started from a slot: the active roast's planned green is the slot's (R4 pre-fills it).
  if (mineItem && mineSlot) mineItem = { ...mineItem, plannedGreenKg: mineSlot.plannedGreenKg, slot: mineSlot };
  const mine = mineView ? { ...mineView, item: mineItem, slot: mineSlot } : null;

  // «المحمصة اليوم»: today's batches on the server's calendar day (the production page's own rule).
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const todays = await prisma.roastingBatch.findMany({
    where: { createdAt: { gte: start }, isBlend: false, ...(roaster ? { OR: [{ roasterId: roaster.id }, { roasterId: null }] } : {}) },
    select: { status: true, greenBeanQuantity: true, roastedBeanQuantity: true },
  });
  const today = {
    batches: todays.length,
    rejected: todays.filter((b) => b.status === "Rejected").length,
    greenKg: r3(todays.reduce((s, b) => s + b.greenBeanQuantity, 0)),
    roastedKg: r3(todays.reduce((s, b) => s + b.roastedBeanQuantity, 0)),
  };

  const lotScan = (await readStationSettings(prisma)).lotScanRequired;
  const body = { roasters, roaster, slots, items, mine, today, lotScan };
  const version = createHash("sha1").update(JSON.stringify(body)).digest("hex").slice(0, 16);
  return { serverTime: new Date().toISOString(), version, ...body };
}
