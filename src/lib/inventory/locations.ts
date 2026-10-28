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
/** What a transfer line carries: a green lot / material (a balance), or a finished-goods lot (whole units). */
export type TransferItemKind = StockItemKind | "FG_LOT";

/**
 * «في الطريق» (20261117090000_locations_enhancements): the ONE system location holding what a two-step transfer has
 * sent and not yet received. A real "StockLocation" row (type TRANSIT), so every balance invariant holds unchanged
 * and in-transit stock counts in the company totals and valuation — but never a site anyone picks, receives at,
 * counts, roasts or packs at, and never default / production (database CHECK + guard).
 */
export const TRANSIT_LOCATION_ID = "loc_transit";
export const TRANSIT_TYPE = "TRANSIT";
export const TRANSIT_LABEL: [string, string] = ["في الطريق", "In transit"];
export const isTransitLocation = (l: { id?: string; type?: string } | null | undefined) => !!l && (l.type === TRANSIT_TYPE || l.id === TRANSIT_LOCATION_ID);

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

/** A location's type label («في الطريق» for the transit location). */
export function locationTypeLabel(type: string, lang: "ar" | "en" | string): string {
  const pair = type === TRANSIT_TYPE ? TRANSIT_LABEL : isLocationType(type) ? LOCATION_TYPE_LABEL[type] : null;
  return pair ? (lang === "en" ? pair[1] : pair[0]) : type;
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

/**
 * The site a workstation / roaster works at: its own location when set and active (never transit), else the production
 * site (owner decision 5, 20261117090000: the production site stays the fallback).
 */
export function workSiteOf<T extends LocationRow>(rows: readonly T[], ownLocationId: string | null | undefined): T | null {
  const own = ownLocationId ? rows.find((r) => r.id === ownLocationId && r.isActive && !isTransitLocation(r)) : undefined;
  return own ?? pickProductionLocation(rows);
}

/** Active locations for a picker, in their order (the default first among equals). Never the transit location. */
export function pickerLocations<T extends LocationRow>(rows: readonly T[]): T[] {
  return rows.filter((r) => r.isActive && !isTransitLocation(r)).sort((a, b) => a.sortOrder - b.sortOrder || Number(b.isDefault) - Number(a.isDefault) || a.code.localeCompare(b.code));
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
/** «تحويل في الطريق» — a site named by a transfer on its way is not deactivated (council F2). */
export function inTransitRefusal(name: string, refs: string, locationId?: string): LocationRefusal {
  return {
    status: 409, code: "STOCK_LOCATION_IN_TRANSIT", locationId,
    error: `لا يُوقف «${name}»: تحويلات في الطريق منه أو إليه (${refs}). استلمها أو ألغِها أولًا.`,
    errorEn: `«${name}» cannot be deactivated: transfers on their way from or to it (${refs}). Receive or cancel them first.`,
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
  const t = /STOCK_LOCATION_IN_TRANSIT\|([^|\n]*)\|([^|\n]*)\|([^\n"]*)/.exec(message);
  if (t) return inTransitRefusal(t[2], t[3].trim(), t[1]);
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

export type TransferLineInput = { itemKind: TransferItemKind; entityId: string; qty: number; notes: string | null };

/** Validate a transfer's lines (shape and quantities); duplicates of one item are merged. */
export function parseTransferLines(raw: unknown): { ok: true; lines: TransferLineInput[] } | { ok: false; code: string; error: string; errorEn: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, code: "TRANSFER_LINES_REQUIRED", error: "أضف صنفًا واحدًا على الأقل.", errorEn: "Add at least one item." };
  if (raw.length > MAX_TRANSFER_LINES) return { ok: false, code: "TRANSFER_TOO_LARGE", error: `${MAX_TRANSFER_LINES} سطرًا كحد أقصى.`, errorEn: `At most ${MAX_TRANSFER_LINES} lines.` };
  const merged = new Map<string, TransferLineInput>();
  for (const [i, it] of raw.entries()) {
    const r = (it ?? {}) as Record<string, unknown>;
    const kind = r.itemKind === "GREEN_BEAN" || r.itemKind === "MATERIAL" || r.itemKind === "FG_LOT" ? r.itemKind : null;
    const id = typeof r.entityId === "string" && r.entityId.trim() ? r.entityId.trim().slice(0, 64) : null;
    const n = typeof r.qty === "number" ? r.qty : typeof r.qty === "string" && /^\d{1,9}(\.\d{1,4})?$/.test(r.qty.trim()) ? Number(r.qty) : NaN;
    if (!kind || !id) return { ok: false, code: "TRANSFER_LINE_INVALID", error: `السطر ${i + 1}: اختر الصنف.`, errorEn: `Line ${i + 1}: choose the item.` };
    if (!Number.isFinite(n) || n <= 0 || n > 1_000_000 || Number(n.toFixed(4)) !== n) {
      return { ok: false, code: "TRANSFER_LINE_INVALID", error: `السطر ${i + 1}: الكمية أكبر من صفر (4 خانات عشرية كحد أقصى).`, errorEn: `Line ${i + 1}: quantity above zero (at most 4 decimals).` };
    }
    // A finished lot moves in whole packages (its units).
    if (kind === "FG_LOT" && !Number.isInteger(n)) {
      return { ok: false, code: "TRANSFER_LINE_INVALID", error: `السطر ${i + 1}: المنتج الجاهز يُحوَّل بعدد صحيح من العبوات.`, errorEn: `Line ${i + 1}: finished goods move in whole packages.` };
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

// ─── Two-step transfers (20261117090000_locations_enhancements) ─────────────────────────────────

export const TRANSFER_MODES = ["IMMEDIATE", "TWO_STEP"] as const;
export type TransferMode = (typeof TRANSFER_MODES)[number];
export type TransferStatus = "POSTED" | "IN_TRANSIT" | "RECEIVED" | "CANCELLED";

export const TRANSFER_STATUS_LABEL: Record<TransferStatus, [string, string]> = {
  POSTED: ["مُرحَّل", "Posted"],
  IN_TRANSIT: ["في الطريق", "In transit"],
  RECEIVED: ["مُستلَم", "Received"],
  CANCELLED: ["ملغى", "Cancelled"],
};

export type ReceiveLineInput = { lineNo: number; qtyReceived: number; varianceReason: string | null };

/**
 * Validate a receipt against the sent lines. Every line is answered (a missing line = received in full). A green /
 * material line may arrive short — the shortfall is written off from transit and needs a reason (≥ 3 characters);
 * a finished-goods line is received in full only (whole packages travel as one lot; a missing package is a count
 * correction at the destination afterwards). Never more than was sent.
 */
export function parseReceiveLines(raw: unknown, sent: readonly { lineNo: number; itemKind: string; qty: number }[]):
  { ok: true; lines: (ReceiveLineInput & { qtyShort: number })[] } | { ok: false; code: string; error: string; errorEn: string; lineNo?: number } {
  const given = new Map<number, Record<string, unknown>>();
  if (raw !== undefined && raw !== null) {
    if (!Array.isArray(raw)) return { ok: false, code: "TRANSFER_RECEIVE_INVALID", error: "سطور الاستلام غير صالحة.", errorEn: "The receipt lines are not valid." };
    for (const it of raw) {
      const r = (it ?? {}) as Record<string, unknown>;
      const no = typeof r.lineNo === "number" ? r.lineNo : Number(r.lineNo);
      if (!Number.isInteger(no)) return { ok: false, code: "TRANSFER_RECEIVE_INVALID", error: "سطور الاستلام غير صالحة.", errorEn: "The receipt lines are not valid." };
      given.set(no, r);
    }
  }
  const out: (ReceiveLineInput & { qtyShort: number })[] = [];
  for (const l of sent) {
    const r = given.get(l.lineNo);
    const v = r?.qtyReceived;
    const n = v === undefined || v === null || v === "" ? l.qty : typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n) || n < 0 || Number(n.toFixed(4)) !== n) {
      return { ok: false, lineNo: l.lineNo, code: "TRANSFER_RECEIVE_INVALID", error: `السطر ${l.lineNo}: الكمية المستلمة غير صالحة.`, errorEn: `Line ${l.lineNo}: the received quantity is not valid.` };
    }
    if (n > l.qty + QTY_EPSILON) {
      return { ok: false, lineNo: l.lineNo, code: "TRANSFER_RECEIVE_OVER", error: `السطر ${l.lineNo}: المستلم أكثر من المرسَل (${l.qty}).`, errorEn: `Line ${l.lineNo}: more received than was sent (${l.qty}).` };
    }
    const short = Number((l.qty - n).toFixed(4));
    if (l.itemKind === "FG_LOT" && short > QTY_EPSILON) {
      return { ok: false, lineNo: l.lineNo, code: "TRANSFER_FG_FULL_ONLY", error: `السطر ${l.lineNo}: المنتج الجاهز يُستلم كاملًا. استلمه ثم صحّح العدد بالجرد في موقع الوصول.`, errorEn: `Line ${l.lineNo}: finished goods are received in full. Receive it, then correct the count at the destination.` };
    }
    const reason = typeof r?.varianceReason === "string" && r.varianceReason.trim() ? r.varianceReason.trim().slice(0, 300) : null;
    if (short > QTY_EPSILON && (!reason || reason.length < 3)) {
      return { ok: false, lineNo: l.lineNo, code: "TRANSFER_VARIANCE_REASON", error: `السطر ${l.lineNo}: وصل ${n} من ${l.qty} — اكتب سبب الفرق (3 أحرف على الأقل).`, errorEn: `Line ${l.lineNo}: ${n} of ${l.qty} arrived — give the reason for the difference (at least 3 characters).` };
    }
    out.push({ lineNo: l.lineNo, qtyReceived: short > QTY_EPSILON ? n : l.qty, qtyShort: short > QTY_EPSILON ? short : 0, varianceReason: short > QTY_EPSILON ? reason : null });
  }
  return { ok: true, lines: out };
}

// ─── Reorder points per location ────────────────────────────────────────────────────────────────

/** «تحت حد إعادة الطلب» at one site: a point set (> 0) and the site's balance at or below it. */
export const belowReorder = (qty: number, point: number | null | undefined) => point !== null && point !== undefined && point > 0 && qty <= point + QTY_EPSILON;

/** Parse a reorder point entered for a site: "" / null clears it; otherwise ≥ 0 with at most 4 decimals. */
export function parseReorderPoint(v: unknown): { ok: true; value: number | null } | { ok: false } {
  if (v === null || v === undefined || v === "") return { ok: true, value: null };
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,9}(\.\d{1,4})?$/.test(v.trim()) ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 0 || n >= 1e9 || Number(n.toFixed(4)) !== n) return { ok: false };
  return { ok: true, value: n };
}
