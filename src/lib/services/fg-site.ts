/**
 * Where finished goods are PROMISED from (council F1 on 20261117090000_locations_enhancements): the production site —
 * the dispatch's default ship-from. Free-to-promise, shelf reservations, the preparation review and the roast queue's
 * «on the shelf» count only the AVAILABLE lots there. A lot at another site is shown as «في موقع آخر — يحتاج تحويل»
 * with a prefilled transfer; it never covers an order (nor suppresses roasting demand) until someone moves it. A lot on
 * its way is IN_TRANSIT and counts nowhere. Takes the caller's client (no database import: safe for any service).
 */
import type { Prisma } from "@/generated/prisma/client";
import { LOT_NOT_HELD } from "@/lib/services/qc/hold-guard";

type Db = Prisma.TransactionClient;

export const TRANSIT_SITE = "loc_transit";

/** The production site's id (null only on a database without locations — never after 20261115090000). */
export async function promiseSiteId(db: Db): Promise<string | null> {
  const r = await db.stockLocation.findFirst({ where: { isProduction: true, isActive: true }, select: { id: true } });
  return r?.id ?? null;
}

/** The lot filter of the promise site ({} when no site is set). */
export async function atPromiseSite(db: Db): Promise<Prisma.FinishedGoodsLotWhereInput> {
  const id = await promiseSiteId(db);
  return id ? { locationId: id } : {};
}

export type OffSiteLot = {
  lotId: string; batchNumber: string; productSkuId: string; locationId: string; nameAr: string; nameEn: string | null; freeUnits: number;
  /** The prefilled transfer that brings it to the promise site. */
  transferHref: string;
};

/** The link of a prefilled finished-goods transfer (lot, units) from its site to `to`. */
export function fgTransferHref(a: { from: string; to: string; lotId: string; units: number }): string {
  const p = new URLSearchParams({ from: a.from, to: a.to, kind: "FG_LOT", item: a.lotId, qty: String(Math.max(1, Math.trunc(a.units))) });
  return `/dashboard/inventory/transfers/new?${p}`;
}

/** Free units of these SKUs in AVAILABLE unit-tracked lots at OTHER active sites (never transit), oldest first. */
export async function offSiteUnitLots(db: Db, skuIds: string[], siteId: string | null): Promise<OffSiteLot[]> {
  if (!skuIds.length || !siteId) return [];
  const lots = await db.finishedGoodsLot.findMany({
    where: {
      productSkuId: { in: skuIds }, isUnitTracked: true, status: "AVAILABLE", unitsAvailable: { gt: 0 },
      locationId: { notIn: [siteId, TRANSIT_SITE] }, location: { isActive: true }, ...LOT_NOT_HELD,
    },
    select: { id: true, batchNumber: true, productSkuId: true, locationId: true, unitsAvailable: true, unitsReserved: true, location: { select: { nameAr: true, nameEn: true } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return lots
    .map((l) => ({ l, free: Math.max(0, l.unitsAvailable - l.unitsReserved) }))
    .filter((x) => x.free > 0 && x.l.productSkuId)
    .map(({ l, free }) => ({
      lotId: l.id, batchNumber: l.batchNumber, productSkuId: l.productSkuId!, locationId: l.locationId, nameAr: l.location.nameAr, nameEn: l.location.nameEn,
      freeUnits: free, transferHref: fgTransferHref({ from: l.locationId, to: siteId, lotId: l.id, units: free }),
    }));
}
