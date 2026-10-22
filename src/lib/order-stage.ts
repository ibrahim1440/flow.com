/**
 * The order pipeline stages of «اليوم» (مسار الطلبات), shared by the read-only dashboard service
 * (services/dashboard/today.ts, server) and the Orders page's `?stage=` filter (client), so the
 * card a person taps and the filtered list it links to count the same orders. Pure: no database.
 *
 * It also holds the ONE display rule for where an order stands (fix/order-progress-ui, owner
 * 2026-10-22): the order's STATUS takes precedence over its production stage — an order on hold
 * reads «معلّق», a cancelled / rejected one «ملغى» / «مرفوض», a completed one «مكتمل», and only
 * otherwise the production stage («بانتظار التحميص» …). Derived on every render, never stored, so
 * resuming an order brings its stage label back by itself.
 */
import type { TranslationKey } from "@/lib/i18n/translations";

export type Stage = "approval" | "roasting" | "qc" | "packing" | "ready";
/**
 * The cards of the row: the five open stages, «سُلّم اليوم», and «معلّق» (held orders are counted
 * in no production stage; they have their own card).
 */
export type PipelineStage = Stage | "delivered" | "hold";
export const PIPELINE_STAGES: readonly PipelineStage[] = ["approval", "roasting", "qc", "packing", "ready", "delivered", "hold"];
export const isPipelineStage = (v: unknown): v is PipelineStage => typeof v === "string" && (PIPELINE_STAGES as readonly string[]).includes(v);

/** Orders no stage counts (they left the pipeline). */
export const TERMINAL_ORDER_STATUSES = ["Completed", "Cancelled", "Rejected"];
const APPROVAL = new Set(["Waiting Approval", "Waiting Preparation Review"]);
const NEEDS_PRODUCTION = new Set(["Needs Production", "Partially Available"]);

export type StageOrder = {
  status: string;
  items: {
    productionStatus: string;
    preparationDecision: string | null;
    productionRequiredQuantity: number | null;
    /** A batch without a `status` is taken as waiting for QC (the server pre-filters to those). */
    roastingBatches: readonly object[];
  }[];
};

/**
 * The one pipeline stage an open order is counted in. A «Preparing» order is split by what its
 * lines are waiting for: a roast waiting for quality control, then a roast still to be done,
 * otherwise the order is being packed / prepared from the shelf.
 */
export function stageOf(o: StageOrder): Stage | "hold" {
  if (statusOverride(o.status) === "hold") return "hold";
  if (APPROVAL.has(o.status)) return "approval";
  if (o.status === "Ready for Shipping") return "ready";
  const waitsForQc = (b: object) => { const st = (b as { status?: unknown }).status; return st === undefined || st === "Pending QC"; };
  if (o.items.some((i) => i.roastingBatches.some(waitsForQc))) return "qc";
  if (o.items.some((i) => (i.productionStatus === "Pending" || i.productionStatus === "In Production")
    && (NEEDS_PRODUCTION.has(i.preparationDecision ?? "") || (i.productionRequiredQuantity ?? 0) > 0))) return "roasting";
  return "packing";
}

/**
 * The card an order is counted in, or null when it is in none: held orders in «معلّق», completed,
 * cancelled and rejected orders nowhere, every other order in its production stage. «سُلّم اليوم»
 * is by delivery date, see `countsAsDelivered`.
 */
export function stageCardOf(o: StageOrder): Stage | "hold" | null {
  const s = statusOverride(o.status);
  if (s === "hold") return "hold";
  if (s) return null;
  return stageOf(o);
}

/** «سُلّم اليوم» counts an order delivered today unless it was cancelled or rejected since. */
export const countsAsDelivered = (status: string) => { const s = statusOverride(status); return s !== "cancelled" && s !== "rejected"; };

// ─── Display: the status takes precedence over the production stage ─────────────────────────

/** The statuses that decide what an order reads, whatever its lines are doing. */
export type StatusOverride = "hold" | "cancelled" | "rejected" | "completed";

/** Exact status values (services/order-operations.ts ORDER_STATUSES). */
export function statusOverride(status: string): StatusOverride | null {
  switch (status) {
    case "On Hold": return "hold";
    case "Cancelled": return "cancelled";
    case "Rejected": return "rejected";
    case "Completed": return "completed";
    default: return null;
  }
}

/** The orders board's production stage (services/orders/pipeline.ts, `pipeline.key`). */
export type ProductionKey = "roast" | "qc" | "pack" | "ready" | "restReady" | "partReady" | "done";
export type ProgressTone = "warn" | "danger" | "ok" | "info";
export type ProgressDisplay = {
  key: StatusOverride | ProductionKey | "blocked";
  /** Translation key of the one text status. */
  label: TranslationKey;
  tone: ProgressTone;
  /** Cancelled / rejected: shown in the danger tone, muted. */
  muted: boolean;
  /** Prefix «سُلّم جزئيًا ·» (only on a production-stage label). */
  partDelivered: boolean;
};

const OVERRIDE: Record<StatusOverride, { label: TranslationKey; tone: ProgressTone; muted: boolean }> = {
  hold: { label: "orderStatusOnHold", tone: "warn", muted: false },
  cancelled: { label: "orderStatusCancelled", tone: "danger", muted: true },
  rejected: { label: "orderStatusRejected", tone: "danger", muted: true },
  completed: { label: "ordStageDone", tone: "ok", muted: false },
};
const PRODUCTION: Record<ProductionKey, { label: TranslationKey; tone: ProgressTone }> = {
  roast: { label: "ordStageRoast", tone: "info" }, qc: { label: "ordStageQc", tone: "info" }, pack: { label: "ordStagePack", tone: "info" },
  partReady: { label: "ordStagePartReady", tone: "info" }, ready: { label: "ordStageReady", tone: "ok" },
  restReady: { label: "ordStageRestReady", tone: "ok" }, done: { label: "ordStageDone", tone: "ok" },
};
/** Line stage on the board (0 roast · 1 QC · 2 pack · 3 deliver · 4 done) → its key. */
const LINE_KEYS: readonly ProductionKey[] = ["roast", "qc", "pack", "ready", "done"];

/**
 * Where an order stands, as one text status: its status when that decides (hold, cancelled,
 * rejected, completed), otherwise its production stage. Null when there is neither (an open order
 * without a computed stage).
 */
export function orderProgress(o: { status: string; pipeline?: { key: string; partDelivered?: boolean } | null }): ProgressDisplay | null {
  const s = statusOverride(o.status);
  if (s) return { key: s, ...OVERRIDE[s], partDelivered: false };
  const k = o.pipeline?.key as ProductionKey | undefined;
  if (!k || !PRODUCTION[k]) return null;
  return { key: k, ...PRODUCTION[k], muted: false, partDelivered: !!o.pipeline?.partDelivered };
}

/**
 * Where one line of an order stands, by the same rule. A line already blocked in data reads
 * «موقوف» first, so nothing is hidden although the UI no longer offers blocking.
 */
export function lineProgress(orderStatus: string, line: { stage: number | null | undefined; blocked: boolean }): ProgressDisplay | null {
  if (line.blocked) return { key: "blocked", label: "ordBlockedTag", tone: "danger", muted: false, partDelivered: false };
  const s = statusOverride(orderStatus);
  if (s) return { key: s, ...OVERRIDE[s], partDelivered: false };
  const k = line.stage == null ? undefined : LINE_KEYS[Math.max(0, Math.min(4, line.stage))];
  return k ? { key: k, ...PRODUCTION[k], muted: false, partDelivered: false } : null;
}

/** The display's text in the viewer's language. */
export function progressText(d: ProgressDisplay, t: (k: TranslationKey) => string): string {
  return d.partDelivered ? `${t("ordStagePartDelivered")} · ${t(d.label)}` : t(d.label);
}

const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** [start, end) of the Riyadh calendar day containing `now`, as UTC instants (UTC+3, no DST). */
export function riyadhDay(now: Date): { start: Date; end: Date } {
  const local = new Date(now.getTime() + RIYADH_OFFSET_MS);
  const startLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const start = new Date(startLocal - RIYADH_OFFSET_MS);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}
