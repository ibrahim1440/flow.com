/**
 * The derived figures the inventory screen draws (Figma 216:2) that no column stores: roast rate
 * and coverage per bean, the daily roast rate, packaging usage and packs coverable, the finished
 * stock in units per SKU and the unpacked roasted coffee. Read-only; every number is computed by
 * the pure formulas in src/lib/inventory/metrics.ts from movements, balances and BOMs — see that
 * file for each formula and its "insufficient history" rule.
 */
import { prisma } from "@/lib/db";
import {
  PACK_WINDOW_DAYS, ROAST_WINDOW_DAYS, beanGroupKey, coverageDays, dailyRate, netDrawn, packsCoverable,
  type MovementLike,
} from "@/lib/inventory/metrics";
import { PACKABLE_BATCH_STATUSES } from "@/lib/services/finished-products";

const DAY_MS = 86_400_000;
const minDate = (...ds: (Date | null | undefined)[]) => ds.reduce<Date | null>((a, d) => (d && (!a || d < a) ? d : a), null);
const finite = (n: number | null) => (n === Infinity ? "INF" : n);

export async function greenOverview(now = new Date()) {
  const since = new Date(now.getTime() - ROAST_WINDOW_DAYS * DAY_MS);
  const [beans, moves, firstMove] = await Promise.all([
    prisma.greenBean.findMany({ select: { id: true, beanType: true, country: true, process: true, quantityKg: true, isActive: true, receivedDate: true, createdAt: true } }),
    prisma.inventoryMovement.findMany({
      where: { category: "RAW_MATERIAL", sourceDocType: "ROASTING_BATCH", timestamp: { gt: since, lte: now } },
      select: { type: true, category: true, sourceDocType: true, referenceEntityId: true, quantityChanged: true, timestamp: true },
    }),
    prisma.inventoryMovement.findFirst({ where: { category: "RAW_MATERIAL" }, orderBy: { timestamp: "asc" }, select: { timestamp: true } }),
  ]);
  const ms = moves as MovementLike[];

  // Per bean (the lots of one coffee): consumed, rate, coverage of the ACTIVE balance.
  const groups = new Map<string, { ids: Set<string>; balance: number; historyStart: Date | null }>();
  for (const b of beans) {
    const k = beanGroupKey(b);
    const g = groups.get(k) ?? { ids: new Set<string>(), balance: 0, historyStart: null };
    g.ids.add(b.id);
    if (b.isActive && Number.isFinite(b.quantityKg)) g.balance += b.quantityKg;
    g.historyStart = minDate(g.historyStart, b.receivedDate, b.createdAt);
    groups.set(k, g);
  }
  const perGroup: Record<string, { consumed: number; rate: number | null; coverage: number | "INF" | null; historyStart: string | null }> = {};
  for (const [k, g] of groups) {
    const consumed = netDrawn(ms, { category: "RAW_MATERIAL", source: "ROASTING_BATCH", now, days: ROAST_WINDOW_DAYS, ids: g.ids });
    const rate = dailyRate(consumed, g.historyStart, now, ROAST_WINDOW_DAYS);
    perGroup[k] = { consumed, rate, coverage: finite(coverageDays(g.balance, rate)), historyStart: g.historyStart?.toISOString() ?? null };
  }

  // Overall: all green coffee roasted in the window / 14; history from the first green movement or lot.
  const overallStart = minDate(firstMove?.timestamp, ...beans.map((b) => b.receivedDate));
  const consumed = netDrawn(ms, { category: "RAW_MATERIAL", source: "ROASTING_BATCH", now, days: ROAST_WINDOW_DAYS });
  return {
    now: now.toISOString(),
    windowDays: ROAST_WINDOW_DAYS,
    overall: { consumed, rate: dailyRate(consumed, overallStart, now, ROAST_WINDOW_DAYS), historyStart: overallStart?.toISOString() ?? null },
    groups: perGroup,
  };
}

export async function packagingOverview(now = new Date()) {
  const since = new Date(now.getTime() - PACK_WINDOW_DAYS * DAY_MS);
  const [materials, moves, firstMove, skus, ops] = await Promise.all([
    prisma.materialItem.findMany({ select: { id: true, code: true, name: true, nameAr: true, unitOfMeasure: true, quantityOnHand: true, isActive: true, createdAt: true } }),
    prisma.inventoryMovement.findMany({
      where: { category: "PACKAGING_MATERIAL", sourceDocType: "BOM_CONSUMPTION", timestamp: { gt: since, lte: now } },
      select: { type: true, category: true, sourceDocType: true, referenceEntityId: true, quantityChanged: true, timestamp: true },
    }),
    prisma.inventoryMovement.findFirst({ where: { category: "PACKAGING_MATERIAL" }, orderBy: { timestamp: "asc" }, select: { timestamp: true } }),
    prisma.productSKU.findMany({
      where: { isActive: true },
      select: { id: true, skuCode: true, name: true, nameAr: true, weightGrams: true, product: { select: { productNameEn: true, productNameAr: true } }, bomComponents: { where: { type: "MATERIAL" }, select: { materialItemId: true, quantityPerUnit: true } } },
    }),
    prisma.packagingOperation.findMany({ where: { createdAt: { gt: since, lte: now }, productSkuId: { not: null }, quantityUnits: { not: null } }, select: { productSkuId: true, quantityUnits: true } }),
  ]);
  const ms = moves as MovementLike[];
  const usage: Record<string, { used: number; rate: number | null; coverage: number | "INF" | null }> = {};
  let total = 0;
  for (const m of materials) {
    const used = netDrawn(ms, { category: "PACKAGING_MATERIAL", source: "BOM_CONSUMPTION", now, days: PACK_WINDOW_DAYS, ids: new Set([m.id]) });
    // History starts when BOTH the material existed and the packaging ledger was being written:
    // the later of its creation and the first packaging-material movement (none yet → null).
    const start = firstMove ? (firstMove.timestamp > m.createdAt ? firstMove.timestamp : m.createdAt) : null;
    const rate = dailyRate(used, start, now, PACK_WINDOW_DAYS);
    usage[m.id] = { used, rate, coverage: finite(coverageDays(m.quantityOnHand, rate)) };
    // The headline sums countable pieces only; a material kept in kg is not «قطعة».
    if (m.unitOfMeasure === "PIECE" || m.unitOfMeasure === "UNIT") total += used;
  }
  const totalOk = !!firstMove && firstMove.timestamp.getTime() <= now.getTime() - PACK_WINDOW_DAYS * DAY_MS;

  const stock = new Map(materials.map((m) => [m.id, m]));
  const matName = new Map(materials.map((m) => [m.id, { name: m.name, nameAr: m.nameAr }]));
  const packedUnits = new Map<string, number>();
  for (const o of ops) packedUnits.set(o.productSkuId!, (packedUnits.get(o.productSkuId!) ?? 0) + (o.quantityUnits ?? 0));
  const perSku = skus
    .map((s) => {
      const p = packsCoverable(s.bomComponents.map((b) => ({ materialItemId: b.materialItemId!, quantityPerUnit: b.quantityPerUnit })).filter((b) => b.materialItemId), stock);
      return p ? {
        skuId: s.id, skuCode: s.skuCode, name: s.name ?? s.product.productNameEn, nameAr: s.nameAr ?? s.product.productNameAr, weightGrams: s.weightGrams,
        units: p.units, limiting: { id: p.limitingMaterialId, ...(matName.get(p.limitingMaterialId) ?? { name: "—", nameAr: null }) },
        packed7d: packedUnits.get(s.id) ?? 0,
      } : null;
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
  // Headline: the SKU packed most in the last 7 days (the line the packers are actually running);
  // with no packing in the window, the tightest SKU (fewest packs coverable).
  const headline = [...perSku].sort((a, b) => b.packed7d - a.packed7d || a.units - b.units)[0] ?? null;
  return { now: now.toISOString(), windowDays: PACK_WINDOW_DAYS, usage, total: totalOk ? total : null, packs: { headline, perSku } };
}

export async function finishedOverview() {
  const [lots, skus, batches] = await Promise.all([
    prisma.finishedGoodsLot.findMany({
      where: { OR: [{ isUnitTracked: true, OR: [{ unitsAvailable: { gt: 0 } }, { status: "PARTIAL" }] }, { isUnitTracked: false, availableQty: { gt: 0 } }] },
      orderBy: { createdAt: "desc" },
      select: {
        id: true, batchNumber: true, productSkuId: true, isUnitTracked: true, status: true, createdAt: true,
        unitsProduced: true, unitsAvailable: true, unitsReserved: true, availableQty: true, reservedQty: true, quantityKg: true,
        actualContentGrams: true,
        product: { select: { productNameEn: true, productNameAr: true } },
        allocations: { where: { status: "RESERVED" }, select: { quantityUnits: true, quantityKg: true, orderItem: { select: { order: { select: { id: true, orderNumber: true } } } } } },
      },
    }),
    prisma.productSKU.findMany({ select: { id: true, skuCode: true, name: true, nameAr: true, weightGrams: true, isActive: true, category: true, product: { select: { productNameEn: true, productNameAr: true } } }, orderBy: { skuCode: "asc" } }),
    prisma.roastingBatch.findMany({
      where: { roastedAvailableKg: { gt: 0.0005 }, isBlend: false },
      orderBy: { date: "desc" },
      take: 100,
      select: { id: true, batchNumber: true, date: true, status: true, roastedBeanQuantity: true, roastedAvailableKg: true, roastProfile: true,
        product: { select: { productNameEn: true, productNameAr: true } }, greenBean: { select: { beanType: true, beanTypeAr: true } } },
    }),
  ]);

  // Units per SKU (unit-tracked lots): available = Σ unitsAvailable of AVAILABLE lots, reserved =
  // Σ unitsReserved, free = available − reserved; partial = PARTIAL packages (not sellable).
  type Row = { skuId: string; skuCode: string; name: string; nameAr: string | null; weightGrams: number; isActive: boolean; category: string; available: number; reserved: number; free: number; partial: number; lots: number; orders: Set<number>; lotRows: unknown[] };
  const rows = new Map<string, Row>();
  for (const s of skus) {
    rows.set(s.id, { skuId: s.id, skuCode: s.skuCode, name: s.name ?? s.product.productNameEn, nameAr: s.nameAr ?? s.product.productNameAr, weightGrams: s.weightGrams, isActive: s.isActive, category: s.category, available: 0, reserved: 0, free: 0, partial: 0, lots: 0, orders: new Set(), lotRows: [] });
  }
  const legacy: unknown[] = [];
  for (const l of lots) {
    const orders = [...new Set(l.allocations.map((a) => a.orderItem.order.orderNumber))].sort((a, b) => a - b);
    if (!l.isUnitTracked || !l.productSkuId || !rows.has(l.productSkuId)) {
      if (!l.isUnitTracked) legacy.push({ id: l.id, batchNumber: l.batchNumber, createdAt: l.createdAt, status: l.status, quantityKg: l.quantityKg, availableQty: l.availableQty, reservedQty: l.reservedQty, product: l.product, orders });
      continue;
    }
    const r = rows.get(l.productSkuId)!;
    const free = Math.max(0, l.unitsAvailable - l.unitsReserved);
    r.lots++;
    if (l.status === "PARTIAL") r.partial++;
    else { r.available += l.unitsAvailable; r.reserved += l.unitsReserved; r.free += free; }
    orders.forEach((o) => r.orders.add(o));
    r.lotRows.push({ id: l.id, batchNumber: l.batchNumber, createdAt: l.createdAt, status: l.status, available: l.status === "PARTIAL" ? 0 : l.unitsAvailable, reserved: l.unitsReserved, free: l.status === "PARTIAL" ? 0 : free, actualContentGrams: l.actualContentGrams, orders });
  }
  const skuRows = [...rows.values()].map(({ orders, ...r }) => ({ ...r, orders: [...orders].sort((a, b) => a - b) }));
  const allOrders = new Set(skuRows.flatMap((r) => r.orders));
  const packable = (s: string) => (PACKABLE_BATCH_STATUSES as readonly string[]).includes(s);
  const unpacked = batches.map((b) => ({
    id: b.id, batchNumber: b.batchNumber, date: b.date, status: b.status, roastProfile: b.roastProfile,
    name: b.product?.productNameEn ?? b.greenBean?.beanType ?? "—", nameAr: b.product?.productNameAr ?? b.greenBean?.beanTypeAr ?? null,
    roastedKg: b.roastedBeanQuantity, unpackedKg: b.roastedAvailableKg, packable: packable(b.status),
  }));
  return {
    skus: skuRows,
    totals: {
      available: skuRows.reduce((s, r) => s + r.available, 0),
      reserved: skuRows.reduce((s, r) => s + r.reserved, 0),
      free: skuRows.reduce((s, r) => s + r.free, 0),
      partial: skuRows.reduce((s, r) => s + r.partial, 0),
      lots: skuRows.reduce((s, r) => s + r.lots, 0),
      skusInStock: skuRows.filter((r) => r.lots > 0).length,
      openOrders: allOrders.size,
      unpackedPackableKg: Number(unpacked.filter((u) => u.packable).reduce((s, u) => s + u.unpackedKg, 0).toFixed(3)),
      unpackedPendingKg: Number(unpacked.filter((u) => u.status === "Pending QC").reduce((s, u) => s + u.unpackedKg, 0).toFixed(3)),
    },
    unpacked,
    legacy,
  };
}
