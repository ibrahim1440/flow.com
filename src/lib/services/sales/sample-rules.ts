// Sales samples issued from stock — the RULES, pure (no database: safe in unit tests and in the browser).
// docs/sales/SAMPLES_INVENTORY.md is the narrative; services/sales/sample-issue.ts is the transaction.
//
// Two kinds of sample live in one table, and every rule below asks which one it is looking at:
//
//   · a STOCK sample — a SKU in whole units. The rep REQUESTS it from the deal; the dispatch department prepares
//     and ISSUES it. Issuing is the one moment finished units leave the shelf. Before that, a request is a promise
//     on paper: it reserves nothing and deducts nothing, so a forgotten request never hides stock from an order.
//   · a RECORD-ONLY sample — free text, or kilograms / grams, and every row written before 20261204090000. The old
//     behaviour, unchanged: the rep records it, marks it sent, and no stock moves. Kilograms are not a unit any
//     finished lot is counted in (lots are unit-tracked; a 0.25 kg scoop is not a bag), so they cannot be issued.
import { Decimal } from "@/lib/services/commissions/engine";
import { issue, qty4 } from "@/lib/accounting/ops/costing";
import type { Permissions } from "@/lib/auth-shared";
import { seesAllSales } from "./scope";

export const SAMPLE_STATUSES = ["REQUESTED", "PREPARING", "SENT", "FEEDBACK_RECEIVED", "CANCELLED"] as const;
export type SampleStatus = (typeof SAMPLE_STATUSES)[number];
export const isSampleStatus = (v: unknown): v is SampleStatus => typeof v === "string" && (SAMPLE_STATUSES as readonly string[]).includes(v);

/** The statuses the dispatch queue shows: requested and not yet issued. */
export const PENDING_SAMPLE_STATUSES: SampleStatus[] = ["REQUESTED", "PREPARING"];

/** A sample is issued from stock when it names a SKU and is counted in units — nothing else can leave a lot. */
export function isStockSample(s: { unit: string; productSkuId: string | null | undefined }): boolean {
  return s.unit === "UNIT" && !!s.productSkuId;
}

/**
 * A sample that names a product is a STOCK sample, so it is counted in units. A product in kilograms / grams used to
 * become record-only silently — a rep who picked a bag and typed «0.25 KG» got a sample dispatch never saw. Refused
 * instead (400); a record-only sample is free text (no product), in any unit, as before.
 */
export function sampleUnitRefusal(s: { unit: string; productSkuId: string | null | undefined }) {
  if (!s.productSkuId || s.unit === "UNIT") return null;
  return {
    error: "عيّنة المنتج تُطلب بالعبوة (عدد صحيح). للتسجيل فقط بالكيلوغرام أو الغرام اكتب وصفًا حرًّا بلا منتج.",
    errorEn: "A product sample is requested in units (whole bags). For a record-only sample in kilograms or grams, describe it without picking a product.",
    code: "SAMPLE_SKU_NEEDS_UNITS",
  };
}

// ─── «للعميل من كل محصول عيّنة واحدة» (owner decision; 20261205090000_sample_approval) ─────────────────
//
// It replaces the «5 units per request» cap of the previous round (and its SAMPLE_REQUEST_UNIT_CAP variable): the
// limit is not per request but per customer and product, for ever.
//
//   · a stock sample is ONE unit (one bag) — every request; a larger one is refused (SAMPLE_ONE_UNIT);
//   · a customer receives one sample of each coffee PRODUCT — the product of the SKU (ProductSKU.productId), so the
//     250 g and the 1 kg bag of the same coffee are the same product. Counted over every sample of that product for
//     that customer that is not CANCELLED (requested, being prepared, sent, evaluated — and a second one waiting for
//     or holding an approval); a declined request is CANCELLED, so it never counts. A deal without a customer counts
//     on its own (the deal stands for the prospect);
//   · a SECOND (or later) sample of the same product needs the sales manager: a rep's request is recorded REQUESTED
//     with `approvalRequired` and stays out of the dispatch queue until a manager approves it (or declines it, with a
//     reason); a manager's own request records the manager's approval at creation. The approval is on the request
//     (approvedById / approvedAt / approvalNote); the issue refuses an unapproved one under its lock, and the CHECK
//     "SampleShipment_approval_before_issue" refuses it again at the database.

/** Every stock sample is exactly this many units. */
export const SAMPLE_UNITS = 1;

/** A request for more than one unit is refused (409, coded). Null = one unit. */
export function sampleOneUnitRefusal(units: number) {
  if (units === SAMPLE_UNITS) return null;
  return {
    _appCode: 409,
    code: "SAMPLE_ONE_UNIT",
    message: "العيّنة وحدة واحدة من كل محصول.",
    errorEn: "A sample is one unit of each product.",
  };
}

/**
 * Who approves a second sample: the sales manager (`sales › lead_assign`, the privilege that already sees and
 * reassigns every rep's deals) or the administrator — the same people who read the team's reports.
 */
export function approvesSamples(permissions: Permissions | Record<string, unknown>): boolean {
  // By permission only (release gate N2): `sales › lead_assign`, the sales-manager mark. The admin role holds it
  // through its template (and every permission under SIMPLE MODE), so no unreviewed role check decides an approval.
  return seesAllSales(permissions);
}

export type SampleApprovalState = "NOT_NEEDED" | "PENDING" | "APPROVED" | "DECLINED";

/** Where a request stands on the approval: a first sample needs none; a second waits, is approved, or was declined. */
export function sampleApprovalState(s: { approvalRequired?: boolean | null; approvedAt?: Date | string | null; declinedAt?: Date | string | null }): SampleApprovalState {
  if (!s.approvalRequired) return "NOT_NEEDED";
  if (s.declinedAt) return "DECLINED";
  return s.approvedAt ? "APPROVED" : "PENDING";
}

/** Prisma `where`: what dispatch may see and act on — no request waiting for (or refused) a manager's approval. */
export const DISPATCHABLE_APPROVAL = { OR: [{ approvalRequired: false }, { approvedAt: { not: null } }] };

/** The refusal for acting on a request that still waits for the manager (409, coded). */
export const AWAITING_APPROVAL_REFUSAL = {
  _appCode: 409,
  code: "SAMPLE_AWAITING_APPROVAL",
  message: "سبق إرسال عيّنة من هذا المحصول لهذا العميل؛ هذا الطلب بانتظار موافقة المدير ولا يُصرف قبلها.",
  errorEn: "This customer has already had a sample of this product; this request awaits the sales manager's approval and is not issued before it.",
};

/**
 * Idempotency of a request. The client sends `requestKey` (8–128 characters, one per dialog opening); the table has
 * no column for it (no migration in this fix), so the server's guarantee is a window instead: an identical stock
 * request — same deal, product, quantity and requester, still REQUESTED — made within SAMPLE_REQUEST_REPLAY_MS is the
 * same request, answered with the existing row (200, `replayed: true`). Checked under a row lock on the deal, so a
 * double click or a retry racing the first answer cannot create two.
 */
export const SAMPLE_REQUEST_REPLAY_MS = 2 * 60_000;

/** `requestKey`: absent, or a string of 8–128 characters. */
export function requestKeyRefusal(v: unknown) {
  if (v === undefined || v === null) return null;
  if (typeof v === "string" && v.length >= 8 && v.length <= 128) return null;
  return { error: "مفتاح الطلب غير صالح (من 8 إلى 128 حرفًا).", errorEn: "requestKey must be 8–128 characters.", code: "SAMPLE_REQUEST_KEY" };
}

/**
 * Who moves a sample, and where to.
 *
 * Stated as a table, like the quote lifecycle, because what matters is what is absent:
 *   · the rep never marks a STOCK sample sent — sending it IS the issue, and only dispatch issues;
 *   · nobody cancels a stock sample once issued — the coffee has left the building, and a reversal would put back
 *     on the shelf units that are not on it (docs: «الإلغاء بعد الصرف»);
 *   · a sample cannot collect feedback before it has been sent — a score against something still on the bench is
 *     somebody's guess, and it would then be read as the customer's opinion.
 * SENT is reached on a stock sample only through issueSample(), never through this table's PATCH.
 */
type Actor = "rep" | "dispatch";
const STOCK_FLOW: Record<SampleStatus, Partial<Record<SampleStatus, Actor[]>>> = {
  REQUESTED: { PREPARING: ["dispatch"], CANCELLED: ["rep"] },
  PREPARING: { CANCELLED: ["rep"] },
  SENT: { FEEDBACK_RECEIVED: ["rep"] },
  FEEDBACK_RECEIVED: {},
  CANCELLED: {},
};
/** Record-only samples: the table from before the migration, for the rep alone (dispatch never sees them). */
const RECORD_FLOW: Record<SampleStatus, Partial<Record<SampleStatus, Actor[]>>> = {
  REQUESTED: {},
  PREPARING: { SENT: ["rep"], CANCELLED: ["rep"] },
  SENT: { FEEDBACK_RECEIVED: ["rep"], CANCELLED: ["rep"] },
  FEEDBACK_RECEIVED: {},
  CANCELLED: {},
};

export type Refusal = { _appCode: number; code: string; message: string; errorEn: string };

const STATUS_AR: Record<SampleStatus, string> = {
  REQUESTED: "مطلوبة", PREPARING: "قيد التجهيز", SENT: "مُرسلة", FEEDBACK_RECEIVED: "وصل تقييمها", CANCELLED: "ملغاة",
};
const statusEn = (s: string) => s.toLowerCase().replace(/_/g, " ");

/** Null when `actor` may move a sample of this kind from `from` to `to`; otherwise the refusal (409). */
export function sampleTransitionRefusal(fromStock: boolean, from: string, to: string, actor: Actor): Refusal | null {
  if (!isSampleStatus(from) || !isSampleStatus(to)) {
    return { _appCode: 400, code: "SAMPLE_STATUS_UNKNOWN", message: "حالة العيّنة غير معروفة.", errorEn: "Unknown sample status." };
  }
  if (fromStock && from === "SENT" && to === "CANCELLED") {
    return {
      _appCode: 409, code: "SAMPLE_ISSUED_NO_CANCEL",
      message: "صُرفت العيّنة من المخزون وخرجت؛ لا تُلغى بعد الصرف. سجّل نتيجتها، أو عالج أي إرجاع فعلي بتسوية مخزون.",
      errorEn: "This sample was issued from stock and has left; it cannot be cancelled after issue. Record its result, or handle any physical return with a stock adjustment.",
    };
  }
  if (fromStock && to === "SENT") {
    return {
      _appCode: 409, code: "SAMPLE_SENT_BY_DISPATCH",
      message: "عيّنة المخزون تُرسل بصرفها من قسم الشحن، لا بتعليمها مُرسلة.",
      errorEn: "A stock sample is sent by being issued by dispatch, not by being marked sent.",
    };
  }
  const allowed = (fromStock ? STOCK_FLOW : RECORD_FLOW)[from][to];
  if (!allowed || !allowed.includes(actor)) {
    return {
      _appCode: 409, code: "SAMPLE_TRANSITION",
      message: `لا تنتقل عيّنة ${STATUS_AR[from]} إلى ${STATUS_AR[to]}.`,
      errorEn: `A ${statusEn(from)} sample cannot become ${statusEn(to)}.`,
    };
  }
  return null;
}

/**
 * A stock sample's quantity: a whole number of units, at least one. Null when it is not one (the caller answers
 * 400). Decimal in, integer out — the column is numeric(12,3) because record-only samples carry kilograms.
 */
export function wholeUnits(q: Decimal | null): number | null {
  if (!q || !q.isFinite() || !q.isInteger() || q.lessThan(1) || q.greaterThan(100_000)) return null;
  return q.toNumber();
}

// ─── Which lots, how many from each ──────────────────────────────────────────────────────────────

export type SampleLotCandidate = {
  id: string; batchNumber: string; unitsAvailable: number; unitsReserved: number;
  /** Packed from a batch on QC hold (hold-guard.ts) — never issued. */
  held: boolean;
};
export type SamplePlan =
  | { ok: true; lots: { lotId: string; batchNumber: string; units: number }[]; free: number }
  | { ok: false; reason: "short"; free: number; heldFree: number; heldBatch: string | null };

/**
 * FIFO over FREE units only — `unitsAvailable - unitsReserved` — oldest lot first (the caller passes them in that
 * order). A unit reserved for an order is that order's, and a sample never takes it: the conditional UPDATE in the
 * service re-checks the same inequality under the lot lock, so this plan and the write cannot disagree.
 *
 * Held lots are skipped. When the shortfall would have been covered by held stock, `heldBatch` names the batch so
 * the refusal says «on QC hold» rather than «not enough» — the dispatcher can see coffee on the shelf.
 */
export function planSampleLots(candidates: SampleLotCandidate[], units: number): SamplePlan {
  let remaining = Math.trunc(units);
  let free = 0, heldFree = 0;
  let heldBatch: string | null = null;
  const lots: { lotId: string; batchNumber: string; units: number }[] = [];
  for (const c of candidates) {
    const f = Math.max(0, c.unitsAvailable - c.unitsReserved);
    if (f <= 0) continue;
    if (c.held) { heldFree += f; heldBatch ??= c.batchNumber; continue; }
    free += f;
    if (remaining <= 0) continue;
    const take = Math.min(f, remaining);
    lots.push({ lotId: c.id, batchNumber: c.batchNumber, units: take });
    remaining -= take;
  }
  if (remaining > 0) return { ok: false, reason: "short", free, heldFree, heldBatch: heldFree > 0 ? heldBatch : null };
  return { ok: true, lots, free };
}

/**
 * The cost of `units` leaving a lot whose cost holder holds `holder` (qty in kg, value in SAR) while the lot held
 * `unitsBefore` units — exactly as onDelivery (accounting/ops/inventory-events.ts) issues a unit-tracked lot: the
 * share of the holder's quantity by units, at the moving average, the whole remaining value when the lot is emptied.
 * The pure model of what onSampleIssue moves out of a lot's holder per lot (the issue itself goes through costOut,
 * which moves the holder, so the next sample or delivery sees the reduced holder and `unitsBefore` is simply the lot's
 * units before the issue). Kept for the unit suite and for previews. Null without a holder.
 */
export function sampleLotCost(holder: { qty: Decimal; value: Decimal } | null, units: number, unitsBefore: number, emptied: boolean): Decimal | null {
  if (!holder || unitsBefore <= 0) return null;
  const q = qty4(holder.qty.times(units).dividedBy(unitsBefore));
  return issue(holder, q, { closeOut: emptied }).value;
}
