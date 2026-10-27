/**
 * The movement ledger's filter parameters — pure parsing, shared by the list and the CSV export
 * (GET /api/inventory-movements, GET /api/inventory-movements/export) and unit-tested.
 */
export const MOVEMENT_TYPES = ["IN", "OUT", "ADJUSTMENT", "LOSS"] as const;
export const MOVEMENT_CATEGORIES = ["RAW_MATERIAL", "FINISHED_GOODS", "ROASTED_COFFEE", "PACKAGING_MATERIAL"] as const;
export const MOVEMENT_SOURCES = [
  "PURCHASE", "ROASTING_BATCH", "DELIVERY", "BLEND", "MANUAL_ADJUSTMENT", "PACKING", "BOM_CONSUMPTION",
  "PRODUCTION_ORDER", "OPENING_BALANCE", "RECEIVING", "STOCK_TRANSFER",
] as const;
export const LEDGER_PAGE_SIZES = [10, 25, 50, 100] as const;
export const LEDGER_EXPORT_MAX = 10_000;

export type LedgerFilter = {
  type?: (typeof MOVEMENT_TYPES)[number];
  category?: (typeof MOVEMENT_CATEGORIES)[number];
  source?: (typeof MOVEMENT_SOURCES)[number];
  q?: string;
  entityId?: string;
  sourceDocId?: string;
  /** An item category (unified inventory): its movements, a root's sub-categories included. */
  itemCategoryId?: string;
  /** Phase 3 (stock locations): the movements AT one location. */
  locationId?: string;
  from?: Date;
  to?: Date;
  page: number;
  pageSize: number;
};

const pick = <T extends string>(v: string | null, list: readonly T[]): T | undefined =>
  v && (list as readonly string[]).includes(v) ? (v as T) : undefined;

const date = (v: string | null): Date | undefined => {
  if (!v || !/^\d{4}-\d{2}-\d{2}/.test(v)) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

/** Unknown values are ignored (treated as "all"), never an error: a stale link still opens. */
export function parseLedgerFilter(sp: URLSearchParams): LedgerFilter {
  const page = Math.max(1, Math.floor(Number(sp.get("page")) || 1));
  const size = Number(sp.get("pageSize"));
  const q = (sp.get("q") ?? "").trim().slice(0, 80);
  return {
    type: pick(sp.get("type"), MOVEMENT_TYPES),
    category: pick(sp.get("category"), MOVEMENT_CATEGORIES),
    source: pick(sp.get("source"), MOVEMENT_SOURCES),
    q: q || undefined,
    entityId: sp.get("entityId")?.slice(0, 64) || undefined,
    itemCategoryId: sp.get("itemCategory")?.slice(0, 64) || undefined,
    locationId: sp.get("location")?.slice(0, 64) || undefined,
    sourceDocId: sp.get("sourceDocId")?.slice(0, 64) || undefined,
    from: date(sp.get("from")),
    to: date(sp.get("to")),
    page,
    pageSize: (LEDGER_PAGE_SIZES as readonly number[]).includes(size) ? size : 25,
  };
}
