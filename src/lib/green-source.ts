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
 */
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
};

export type GreenPick =
  | { ok: true; lot: GreenLot; source: "default" | "fifo_fallback"; defaultLot: GreenLot | null }
  | { ok: false; reason: "NO_DEFAULT" | "INSUFFICIENT"; defaultLot: GreenLot | null; availableKg: number };

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
export function pickGreenLot(defaultLot: GreenLot | null, candidates: GreenLot[], kg: number): GreenPick {
  const need = Math.max(0, kg);
  const enough = (l: GreenLot) => l.isActive && l.quantityKg > 0 && l.quantityKg + 1e-9 >= need;
  if (!defaultLot) return { ok: false, reason: "NO_DEFAULT", defaultLot: null, availableKg: 0 };
  if (enough(defaultLot)) return { ok: true, lot: defaultLot, source: "default", defaultLot };
  const fallback = fifo(candidates.filter((c) => c.id !== defaultLot.id && sameOrigin(c, defaultLot))).find(enough);
  if (fallback) return { ok: true, lot: fallback, source: "fifo_fallback", defaultLot };
  const availableKg = Math.max(
    defaultLot.isActive ? defaultLot.quantityKg : 0,
    ...candidates.filter((c) => c.isActive && sameOrigin(c, defaultLot)).map((c) => c.quantityKg),
  );
  return { ok: false, reason: "INSUFFICIENT", defaultLot, availableKg };
}

/** The refusal the server returns (409) and the sheet shows, in both languages. */
export function greenRefusal(p: Extract<GreenPick, { ok: false }>, kg: number): { ar: string; en: string } {
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
    ar: `لا يكفي البن الأخضر لهذه الدفعة: المطلوب ${kgText(kg)} كغ من ${name}، وأكبر رصيد متاح ${kgText(p.availableKg)} كغ. اطلب من المشرف اختيار مصدر آخر أو استلام مخزون.`,
    en: `Not enough green coffee for this batch: ${kgText(kg)} kg of ${d.beanType} (${d.country}) needed, the largest available lot holds ${kgText(p.availableKg)} kg. Ask the supervisor to pick another lot or receive stock.`,
  };
}
