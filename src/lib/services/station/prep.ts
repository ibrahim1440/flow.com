// Workstations W4 — «تجهيز الطلبات», the preparation tab of the packaging station (Figma P1–P7).
//
// What it prepares: order lines of whole units (SKU lines) whose units are RESERVED on finished-goods
// lots — the preparation review and packaging already decided that (StockAllocation, the single
// source). The station never reserves, never moves stock and never delivers:
//
//   start     P1 «بدء تجهيز #…»: a WorkItemClaim on the order (stationType PACKAGING, itemType Order),
//             so two people never prepare one order. Coordination only.
//   match     P2/P3 (W1): the typed lot number against the lot numbers reserved for THIS line — last
//             four characters only when unique, otherwise the full number; wrong lots are refused.
//   pick      P2 «تأكيد … وحدات من اللوت»: the counted units, re-matched and re-checked under the line's
//             lock, recorded as PreparationPick rows (PICKED). No stock moves.
//   decision  P7 «حفظ الجزء المنجز»: keep the rest for me (the claim gets an expiry) or release it.
//   handoff   P4 → P6 «تسليم للشحن» (J-18): the order — or some of its lines — handed to dispatch: a
//             DispatchHandoff with its lines, staging note and parcels; the picks become HANDED_OFF.
//             Idempotent by its key, partial per line. The ERP dispatch page then shows the order as
//             handed off and records the delivery (POST /api/deliveries settles the picks).
//
// Every write carries the caller's Idempotency-Key, kept in WorkstationActionLog (unique): a retry
// answers with the first result. Order status wins over everything (src/lib/order-stage.ts): an
// order «معلّق مؤقتاً» is listed as blocked and nothing can be prepared or handed off.
// Customers appear by name and order number only (owner policy F4), never their contact record.
import { createHash } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { prisma, TX_OPTS } from "@/lib/db";
import { CUSTOMER_DELIVERY_SELECT } from "@/lib/auth/customer-detail";
import { DELIVERY_ALLOWED_STATUSES, appendOrderActivity } from "@/lib/services/order-operations";
import { matchLot, normalizeLotEntry, splitPick, LOT_SUFFIX_LENGTH } from "@/lib/station/lot-match";
import { claimLive, prepState, type PrepOrderState, type PrepTotals } from "@/lib/station/prep-rules";

export { claimLive, prepState };
export type { PrepOrderState };

type Db = Prisma.TransactionClient | typeof prisma;
type Actor = { id: string; name: string; role: string };

export const PREP_STATION = "PACKAGING";
export const PREP_ITEM = "Order";
/** «إبقاء المتبقي محجوزًا لي» (P7): how long the rest stays with the person (provisional, 2 h). */
export const PREP_KEEP_MS = 2 * 60 * 60 * 1000;
const OPEN_PICK = ["PICKED", "HANDED_OFF"];
const STAGING_MAX = 120;

const AR = (ar: string, en: string, status: number, code: string, extra: Record<string, unknown> = {}) => ({ _appCode: status, message: ar, errorEn: en, code, ...extra });

// ── Reading ─────────────────────────────────────────────────────────────────────────────────────

export type PrepLot = {
  batchNumber: string;
  lotIds: string[];
  /** Units of this lot number reserved for the line. */
  reserved: number;
  /** Units of it already picked for the line and not delivered yet. */
  picked: number;
  /** Still to be counted from it: reserved − picked. */
  pickable: number;
  verifiedAt: string | null;
};
export type PrepLine = {
  id: string; nameEn: string; nameAr: string | null; skuCode: string | null; weightGrams: number | null;
  ordered: number; delivered: number; outstanding: number;
  /** Verified at the station, not handed off yet. */
  picked: number;
  /** Handed to dispatch, not delivered yet. */
  handedOff: number;
  prepared: number;
  /** Still to prepare: outstanding − prepared. */
  remaining: number;
  reserved: number;
  /** Of `remaining`, what the reserved lots cover now. */
  readyToPick: number;
  /** Of `remaining`, what is not reserved yet («بانتظار الإنتاج»). */
  waiting: number;
  blocked: boolean;
  lots: PrepLot[];
};
export type PrepClaim = { id: string; byId: string; byName: string; at: string; expiresAt: string | null };
export type PrepOrder = {
  id: string; orderNumber: number; status: string; createdAt: string;
  customer: { name: string; nameAr: string | null };
  state: PrepOrderState;
  lines: PrepLine[];
  /** Kilogram (legacy) lines are not prepared at the station; they stay in the ERP. */
  legacyLines: number;
  totals: PrepTotals;
  claim: PrepClaim | null;
  lastHandoff: { at: string; byName: string; stagingNote: string | null; packages: number | null; units: number } | null;
};

const ORDER_SELECT = {
  id: true, orderNumber: true, status: true, createdAt: true,
  customer: { select: CUSTOMER_DELIVERY_SELECT },
  items: {
    orderBy: { id: "asc" as const },
    select: {
      id: true, beanTypeName: true, quantityUnits: true, deliveredUnits: true, deliveryStatus: true, preparationDecision: true,
      product: { select: { productNameEn: true, productNameAr: true } },
      productSku: { select: { id: true, skuCode: true, name: true, nameAr: true, weightGrams: true } },
    },
  },
} satisfies Prisma.OrderSelect;
type OrderRow = Prisma.OrderGetPayload<{ select: typeof ORDER_SELECT }>;

async function buildOrders(db: Db, orders: OrderRow[]): Promise<PrepOrder[]> {
  const unitItems = orders.flatMap((o) => o.items).filter((i) => i.quantityUnits !== null && i.productSku);
  const itemIds = unitItems.map((i) => i.id);
  const [allocs, picks, claims, handoffs] = await Promise.all([
    itemIds.length ? db.stockAllocation.findMany({
      where: { orderItemId: { in: itemIds }, status: "RESERVED", quantityUnits: { not: null }, finishedGoodsLot: { isUnitTracked: true, status: "AVAILABLE" } },
      select: { orderItemId: true, quantityUnits: true, finishedGoodsLot: { select: { id: true, batchNumber: true, createdAt: true } } },
    }) : [],
    itemIds.length ? db.preparationPick.findMany({
      where: { orderItemId: { in: itemIds }, status: { in: OPEN_PICK } },
      select: { orderItemId: true, finishedGoodsLotId: true, batchNumber: true, units: true, status: true, createdAt: true },
    }) : [],
    orders.length ? db.workItemClaim.findMany({ where: { stationType: PREP_STATION, itemType: PREP_ITEM, itemId: { in: orders.map((o) => o.id) }, status: "ACTIVE" } }) : [],
    orders.length ? db.dispatchHandoff.findMany({ where: { orderId: { in: orders.map((o) => o.id) } }, orderBy: { createdAt: "desc" }, select: { orderId: true, createdAt: true, preparedByName: true, stagingNote: true, packages: true, units: true } }) : [],
  ]);
  const now = Date.now();
  const out: PrepOrder[] = [];
  for (const o of orders) {
    const lines: PrepLine[] = [];
    let legacy = 0;
    for (const i of o.items) {
      if (i.quantityUnits === null || !i.productSku) { if (i.deliveryStatus !== "Delivered") legacy++; continue; }
      const outstanding = Math.max(0, i.quantityUnits - i.deliveredUnits);
      const mine = picks.filter((p) => p.orderItemId === i.id);
      const picked = mine.filter((p) => p.status === "PICKED").reduce((s, p) => s + p.units, 0);
      const handedOff = mine.filter((p) => p.status === "HANDED_OFF").reduce((s, p) => s + p.units, 0);
      const byNumber = new Map<string, PrepLot & { firstAt: number }>();
      for (const a of allocs.filter((x) => x.orderItemId === i.id)) {
        const lot = a.finishedGoodsLot;
        const g = byNumber.get(lot.batchNumber) ?? { batchNumber: lot.batchNumber, lotIds: [], reserved: 0, picked: 0, pickable: 0, verifiedAt: null, firstAt: lot.createdAt.getTime() };
        if (!g.lotIds.includes(lot.id)) g.lotIds.push(lot.id);
        g.reserved += a.quantityUnits ?? 0;
        g.firstAt = Math.min(g.firstAt, lot.createdAt.getTime());
        byNumber.set(lot.batchNumber, g);
      }
      for (const p of mine) {
        const g = byNumber.get(p.batchNumber);
        if (!g) continue;
        g.picked += p.units;
        const at = p.createdAt.toISOString();
        if (!g.verifiedAt || at > g.verifiedAt) g.verifiedAt = at;
      }
      const lots = [...byNumber.values()].sort((a, b) => a.firstAt - b.firstAt || a.batchNumber.localeCompare(b.batchNumber))
        .map((g) => ({ batchNumber: g.batchNumber, lotIds: g.lotIds, reserved: g.reserved, picked: g.picked, verifiedAt: g.verifiedAt, pickable: Math.max(0, g.reserved - g.picked) }));
      const prepared = Math.min(outstanding, picked + handedOff);
      const remaining = Math.max(0, outstanding - prepared);
      const reserved = lots.reduce((s, l) => s + l.reserved, 0);
      const blocked = i.preparationDecision === "Blocked";
      const readyToPick = blocked ? 0 : Math.min(remaining, lots.reduce((s, l) => s + l.pickable, 0));
      if (outstanding === 0 && prepared === 0) continue;
      lines.push({
        id: i.id, nameEn: i.productSku.name || i.product?.productNameEn || i.beanTypeName, nameAr: i.productSku.nameAr || i.product?.productNameAr || null,
        skuCode: i.productSku.skuCode, weightGrams: Math.round(i.productSku.weightGrams),
        ordered: i.quantityUnits, delivered: i.deliveredUnits, outstanding, picked, handedOff, prepared, remaining, reserved, readyToPick,
        waiting: Math.max(0, remaining - readyToPick), blocked, lots,
      });
    }
    if (lines.length === 0) continue;
    const sum = (k: keyof PrepLine) => lines.reduce((s, l) => s + (l[k] as number), 0);
    const totals = { outstanding: sum("outstanding"), prepared: sum("prepared"), picked: sum("picked"), handedOff: sum("handedOff"), remaining: sum("remaining"), readyToPick: sum("readyToPick"), waiting: sum("waiting") };
    const c = claims.find((x) => x.itemId === o.id && claimLive(x, now)) ?? null;
    const h = handoffs.find((x) => x.orderId === o.id) ?? null;
    out.push({
      id: o.id, orderNumber: o.orderNumber, status: o.status, createdAt: o.createdAt.toISOString(),
      customer: { name: o.customer.name, nameAr: o.customer.nameAr },
      state: prepState(o.status, totals, !!c), lines, legacyLines: legacy, totals,
      claim: c ? { id: c.id, byId: c.claimedById, byName: c.claimedByName, at: c.claimedAt.toISOString(), expiresAt: c.expiresAt?.toISOString() ?? null } : null,
      lastHandoff: h ? { at: h.createdAt.toISOString(), byName: h.preparedByName, stagingNote: h.stagingNote, packages: h.packages, units: h.units } : null,
    });
  }
  return out;
}

export type PrepQueue = {
  /** Actionable or in progress (P1), oldest order first (J-14). */
  orders: PrepOrder[];
  /** P5: orders on hold — the status wins (src/lib/order-stage.ts). */
  blocked: PrepOrder[];
  /** Handed to dispatch, waiting for the delivery (P6 summary). */
  handed: PrepOrder[];
  /** The caller's own claimed order (S5 handover reads it). */
  mine: { orderId: string; orderNumber: number; claimId: string; claimedAt: string } | null;
  serverTime: string;
  version: string;
};

/** P1 / P5: the preparation queue. */
export async function prepQueue(user: { id: string }): Promise<PrepQueue> {
  const rows = await prisma.order.findMany({
    where: { status: { in: [...DELIVERY_ALLOWED_STATUSES, "On Hold"] }, items: { some: { quantityUnits: { not: null }, deliveryStatus: { not: "Delivered" } } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 200,
    select: ORDER_SELECT,
  });
  const all = await buildOrders(prisma, rows);
  const orders = all.filter((o) => o.state !== "hold" && o.state !== "handed" && (o.state !== "waiting" || o.claim));
  const blocked = all.filter((o) => o.state === "hold");
  const handed = all.filter((o) => o.state === "handed");
  // Orders being prepared first, then the ones ready, prepared awaiting the handoff, the partial ones last.
  const rank: Record<PrepOrderState, number> = { preparing: 0, prepared: 1, ready: 2, partial: 3, waiting: 4, hold: 5, handed: 6 };
  orders.sort((a, b) => rank[a.state] - rank[b.state] || a.createdAt.localeCompare(b.createdAt));
  const mineOrder = all.find((o) => o.claim?.byId === user.id) ?? null;
  const version = createHash("sha256").update(JSON.stringify([orders, blocked, handed.map((h) => [h.id, h.lastHandoff?.at])])).digest("hex").slice(0, 16);
  return {
    orders, blocked, handed,
    mine: mineOrder?.claim ? { orderId: mineOrder.id, orderNumber: mineOrder.orderNumber, claimId: mineOrder.claim.id, claimedAt: mineOrder.claim.at } : null,
    serverTime: new Date().toISOString(), version,
  };
}

/** One order at the station (P2–P4, P6, P7). */
export async function prepOrder(orderId: string, db: Db = prisma): Promise<PrepOrder | null> {
  const row = await db.order.findUnique({ where: { id: orderId }, select: ORDER_SELECT });
  if (!row) return null;
  const [o] = await buildOrders(db, [row]);
  return o ?? null;
}

// ── Lot match (W1) ──────────────────────────────────────────────────────────────────────────────

export type MatchAnswer =
  | { kind: "unique"; batchNumber: string; by: "suffix" | "full"; orderItemId: string; nameEn: string; nameAr: string | null; skuCode: string | null; weightGrams: number | null; pickable: number; lineRemaining: number }
  | { kind: "ambiguous"; candidates: string[]; fullLength: number | null }
  | { kind: "wrong"; other: string | null; reason: "NOT_RESERVED" | "OTHER_SKU" | "NONE" }
  | { kind: "too_short"; length: number };

async function lineForMatch(db: Db, orderItemId: string) {
  const item = await db.orderItem.findUnique({ where: { id: orderItemId }, select: { id: true, orderId: true, productSkuId: true } });
  if (!item) throw AR("البند غير موجود.", "Order line not found.", 404, "LINE_NOT_FOUND");
  const o = await prepOrder(item.orderId, db);
  const line = o?.lines.find((l) => l.id === orderItemId) ?? null;
  if (!o || !line) throw AR("هذا البند لا يُجهَّز من المحطة.", "This line is not prepared at the station.", 409, "LINE_NOT_PREPARABLE");
  return { o, line, skuId: item.productSkuId };
}

/** The entry against THIS line's reserved lot numbers (still to be counted from). Read only. */
export async function matchForLine(orderItemId: string, entry: unknown, db: Db = prisma): Promise<MatchAnswer> {
  const { line, skuId } = await lineForMatch(db, orderItemId);
  const candidates = line.lots.filter((l) => l.pickable > 0);
  const m = matchLot(entry, candidates);
  if (m.kind === "too_short") return { kind: "too_short", length: LOT_SUFFIX_LENGTH };
  if (m.kind === "ambiguous") return { kind: "ambiguous", candidates: m.candidates, fullLength: m.fullLength };
  if (m.kind === "unique") {
    const lot = candidates.find((l) => l.batchNumber === m.batchNumber)!;
    return { kind: "unique", batchNumber: m.batchNumber, by: m.by, orderItemId, nameEn: line.nameEn, nameAr: line.nameAr, skuCode: line.skuCode, weightGrams: line.weightGrams, pickable: Math.min(lot.pickable, line.remaining), lineRemaining: line.remaining };
  }
  // Wrong lot: name the lot the box belongs to when the entry points at exactly one number.
  const e = normalizeLotEntry(entry);
  const found = await db.finishedGoodsLot.findMany({
    where: { batchNumber: { endsWith: e.slice(-LOT_SUFFIX_LENGTH), mode: "insensitive" } },
    select: { batchNumber: true, productSkuId: true }, take: 50,
  });
  const others = found.filter((x) => (e.length === LOT_SUFFIX_LENGTH ? normalizeLotEntry(x.batchNumber).endsWith(e) : normalizeLotEntry(x.batchNumber) === e));
  const numbers = [...new Set(others.map((x) => x.batchNumber))];
  if (numbers.length !== 1) return { kind: "wrong", other: null, reason: "NONE" };
  const sameSku = others.some((x) => x.productSkuId === skuId);
  return { kind: "wrong", other: numbers[0], reason: sameSku ? "NOT_RESERVED" : "OTHER_SKU" };
}

// ── Writes ──────────────────────────────────────────────────────────────────────────────────────

async function replayByKey(db: Db, key: string, user: Actor) {
  const row = await db.workstationActionLog.findUnique({ where: { idempotencyKey: key } });
  if (!row) return null;
  if (row.employeeId !== user.id) throw AR("مفتاح التكرار مستخدم لعملية أخرى.", "This Idempotency-Key belongs to another action.", 422, "IDEMPOTENCY_MISMATCH");
  return row;
}

async function log(db: Db, a: { itemType: string; itemId: string; action: string; fromState?: string | null; toState?: string | null; user: Actor; key: string; reason?: string | null }) {
  return db.workstationActionLog.create({
    data: {
      stationType: PREP_STATION, itemType: a.itemType, itemId: a.itemId, action: a.action, fromState: a.fromState ?? null, toState: a.toState ?? null,
      employeeId: a.user.id, employeeName: a.user.name, idempotencyKey: a.key, status: "SUCCESS", reason: a.reason?.slice(0, 500) ?? null, sourceInterface: "STATION",
    },
  });
}

function assertPreparable(o: PrepOrder) {
  if (o.state === "hold") throw AR(`الطلب #${o.orderNumber} معلّق مؤقتاً. لا يُجهَّز حتى يُستأنف.`, `Order #${o.orderNumber} is on hold. It is not prepared until it is resumed.`, 409, "ORDER_ON_HOLD");
  if (!(DELIVERY_ALLOWED_STATUSES as string[]).includes(o.status)) throw AR("هذا الطلب لا يُجهَّز الآن.", "This order cannot be prepared now.", 409, "ORDER_NOT_PREPARABLE");
}

/** The caller's live claim on the order, taking it when nobody holds one (or it expired). */
async function ensureClaim(tx: Prisma.TransactionClient, o: PrepOrder, user: Actor, key: string) {
  const ref = `${PREP_ITEM}:${o.id}`;
  const cur = await tx.workItemClaim.findUnique({ where: { activeItemRef: ref } });
  if (cur && claimLive(cur)) {
    if (cur.claimedById !== user.id) throw AR(`يجهّز هذا الطلب ${cur.claimedByName} الآن.`, `${cur.claimedByName} is preparing this order now.`, 409, "CLAIM_TAKEN", { claimedBy: cur.claimedByName });
    if (cur.expiresAt) await tx.workItemClaim.update({ where: { id: cur.id }, data: { expiresAt: null } });
    return { claim: cur, created: false };
  }
  if (cur) await tx.workItemClaim.update({ where: { id: cur.id }, data: { status: "EXPIRED", activeItemRef: null, releasedAt: new Date() } });
  const claim = await tx.workItemClaim.create({
    data: { stationType: PREP_STATION, itemType: PREP_ITEM, itemId: o.id, itemRef: ref, activeItemRef: ref, claimedById: user.id, claimedByName: user.name, status: "ACTIVE" },
  });
  await log(tx, { itemType: "WorkItemClaim", itemId: claim.id, action: "CLAIM", fromState: "QUEUED", toState: "PREPARING", user, key: `${key}:claim`, reason: `order #${o.orderNumber}` });
  return { claim, created: true };
}

/** P1 «بدء تجهيز»: claim the order for the caller. Moves nothing. */
export async function startPrep(args: { user: Actor; orderId: string; key: string }) {
  const { user, orderId, key } = args;
  return prisma.$transaction(async (tx) => {
    const replay = await replayByKey(tx, key, user);
    if (replay) return { order: await prepOrder(orderId, tx), replayed: true };
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
    const o = await prepOrder(orderId, tx);
    if (!o) throw AR("الطلب غير موجود أو لا بنود فيه للتجهيز.", "Order not found, or nothing in it to prepare.", 404, "ORDER_NOT_FOUND");
    assertPreparable(o);
    if (o.state === "partial" || o.state === "waiting") throw AR("الطلب غير متاح للتجهيز: الباقي بانتظار الإنتاج.", "The order is not available to prepare: the rest is waiting for production.", 409, "ORDER_NOT_READY");
    const c = await ensureClaim(tx, o, user, key);
    await log(tx, { itemType: PREP_ITEM, itemId: o.id, action: "ADVANCE:START", fromState: o.state.toUpperCase(), toState: "PREPARING", user, key, reason: `claim ${c.claim.id}` });
    return { order: await prepOrder(orderId, tx), replayed: false };
  }, TX_OPTS);
}

/** P2 «تأكيد N وحدات من اللوت»: re-match under the line's lock and record the counted units. */
export async function recordPick(args: { user: Actor; orderItemId: string; entry: unknown; units: unknown; key: string; stationId: string | null }) {
  const { user, orderItemId, key } = args;
  const units = typeof args.units === "number" ? args.units : Number(args.units);
  if (!Number.isInteger(units) || units <= 0 || units > 100000) throw AR("أدخل عدد الوحدات التي عددتها.", "Enter the number of units you counted.", 400, "UNITS_REQUIRED");
  return prisma.$transaction(async (tx) => {
    const replay = await replayByKey(tx, key, user);
    if (replay) {
      const picks = await tx.preparationPick.findMany({ where: { requestKey: key }, select: { batchNumber: true, units: true, finishedGoodsLotId: true } });
      return { replayed: true, batchNumber: picks[0]?.batchNumber ?? null, units: picks.reduce((s, p) => s + p.units, 0), at: replay.createdAt.toISOString() };
    }
    // One pick at a time per line: the OrderItem row (POST /api/deliveries takes it too).
    const locked = await tx.$queryRaw<{ id: string; orderId: string }[]>`SELECT id, "orderId" FROM "OrderItem" WHERE id = ${orderItemId} FOR UPDATE`;
    if (!locked[0]) throw AR("البند غير موجود.", "Order line not found.", 404, "LINE_NOT_FOUND");
    const o = await prepOrder(locked[0].orderId, tx);
    const line = o?.lines.find((l) => l.id === orderItemId) ?? null;
    if (!o || !line) throw AR("هذا البند لا يُجهَّز من المحطة.", "This line is not prepared at the station.", 409, "LINE_NOT_PREPARABLE");
    assertPreparable(o);
    if (line.blocked) throw AR("هذا البند موقوف. لا يُجهَّز من المحطة.", "This line is blocked. It is not prepared at the station.", 409, "LINE_BLOCKED");
    const candidates = line.lots.filter((l) => l.pickable > 0);
    const m = matchLot(args.entry, candidates);
    if (m.kind === "ambiguous") throw AR("آخر 4 أرقام تطابق أكثر من لوت محجوز لهذا البند. أدخل رقم اللوت كاملًا.", "The last four digits match more than one lot reserved for this line. Enter the full lot number.", 409, "LOT_AMBIGUOUS", { candidates: m.candidates });
    if (m.kind !== "unique") throw AR("لوت غير مطابق: ليس محجوزًا لهذا البند. لم يُسجَّل شيء.", "Wrong lot: it is not reserved for this line. Nothing was recorded.", 409, "LOT_NOT_RESERVED");
    const lot = candidates.find((l) => l.batchNumber === m.batchNumber)!;
    if (units > line.remaining) throw AR(`المتبقي لهذا البند ${line.remaining} وحدة فقط.`, `Only ${line.remaining} unit(s) remain on this line.`, 409, "UNITS_OVER_LINE", { remaining: line.remaining });
    if (units > lot.pickable) throw AR(`المحجوز من اللوت ${lot.batchNumber} لهذا البند ${lot.pickable} وحدة فقط.`, `Only ${lot.pickable} unit(s) of lot ${lot.batchNumber} are reserved for this line.`, 409, "UNITS_OVER_LOT", { pickable: lot.pickable });
    await ensureClaim(tx, o, user, key);
    // Per lot of that number, what the line still holds on it (reserved − picked), oldest lot first.
    const perLot = await Promise.all(lot.lotIds.map(async (lotId) => {
      const [r, p] = await Promise.all([
        tx.stockAllocation.aggregate({ where: { orderItemId, finishedGoodsLotId: lotId, status: "RESERVED", quantityUnits: { not: null } }, _sum: { quantityUnits: true } }),
        tx.preparationPick.aggregate({ where: { orderItemId, finishedGoodsLotId: lotId, status: { in: OPEN_PICK } }, _sum: { units: true } }),
      ]);
      return { lotId, pickable: (r._sum.quantityUnits ?? 0) - (p._sum.units ?? 0) };
    }));
    const split = splitPick(perLot, units);
    if (!split) throw AR("تغيّر الحجز أثناء التجهيز. حدّث الشاشة.", "The reservation changed while preparing. Refresh the screen.", 409, "RESERVATION_CHANGED");
    await tx.preparationPick.createMany({
      data: split.map((s) => ({
        orderId: o.id, orderItemId, finishedGoodsLotId: s.lotId, batchNumber: lot.batchNumber, units: s.units, status: "PICKED",
        requestKey: key, pickedById: user.id, pickedByName: user.name, stationId: args.stationId,
      })),
    });
    const row = await log(tx, { itemType: "OrderItem", itemId: orderItemId, action: "ADVANCE:PICK", fromState: "RESERVED", toState: "PICKED", user, key, reason: `order #${o.orderNumber} · lot ${lot.batchNumber} · ${units} unit(s) · by ${m.by}` });
    return { replayed: false, batchNumber: lot.batchNumber, units, at: row.createdAt.toISOString() };
  }, TX_OPTS);
}

/** P7 «حفظ الجزء المنجز»: keep the rest for me (until the expiry) or release it to a colleague. */
export async function claimDecision(args: { user: Actor; orderId: string; decision: unknown; key: string }) {
  const { user, orderId, key } = args;
  const decision = args.decision === "keep" || args.decision === "release" ? args.decision : null;
  if (!decision) throw AR("اختر: إبقاء المتبقي لك أو تحريره لزميل.", "Choose: keep the rest for you, or release it to a colleague.", 400, "DECISION_REQUIRED");
  return prisma.$transaction(async (tx) => {
    const replay = await replayByKey(tx, key, user);
    if (replay) return { replayed: true, decision, expiresAt: null as string | null };
    const c = await tx.workItemClaim.findUnique({ where: { activeItemRef: `${PREP_ITEM}:${orderId}` } });
    if (!c || !claimLive(c)) throw AR("هذا الطلب لم يعد محجوزًا لك. عد إلى الطابور.", "This order is no longer claimed by you. Go back to the queue.", 409, "CLAIM_NOT_ACTIVE");
    if (c.claimedById !== user.id) throw AR("هذا الطلب محجوز لموظف آخر.", "This order is claimed by somebody else.", 403, "NOT_YOUR_CLAIM");
    if (decision === "release") {
      await tx.workItemClaim.update({ where: { id: c.id }, data: { status: "RELEASED", activeItemRef: null, releasedAt: new Date(), releasedById: user.id, releasedByName: user.name } });
      await log(tx, { itemType: "WorkItemClaim", itemId: c.id, action: "RELEASE", fromState: "PREPARING", toState: "QUEUED", user, key, reason: "partial: the rest released to a colleague" });
      return { replayed: false, decision, expiresAt: null };
    }
    const expiresAt = new Date(Date.now() + PREP_KEEP_MS);
    await tx.workItemClaim.update({ where: { id: c.id }, data: { expiresAt } });
    await log(tx, { itemType: "WorkItemClaim", itemId: c.id, action: "FLAG", fromState: "PREPARING", toState: "PARTIAL_KEPT", user, key, reason: `partial: kept until ${expiresAt.toISOString()}` });
    return { replayed: false, decision, expiresAt: expiresAt.toISOString() };
  }, TX_OPTS);
}

export type HandoffView = {
  id: string; orderId: string; orderNumber: number; units: number; partial: boolean; stagingNote: string | null; packages: number | null;
  preparedByName: string; createdAt: string; lines: { orderItemId: string; units: number; lots: { batchNumber: string; units: number; lotIds: string[] }[] }[];
};

async function handoffView(db: Db, id: string): Promise<HandoffView> {
  const h = await db.dispatchHandoff.findUniqueOrThrow({ where: { id }, include: { lines: true, order: { select: { orderNumber: true } } } });
  return {
    id: h.id, orderId: h.orderId, orderNumber: h.order.orderNumber, units: h.units, partial: h.partial, stagingNote: h.stagingNote, packages: h.packages,
    preparedByName: h.preparedByName, createdAt: h.createdAt.toISOString(),
    lines: h.lines.map((l) => ({ orderItemId: l.orderItemId, units: l.units, lots: (l.lots as { batchNumber: string; units: number; lotIds: string[] }[]) ?? [] })),
  };
}

/**
 * P4 → P6 «تسليم للشحن» (J-18): hand the verified units of the order (all its lines, or the lines
 * named) to dispatch. Idempotent by the key (DispatchHandoff.requestKey); per line and partial; moves
 * no stock and delivers nothing. Dispatch-module holders are notified; the order's timeline says so.
 */
export async function handOff(args: { user: Actor; orderId: string; orderItemIds: unknown; stagingNote: unknown; packages: unknown; key: string; stationId: string | null }) {
  const { user, orderId, key } = args;
  const note = typeof args.stagingNote === "string" ? args.stagingNote.trim().replace(/\s+/g, " ").slice(0, STAGING_MAX) : "";
  const packages = args.packages === null || args.packages === undefined || args.packages === "" ? null : Number(args.packages);
  if (packages !== null && (!Number.isInteger(packages) || packages < 0 || packages > 999)) throw AR("عدد الطرود غير صالح.", "The parcel count is not valid.", 400, "PACKAGES_INVALID");
  const only = Array.isArray(args.orderItemIds) ? args.orderItemIds.filter((x): x is string => typeof x === "string" && !!x) : null;
  return prisma.$transaction(async (tx) => {
    const existing = await tx.dispatchHandoff.findUnique({ where: { requestKey: key }, select: { id: true, preparedById: true } });
    if (existing) {
      if (existing.preparedById !== user.id) throw AR("مفتاح التكرار مستخدم لعملية أخرى.", "This Idempotency-Key belongs to another action.", 422, "IDEMPOTENCY_MISMATCH");
      return { handoff: await handoffView(tx, existing.id), replayed: true };
    }
    const items = await tx.orderItem.findMany({ where: { orderId }, select: { id: true }, orderBy: { id: "asc" } });
    if (items.length === 0) throw AR("الطلب غير موجود.", "Order not found.", 404, "ORDER_NOT_FOUND");
    // The lines in id order (the order every multi-line writer here takes them in).
    await tx.$queryRaw`SELECT id FROM "OrderItem" WHERE "orderId" = ${orderId} ORDER BY id ASC FOR UPDATE`;
    const o = await prepOrder(orderId, tx);
    if (!o) throw AR("لا شيء في هذا الطلب للتسليم.", "Nothing in this order to hand off.", 409, "NOTHING_TO_HAND_OFF");
    assertPreparable(o);
    const lines = o.lines.filter((l) => l.picked > 0 && (!only || only.includes(l.id)));
    if (only && only.some((id) => !o.lines.some((l) => l.id === id))) throw AR("بند ليس في هذا الطلب.", "A line is not in this order.", 400, "LINE_NOT_IN_ORDER");
    if (lines.length === 0) throw AR("لا وحدات مُتحقق منها للتسليم. جهّز البنود أولًا.", "No verified units to hand off. Prepare the lines first.", 409, "NOTHING_TO_HAND_OFF");
    const picks = await tx.preparationPick.findMany({ where: { orderItemId: { in: lines.map((l) => l.id) }, status: "PICKED" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    const units = picks.reduce((s, p) => s + p.units, 0);
    if (units <= 0) throw AR("لا وحدات مُتحقق منها للتسليم. جهّز البنود أولًا.", "No verified units to hand off. Prepare the lines first.", 409, "NOTHING_TO_HAND_OFF");
    // Partial: some of the order's open units are not in this handoff (or in an earlier one).
    const partial = o.totals.outstanding - (o.totals.handedOff + units) > 0;
    const h = await tx.dispatchHandoff.create({
      data: { orderId, requestKey: key, stagingNote: note || null, packages, units, partial, preparedById: user.id, preparedByName: user.name, stationId: args.stationId },
    });
    for (const l of lines) {
      const mine = picks.filter((p) => p.orderItemId === l.id);
      // Per lot NUMBER (what is printed on the box); the lot rows behind it are listed.
      const byLot = new Map<string, { batchNumber: string; units: number; lotIds: string[] }>();
      for (const p of mine) {
        const g = byLot.get(p.batchNumber) ?? { batchNumber: p.batchNumber, units: 0, lotIds: [] };
        g.units += p.units;
        if (!g.lotIds.includes(p.finishedGoodsLotId)) g.lotIds.push(p.finishedGoodsLotId);
        byLot.set(p.batchNumber, g);
      }
      const lu = mine.reduce((s, p) => s + p.units, 0);
      if (lu > 0) await tx.dispatchHandoffLine.create({ data: { handoffId: h.id, orderItemId: l.id, units: lu, lots: [...byLot.values()] } });
    }
    await tx.preparationPick.updateMany({ where: { id: { in: picks.map((p) => p.id) } }, data: { status: "HANDED_OFF", handoffId: h.id } });
    await log(tx, { itemType: "DispatchHandoff", itemId: h.id, action: "ADVANCE:HANDOFF", fromState: "PICKED", toState: "HANDED_OFF", user, key: `handoff:${key}`, reason: `order #${o.orderNumber} · ${units} unit(s)${partial ? " · partial" : ""}${note ? ` · ${note}` : ""}` });
    // Nothing left to prepare: the order's claim ends with the handoff.
    const left = o.totals.remaining;
    if (left === 0 && o.claim) {
      await tx.workItemClaim.updateMany({ where: { id: o.claim.id, status: "ACTIVE" }, data: { status: "RELEASED", activeItemRef: null, releasedAt: new Date(), releasedById: user.id, releasedByName: user.name } });
    }
    const { notify } = await import("@/lib/notifications/notify");
    await notify(tx, {
      event: "dispatch.order_handed_off", dedupeKey: h.id, actorId: user.id, entity: { type: "Order", id: orderId },
      facts: { orderNumber: o.orderNumber, units, partial: partial ? "yes" : "", staging: note, packages: packages ?? "", byName: user.name },
    });
    await appendOrderActivity(tx, {
      orderId, type: "ORDER_HANDED_TO_DISPATCH", department: "Shipping",
      message: `${units} unit(s) prepared and handed to dispatch${partial ? " (partial)" : ""} by ${user.name}${note ? ` — staged at: ${note}` : ""}.`,
      authorId: user.id, authorName: user.name,
      metadata: { handoffId: h.id, units, partial, stagingNote: note || null, packages },
    });
    return { handoff: await handoffView(tx, h.id), replayed: false };
  }, TX_OPTS);
}

/** The dispatch page (/api/deliveries/ready): the open handoff of each order — handed off, not delivered yet. */
export async function openHandoffs(db: Db, orderIds: string[]) {
  if (orderIds.length === 0) return new Map<string, { units: number; lines: Record<string, number>; stagingNote: string | null; packages: number | null; at: string; byName: string }>();
  const [picks, last] = await Promise.all([
    db.preparationPick.findMany({ where: { orderId: { in: orderIds }, status: "HANDED_OFF" }, select: { orderId: true, orderItemId: true, units: true } }),
    db.dispatchHandoff.findMany({ where: { orderId: { in: orderIds } }, orderBy: { createdAt: "desc" }, select: { orderId: true, stagingNote: true, packages: true, createdAt: true, preparedByName: true } }),
  ]);
  const out = new Map<string, { units: number; lines: Record<string, number>; stagingNote: string | null; packages: number | null; at: string; byName: string }>();
  for (const p of picks) {
    const h = last.find((x) => x.orderId === p.orderId);
    if (!h) continue;
    const cur = out.get(p.orderId) ?? { units: 0, lines: {}, stagingNote: h.stagingNote, packages: h.packages, at: h.createdAt.toISOString(), byName: h.preparedByName };
    cur.units += p.units;
    cur.lines[p.orderItemId] = (cur.lines[p.orderItemId] ?? 0) + p.units;
    out.set(p.orderId, cur);
  }
  return out;
}
