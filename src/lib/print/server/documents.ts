// The facts behind the two A4 documents of feat/print-docs — the roast sheet and the delivery note.
// Read-only: nothing here writes, reserves or moves anything. The pure builders
// (../roast-sheet.ts, ../delivery-note.ts) decide what the page says.
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { greenSourceFacts, pickFromFacts } from "@/lib/services/green-source";
import { deliveryLotsFor } from "@/lib/services/delivery-lots";
import { batchRoasterId, readRoasters } from "@/lib/services/schedule/schedule-db";
import { addDays, effectiveStatus, hoursOf, riyadhKey, riyadhMidnight, workWindow } from "@/lib/services/schedule/planner";
import { employeeNames } from "@/lib/services/settings/roasters-db";
import { readQuoteSettings } from "@/lib/services/sales/quote-settings";
import type { RoastSheetData, RoastSheetEntry, RoastSheetLot, RoastSheetRoaster } from "../roast-sheet";
import type { DeliveryNoteItem, DeliveryRecord } from "../delivery-note";

type Db = PrismaClient | Prisma.TransactionClient;
const num = (d: { toString(): string } | number | null | undefined) => (d === null || d === undefined ? 0 : Number(d.toString()));
const nameOf = (p: { productNameAr: string | null; productNameEn: string } | null | undefined, fallback?: string | null) =>
  ({ ar: p?.productNameAr || p?.productNameEn || fallback || "—", en: p?.productNameEn || fallback || "—" });

/** The company block every document prints: only what the owner filled in (empty in production today). */
export type DocumentSeller = { nameAr: string | null; nameEn: string | null; addressAr: string | null; addressEn: string | null; phone: string | null; crNumber: string | null };

export async function documentSeller(db: Db): Promise<DocumentSeller> {
  const { seller: s } = await readQuoteSettings(db);
  return { nameAr: s.sellerLegalNameAr, nameEn: s.sellerLegalNameEn, addressAr: s.sellerAddressAr, addressEn: s.sellerAddressEn, phone: s.sellerPhone, crNumber: s.sellerCrNumber };
}

export class DocumentNotFound extends Error {}

// ── Roast sheet ─────────────────────────────────────────────────────────────────────────────

const BATCH_INCLUDE = {
  greenBean: { select: { serialNumber: true, beanType: true, beanTypeAr: true } },
  product: { select: { productNameAr: true, productNameEn: true, expectedRoastLoss: true } },
  orderItem: { select: { beanTypeName: true, order: { select: { orderNumber: true } }, productSku: { select: { product: { select: { productNameAr: true, productNameEn: true, expectedRoastLoss: true } } } } } },
  scheduledSlot: { select: { roasterId: true, operatorId: true, startsAt: true, endsAt: true, plannedGreenKg: true, purpose: true, status: true } },
} as const;
type BatchRow = Prisma.RoastingBatchGetPayload<{ include: typeof BATCH_INCLUDE }>;

const lotOf = (b: Pick<BatchRow, "greenBean">): RoastSheetLot | null =>
  b.greenBean ? { serial: b.greenBean.serialNumber, name: b.greenBean.beanTypeAr || b.greenBean.beanType, source: "recorded" } : null;

const actualOf = (b: BatchRow) => ({
  batchNumber: b.batchNumber, greenKg: b.greenBeanQuantity, roastedKg: b.roastedBeanQuantity,
  batchStatus: b.status, recordedAt: b.createdAt.toISOString(), roastProfile: b.roastProfile,
});

function batchEntry(b: BatchRow, operatorName: string | null): RoastSheetEntry {
  const product = b.product ?? b.orderItem?.productSku?.product ?? null;
  const slot = b.scheduledSlot;
  return {
    kind: slot ? "slot" : "batch",
    startsAt: slot?.startsAt.toISOString() ?? b.createdAt.toISOString(),
    endsAt: slot?.endsAt.toISOString() ?? null,
    coffee: nameOf(product, b.orderItem?.beanTypeName),
    purpose: slot ? (slot.purpose === "STOCK" ? "STOCK" : "DEMAND") : b.orderItem ? "DEMAND" : "STOCK",
    orderNumber: b.orderItem?.order.orderNumber ?? null,
    operatorName,
    plannedGreenKg: slot ? num(slot.plannedGreenKg) : null,
    expectedLossPct: product?.expectedRoastLoss ?? null,
    greenLot: lotOf(b),
    status: "RECORDED",
    actual: actualOf(b),
  };
}

/** The lot a planned slot would draw on today (the same automatic choice the roast POST applies). */
async function expectedLot(db: Db, productId: string, kg: number, cache: Map<string, Awaited<ReturnType<typeof greenSourceFacts>>>): Promise<RoastSheetLot | null> {
  if (!cache.has(productId)) cache.set(productId, await greenSourceFacts(db as never, { productId }));
  const facts = cache.get(productId);
  if (!facts) return null;
  const pick = pickFromFacts(facts, kg);
  if (!pick.ok) return null;
  return { serial: pick.lot.serialNumber, name: pick.lot.beanTypeAr || pick.lot.beanType, source: pick.source };
}

/**
 * «طباعة ورقة التحميص» for a day: each production roaster (or the one asked for) with every slot of
 * that Riyadh day that is not cancelled, in time order, and the batches recorded that day without a
 * slot. `roasterId` that names no production roaster → DocumentNotFound.
 */
export async function roastSheetForDay(db: Db, day: string, roasterId: string | null, now = new Date()): Promise<RoastSheetData> {
  const all = await readRoasters(db);
  const roasters = roasterId ? all.filter((r) => r.id === roasterId) : all;
  if (roasterId && roasters.length === 0) throw new DocumentNotFound("roaster");
  const from = new Date(riyadhMidnight(day)), to = new Date(riyadhMidnight(addDays(day, 1)));
  const slots = await db.scheduledSlot.findMany({
    where: { startsAt: { gte: from, lt: to }, status: { not: "CANCELLED" }, ...(roasterId ? { roasterId } : {}) },
    orderBy: { startsAt: "asc" },
    include: {
      product: { select: { productNameAr: true, productNameEn: true, expectedRoastLoss: true } },
      batch: { include: BATCH_INCLUDE },
    },
  });
  const loose = await db.roastingBatch.findMany({
    where: { createdAt: { gte: from, lt: to }, isBlend: false, scheduledSlotId: null },
    include: BATCH_INCLUDE,
    orderBy: { createdAt: "asc" },
  });
  const maint = await db.roasterMaintenance.findMany({
    where: { roasterId: { in: roasters.map((r) => r.id) }, status: { in: ["PLANNED", "IN_PROGRESS"] }, startsAt: { lt: to }, endsAt: { gt: from } },
    select: { roasterId: true, title: true, startsAt: true, endsAt: true },
    orderBy: { startsAt: "asc" },
  });
  const names = await employeeNames(db, slots.map((s) => s.operatorId));
  const lots = new Map<string, Awaited<ReturnType<typeof greenSourceFacts>>>();
  const sole = all.length === 1 ? all[0].id : null;

  const out: RoastSheetRoaster[] = [];
  for (const r of roasters) {
    const entries: RoastSheetEntry[] = [];
    for (const s of slots.filter((x) => x.roasterId === r.id)) {
      const operatorName = names.get(s.operatorId) ?? null;
      if (s.batch) { entries.push(batchEntry(s.batch, operatorName)); continue; }
      const planned = num(s.plannedGreenKg);
      entries.push({
        kind: "slot",
        startsAt: s.startsAt.toISOString(), endsAt: s.endsAt.toISOString(),
        coffee: nameOf(s.product), purpose: s.purpose === "STOCK" ? "STOCK" : "DEMAND", orderNumber: null,
        operatorName, plannedGreenKg: planned, expectedLossPct: s.product?.expectedRoastLoss ?? null,
        greenLot: await expectedLot(db, s.productId, planned, lots),
        status: effectiveStatus({ status: s.status, endsAt: s.endsAt, hasBatch: false }, now),
        actual: null,
      });
    }
    for (const b of loose.filter((x) => batchRoasterId(x, sole) === r.id)) entries.push(batchEntry(b, null));
    entries.sort((a, b) => Date.parse(a.startsAt ?? "") - Date.parse(b.startsAt ?? ""));
    const w = workWindow(day, hoursOf(r.workingHours));
    out.push({
      id: r.id, name: r.name,
      window: w ? { start: new Date(w.start).toISOString(), end: new Date(w.end).toISOString() } : null,
      maintenance: maint.filter((m) => m.roasterId === r.id).map((m) => ({ title: m.title, startsAt: m.startsAt.toISOString(), endsAt: m.endsAt.toISOString() })),
      entries,
    });
  }
  // A day with no production roaster registered still prints one sheet (the recorded batches, blank rows).
  if (out.length === 0 && !roasterId) {
    out.push({ id: null, name: null, window: null, maintenance: [], entries: loose.map((b) => batchEntry(b, null)) });
  }
  return { mode: "day", day, roasters: out };
}

/** «طباعة» on one recorded batch: that batch's actual figures, with its slot's plan when it had one. */
export async function roastSheetForBatch(db: Db, batchId: string): Promise<RoastSheetData> {
  const b = await db.roastingBatch.findUnique({ where: { id: batchId }, include: BATCH_INCLUDE });
  if (!b) throw new DocumentNotFound("batch");
  const rid = b.roasterId || b.scheduledSlot?.roasterId || null;
  const roaster = rid ? await db.roaster.findUnique({ where: { id: rid }, select: { id: true, name: true } }) : null;
  const names = await employeeNames(db, [b.scheduledSlot?.operatorId]);
  const entry = batchEntry(b, b.scheduledSlot ? names.get(b.scheduledSlot.operatorId) ?? null : null);
  return {
    mode: "batch",
    day: riyadhKey(b.scheduledSlot?.startsAt ?? b.createdAt),
    roasters: [{ id: roaster?.id ?? null, name: roaster?.name ?? null, window: null, maintenance: [], entries: [entry] }],
  };
}

// ── Delivery note ───────────────────────────────────────────────────────────────────────────

export type DeliveryNoteFacts = {
  order: { id: string; orderNumber: number; status: string; ownerId: string | null; customerAccountOwnerId: string | null };
  customer: { name: string; nameAr: string | null; phone: string | null; address: string | null; city: string | null; contact: { name: string; role: string | null; phone: string | null } | null };
  items: DeliveryNoteItem[];
  history: DeliveryRecord[];
};

/**
 * The order the deliveries belong to, its lines and every delivery it has had (with lots).
 * Throws DocumentNotFound when an id is unknown; returns null when the ids span several orders.
 * `contact`: whether the caller may read the customer's contact record (owner policy F4).
 */
export async function deliveryNoteFacts(db: Db, ids: string[], contact: boolean): Promise<DeliveryNoteFacts | null> {
  const picked = await db.delivery.findMany({ where: { id: { in: ids } }, select: { id: true, orderItem: { select: { orderId: true } } } });
  if (picked.length !== new Set(ids).size) throw new DocumentNotFound("delivery");
  const orderIds = new Set(picked.map((d) => d.orderItem.orderId));
  if (orderIds.size !== 1) return null;
  const [orderId] = [...orderIds];
  const order = await db.order.findUniqueOrThrow({
    where: { id: orderId },
    select: {
      id: true, orderNumber: true, status: true, ownerId: true,
      customer: {
        select: {
          name: true, nameAr: true, phone: true, address: true, city: true, accountOwnerId: true,
          contacts: { orderBy: [{ position: "asc" }, { createdAt: "asc" }], take: 1, select: { name: true, role: true, phone: true } },
        },
      },
      items: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true, beanTypeName: true, quantityKg: true, quantityUnits: true,
          product: { select: { productNameAr: true, productNameEn: true } },
          productSku: { select: { skuCode: true, name: true, nameAr: true, product: { select: { productNameAr: true, productNameEn: true } } } },
          deliveries: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, orderItemId: true, date: true, createdAt: true, quantityUnits: true, quantityKg: true, notes: true } },
        },
      },
    },
  });
  const all = order.items.flatMap((i) => i.deliveries);
  const lots = await deliveryLotsFor(db, all.map((d) => d.id));
  const c = order.customer;
  return {
    order: { id: order.id, orderNumber: order.orderNumber, status: order.status, ownerId: order.ownerId, customerAccountOwnerId: c.accountOwnerId },
    customer: {
      name: c.name, nameAr: c.nameAr,
      phone: contact ? c.phone : null, address: contact ? c.address : null, city: contact ? c.city : null,
      contact: contact && c.contacts[0] ? { name: c.contacts[0].name, role: c.contacts[0].role, phone: c.contacts[0].phone } : null,
    },
    items: order.items.map((i) => {
      const sku = i.productSku;
      const isUnit = i.quantityUnits !== null && !!sku;
      const p = sku?.product ?? i.product;
      return {
        id: i.id,
        name: { ar: sku?.nameAr || p?.productNameAr || sku?.name || p?.productNameEn || i.beanTypeName, en: sku?.name || p?.productNameEn || i.beanTypeName },
        skuCode: sku?.skuCode ?? null,
        isUnit,
        orderedUnits: i.quantityUnits,
        orderedKg: i.quantityKg,
      };
    }),
    history: all.map((d) => ({
      id: d.id, orderItemId: d.orderItemId, date: d.date.toISOString(), createdAt: d.createdAt.toISOString(),
      quantityUnits: d.quantityUnits, quantityKg: d.quantityKg, notes: d.notes,
      lots: (lots.get(d.id) ?? []).map((l) => ({ batchNumber: l.batchNumber, quantityUnits: l.quantityUnits, quantityKg: l.quantityKg })),
    })),
  };
}
