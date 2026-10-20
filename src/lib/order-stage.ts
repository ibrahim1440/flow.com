/**
 * The order pipeline stages of «اليوم» (مسار الطلبات), shared by the read-only dashboard service
 * (services/dashboard/today.ts, server) and the Orders page's `?stage=` filter (client), so the
 * card a person taps and the filtered list it links to count the same orders. Pure: no database.
 */

export type Stage = "approval" | "roasting" | "qc" | "packing" | "ready";
/** The six cards of the row: the five open stages plus «سُلّم اليوم». */
export type PipelineStage = Stage | "delivered";
export const PIPELINE_STAGES: readonly PipelineStage[] = ["approval", "roasting", "qc", "packing", "ready", "delivered"];
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
  if (o.status === "On Hold") return "hold";
  if (APPROVAL.has(o.status)) return "approval";
  if (o.status === "Ready for Shipping") return "ready";
  const waitsForQc = (b: object) => { const st = (b as { status?: unknown }).status; return st === undefined || st === "Pending QC"; };
  if (o.items.some((i) => i.roastingBatches.some(waitsForQc))) return "qc";
  if (o.items.some((i) => (i.productionStatus === "Pending" || i.productionStatus === "In Production")
    && (NEEDS_PRODUCTION.has(i.preparationDecision ?? "") || (i.productionRequiredQuantity ?? 0) > 0))) return "roasting";
  return "packing";
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
