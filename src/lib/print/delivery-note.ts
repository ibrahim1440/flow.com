// The delivery note «إشعار التسليم» (feat/print-docs): one A4 note per shipment. Pure and
// client-safe — the server gathers the order, its deliveries and their lots
// (src/lib/print/server/documents.ts), this file decides what the page says, and DocumentSheet lays
// it out. Asserted without a browser in tests/print/unit/print-documents.test.ts.
//
// No Figma frame exists for a printed delivery note (Gap C 1086:6 and the approved dispatch frames
// OG-D1…D7 1575:2 are screens). The page follows the quotation document's A4 layout (QP-05 1295:987)
// and the Direction 2.1 tokens. No prices: a delivery note states quantities, never amounts — and it
// is not an invoice (the invoice is deferred with accounting and ZATCA).
//
// ── What a «shipment» is ──
// The dispatch screen confirms one order at a time and records one Delivery row per order line
// (POST /api/deliveries, each under its own Idempotency-Key). The note covers the Delivery rows it
// is given — all of one order. The screens hand it the rows recorded together (deliveryShipments).
//
// ── «Delivered so far» ──
// Read as of this note: the line's deliveries recorded up to and including the latest one on the
// note, so reprinting an old note tomorrow still states what had been delivered when it shipped.
import { formatQuantity, unitLabel, type DocCell, type DocColumn, type DocLang } from "./quote-document";

export type DeliveryLot = { batchNumber: string | null; quantityUnits: number | null; quantityKg: number };

export type DeliveryNoteItem = {
  id: string;
  name: { ar: string; en: string };
  skuCode: string | null;
  /** Whole units (a SKU line) or kilograms (a legacy bulk line). */
  isUnit: boolean;
  orderedUnits: number | null;
  orderedKg: number;
};

export type DeliveryRecord = {
  id: string;
  orderItemId: string;
  /** The delivery date the dispatcher's record carries. */
  date: string;
  /** When the row was written (orders the «so far» cut). */
  createdAt: string;
  quantityUnits: number | null;
  quantityKg: number;
  notes: string | null;
  lots: DeliveryLot[];
};

export type DeliveryNoteInput = {
  orderNumber: number;
  items: DeliveryNoteItem[];
  /** Every delivery of the order (the note's and the others), for «delivered so far». */
  history: DeliveryRecord[];
  /** The deliveries this note covers. */
  noteIds: string[];
};

export type DeliveryNoteLine = {
  itemId: string;
  name: { ar: string; en: string };
  skuCode: string | null;
  isUnit: boolean;
  /** Delivered on this note. */
  quantity: number;
  lots: DeliveryLot[];
  ordered: number;
  /** Delivered up to and including this note. */
  deliveredToDate: number;
  remaining: number;
};

export type DeliveryNote = {
  orderNumber: number;
  /** The latest delivery date on the note. */
  deliveredAt: string;
  lines: DeliveryNoteLine[];
  /** Lines of the order with something still to deliver after this note (not on it). */
  outstanding: Omit<DeliveryNoteLine, "quantity" | "lots">[];
  /** Something on the order is still to deliver after this note. */
  partial: boolean;
  notes: string[];
  docNumber: string;
};

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const qtyOf = (isUnit: boolean, d: Pick<DeliveryRecord, "quantityUnits" | "quantityKg">) => (isUnit ? d.quantityUnits ?? 0 : d.quantityKg);

export class DeliveryNoteError extends Error {
  constructor(public code: "EMPTY" | "UNKNOWN_DELIVERY" | "UNKNOWN_LINE") { super(code); }
}

export function buildDeliveryNote(input: DeliveryNoteInput): DeliveryNote {
  const byId = new Map(input.history.map((d) => [d.id, d]));
  const ids = [...new Set(input.noteIds)];
  if (ids.length === 0) throw new DeliveryNoteError("EMPTY");
  const mine = ids.map((id) => byId.get(id));
  if (mine.some((d) => !d)) throw new DeliveryNoteError("UNKNOWN_DELIVERY");
  const onNote = mine as DeliveryRecord[];
  const items = new Map(input.items.map((i) => [i.id, i]));
  if (onNote.some((d) => !items.has(d.orderItemId))) throw new DeliveryNoteError("UNKNOWN_LINE");

  const cut = Math.max(...onNote.map((d) => Date.parse(d.createdAt)));
  const delivered = (item: DeliveryNoteItem) =>
    r3(input.history.filter((d) => d.orderItemId === item.id && Date.parse(d.createdAt) <= cut).reduce((s, d) => s + qtyOf(item.isUnit, d), 0));
  const orderedOf = (item: DeliveryNoteItem) => (item.isUnit ? item.orderedUnits ?? 0 : item.orderedKg);
  const facts = (item: DeliveryNoteItem) => {
    const ordered = orderedOf(item);
    const deliveredToDate = delivered(item);
    return { itemId: item.id, name: item.name, skuCode: item.skuCode, isUnit: item.isUnit, ordered, deliveredToDate, remaining: Math.max(0, r3(ordered - deliveredToDate)) };
  };

  // Lines in the order's own line order; two deliveries of one line on one note are added up.
  const lines: DeliveryNoteLine[] = input.items
    .filter((item) => onNote.some((d) => d.orderItemId === item.id))
    .map((item) => {
      const ds = onNote.filter((d) => d.orderItemId === item.id);
      const lots = mergeLots(ds.flatMap((d) => d.lots));
      return { ...facts(item), quantity: r3(ds.reduce((s, d) => s + qtyOf(item.isUnit, d), 0)), lots };
    });
  const outstanding = input.items.filter((i) => !lines.some((l) => l.itemId === i.id)).map(facts).filter((l) => l.remaining > 0);
  const partial = lines.some((l) => l.remaining > 0) || outstanding.length > 0;
  const deliveredAt = onNote.map((d) => d.date).sort().at(-1)!;
  const notes = [...new Set(onNote.map((d) => d.notes?.trim()).filter((n): n is string => !!n))];
  return { orderNumber: input.orderNumber, deliveredAt, lines, outstanding, partial, notes, docNumber: deliveryNoteNumber(input.orderNumber, onNote) };
}

/** One entry per lot, quantities added (a line shipped twice from the same lot on one note). */
function mergeLots(lots: DeliveryLot[]): DeliveryLot[] {
  const out = new Map<string, DeliveryLot>();
  for (const l of lots) {
    const k = l.batchNumber ?? "—";
    const prev = out.get(k);
    out.set(k, prev
      ? { batchNumber: l.batchNumber, quantityUnits: prev.quantityUnits === null && l.quantityUnits === null ? null : (prev.quantityUnits ?? 0) + (l.quantityUnits ?? 0), quantityKg: r3(prev.quantityKg + l.quantityKg) }
      : { ...l });
  }
  return [...out.values()];
}

/**
 * «DN-1046-20261023-7Q2K»: the order, the Riyadh day of the latest delivery and four characters of
 * the first delivery id — the same note prints the same reference every time.
 */
export function deliveryNoteNumber(orderNumber: number, deliveries: Pick<DeliveryRecord, "id" | "date">[]): string {
  const latest = deliveries.map((d) => d.date).sort().at(-1) ?? new Date(0).toISOString();
  const day = new Date(Date.parse(latest) + 3 * 3_600_000).toISOString().slice(0, 10).replace(/-/g, "");
  const first = [...deliveries].map((d) => d.id).sort()[0] ?? "";
  return `DN-${orderNumber}-${day}-${first.slice(-4).toUpperCase()}`;
}

/**
 * A run of mixed text kept whole inside the other direction (FSI … PDI): «R-2611-01 (4)» in an Arabic
 * line, «#990101» after an Arabic word. Without it the bidi algorithm pulls the parentheses and the
 * separators across runs and the list reads scrambled.
 */
export const isolate = (s: string) => `\u2068${s}\u2069`;

/**
 * «24 عبوة» / «6 عبوات» / «12.5 كغ» (units for a SKU line, kilograms for a bulk line). The numeral is
 * always written (a table), with the plural the Arabic count takes for 3–10; «pack» / «packs».
 */
export function quantityText(n: number, isUnit: boolean, lang: DocLang): string {
  const q = formatQuantity(String(n));
  if (!isUnit) return `${q} ${unitLabel("KG", lang)}`;
  if (lang === "en") return `${q} ${n === 1 ? "pack" : "packs"}`;
  const r = Math.trunc(n) % 100;
  return `${q} ${Number.isInteger(n) && r >= 3 && r <= 10 ? "عبوات" : "عبوة"}`;
}

/**
 * «R-2610-01 (12), R-2610-04 (6)» — each lot with what it gave on this note. Lot numbers are Latin
 * identifiers, so the list is one left-to-right run in either language (the column is `ltr`): mixed
 * into an Arabic line, the parentheses and separators would be pulled across the runs.
 */
export function lotsText(lots: DeliveryLot[], isUnit: boolean): string | null {
  if (lots.length === 0) return null;
  return lots.map((l) => `${l.batchNumber ?? "—"} (${formatQuantity(String(isUnit && l.quantityUnits !== null ? l.quantityUnits : l.quantityKg))})`).join(", ");
}

export const DELIVERY_NOTE_COLUMNS = ["index", "item", "lots", "ordered", "delivered", "toDate", "remaining"] as const;
export type DeliveryNoteColumnKey = (typeof DELIVERY_NOTE_COLUMNS)[number];
const LABELS: Record<DeliveryNoteColumnKey, { ar: string; en: string }> = {
  index: { ar: "#", en: "#" },
  item: { ar: "الصنف", en: "Item" },
  lots: { ar: "اللوتات", en: "Lots" },
  ordered: { ar: "المطلوب", en: "Ordered" },
  delivered: { ar: "المسلَّم الآن", en: "Delivered now" },
  toDate: { ar: "المسلَّم حتى الآن", en: "Delivered so far" },
  remaining: { ar: "المتبقي", en: "Remaining" },
};

export function deliveryNoteColumns(lang: DocLang): DocColumn[] {
  return DELIVERY_NOTE_COLUMNS.map((key) => ({
    key,
    label: LABELS[key][lang],
    numeric: key === "ordered" || key === "delivered" || key === "toDate" || key === "remaining",
    muted: key === "index",
    ltr: key === "lots",
  }));
}

/** One line → its cells: # · item (SKU under it) · lots · ordered · delivered now · so far · remaining. */
export function deliveryNoteCells(l: DeliveryNoteLine, ordinal: number, lang: DocLang): DocCell[] {
  const q = (n: number) => quantityText(n, l.isUnit, lang);
  const byKey: Record<DeliveryNoteColumnKey, DocCell> = {
    index: { main: String(ordinal) },
    item: { main: (lang === "ar" ? l.name.ar : l.name.en) || "—", sub: l.skuCode, subMono: true },
    lots: { main: lotsText(l.lots, l.isUnit) ?? "—" },
    ordered: { main: q(l.ordered) },
    delivered: { main: q(l.quantity) },
    toDate: { main: q(l.deliveredToDate) },
    remaining: { main: l.remaining > 0 ? q(l.remaining) : "—" },
  };
  return DELIVERY_NOTE_COLUMNS.map((k) => byKey[k]);
}

/**
 * The deliveries a screen offers as one note: the rows of one order recorded together. The
 * dispatch screen posts one row per line in sequence, under one shared note text; rows of the same
 * order with the same note, each written within SHIPMENT_GAP_MS of the previous one, are one
 * shipment. Input order does not matter; the result is newest first.
 */
export const SHIPMENT_GAP_MS = 5 * 60_000;

export function deliveryShipments<T extends { id: string; orderId: string; createdAt: string; notes: string | null }>(rows: T[]): T[][] {
  const sorted = [...rows].sort((a, b) => a.orderId.localeCompare(b.orderId) || Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
  const groups: T[][] = [];
  for (const r of sorted) {
    const g = groups.at(-1);
    const last = g?.at(-1);
    if (g && last && last.orderId === r.orderId && (last.notes ?? "").trim() === (r.notes ?? "").trim()
      && Date.parse(r.createdAt) - Date.parse(last.createdAt) <= SHIPMENT_GAP_MS) g.push(r);
    else groups.push([r]);
  }
  return groups.sort((a, b) => Date.parse(b.at(-1)!.createdAt) - Date.parse(a.at(-1)!.createdAt));
}
