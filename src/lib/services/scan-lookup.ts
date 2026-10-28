/**
 * What a scanned code names (20261114090000_green_lot_labels): a green lot (GL-00042), a stock material (MT-00007), a
 * finished product's SKU barcode (EAN), or — for text that is none of these — a lot serial number / material code,
 * exactly. Read-only; quantities and states only, never a price or a person.
 */
import { prisma } from "@/lib/db";
import { parseScan } from "@/lib/scan/codes";
import { QTY_EPSILON, covers } from "@/lib/inventory/locations";
import { assertLocationHas, locationQty, roasterSiteId, workSite } from "./stock-locations";

export type ScanHit =
  | { kind: "GREEN_LOT"; id: string; code: string; serialNumber: string; beanType: string; beanTypeAr: string | null; country: string; countryAr: string | null; quantityKg: number; isActive: boolean; sackCount: number | null; sackWeightKg: number | null }
  | { kind: "MATERIAL"; id: string; code: string; itemCode: string; name: string; nameAr: string | null; unit: string; quantityOnHand: number; isActive: boolean; categoryId: string | null }
  | { kind: "SKU"; id: string; skuCode: string; barcode: string; productId: string; name: string; nameAr: string | null };

export type ScanResult = { ok: true; hit: ScanHit; scanned: string } | { ok: false; code: "EMPTY" | "NOT_FOUND" | "AMBIGUOUS"; scanned: string };

const GREEN_SELECT = { id: true, labelCode: true, serialNumber: true, beanType: true, beanTypeAr: true, country: true, countryAr: true, quantityKg: true, isActive: true, sackCount: true, sackWeightKg: true } as const;
const MAT_SELECT = { id: true, labelCode: true, code: true, name: true, nameAr: true, unitOfMeasure: true, quantityOnHand: true, isActive: true, categoryId: true } as const;

type GreenRow = { id: string; labelCode: string; serialNumber: string; beanType: string; beanTypeAr: string | null; country: string; countryAr: string | null; quantityKg: number; isActive: boolean; sackCount: number | null; sackWeightKg: number | null };
type MatRow = { id: string; labelCode: string; code: string; name: string; nameAr: string | null; unitOfMeasure: string; quantityOnHand: number; isActive: boolean; categoryId: string | null };

const green = (g: GreenRow): ScanHit => ({ kind: "GREEN_LOT", id: g.id, code: g.labelCode, serialNumber: g.serialNumber, beanType: g.beanType, beanTypeAr: g.beanTypeAr, country: g.country, countryAr: g.countryAr, quantityKg: g.quantityKg, isActive: g.isActive, sackCount: g.sackCount, sackWeightKg: g.sackWeightKg });
const material = (m: MatRow): ScanHit => ({ kind: "MATERIAL", id: m.id, code: m.labelCode, itemCode: m.code, name: m.name, nameAr: m.nameAr, unit: m.unitOfMeasure, quantityOnHand: m.quantityOnHand, isActive: m.isActive, categoryId: m.categoryId });

/** `only` limits the answer to one kind (a roast draw scans green lots only). */
export async function lookupScan(raw: unknown, only?: "GREEN_LOT" | "MATERIAL"): Promise<ScanResult> {
  const p = parseScan(raw);
  const scanned = p.kind === "GREEN_LOT" || p.kind === "MATERIAL" ? p.code : p.kind === "EMPTY" ? "" : p.value;
  if (p.kind === "EMPTY") return { ok: false, code: "EMPTY", scanned };
  const nf = { ok: false as const, code: "NOT_FOUND" as const, scanned };
  if (p.kind === "GREEN_LOT") {
    if (only === "MATERIAL") return nf;
    const g = await prisma.greenBean.findUnique({ where: { labelCode: p.code }, select: GREEN_SELECT });
    return g ? { ok: true, hit: green(g), scanned } : nf;
  }
  if (p.kind === "MATERIAL") {
    if (only === "GREEN_LOT") return nf;
    const m = await prisma.materialItem.findUnique({ where: { labelCode: p.code }, select: MAT_SELECT });
    return m ? { ok: true, hit: material(m), scanned } : nf;
  }
  if (p.kind === "EAN" && !only) {
    const s = await prisma.productSKU.findFirst({ where: { barcode: p.value }, select: { id: true, skuCode: true, barcode: true, productId: true, name: true, nameAr: true } });
    if (s) return { ok: true, hit: { kind: "SKU", id: s.id, skuCode: s.skuCode, barcode: s.barcode ?? p.value, productId: s.productId, name: s.name ?? s.skuCode, nameAr: s.nameAr ?? null }, scanned };
  }
  // Text: the serial number printed on an older sticker, or a material's own code — exact, as mapped or as typed.
  const values = p.kind === "TEXT" ? [...new Set([p.value, p.raw])].filter(Boolean) : [p.value];
  if (only !== "MATERIAL") {
    // A serial number is free text, not unique: two lots answering it are never guessed between (council LOW) — the
    // label code (GL-…) is.
    const gs = await prisma.greenBean.findMany({ where: { OR: values.map((v) => ({ serialNumber: { equals: v, mode: "insensitive" as const } })) }, select: GREEN_SELECT, take: 2 });
    if (gs.length > 1) return { ok: false, code: "AMBIGUOUS", scanned };
    if (gs[0]) return { ok: true, hit: green(gs[0]), scanned };
  }
  if (only !== "GREEN_LOT") {
    const m = await prisma.materialItem.findFirst({ where: { OR: values.map((v) => ({ code: { equals: v, mode: "insensitive" as const } })) }, select: MAT_SELECT });
    if (m) return { ok: true, hit: material(m), scanned };
  }
  return nf;
}

/**
 * A scanned lot at the roast draw: refused when inactive or holding less than the green weight being charged, and
 * flagged when it is not the coffee of the product being roasted (the product's default lot names the bean and its
 * country — the same rule the automatic FIFO fallback uses, src/lib/green-source.ts). Bilingual reasons.
 */
export type DrawCheck =
  | { ok: true; sameCoffee: boolean | null }
  | { ok: false; code: "LOT_INACTIVE" | "LOT_SHORT" | "OTHER_COFFEE" | "STOCK_LOCATION_SHORT"; ar: string; en: string; location?: Record<string, unknown> };

type ShortFail = { location?: Record<string, unknown> & { from?: { nameAr: string; nameEn: string | null; qty: number } | null } };

/**
 * Phase 3 (20261115090000_stock_locations): a roast draws green AT the production site, so a scanned lot must be there
 * too — the company total is not enough. Refused (STOCK_LOCATION_SHORT) with where the coffee is and the prefilled
 * transfer, as the roast itself would be.
 */
async function productionSiteCheck(lot: { id: string; serialNumber: string }, need: number, siteId: string | null): Promise<DrawCheck | null> {
  // The roaster's / station's site (20261117090000, owner decision 5), else the production site.
  const site = await workSite(prisma, siteId);
  const have = await locationQty(prisma, "GREEN_BEAN", lot.id, site.id);
  if (need > 0 ? covers(have, need) : have > QTY_EPSILON) return null;
  try {
    await assertLocationHas(prisma, { kind: "GREEN_BEAN", entityId: lot.id, locationId: site.id, need: need > 0 ? need : 0.001 });
    return null;
  } catch (e) {
    const f = e as ShortFail;
    const from = f.location?.from ?? null;
    const whereAr = from ? ` البن في «${from.nameAr}» (${Math.round(from.qty * 100) / 100} كغ) — حوّله إلى «${site.nameAr}» أولًا.` : "";
    const whereEn = from ? ` The coffee is at «${from.nameEn || from.nameAr}» (${Math.round(from.qty * 100) / 100} kg) — transfer it to «${site.nameEn || site.nameAr}» first.` : "";
    const h = Math.round(have * 100) / 100;
    return need > 0
      ? { ok: false, code: "STOCK_LOCATION_SHORT", ar: `لا يكفي البن في «${site.nameAr}» (${site.isProduction ? "موقع الإنتاج" : "موقع التحميص"}): المتوفر ${h} كغ والمطلوب ${need} كغ.${whereAr}`, en: `Not enough at «${site.nameEn || site.nameAr}» (${site.isProduction ? "the production site" : "the roasting site"}): ${h} kg available, ${need} kg needed.${whereEn}`, location: f.location }
      : { ok: false, code: "STOCK_LOCATION_SHORT", ar: `اللوت ${lot.serialNumber} ليس في «${site.nameAr}» (${site.isProduction ? "موقع الإنتاج" : "موقع التحميص"}).${whereAr}`, en: `Lot ${lot.serialNumber} is not at «${site.nameEn || site.nameAr}» (${site.isProduction ? "the production site" : "the roasting site"}).${whereEn}`, location: f.location };
  }
}

export async function greenDrawCheck(lot: { id: string; beanType: string; country: string; quantityKg: number; isActive: boolean; serialNumber: string }, productId: string | null, kg: number, allowOtherCoffee = false, roasterId: string | null = null): Promise<DrawCheck> {
  if (!lot.isActive) return { ok: false, code: "LOT_INACTIVE", ar: `اللوت ${lot.serialNumber} غير نشط — لا يُسحب منه. اطلب من المشرف تفعيله أو اختر لوتًا آخر.`, en: `Lot ${lot.serialNumber} is inactive — nothing is drawn from it. Ask the supervisor to reactivate it, or scan another lot.` };
  const need = Number.isFinite(kg) && kg > 0 ? kg : 0;
  if (lot.quantityKg <= 0 || lot.quantityKg + 1e-9 < need) {
    const have = (Math.round(lot.quantityKg * 100) / 100).toString();
    return need > 0
      ? { ok: false, code: "LOT_SHORT", ar: `لا يكفي اللوت ${lot.serialNumber}: المطلوب ${need} كغ والمتاح ${have} كغ.`, en: `Lot ${lot.serialNumber} is short: ${need} kg needed, ${have} kg available.` }
      : { ok: false, code: "LOT_SHORT", ar: `اللوت ${lot.serialNumber} فارغ (0 كغ).`, en: `Lot ${lot.serialNumber} is empty (0 kg).` };
  }
  const atSite = await productionSiteCheck(lot, need, await roasterSiteId(prisma, roasterId));
  if (atSite) return atSite;
  return otherCoffeeCheck(lot, productId, allowOtherCoffee);
}

/**
 * Is `lot` the coffee of `productId` (its default lot, or the same bean and country)? Another coffee is refused
 * (OTHER_COFFEE) unless `allowOtherCoffee` (production › roast_to_stock). Used by the scan draw check AND by the roast
 * POST for a stated lot (council MEDIUM: the station record route cannot bypass it).
 */
export async function otherCoffeeCheck(lot: { id: string; beanType: string; country: string; serialNumber: string }, productId: string | null, allowOtherCoffee = false): Promise<DrawCheck> {
  if (!productId) return { ok: true, sameCoffee: null };
  const p = await prisma.coffeeProduct.findUnique({ where: { id: productId }, select: { defaultGreenBean: { select: { id: true, beanType: true, country: true } } } });
  const d = p?.defaultGreenBean;
  if (!d) return { ok: true, sameCoffee: null };
  const same = d.id === lot.id || (d.beanType.trim().toLowerCase() === lot.beanType.trim().toLowerCase() && d.country.trim().toLowerCase() === lot.country.trim().toLowerCase());
  if (!same && !allowOtherCoffee) return { ok: false, code: "OTHER_COFFEE", ar: `اللوت ${lot.serialNumber} ليس من بن هذا المنتج (${d.beanType}). اطلب من المشرف تغيير المصدر.`, en: `Lot ${lot.serialNumber} is not this product's coffee (${d.beanType}). Ask the supervisor to change the source.` };
  return { ok: true, sameCoffee: same };
}
