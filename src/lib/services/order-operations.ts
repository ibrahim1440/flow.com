import { Prisma } from "@/generated/prisma/client";

type PrismaTx = Prisma.TransactionClient;

// ─── Order status ──────────────────────────────────────────────────────────

export const ORDER_STATUSES = [
  "Waiting Approval",
  "Waiting Preparation Review",
  "Preparing",
  "Ready for Shipping",
  "Completed",
  "On Hold",
  "Cancelled",
  "Rejected",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const TERMINAL_ORDER_STATUSES: ReadonlySet<OrderStatus> = new Set([
  "Completed",
  "Cancelled",
  "Rejected",
]);

export function isOrderStatus(value: unknown): value is OrderStatus {
  return typeof value === "string" && (ORDER_STATUSES as readonly string[]).includes(value);
}

// Statuses from which preparation-review may run. Excludes "Waiting Approval" (not yet
// approved), "On Hold" (must be resumed first — business rule 5), and all terminal states.
export const PREPARATION_REVIEW_ENTRY_STATUSES: OrderStatus[] = [
  "Waiting Preparation Review",
  "Preparing",
  "Ready for Shipping",
];

// Statuses from which the approve route may act at all. "Rejected" is deliberately
// included even though it is otherwise a terminal status (see TERMINAL_ORDER_STATUSES) —
// it is the one terminal state produced BY this same route's own decision field, and
// reconsidering a rejection (No -> Yes or No -> Pending) is legitimate. Every other
// downstream status (Preparing, Ready for Shipping, Completed, On Hold, Cancelled) is
// real operational progress the approval decision must never be able to silently rewind.
export const APPROVAL_ENTRY_STATUSES: OrderStatus[] = [
  "Waiting Approval",
  "Waiting Preparation Review",
  "Rejected",
];

// ─── Preparation decisions ─────────────────────────────────────────────────

export const PREPARATION_DECISIONS = [
  "Available on Shelf",
  "Needs Production",
  "Partially Available",
  "Blocked",
] as const;
export type PreparationDecision = (typeof PREPARATION_DECISIONS)[number];

export function isPreparationDecision(value: unknown): value is PreparationDecision {
  return typeof value === "string" && (PREPARATION_DECISIONS as readonly string[]).includes(value);
}

// ─── Activity ───────────────────────────────────────────────────────────────

export const ACTIVITY_TYPES = [
  "ORDER_CREATED",
  "ORDER_APPROVED",
  "ORDER_REJECTED",
  "PREPARATION_REVIEWED",
  "STATUS_CHANGED",
  "MANUAL_NOTE",
  "ORDER_HELD",
  "ORDER_RESUMED",
  "ORDER_CANCELLED",
  "ORDER_COMPLETED",
  // Production-order events. They live on the customer order's timeline rather than in a
  // separate production audit log: every production order in this workflow is raised from
  // an order line, and the person asking "why was this order late?" wants the roasting
  // history in the same list as the approval and the hold, not in a second place.
  "PRODUCTION_ORDER_CREATED",
  "PRODUCTION_ORDER_RELEASED",
  "PRODUCTION_ORDER_COMPLETED",
  "PRODUCTION_ORDER_CANCELLED",
  "PRODUCTION_BATCH_LINKED",
  "PRODUCTION_BATCH_UNLINKED",
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const NOTE_DEPARTMENTS = [
  "Sales",
  "Online",
  "Preparation",
  "Production",
  "Operations",
  "Shipping",
] as const;
export type NoteDepartment = (typeof NOTE_DEPARTMENTS)[number];

export function isNoteDepartment(value: unknown): value is NoteDepartment {
  return typeof value === "string" && (NOTE_DEPARTMENTS as readonly string[]).includes(value);
}

export const NOTE_MESSAGE_MAX_LENGTH = 2000;

// ─── Status actions (hold / resume / cancel / complete) ────────────────────

export const STATUS_ACTIONS = ["hold", "resume", "cancel", "complete"] as const;
export type StatusAction = (typeof STATUS_ACTIONS)[number];

export function isStatusAction(value: unknown): value is StatusAction {
  return typeof value === "string" && (STATUS_ACTIONS as readonly string[]).includes(value);
}

// Statuses from which "hold" is allowed (business rule 7).
export const HOLD_FROM_STATUSES: OrderStatus[] = [
  "Waiting Preparation Review",
  "Preparing",
  "Ready for Shipping",
];

// "resume" is only allowed from "On Hold".
export const RESUME_FROM_STATUS: OrderStatus = "On Hold";

// "complete" is only allowed from "Ready for Shipping".
export const COMPLETE_FROM_STATUSES: OrderStatus[] = ["Ready for Shipping"];

// "cancel" is allowed from any non-terminal status.
export function isCancelAllowedFrom(status: OrderStatus): boolean {
  return !TERMINAL_ORDER_STATUSES.has(status);
}

// ─── Dispatch ──────────────────────────────────────────────────────────────

// Statuses from which a delivery may be recorded.
//
// "Ready for Shipping" is the obvious one. "Preparing" is included because a multi-line
// order aggregates to it as soon as ONE line still needs production, while its other
// lines may already be covered from the shelf and legitimately dispatchable — refusing
// there would block partial dispatch of mixed orders, which is ordinary practice.
//
// Everything else is excluded for a specific reason. "Waiting Approval" and "Waiting
// Preparation Review" have had no preparation review, and review is what reserves the
// stock — shipping before it hands out coffee that is promised to nobody, so units leave
// the shelf with no reservation behind them. "On Hold" is the one status whose entire
// purpose is to stop work on the order. "Completed", "Cancelled" and "Rejected" are
// terminal, and the first two have already released their reservations, so a delivery
// there consumes stock that was handed back to the free pool.
export const DELIVERY_ALLOWED_STATUSES: OrderStatus[] = ["Preparing", "Ready for Shipping"];

export function isDeliveryAllowedFrom(status: OrderStatus): boolean {
  return DELIVERY_ALLOWED_STATUSES.includes(status);
}

// ─── Production ────────────────────────────────────────────────────────────

// Statuses from which production may be scheduled or roasted against a customer order.
//
// The set is derived from aggregatePreparationStatus below, which is the source of truth
// for how an order reaches a status at all. It returns "Waiting Preparation Review" if ANY
// line still lacks a preparationDecision, so the two statuses here are the only ones that
// can be reached once every line has been reviewed:
//
//   "Preparing"          — reviewed, and at least one line needs more than the shelf holds.
//                          This is the ordinary production case.
//   "Ready for Shipping" — reviewed, and every line was shelf-covered AT REVIEW TIME.
//                          Included deliberately: coverage can go stale afterwards when
//                          another order frees or claims stock, and the roasting route
//                          derives its ceiling from live reservations rather than the
//                          stored productionRequiredQuantity precisely because of that.
//                          Refusing here would block legitimate work; the live shortfall
//                          check remains the authority on whether anything is left to make.
//
// Everything else is excluded for a specific reason. "Waiting Approval" has not been
// approved — production there consumes green coffee for an order that may never be agreed.
// "Waiting Preparation Review" is approved but unreviewed: review is what reserves shelf
// stock and computes the shortfall, so roasting first produces against a quantity nobody
// has established. "On Hold" is the one status whose entire purpose is to stop work.
// "Completed", "Cancelled" and "Rejected" are terminal.
//
// Order.status is also written directly by the approve and status routes, not only by the
// aggregate, which is why "On Hold" can coexist with fully reviewed lines and must be
// listed as excluded rather than assumed unreachable.
export const PRODUCTION_ENTRY_STATUSES: OrderStatus[] = ["Preparing", "Ready for Shipping"];

export function isProductionAllowedFrom(status: OrderStatus): boolean {
  return PRODUCTION_ENTRY_STATUSES.includes(status);
}

/** The fields the production gate needs. Loaded by the caller; this function does no I/O. */
export type ProductionGateSubject = {
  preparationDecision: string | null;
  order: { status: string; approvalStatus: string };
};

/**
 * Whether this order line may have production started or scheduled against it.
 *
 * Returns the refusal in the `{ _appCode, message }` shape both call sites already
 * understand, or null when production is allowed. Deliberately pure: the roasting route
 * needs to check this inside its transaction before any inventory moves, while the
 * production-requirement route checks it before opening one, and a function that did its
 * own reads could not serve both without an extra round trip.
 *
 * Not gated on productionRequiredQuantity. That column is written only by preparation
 * review and goes stale as coverage moves; the live shortfall is authoritative and is
 * computed separately by each caller.
 */
export function productionGateRefusal(
  subject: ProductionGateSubject,
  verb: "schedule" | "start" = "schedule",
): { _appCode: number; message: string } | null {
  const { order, preparationDecision } = subject;

  // Status first: it produces the most specific message, and it is the check the existing
  // lifecycle test asserts against for a cancelled order.
  if (!isOrderStatus(order.status) || !isProductionAllowedFrom(order.status)) {
    return {
      _appCode: 409,
      message: `Cannot ${verb} production for an order in status "${order.status}".`,
    };
  }

  // Belt and braces. status and approvalStatus are separate columns written by the same
  // route, so a disagreement between them means something wrote one without the other.
  if (order.approvalStatus !== "Yes") {
    return {
      _appCode: 409,
      message: `Cannot ${verb} production: this order has not been approved (approval is "${order.approvalStatus}").`,
    };
  }

  // Per line, because a roast targets one line and the order-level status is a derived
  // column. A null decision means preparation review never ran for this line, so nothing
  // has reserved shelf stock against it and no shortfall has been established.
  if (preparationDecision === null) {
    return {
      _appCode: 409,
      message: `Cannot ${verb} production: this line has not completed preparation review.`,
    };
  }

  return null;
}

/**
 * Late lifecycle-serialization barrier for order-backed production.
 *
 * Call this INSIDE the production transaction, after the OrderItem and inventory work and
 * immediately before commit. It locks the parent Order row and re-evaluates eligibility
 * against transaction-current committed state, so a Hold or Cancel that committed while
 * this transaction was running is seen and the whole transaction rolls back.
 *
 * ── Why the lock is taken here and not earlier ─────────────────────────────
 * The roasting transaction writes OrderItem (recalcOrderItemStatus) before it finishes, and
 * preparation-review writes OrderItem and then Order. Taking Order first in production
 * would invert that and deadlock: production would hold Order and wait for OrderItem while
 * review held OrderItem and waited for Order. Acquiring Order last keeps production in the
 * same direction review already uses — OrderItem then Order — so no cycle exists.
 *
 * ── Why FOR UPDATE OF o, and not a conditional UPDATE ─────────────────────
 * FOR UPDATE takes the same conflicting row lock a status transition needs, without writing
 * anything: no business-visible timestamp is touched. Under READ COMMITTED, once the lock
 * is granted Postgres re-reads the latest committed version of the row, so the values
 * returned here are transaction-current rather than from this transaction's snapshot. The
 * OF o restricts the lock to the Order row: locking the joined OrderItem too would put an
 * OrderItem lock AFTER Order in the roasting path and reintroduce the inversion above.
 *
 * ── Why preparationDecision may be read under this same lock ──────────────
 * It is serialized transitively rather than directly, which is sound only while all of the
 * following hold — verified at the time of writing:
 *   1. preparation-review is the ONLY writer of OrderItem.preparationDecision in the
 *      application (every other reference in src/ is a read).
 *   2. It never writes null: decisionFor returns one of three non-null literals, so a
 *      decision can go null -> decided or decided -> decided', never decided -> null.
 *      (Re-review DOES overwrite an existing decision — the weaker "never becomes null" is
 *      the property this argument needs, not "only ever set once".)
 *   3. That same transaction always writes the parent Order row before commit
 *      (order.updateMany, unconditional, after every OrderItem update).
 * Because of (3), no review can commit a decision change while this lock is held; because
 * of (2), a decision that is already non-null cannot become null under us. If a future
 * change writes preparationDecision without touching the Order row, this argument breaks
 * and the decision must be locked directly.
 */
export async function assertOrderStillAcceptsProduction(
  tx: PrismaTx,
  orderItemId: string,
  verb: "schedule" | "start" = "schedule",
): Promise<void> {
  const rows = await tx.$queryRaw<
    { status: string; approvalStatus: string; preparationDecision: string | null }[]
  >`
    SELECT o."status", o."approvalStatus", oi."preparationDecision"
      FROM "OrderItem" oi
      JOIN "Order" o ON o."id" = oi."orderId"
     WHERE oi."id" = ${orderItemId}
       FOR UPDATE OF o
  `;
  const current = rows[0];
  if (!current) throw { _appCode: 404, message: "Order item not found." };

  const refusal = productionGateRefusal(
    {
      preparationDecision: current.preparationDecision,
      order: { status: current.status, approvalStatus: current.approvalStatus },
    },
    verb,
  );
  if (refusal) throw refusal;
}

export const REASON_MAX_LENGTH = 500;

// ─── Quantity validation (business rule 6) ──────────────────────────────────
//
// Precision: this codebase has an established, repo-wide convention for kg-denominated
// quantity fields — round to 3 decimal places (gram-level precision) via `+value.toFixed(3)`
// before comparing or storing. Confirmed present in every backend route that does kg
// arithmetic: src/app/api/deliveries/route.ts, src/app/api/roasting-batches/route.ts,
// src/app/api/roasting-batches/[id]/package/route.ts, and
// src/app/api/order-items/[id]/fulfillment-options/route.ts. availableQuantity and
// productionRequiredQuantity are the same Float/"Kg" field family (see OrderItem in
// schema.prisma), so this is the correct precision to reuse here — not an invented one.
//
// Why toFixed(3) + Number(...) is safe (not naive float equality): toFixed produces a
// decimal *string* first ("0.300"), and parsing that string back to a number always
// yields the same nearest-double for a given decimal string. Two values that round to
// the same 3-decimal string therefore always compare === after this normalization, even
// though the raw unrounded floats might differ by representation error
// (e.g. 0.1 + 0.2 === 0.30000000000000004 !== 0.3, but roundKg(0.1 + 0.2) === roundKg(0.3)).
export const KG_DECIMAL_PLACES = 3;

export function roundKg(value: number): number {
  // Normalize -0 to 0 so it never leaks into a JSON response or a stored row.
  const rounded = +value.toFixed(KG_DECIMAL_PLACES);
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function quantitiesEqual(a: number, b: number): boolean {
  return roundKg(a) === roundKg(b);
}

// Maximum: no cap on quantityKg-shaped fields exists anywhere else in this codebase
// (checked src/app/api/orders/route.ts and src/app/api/orders/[id]/route.ts — both only
// enforce Number.isFinite + qty > 0, no upper bound). Rather than invent an arbitrary
// disconnected constant, the ceiling used here is the order item's own requested
// quantityKg: neither availableQuantity nor productionRequiredQuantity can ever
// legitimately exceed what was actually ordered. This is a narrower, business-derived
// bound, not a guessed precision/limit.
function validateQuantityBound(label: string, value: number, requestedQty: number): string | null {
  if (!Number.isFinite(value)) return `${label} must be a finite number.`;
  if (value < 0) return `${label} must not be negative.`;
  if (roundKg(value) > roundKg(requestedQty)) return `${label} must not exceed the requested quantity (${requestedQty}).`;
  return null;
}

/**
 * Validates availableQuantity / productionRequiredQuantity against a decision and the
 * item's requested quantityKg, per business rule 6. Returns an error message, or null
 * if valid. Does not enforce the Blocked-note requirement — that is order-level (a
 * single `note` field on the request body), enforced by the calling route.
 */
export function validatePreparationQuantities(
  decision: PreparationDecision,
  requestedQty: number,
  availableQuantity: number | null | undefined,
  productionRequiredQuantity: number | null | undefined
): string | null {
  const avail = availableQuantity ?? 0;
  const needed = productionRequiredQuantity ?? 0;

  // Bounds apply uniformly to every decision, including Blocked — a Blocked item's
  // quantities are optional but, if sent, still must not be negative, non-finite, or
  // larger than what was actually ordered.
  const availBoundError = validateQuantityBound("availableQuantity", avail, requestedQty);
  if (availBoundError) return availBoundError;
  const neededBoundError = validateQuantityBound("productionRequiredQuantity", needed, requestedQty);
  if (neededBoundError) return neededBoundError;

  switch (decision) {
    case "Available on Shelf":
      if (!quantitiesEqual(avail, requestedQty))
        return "availableQuantity must equal the requested quantity for 'Available on Shelf'.";
      if (!quantitiesEqual(needed, 0))
        return "productionRequiredQuantity must be zero for 'Available on Shelf'.";
      return null;

    case "Needs Production":
      if (!quantitiesEqual(avail, 0))
        return "availableQuantity must be zero for 'Needs Production'.";
      if (!quantitiesEqual(needed, requestedQty))
        return "productionRequiredQuantity must equal the requested quantity for 'Needs Production'.";
      return null;

    case "Partially Available":
      if (!(roundKg(avail) > 0))
        return "availableQuantity must be greater than zero for 'Partially Available'.";
      if (!(roundKg(needed) > 0))
        return "productionRequiredQuantity must be greater than zero for 'Partially Available'.";
      if (!quantitiesEqual(avail + needed, requestedQty))
        return "availableQuantity + productionRequiredQuantity must equal the requested quantity for 'Partially Available'.";
      return null;

    case "Blocked":
      return null; // bounds already checked above; no further decision-specific constraint
  }
}

// ─── Order-level aggregation (business rule 5) ──────────────────────────────

export type PreparationAggregateStatus = "Waiting Preparation Review" | "Preparing" | "Ready for Shipping";

/**
 * Aggregates OrderItem.preparationDecision values into an order-level status.
 * Used both by preparation-review (after writing decisions) and by "resume"
 * (recomputed fresh from whatever decisions already exist — no stored snapshot).
 */
export function aggregatePreparationStatus(
  items: { preparationDecision: string | null }[]
): PreparationAggregateStatus {
  if (items.length === 0) return "Waiting Preparation Review";
  if (items.some((i) => !i.preparationDecision)) return "Waiting Preparation Review";
  const allShelf = items.every((i) => i.preparationDecision === "Available on Shelf");
  return allShelf ? "Ready for Shipping" : "Preparing";
}

// ─── Activity helper ─────────────────────────────────────────────────────────

export async function appendOrderActivity(
  tx: PrismaTx,
  params: {
    orderId: string;
    type: ActivityType;
    message: string;
    department?: NoteDepartment | null;
    authorId?: string | null;
    authorName: string;
    metadata?: Prisma.InputJsonValue;
  }
) {
  return tx.orderActivity.create({
    data: {
      orderId: params.orderId,
      type: params.type,
      message: params.message,
      department: params.department ?? null,
      authorId: params.authorId ?? null,
      authorName: params.authorName,
      metadata: params.metadata,
    },
  });
}
