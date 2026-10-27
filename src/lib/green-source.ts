/**
 * Which green lot a roast draws on, when the roaster does not choose one (production
 * simplification item 1, owner decision O1). Pure and client-safe: the roast sheet shows the
 * same answer the server will apply, from the same function.
 *
 *   1. The product's default green lot (CoffeeProduct.defaultGreenBeanId), while it is active
 *      and holds at least the green weight being charged.
 *   2. Otherwise — O1 — the OLDEST other active lot of the same beanType and country (FIFO by
 *      receivedDate, then createdAt) that holds enough. Shown to the roaster as an info line.
 *   3. Otherwise none: the server refuses with 409 and a message telling the roaster to ask the
 *      supervisor (who may pick another lot, or update the product).
 *
 * Phase 3 (stock locations, council HIGH): with the production `site` given, «enough» is what the lot
 * holds AT that site (`siteKg`) — the roast draws there. When no lot holds enough at the site but one
 * holds enough company-wide, the answer is AT_OTHER_SITE: that lot, where it is, the shortfall and the
 * prefilled transfer («بانتظار تحويل»). Otherwise INSUFFICIENT, reporting the largest SITE quantity.
 */
import { transferLink } from "@/lib/inventory/locations";

/** Where else a lot is held (the largest balance at another active site). */
export type LotElsewhere = { locationId: string; nameAr: string; nameEn: string | null; qty: number };
export type GreenSite = { id: string; nameAr: string; nameEn: string | null };
export type GreenLot = {
  id: string;
  serialNumber: string;
  beanType: string;
  beanTypeAr?: string | null;
  country: string;
  countryAr?: string | null;
  quantityKg: number;
  isActive: boolean;
  receivedDate: string | Date;
  createdAt?: string | Date;
  /** The scanner code on its label (GL-00042), when known. */
  labelCode?: string | null;
  sackCount?: number | null;
  sackWeightKg?: number | null;
  /** Phase 3: what the lot holds at the production site (absent: no site known — the total decides). */
  siteKg?: number;
  /** Phase 3: the largest balance of the lot at another active site. */
  elsewhere?: LotElsewhere | null;
  /** Every other active site holding it, largest first (the first is `elsewhere`). */
  elsewhereAll?: LotElsewhere[];
};

export type GreenPick =
  | { ok: true; lot: GreenLot; source: "default" | "fifo_fallback"; defaultLot: GreenLot | null; site: GreenSite | null }
  | { ok: false; reason: "NO_DEFAULT" | "INSUFFICIENT"; defaultLot: GreenLot | null; availableKg: number; site: GreenSite | null }
  | {
      ok: false; reason: "AT_OTHER_SITE"; defaultLot: GreenLot | null; availableKg: number; site: GreenSite;
      /** The lot to bring to the production site (the default when it holds enough company-wide, else FIFO). */
      lot: GreenLot;
      /**
       * Where it is now (its largest balance elsewhere), the kilograms missing at the site, and the prefilled transfer of
       * what that one site can send — min(shortfall, its balance). `restKg` > 0: the rest is needed from `others`.
       */
      from: LotElsewhere | null; shortKg: number; transferHref: string; transferKg: number; restKg: number; others: LotElsewhere[];
    };

const time = (v: string | Date | undefined) => (v ? new Date(v).getTime() : 0);
const sameOrigin = (a: GreenLot, b: GreenLot) =>
  a.beanType.trim().toLowerCase() === b.beanType.trim().toLowerCase() && a.country.trim().toLowerCase() === b.country.trim().toLowerCase();

/** FIFO order: oldest received first, then oldest created, then id (stable). */
export function fifo(lots: GreenLot[]): GreenLot[] {
  return [...lots].sort((a, b) => time(a.receivedDate) - time(b.receivedDate) || time(a.createdAt) - time(b.createdAt) || a.id.localeCompare(b.id));
}

/**
 * `defaultLot`: the product's default lot (null when the product names none, or it no longer
 * exists). `candidates`: active lots of any origin — only those of the default lot's beanType +
 * country are considered. `kg`: the green weight being charged (0 = only "has any stock").
 */
export function pickGreenLot(defaultLot: GreenLot | null, candidates: GreenLot[], kg: number, site: GreenSite | null = null): GreenPick {
  const need = Math.max(0, kg);
  // With a production site, a lot is drawn from what it holds THERE; without one, from its total (as before).
  const here = (l: GreenLot) => (site ? l.siteKg ?? 0 : l.quantityKg);
  const covers = (have: number) => have > 0 && have + 1e-9 >= need;
  const enough = (l: GreenLot) => l.isActive && covers(here(l));
  if (!defaultLot) return { ok: false, reason: "NO_DEFAULT", defaultLot: null, availableKg: 0, site };
  if (enough(defaultLot)) return { ok: true, lot: defaultLot, source: "default", defaultLot, site };
  const others = fifo(candidates.filter((c) => c.id !== defaultLot.id && sameOrigin(c, defaultLot)));
  const fallback = others.find(enough);
  if (fallback) return { ok: true, lot: fallback, source: "fifo_fallback", defaultLot, site };
  const availableKg = Math.max(0, defaultLot.isActive ? here(defaultLot) : 0, ...others.filter((c) => c.isActive).map(here));
  if (site) {
    // Enough in the company, not at the site: the coffee waits for a transfer (never drawn elsewhere).
    const away = [defaultLot, ...others].find((l) => l.isActive && covers(l.quantityKg));
    if (away) {
      const r4 = (n: number) => Math.round(n * 10_000) / 10_000;
      const shortKg = r4(Math.max(0, need - (away.siteKg ?? 0)));
      const from = away.elsewhere ?? null;
      // One transfer from the largest other site, never more than it holds (council F4); the rest from the next ones.
      const transferKg = r4(from ? Math.min(shortKg, from.qty) : shortKg);
      const restKg = r4(Math.max(0, shortKg - transferKg));
      const others = restKg > 0 ? (away.elsewhereAll ?? []).filter((e) => e.locationId !== from?.locationId) : [];
      return {
        ok: false, reason: "AT_OTHER_SITE", defaultLot, availableKg, site, lot: away, from, shortKg, transferKg, restKg, others,
        transferHref: transferLink({ from: from?.locationId ?? null, to: site.id, kind: "GREEN_BEAN", item: away.id, qty: transferKg > 0 ? transferKg : null }),
      };
    }
  }
  return { ok: false, reason: "INSUFFICIENT", defaultLot, availableKg, site };
}

/**
 * The sacks to open for `kg`, when the lot's sacks are known (labels «كيس 3 من 15»): the first not yet emptied, as far
 * as `kg` reaches. Approximate by design (a partly used sack counts as the next one). Null when sacks are unknown.
 */
export function sackRange(lot: Pick<GreenLot, "quantityKg" | "sackCount" | "sackWeightKg">, kg: number): { from: number; to: number; of: number } | null {
  const n = lot.sackCount ?? 0, w = lot.sackWeightKg ?? 0;
  if (!(n > 0) || !(w > 0)) return null;
  const left = Math.min(n, Math.max(0, Math.ceil(lot.quantityKg / w - 1e-9)));
  if (left === 0) return null;
  const from = n - left + 1;
  const to = Math.min(n, from + Math.max(1, Math.ceil(Math.max(0, kg) / w - 1e-9)) - 1);
  return { from, to, of: n };
}

/** The refusal the server returns (409) and the sheet shows, in both languages. */
export function greenRefusal(p: Extract<GreenPick, { ok: false }>, kg: number): { ar: string; en: string } {
  const kgT = (v: number) => (Math.round(v * 100) / 100).toString();
  if (p.reason === "AT_OTHER_SITE") {
    const l = p.lot;
    const code = l.labelCode ? ` · ${l.labelCode}` : "";
    const fromAr = p.from ? `في «${p.from.nameAr}»` : "في موقع آخر";
    const fromEn = p.from ? `at «${p.from.nameEn || p.from.nameAr}»` : "at another location";
    // The card / sheet titles already say «بانتظار تحويل»: the message starts with the coffee (cosmetic, council).
    const restAr = p.restKg > 0 ? ` يكفي «${p.from?.nameAr ?? ""}» ${kgT(p.transferKg)} كغ، والباقي ${kgT(p.restKg)} كغ مطلوب من موقع آخر: ${p.others.map((o) => `«${o.nameAr}» (${kgT(o.qty)} كغ)`).join("، ")}.` : "";
    const restEn = p.restKg > 0 ? ` «${p.from?.nameEn || p.from?.nameAr || ""}» can send ${kgT(p.transferKg)} kg; the remaining ${kgT(p.restKg)} kg are needed from another site: ${p.others.map((o) => `«${o.nameEn || o.nameAr}» (${kgT(o.qty)} kg)`).join(", ")}.` : "";
    return {
      ar: `البن ${l.beanTypeAr || l.beanType} (${l.serialNumber}${code}) ${fromAr}، ويلزم ${kgT(p.shortKg)} كغ في «${p.site.nameAr}» لهذه الدفعة. حوّله قبل التحميص.${restAr}`,
      en: `${l.beanType} (${l.serialNumber}${code}) is ${fromEn}; ${kgT(p.shortKg)} kg are needed at «${p.site.nameEn || p.site.nameAr}» for this batch. Transfer it before roasting.${restEn}`,
    };
  }
  if (p.reason === "NO_DEFAULT") {
    return {
      ar: "هذا المنتج لا يحدد بنًا أخضر افتراضيًا. اطلب من المشرف ضبطه في إعداد المنتج أو اختيار مصدر البن.",
      en: "This product names no default green coffee. Ask the supervisor to set it on the product, or to pick the green lot.",
    };
  }
  const d = p.defaultLot!;
  const name = `${d.beanTypeAr || d.beanType} · ${d.countryAr || d.country}`;
  const kgText = (v: number) => (Math.round(v * 100) / 100).toString();
  return {
    ar: `لا يكفي البن الأخضر لهذه الدفعة: المطلوب ${kgText(kg)} كغ من ${name}، وأكبر رصيد متاح${p.site ? ` في «${p.site.nameAr}»` : ""} ${kgText(p.availableKg)} كغ. اطلب من المشرف اختيار مصدر آخر أو استلام مخزون.`,
    en: `Not enough green coffee for this batch: ${kgText(kg)} kg of ${d.beanType} (${d.country}) needed, the largest available lot${p.site ? ` at «${p.site.nameEn || p.site.nameAr}»` : ""} holds ${kgText(p.availableKg)} kg. Ask the supervisor to pick another lot or receive stock.`,
  };
}
