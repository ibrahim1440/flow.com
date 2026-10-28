import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { greenRefusal, pickGreenLot, type GreenLot, type GreenPick, type GreenSite } from "@/lib/green-source";
import { TRANSIT_LOCATION_ID } from "@/lib/inventory/locations";
import { assertLocationHas, workSite } from "./stock-locations";

type Db = Prisma.TransactionClient | typeof prisma;

const LOT_SELECT = {
  id: true, serialNumber: true, beanType: true, beanTypeAr: true, country: true, countryAr: true,
  quantityKg: true, isActive: true, receivedDate: true, createdAt: true, labelCode: true, sackCount: true, sackWeightKg: true,
} as const;

export type GreenSourceFacts = {
  productId: string | null;
  productNameEn: string | null;
  productNameAr: string | null;
  /** The product's expected roast loss, percent (CoffeeProduct.expectedRoastLoss, default 15). */
  expectedRoastLoss: number;
  defaultLot: GreenLot | null;
  /** Active lots of the default lot's beanType + country, the default included, FIFO order not applied. */
  candidates: GreenLot[];
  /**
   * Phase 3 (stock locations): the production site the roast draws at — every lot above carries `siteKg` (what it holds
   * there) and `elsewhere` (its largest balance at another active site). Null only when no production site is set.
   */
  site: GreenSite | null;
};

/**
 * The facts the automatic green-lot choice is made from, for a stock roast (`productId`) or an
 * order-backed one (`orderItemId`). The product's default lot first; a legacy order line whose
 * product names none falls back to the lot the line itself recorded at order time.
 */
export type GreenSourceArgs = {
  productId?: string | null; orderItemId?: string | null;
  /** The roaster's / station's own location (20261117090000, owner decision 5); null = the production site. */
  siteId?: string | null;
};

export async function greenSourceFacts(db: Db, args: GreenSourceArgs): Promise<GreenSourceFacts | null> {
  let productId = args.productId ?? null;
  let lineLotId: string | null = null;
  if (args.orderItemId) {
    const line = await db.orderItem.findUnique({
      where: { id: args.orderItemId },
      select: { productId: true, greenBeanId: true, productSku: { select: { productId: true } } },
    });
    if (!line) return null;
    productId = line.productSku?.productId ?? line.productId ?? null;
    lineLotId = line.greenBeanId;
  }
  const product = productId
    ? await db.coffeeProduct.findUnique({
        where: { id: productId },
        select: { id: true, productNameEn: true, productNameAr: true, expectedRoastLoss: true, defaultGreenBeanId: true },
      })
    : null;
  if (args.productId && !product) return null;

  const defaultId = product?.defaultGreenBeanId ?? lineLotId;
  const defaultLot = defaultId ? await db.greenBean.findUnique({ where: { id: defaultId }, select: LOT_SELECT }) : null;
  const candidates = defaultLot
    ? await db.greenBean.findMany({
        where: {
          isActive: true,
          beanType: { equals: defaultLot.beanType, mode: "insensitive" },
          country: { equals: defaultLot.country, mode: "insensitive" },
        },
        select: LOT_SELECT,
        orderBy: [{ receivedDate: "asc" }, { createdAt: "asc" }],
        take: 50,
      })
    : [];
  // Phase 3: what each lot holds at the roasting site (the roaster's / station's location, else the production site),
  // and where else it is (one read for all of them). Coffee «في الطريق» is nowhere to draw from yet.
  const siteRow = await workSite(db, args.siteId).catch(() => null);
  const site: GreenSite | null = siteRow ? { id: siteRow.id, nameAr: siteRow.nameAr, nameEn: siteRow.nameEn } : null;
  const ids = [...new Set([defaultLot?.id, ...candidates.map((c) => c.id)].filter((x): x is string => !!x))];
  const balances = site && ids.length
    ? await db.stockBalance.findMany({
        where: { itemKind: "GREEN_BEAN", entityId: { in: ids }, qty: { gt: 0 } },
        select: { entityId: true, locationId: true, qty: true, location: { select: { nameAr: true, nameEn: true, isActive: true } } },
        orderBy: { qty: "desc" },
      })
    : [];
  const withSite = <T extends { id: string }>(l: T): T & { siteKg?: number; elsewhere?: GreenLot["elsewhere"]; elsewhereAll?: GreenLot["elsewhereAll"] } => {
    if (!site) return l;
    const mine = balances.filter((b) => b.entityId === l.id);
    const away = mine.filter((b) => b.locationId !== site.id && b.locationId !== TRANSIT_LOCATION_ID && b.location.isActive)
      .map((b) => ({ locationId: b.locationId, nameAr: b.location.nameAr, nameEn: b.location.nameEn, qty: b.qty }));
    return { ...l, siteKg: mine.find((b) => b.locationId === site.id)?.qty ?? 0, elsewhere: away[0] ?? null, elsewhereAll: away };
  };
  return {
    site,
    productId: product?.id ?? null,
    productNameEn: product?.productNameEn ?? null,
    productNameAr: product?.productNameAr ?? null,
    expectedRoastLoss: product?.expectedRoastLoss ?? 15,
    defaultLot: defaultLot ? withSite(defaultLot) : null,
    candidates: candidates.map(withSite),
  };
}

/** The ONE choice (preview and roast alike): the facts' lots at the facts' production site. */
export function pickFromFacts(facts: GreenSourceFacts | null, kg: number): GreenPick {
  return pickGreenLot(facts?.defaultLot ?? null, facts?.candidates ?? [], kg, facts?.site ?? null);
}

/**
 * Resolve the lot for `kg` of green coffee, or throw the 409 refusal (Arabic message, English
 * errorEn, code GREEN_SOURCE_UNAVAILABLE). Read inside the roast transaction; the decrement that
 * follows stays the atomic `quantityKg >= kg` update, so a lot drained in between still refuses.
 */
export async function resolveGreenLot(db: Db, args: GreenSourceArgs, kg: number): Promise<Extract<GreenPick, { ok: true }>> {
  const facts = await greenSourceFacts(db, args);
  const pick = pickFromFacts(facts, kg);
  if (!pick.ok) {
    const msg = greenRefusal(pick, kg);
    if (pick.reason === "AT_OTHER_SITE") {
      // The friendly STOCK_LOCATION_SHORT (figures, where the coffee is, the prefilled transfer), with the pick's reason.
      try {
        await assertLocationHas(db, { kind: "GREEN_BEAN", entityId: pick.lot.id, locationId: pick.site.id, need: kg });
      } catch (e) {
        throw { ...(e as object), message: msg.ar, errorAr: msg.ar, errorEn: msg.en, reason: "AT_OTHER_SITE" };
      }
    }
    throw { _appCode: 409, message: msg.ar, errorEn: msg.en, code: "GREEN_SOURCE_UNAVAILABLE", reason: pick.reason };
  }
  return pick;
}

/**
 * Council F1 — never switch lots silently: the station sends the «اسحب من» lot it showed (`expectedId`). It is recorded
 * when it is still active, still this coffee (the product's default lot, or an active lot of the same bean and origin),
 * and the production site still covers `kg`; otherwise the roast is refused (409 GREEN_LOT_CHANGED) and the station
 * refreshes its suggestion. Read inside the roast transaction; the atomic `quantityKg >= kg` decrement still follows.
 */
export async function resolveExpectedLot(db: Db, args: GreenSourceArgs, kg: number, expectedId: string): Promise<Extract<GreenPick, { ok: true }>> {
  const facts = await greenSourceFacts(db, args);
  const d = facts?.defaultLot ?? null;
  const lot = [d, ...(facts?.candidates ?? [])].find((l): l is GreenLot => !!l && l.id === expectedId) ?? null;
  const here = lot ? (facts?.site ? lot.siteKg ?? 0 : lot.quantityKg) : 0;
  if (lot && d && lot.isActive && here > 0 && here + 1e-9 >= kg) {
    return { ok: true, lot, source: lot.id === d.id ? "default" : "fifo_fallback", defaultLot: d, site: facts?.site ?? null };
  }
  throw {
    _appCode: 409, code: "GREEN_LOT_CHANGED",
    message: "تغيّر اللوط المقترح — حدّث الشاشة. لم يُسجَّل شيء.",
    errorAr: "تغيّر اللوط المقترح — حدّث الشاشة. لم يُسجَّل شيء.",
    errorEn: "The suggested lot has changed — refresh the screen. Nothing was recorded.",
    expectedGreenBeanId: expectedId,
  };
}
