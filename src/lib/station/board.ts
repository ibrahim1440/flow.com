/**
 * «لوحة الطلبات المباشرة» — the read-only orders board of the station devices (owner-approved design D15, option C,
 * 8 Nov 2026). The pure rules the board's API and its screen share: no database, no Next.js, client-safe.
 *
 * Where an order stands is DERIVED on every read from what is true now, never stored and never a new status:
 *
 *   new    «جديد»       Order.status «Waiting Approval» / «Waiting Preparation Review»
 *   roast  «تحميص»      the orders board pipeline (services/orders/pipeline.ts) — its least advanced line, stage 0
 *   qc     «الجودة»     … stage 1: a roast of its coffee is waiting for QC
 *   pack   «تعبئة»      … stage 2: a passed roast of its coffee still holds a package
 *   prep   «تجهيز»      … stage 3: every unit is reserved (or delivered); nothing handed to dispatch yet
 *   ship   «عند الشحن»  … stage 3 and some units are handed to dispatch (PreparationPick HANDED_OFF), not delivered
 *   done   «سُلّم اليوم»  Completed / every line delivered — and only when the last delivery was TODAY (Riyadh)
 *
 * «On Hold» does not move an order: it stays in its stage, flagged `hold` (the screen draws it red). Cancelled and
 * rejected orders are not on the board. Option C: a column is open only while at least one order is in it, and closes
 * the moment it empties (owner decision: no grace period).
 *
 * Privacy (owner decision, 8 Nov 2026): the board carries no customer name, no price, amount, payment state or contact —
 * the order number with its source, quantities, stage and times only.
 */

/** Station types nobody signs in on (no roster, no PIN, no session): the device opens its screen directly. */
export const SESSIONLESS_STATION_TYPES = ["ORDERS_BOARD"] as const;
export const isSessionlessStation = (type: string) => (SESSIONLESS_STATION_TYPES as readonly string[]).includes(type);

export const BOARD_STAGES = ["new", "roast", "qc", "pack", "prep", "ship", "done"] as const;
export type BoardStage = (typeof BOARD_STAGES)[number];

/** «القناة» — Order.channel (CHECK). */
export const ORDER_CHANNELS = ["SALES", "DIRECT_SALE", "STORE", "CAFE", "BACK_OFFICE"] as const;
export type OrderChannel = (typeof ORDER_CHANNELS)[number];
export const isOrderChannel = (v: unknown): v is OrderChannel => typeof v === "string" && (ORDER_CHANNELS as readonly string[]).includes(v);
/**
 * The channels a person may choose on the Orders page form. Not choosing leaves it unrecorded, so the source is derived
 * (the order joins a rep's deal → SALES, otherwise BACK_OFFICE); SALES and DIRECT_SALE are set by their own flows.
 */
export const FORM_CHANNELS = ["STORE", "CAFE"] as const satisfies readonly OrderChannel[];
export const isFormChannel = (v: unknown): v is (typeof FORM_CHANNELS)[number] => typeof v === "string" && (FORM_CHANNELS as readonly string[]).includes(v);

export const CHANNEL_LABEL: Record<OrderChannel, { ar: string; en: string }> = {
  SALES: { ar: "مندوب", en: "Rep" },
  DIRECT_SALE: { ar: "بيع مباشر", en: "Direct sale" },
  STORE: { ar: "المتجر", en: "Web store" },
  CAFE: { ar: "الكافيه", en: "Café" },
  BACK_OFFICE: { ar: "من النظام", en: "Back office" },
};

export const STAGE_LABEL: Record<BoardStage, { ar: string; en: string }> = {
  new: { ar: "جديد", en: "New" },
  roast: { ar: "تحميص", en: "Roasting" },
  qc: { ar: "الجودة", en: "QC" },
  pack: { ar: "تعبئة", en: "Packing" },
  prep: { ar: "تجهيز", en: "Preparing" },
  ship: { ar: "عند الشحن", en: "With dispatch" },
  done: { ar: "سُلّم اليوم", en: "Delivered today" },
};

const NEW_STATUSES = new Set(["Waiting Approval", "Waiting Preparation Review"]);
const OFF_BOARD = new Set(["Cancelled", "Rejected"]);

export type StageInput = {
  status: string;
  /** services/orders/pipeline.ts `stage` (0 roast · 1 QC · 2 pack · 3 deliver · 4 done); null without a pipeline. */
  pipelineStage: number | null;
  /** Units of this order handed to dispatch and not delivered yet (PreparationPick HANDED_OFF). */
  handedOffUnits: number;
  /** The last delivery of the order, if any. */
  lastDeliveryAt: Date | null;
};

/** The board stage of an order at `now`, or null when it is not on the board. */
export function boardStage(o: StageInput, now: Date): BoardStage | null {
  if (OFF_BOARD.has(o.status)) return null;
  const finished = o.status === "Completed" || o.pipelineStage === 4;
  if (finished) return o.lastDeliveryAt && o.lastDeliveryAt >= riyadhDayStart(now) ? "done" : null;
  if (NEW_STATUSES.has(o.status)) return "new";
  const s = o.pipelineStage ?? 0;
  if (s >= 3) return o.handedOffUnits > 0 ? "ship" : "prep";
  return s === 2 ? "pack" : s === 1 ? "qc" : "roast";
}

/**
 * The source of an order: its recorded channel, else (orders created before the column) the evidence the system already
 * keeps — the «بيع مباشر» audit row, then a deal link (a rep's order), otherwise entered in the back office.
 */
export function orderSource(o: { channel: string | null; directSale: boolean; dealLinked: boolean }): OrderChannel {
  if (isOrderChannel(o.channel)) return o.channel;
  if (o.directSale) return "DIRECT_SALE";
  if (o.dealLinked) return "SALES";
  return "BACK_OFFICE";
}

/** Option C: the stages with at least one order, in the fixed stage order (a column never changes place). */
export function openColumns(orders: readonly { stage: BoardStage }[]): BoardStage[] {
  const has = new Set(orders.map((o) => o.stage));
  return BOARD_STAGES.filter((s) => has.has(s));
}

const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;
/** 00:00 of the Riyadh calendar day containing `now`, as a UTC instant (UTC+3, no DST). */
export function riyadhDayStart(now: Date): Date {
  const local = new Date(now.getTime() + RIYADH_OFFSET_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - RIYADH_OFFSET_MS);
}

/** «طلب جديد» tag: an order created within this long. */
export const NEW_TAG_MS = 2 * 60 * 1000;
/** «انتقل قبل …» note after a stage change seen by the screen. */
export const MOVED_NOTE_MS = 60 * 1000;
/** The board's poll (H5: unchanged answers 304). */
export const BOARD_POLL_MS = 10_000;
/** Without a successful read for this long the board says it may be out of date (S1). */
export const BOARD_STALE_MS = 30_000;

/** One card of the board (the API's answer). */
export type BoardOrder = {
  id: string;
  orderNumber: number;
  stage: BoardStage;
  hold: boolean;
  source: OrderChannel;
  /** The rep's name on a SALES order (an employee, never the customer). */
  repName: string | null;
  /** Whole units on SKU lines. */
  units: number;
  /** Kilograms on legacy (kg) lines, 0 when none. */
  kg: number;
  lines: number;
  /** Some units already delivered / handed off while the rest is not. */
  partial: boolean;
  /** Who is preparing it at the packaging station (an active claim), on «تجهيز». */
  preparingBy: string | null;
  createdAt: string;
  /** On «سُلّم اليوم»: the last delivery. */
  deliveredAt: string | null;
  /** Owner decision أ: a direct sale held until the accountant confirms the money taken at the sale (PENDING) or whose
   *  receipt was rejected — «بانتظار تأكيد استلام المبلغ»; it is not prepared before. The state only. */
  confirmHold: "PENDING" | "REJECTED" | null;
};

export type BoardAnswer = { orders: BoardOrder[]; columns: BoardStage[]; version: string; serverTime: string };

/** Stable order of the cards in a column: the one waiting longest first («سُلّم اليوم»: the latest delivery first). */
export function sortCards(orders: BoardOrder[]): BoardOrder[] {
  return [...orders].sort((a, b) => {
    if (a.stage === "done" && b.stage === "done") return (b.deliveredAt ?? "").localeCompare(a.deliveredAt ?? "") || b.orderNumber - a.orderNumber;
    return a.createdAt.localeCompare(b.createdAt) || a.orderNumber - b.orderNumber;
  });
}

/** «منذ …» in the board's words: الآن / 12 د / 2 س 5 د / أمس / 3 أيام. */
export function sinceText(fromIso: string, now: number, lang: "ar" | "en"): string {
  const m = Math.max(0, Math.floor((now - new Date(fromIso).getTime()) / 60_000));
  if (m < 1) return lang === "ar" ? "الآن" : "now";
  if (m < 60) return lang === "ar" ? `${m} د` : `${m} m`;
  const h = Math.floor(m / 60);
  if (h < 24) {
    const r = m % 60;
    return lang === "ar" ? (r ? `${h} س ${r} د` : `${h} س`) : (r ? `${h} h ${r} m` : `${h} h`);
  }
  const d = Math.floor(h / 24);
  if (d === 1) return lang === "ar" ? "أمس" : "1 day";
  return lang === "ar" ? `${d} أيام` : `${d} days`;
}

/** HH:MM in Riyadh time (Latin digits, as the rest of the station). */
export function riyadhClock(iso: string | number | Date): string {
  const d = new Date(new Date(iso).getTime() + RIYADH_OFFSET_MS);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}
