/**
 * Reorder points per item per location (20261117090000_locations_enhancements, owner decision 3) — «حد إعادة الطلب في
 * الموقع». Set in each item's settings (green lots, materials); «تحت حد إعادة الطلب» is then evaluated per location from
 * the item's balance THERE ("StockBalance"). The company-wide view stays (MaterialItem.reorderPoint, the green lots'
 * company total). Every change is one row of the person audit (STOCK_REORDER_POINT_SET, before / after) and of the
 * row audit (ledger_audit_row).
 *
 * Finished SKUs too (the owner's decision before release): a point in UNITS per site, set in the SKU's settings; the
 * site's stock is the AVAILABLE units of the SKU's unit-tracked lots there (not in transit, not held, not shipped).
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { QC_HOLD_STATUS } from "@/lib/services/qc/hold-guard";
import { ipHashOf } from "@/lib/accounting/ops/purchase-activity";
import type { AuditContext } from "@/lib/accounting/audit";
import { belowReorder, isTransitLocation, parseReorderPoint, type StockItemKind } from "@/lib/inventory/locations";

type Fail = { _appCode: number; message: string; errorEn: string; errorAr: string; code: string };
const fail = (status: number, code: string, ar: string, en: string): Fail => ({ _appCode: status, message: ar, errorAr: ar, errorEn: en, code });

type PointKind = StockItemKind | "PRODUCT_SKU";
const kindOf = (v: unknown): PointKind | null => (v === "GREEN_BEAN" || v === "MATERIAL" || v === "PRODUCT_SKU" ? v : null);

/** A finished SKU's AVAILABLE units per site (unit-tracked lots in status AVAILABLE). */
async function skuUnitsBySite(skuIds: string[], locationId?: string | null): Promise<Map<string, number>> {
  if (!skuIds.length) return new Map();
  // FREE units only (council F3): Σ(unitsAvailable − unitsReserved) over AVAILABLE unit-tracked lots at the site, never
  // a lot packed from a batch on QC hold — the same rule as assertLotsNotHeld (heldLotIds: the legacy roastingBatch,
  // packedFromBatch, or any PackagingSource roast on hold).
  const lots = await prisma.finishedGoodsLot.findMany({
    where: {
      productSkuId: { in: skuIds }, status: "AVAILABLE", isUnitTracked: true, ...(locationId ? { locationId } : {}),
      NOT: { OR: [
        { roastingBatch: { status: QC_HOLD_STATUS } },
        { packedFromBatch: { status: QC_HOLD_STATUS } },
        { sources: { some: { roastingBatch: { status: QC_HOLD_STATUS } } } },
      ] },
    },
    select: { locationId: true, productSkuId: true, unitsAvailable: true, unitsReserved: true },
  });
  const out = new Map<string, number>();
  for (const l of lots) {
    const k = `${l.locationId}:${l.productSkuId}`;
    out.set(k, (out.get(k) ?? 0) + Math.max(0, (l.unitsAvailable ?? 0) - (l.unitsReserved ?? 0)));
  }
  return out;
}

/** One item's points and balances, per active site (never transit). */
export async function itemReorderPoints(kindRaw: unknown, entityId: unknown) {
  const kind = kindOf(kindRaw);
  if (!kind || typeof entityId !== "string" || !entityId) throw fail(400, "OPS_BAD_INPUT", "الصنف غير صالح.", "itemKind / entityId.");
  const [locations, points, balances] = await Promise.all([
    prisma.stockLocation.findMany({ where: { isActive: true, type: { not: "TRANSIT" } }, orderBy: [{ sortOrder: "asc" }, { code: "asc" }], select: { id: true, code: true, nameAr: true, nameEn: true, isDefault: true, isProduction: true } }),
    prisma.stockReorderPoint.findMany({ where: { itemKind: kind, entityId }, select: { locationId: true, reorderPoint: true, updatedAt: true } }),
    kind === "PRODUCT_SKU"
      ? skuUnitsBySite([entityId]).then((m) => [...m.entries()].map(([k, qty]) => ({ locationId: k.split(":")[0], qty })))
      : prisma.stockBalance.findMany({ where: { itemKind: kind, entityId }, select: { locationId: true, qty: true } }),
  ]);
  return {
    itemKind: kind, entityId,
    sites: locations.map((l) => {
      const p = points.find((x) => x.locationId === l.id)?.reorderPoint ?? null;
      const qty = balances.find((b) => b.locationId === l.id)?.qty ?? 0;
      return { ...l, qty, reorderPoint: p, low: belowReorder(qty, p) };
    }),
  };
}

/** PUT { itemKind, entityId, points: [{ locationId, reorderPoint: number | null }] } — null / "" clears a site's point. */
export async function setReorderPoints(body: Record<string, unknown>, actor: { id: string }, ctx: AuditContext) {
  const kind = kindOf(body.itemKind);
  const entityId = typeof body.entityId === "string" ? body.entityId : "";
  if (!kind || !entityId) throw fail(400, "OPS_BAD_INPUT", "الصنف غير صالح.", "itemKind / entityId.");
  if (!Array.isArray(body.points) || body.points.length > 100) throw fail(400, "OPS_BAD_INPUT", "حدود المواقع غير صالحة.", "points must be an array.");
  const wanted = new Map<string, number | null>();
  for (const raw of body.points as Record<string, unknown>[]) {
    const id = typeof raw?.locationId === "string" ? raw.locationId : "";
    const v = parseReorderPoint(raw?.reorderPoint);
    if (!id || !v.ok) throw fail(400, "REORDER_POINT_INVALID", "حد إعادة الطلب رقم صفر أو أكبر (4 خانات عشرية كحد أقصى).", "A reorder point is zero or more (at most 4 decimals).");
    if (kind === "PRODUCT_SKU" && v.value !== null && !Number.isInteger(v.value)) throw fail(400, "REORDER_POINT_UNITS", "حد إعادة الطلب للمنتج الجاهز بعدد الوحدات (رقم صحيح).", "A finished SKU's reorder point is a whole number of units.");
    wanted.set(id, v.value);
  }
  return prisma.$transaction(async (tx) => {
    const exists = kind === "GREEN_BEAN"
      ? await tx.greenBean.findUnique({ where: { id: entityId }, select: { id: true, serialNumber: true, beanType: true } })
      : kind === "PRODUCT_SKU"
        ? await tx.productSKU.findUnique({ where: { id: entityId }, select: { id: true, skuCode: true, name: true } }).then((x) => (x ? { id: x.id, code: x.skuCode, name: x.name ?? x.skuCode } : null))
        : await tx.materialItem.findUnique({ where: { id: entityId }, select: { id: true, code: true, name: true } });
    if (!exists) throw fail(404, "STOCK_ITEM_INVALID", "صنف المخزون غير موجود.", "Stock item not found.");
    const locs = await tx.stockLocation.findMany({ where: { id: { in: [...wanted.keys()] } }, select: { id: true, type: true, isActive: true, nameAr: true } });
    for (const id of wanted.keys()) {
      const l = locs.find((x) => x.id === id);
      if (!l || !l.isActive || isTransitLocation(l)) throw fail(400, "STOCK_LOCATION_NOT_FOUND", "اختر مواقع نشطة.", "Choose active locations.");
    }
    const before = await tx.stockReorderPoint.findMany({ where: { itemKind: kind, entityId, locationId: { in: [...wanted.keys()] } }, select: { id: true, locationId: true, reorderPoint: true } });
    const changes: { locationId: string; from: number | null; to: number | null }[] = [];
    for (const [locationId, to] of [...wanted.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const prev = before.find((b) => b.locationId === locationId) ?? null;
      const from = prev?.reorderPoint ?? null;
      if (from === to) continue;
      if (to === null || to === 0) {
        if (prev) await tx.stockReorderPoint.delete({ where: { id: prev.id } });
        if (from !== null) changes.push({ locationId, from, to: null });
        continue;
      }
      await tx.stockReorderPoint.upsert({
        where: { locationId_itemKind_entityId: { locationId, itemKind: kind, entityId } },
        create: { locationId, itemKind: kind, entityId, reorderPoint: to, updatedBy: actor.id },
        update: { reorderPoint: to, updatedBy: actor.id },
      });
      changes.push({ locationId, from, to });
    }
    if (changes.length) {
      const name = "serialNumber" in exists ? `${exists.beanType} · ${exists.serialNumber}` : `${exists.name} · ${exists.code}`;
      await tx.authAuditLog.create({
        data: {
          userId: ctx.actorId, action: "STOCK_REORDER_POINT_SET", result: "SUCCESS", sourceInterface: "WEB", ipHash: await ipHashOf(ctx.ip), userAgent: ctx.userAgent ?? null,
          metadata: JSON.parse(JSON.stringify({ itemKind: kind, entityId, targetName: name, changes: changes.map((c) => ({ ...c, locationName: locs.find((l) => l.id === c.locationId)?.nameAr ?? null })) })) as Prisma.InputJsonValue,
        },
      });
    }
    return { changed: changes.length };
  });
}

/** Every (item, site) at or below its site reorder point: «تحت حد إعادة الطلب» per location. */
export async function lowBySite(locationId?: string | null) {
  const points = await prisma.stockReorderPoint.findMany({
    where: { reorderPoint: { gt: 0 }, ...(locationId ? { locationId } : {}), location: { isActive: true } },
    select: { locationId: true, itemKind: true, entityId: true, reorderPoint: true, location: { select: { nameAr: true, nameEn: true, sortOrder: true } } },
  });
  if (!points.length) return [];
  const stockPoints = points.filter((p) => p.itemKind !== "PRODUCT_SKU");
  const balances = stockPoints.length ? await prisma.stockBalance.findMany({ where: { OR: stockPoints.map((p) => ({ locationId: p.locationId, itemKind: p.itemKind, entityId: p.entityId })) }, select: { locationId: true, itemKind: true, entityId: true, qty: true } }) : [];
  const units = await skuUnitsBySite([...new Set(points.filter((p) => p.itemKind === "PRODUCT_SKU").map((p) => p.entityId))], locationId);
  const qtyOf = (p: { locationId: string; itemKind: string; entityId: string }) => p.itemKind === "PRODUCT_SKU"
    ? units.get(`${p.locationId}:${p.entityId}`) ?? 0
    : balances.find((b) => b.locationId === p.locationId && b.itemKind === p.itemKind && b.entityId === p.entityId)?.qty ?? 0;
  const lows = points.filter((p) => belowReorder(qtyOf(p), p.reorderPoint));
  const g = lows.filter((p) => p.itemKind === "GREEN_BEAN").map((p) => p.entityId);
  const m = lows.filter((p) => p.itemKind === "MATERIAL").map((p) => p.entityId);
  const k = lows.filter((p) => p.itemKind === "PRODUCT_SKU").map((p) => p.entityId);
  const [beans, mats, skus] = await Promise.all([
    g.length ? prisma.greenBean.findMany({ where: { id: { in: g }, isActive: true }, select: { id: true, serialNumber: true, beanType: true, beanTypeAr: true } }) : [],
    m.length ? prisma.materialItem.findMany({ where: { id: { in: m }, isActive: true }, select: { id: true, code: true, name: true, nameAr: true, unitOfMeasure: true } }) : [],
    k.length ? prisma.productSKU.findMany({ where: { id: { in: k }, isActive: true }, select: { id: true, skuCode: true, name: true, nameAr: true, product: { select: { productNameEn: true, productNameAr: true } } } }) : [],
  ]);
  const out = [];
  for (const p of lows) {
    const b = p.itemKind === "GREEN_BEAN" ? beans.find((x) => x.id === p.entityId) : null;
    const x = p.itemKind === "MATERIAL" ? mats.find((y) => y.id === p.entityId) : null;
    const u = p.itemKind === "PRODUCT_SKU" ? skus.find((y) => y.id === p.entityId) : null;
    if (!b && !x && !u) continue;
    const id = b ? { code: b.serialNumber, name: b.beanType, nameAr: b.beanTypeAr, unit: "KG" }
      : x ? { code: x.code, name: x.name, nameAr: x.nameAr, unit: String(x.unitOfMeasure) }
      : { code: u!.skuCode, name: u!.name ?? u!.product.productNameEn, nameAr: u!.nameAr ?? u!.product.productNameAr ?? null, unit: "UNIT" };
    out.push({
      locationId: p.locationId, locationNameAr: p.location.nameAr, locationNameEn: p.location.nameEn, sortOrder: p.location.sortOrder,
      itemKind: p.itemKind, entityId: p.entityId, ...id, qty: qtyOf(p), reorderPoint: p.reorderPoint,
    });
  }
  return out.sort((a, b) => a.sortOrder - b.sortOrder || a.qty / (a.reorderPoint || 1) - b.qty / (b.reorderPoint || 1));
}
