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
