// Unified inventory phase 3 — stock locations (20261115090000_stock_locations). The rules a location follows, defined
// once and pure (no database: safe in unit tests and in the browser). A location says WHERE stock is; a category
// (phase 1) says WHAT it is. Valuation stays company-wide — the moving-average cost ledger is per item, never per
// location, and a transfer between locations is a cost-ledger TRANSFER with no journal entry (same company, same
// inventory account; council roles 01 / 02).

export const LOCATION_TYPES = ["ROASTERY", "WAREHOUSE", "CAFE", "BRANCH", "OTHER"] as const;
export type LocationType = (typeof LOCATION_TYPES)[number];

export const LOCATION_TYPE_LABEL: Record<LocationType, [string, string]> = {
  ROASTERY: ["محمصة / مصنع", "Roastery"],
  WAREHOUSE: ["مستودع", "Warehouse"],
  CAFE: ["مقهى", "Café"],
  BRANCH: ["فرع", "Branch"],
  OTHER: ["أخرى", "Other"],
};

export type StockItemKind = "GREEN_BEAN" | "MATERIAL";
export const STOCK_ITEM_KINDS: readonly StockItemKind[] = ["GREEN_BEAN", "MATERIAL"];

/** The seeded sites (ids only: their names, types, order and the default are the owner's to change). */
export const SEEDED_LOCATIONS = { roastery: "loc_roastery", warehouse: "loc_warehouse", cafe: "loc_cafe" } as const;

export type LocationRow = {
  id: string; code: string; nameAr: string; nameEn: string | null; type: string; isActive: boolean; isDefault: boolean; sortOrder: number;
  /** The production site (exactly one): roasting, packing and every writer that names no site book there. */
  isProduction: boolean;
};

/** Tolerance of a stock quantity comparison (balances are doubles kept to 4 decimals by their writers). */
export const QTY_EPSILON = 0.0000005;

export const isLocationType = (v: unknown): v is LocationType => typeof v === "string" && (LOCATION_TYPES as readonly string[]).includes(v);

/** A location's name in the page language (English falls back to Arabic). */
export function locationName(l: Pick<LocationRow, "nameAr" | "nameEn">, lang: "ar" | "en" | string): string {
  return lang === "en" ? l.nameEn || l.nameAr : l.nameAr;
}

/** Code: trimmed, upper-case, 1–16 of A–Z 0–9 and '-', starting with a letter or digit (the database CHECK). */
export function normalizeLocationCode(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const c = v.trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9-]{0,15}$/.test(c) ? c : null;
}

/** A short code proposed from an English (or any Latin) name: «Jubail branch» → JUBAIL. */
export function suggestLocationCode(nameEn: string | null | undefined, taken: ReadonlySet<string>): string {
  const base = (nameEn ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 8) || "LOC";
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const c = `${base.slice(0, 12)}-${i}`;
    if (!taken.has(c)) return c;
  }
  return `${base}-${Date.now() % 10000}`;
}

/**
 * Where production draws from and packs at: the site the owner flagged «موقع الإنتاج» (exactly one, active — the
 * database keeps it so; seeded on the roasting plant). It is also where a writer that names no site books
 * (stock_location_current()), so changing the default RECEIVING site never moves production. Workstations carry no
 * location yet (a later phase can name one per station).
 */
export function pickProductionLocation<T extends LocationRow>(rows: readonly T[]): T | null {
  return rows.find((r) => r.isProduction && r.isActive) ?? null;
}

/** Active locations for a picker, in their order (the default first among equals). */
export function pickerLocations<T extends LocationRow>(rows: readonly T[]): T[] {
  return rows.filter((r) => r.isActive).sort((a, b) => a.sortOrder - b.sortOrder || Number(b.isDefault) - Number(a.isDefault) || a.code.localeCompare(b.code));
}

// ─── Refusals ───────────────────────────────────────────────────────────────────────────────────

export type LocationRefusal = { status: number; code: string; error: string; errorEn: string; locationId?: string; available?: number; requested?: number; itemKind?: string; entityId?: string };

const num = (s: string | undefined) => (s === undefined || s === "" ? undefined : Number(s));
const q = (n: number | undefined) => (n === undefined || !Number.isFinite(n) ? "—" : String(Number(n.toFixed(4))));

/** «انقل الرصيد أولًا» — the stock a location still holds. */
export function holdsStockRefusal(name: string, locationId?: string): LocationRefusal {
  return {
    status: 409, code: "STOCK_LOCATION_HOLDS_STOCK", locationId,
    error: `الموقع «${name}» ما زال فيه رصيد. انقل الرصيد أولًا ثم أوقف الموقع.`,
    errorEn: `«${name}» still holds stock. Move the stock first, then deactivate the location.`,
  };
}
export function defaultLocationRefusal(name: string, locationId?: string): LocationRefusal {
  return {
    status: 409, code: "STOCK_LOCATION_DEFAULT", locationId,
    error: `«${name}» هو موقع الاستلام الافتراضي ولا يُوقف. اختر موقعًا افتراضيًا آخر أولًا.`,
    errorEn: `«${name}» is the default receiving location and cannot be deactivated. Make another location the default first.`,
  };
}
export function productionRefusal(name: string, locationId?: string): LocationRefusal {
  return {
    status: 409, code: "STOCK_LOCATION_PRODUCTION", locationId,
    error: `«${name}» هو موقع الإنتاج (التحميص والتعبئة) ولا يُوقف. اختر موقع إنتاج آخر أولًا.`,
    errorEn: `«${name}» is the production site (roasting and packing) and cannot be deactivated. Choose another production site first.`,
  };
}
export function shortRefusal(name: string, available: number | undefined, requested: number | undefined, extra: Partial<LocationRefusal> = {}): LocationRefusal {
  return {
    status: 409, code: "STOCK_LOCATION_SHORT", available, requested, ...extra,
    error: `الرصيد في «${name}» لا يكفي: المتوفر ${q(available)} والمطلوب ${q(requested)}. حوّل المخزون إلى هذا الموقع أولًا.`,
    errorEn: `Not enough stock at «${name}»: ${q(available)} available, ${q(requested)} needed. Transfer the stock to this location first.`,
  };
}
export function inactiveRefusal(name: string, locationId?: string): LocationRefusal {
  return {
    status: 409, code: "STOCK_LOCATION_INACTIVE", locationId,
    error: `الموقع «${name}» موقوف ولا يستقبل مخزونًا. أعد تفعيله أو اختر موقعًا آخر.`,
    errorEn: `«${name}» is inactive and receives no stock. Reactivate it or choose another location.`,
  };
}

/** The bilingual refusal of a database stock-location guard (stock_balance_sync / _guard, stock_location_guard), or null. */
export function locationDbRefusal(message: string): LocationRefusal | null {
  const m = /(STOCK_LOCATION_SHORT|STOCK_LOCATION_INACTIVE|STOCK_LOCATION_HOLDS_STOCK|STOCK_LOCATION_DEFAULT|STOCK_LOCATION_PRODUCTION)\|([^|\n]*)\|([^|\n]*)(?:\|([^|\n]*)\|([^|\n]*)\|([^|\n]*)\|([^|\s]*))?/.exec(message);
  if (m) {
    const [, code, id, name] = m;
    if (code === "STOCK_LOCATION_SHORT") return shortRefusal(name, num(m[4]), num(m[5]), { locationId: id, itemKind: m[6], entityId: m[7] });
    if (code === "STOCK_LOCATION_INACTIVE") return inactiveRefusal(name, id);
    if (code === "STOCK_LOCATION_HOLDS_STOCK") return holdsStockRefusal(name, id);
    if (code === "STOCK_LOCATION_PRODUCTION") return productionRefusal(name, id);
    return defaultLocationRefusal(name, id);
  }
  if (/STOCK_LOCATION_NO_PRODUCTION/.test(message)) {
    return { status: 409, code: "STOCK_LOCATION_NO_PRODUCTION", error: "يجب أن يكون هناك موقع إنتاج واحد.", errorEn: "Exactly one production site is required." };
  }
  if (/STOCK_BALANCE_DIRECT_WRITE/.test(message)) {
    return { status: 409, code: "STOCK_BALANCE_DIRECT_WRITE", error: "رصيد الموقع يتغيّر مع الإجمالي أو بتحويل فقط.", errorEn: "A location balance changes only with its total or by a transfer." };
  }
  if (/STOCK_LOCATION_NO_DEFAULT/.test(message)) {
    return { status: 409, code: "STOCK_LOCATION_NO_DEFAULT", error: "يجب أن يكون هناك موقع استلام افتراضي واحد.", errorEn: "Exactly one default receiving location is required." };
  }
  if (/STOCK_BALANCE_MISMATCH/.test(message)) {
    return { status: 409, code: "STOCK_BALANCE_MISMATCH", error: "أرصدة المواقع لا تساوي الإجمالي؛ لم يُحفظ شيء.", errorEn: "The location balances would not add up to the total; nothing was saved." };
  }
  if (/STOCK_LOCATION_UNKNOWN/.test(message)) {
    return { status: 404, code: "STOCK_LOCATION_NOT_FOUND", error: "الموقع غير موجود.", errorEn: "Location not found." };
  }
  return null;
}

/** The link of a prefilled transfer («تحويل مخزون») from one location (and, optionally, to another / of one item). */
export function transferLink(a: { from?: string | null; to?: string | null; kind?: string | null; item?: string | null; qty?: number | null }): string {
  const p = new URLSearchParams();
  if (a.from) p.set("from", a.from);
  if (a.to) p.set("to", a.to);
  if (a.kind && a.item) { p.set("kind", a.kind); p.set("item", a.item); }
  if (a.qty && a.qty > 0) p.set("qty", String(Number(a.qty.toFixed(4))));
  const s = p.toString();
  return `/dashboard/inventory/transfers/new${s ? `?${s}` : ""}`;
}

// ─── Transfers (pure parts) ─────────────────────────────────────────────────────────────────────

export const MAX_TRANSFER_LINES = 100;

export type TransferLineInput = { itemKind: StockItemKind; entityId: string; qty: number; notes: string | null };

/** Validate a transfer's lines (shape and quantities); duplicates of one item are merged. */
export function parseTransferLines(raw: unknown): { ok: true; lines: TransferLineInput[] } | { ok: false; code: string; error: string; errorEn: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, code: "TRANSFER_LINES_REQUIRED", error: "أضف صنفًا واحدًا على الأقل.", errorEn: "Add at least one item." };
  if (raw.length > MAX_TRANSFER_LINES) return { ok: false, code: "TRANSFER_TOO_LARGE", error: `${MAX_TRANSFER_LINES} سطرًا كحد أقصى.`, errorEn: `At most ${MAX_TRANSFER_LINES} lines.` };
  const merged = new Map<string, TransferLineInput>();
  for (const [i, it] of raw.entries()) {
    const r = (it ?? {}) as Record<string, unknown>;
    const kind = r.itemKind === "GREEN_BEAN" || r.itemKind === "MATERIAL" ? r.itemKind : null;
    const id = typeof r.entityId === "string" && r.entityId.trim() ? r.entityId.trim().slice(0, 64) : null;
    const n = typeof r.qty === "number" ? r.qty : typeof r.qty === "string" && /^\d{1,9}(\.\d{1,4})?$/.test(r.qty.trim()) ? Number(r.qty) : NaN;
    if (!kind || !id) return { ok: false, code: "TRANSFER_LINE_INVALID", error: `السطر ${i + 1}: اختر الصنف.`, errorEn: `Line ${i + 1}: choose the item.` };
    if (!Number.isFinite(n) || n <= 0 || n > 1_000_000 || Number(n.toFixed(4)) !== n) {
      return { ok: false, code: "TRANSFER_LINE_INVALID", error: `السطر ${i + 1}: الكمية أكبر من صفر (4 خانات عشرية كحد أقصى).`, errorEn: `Line ${i + 1}: quantity above zero (at most 4 decimals).` };
    }
    const k = `${kind}:${id}`;
    const prev = merged.get(k);
    const notes = typeof r.notes === "string" && r.notes.trim() ? r.notes.trim().slice(0, 300) : null;
    if (prev) prev.qty = Number((prev.qty + n).toFixed(4));
    else merged.set(k, { itemKind: kind, entityId: id, qty: n, notes });
  }
  return { ok: true, lines: [...merged.values()] };
}

/** Whether a quantity `need` is available in `have` (with the float tolerance). */
export const covers = (have: number, need: number) => have + QTY_EPSILON >= need;
