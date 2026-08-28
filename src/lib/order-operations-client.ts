// Thin client-side fetch wrappers for the Order Operations S0 backend routes.
// Pure functions only — no React state — shared by the Orders page and the
// Preparation Workstation page so the two don't duplicate fetch/error handling.

export type ApiErrorInfo = { status: number; message: string };
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiErrorInfo };

async function postJson<T>(url: string, body: unknown): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, error: { status: 0, message: "Network error. Please check your connection and try again." } };
  }

  if (res.ok) {
    return { ok: true, data: (await res.json()) as T };
  }

  // Backend never leaks raw Prisma/stack traces on these routes — `error` is always
  // a short, safe, user-appropriate string. We only add a fallback for the
  // (unexpected) case the response body isn't JSON at all.
  let message = "An unexpected error occurred. Please try again.";
  try {
    const errBody = await res.json();
    if (errBody && typeof errBody.error === "string") message = errBody.error;
  } catch {
    // non-JSON error body — keep the generic fallback
  }
  return { ok: false, error: { status: res.status, message } };
}

/** Human-facing framing per status code. The backend message itself is already safe to show as-is. */
export function describeApiError(error: ApiErrorInfo): string {
  switch (error.status) {
    case 403:
      return error.message || "You do not have permission to perform this action.";
    case 404:
      return error.message || "This record could not be found. It may have been removed.";
    case 409:
      return error.message || "This action conflicts with the order's current state.";
    case 500:
      return error.message || "Something went wrong. Please try again.";
    default:
      return error.message;
  }
}

export type PreparationDecisionValue =
  | "Available on Shelf"
  | "Needs Production"
  | "Partially Available"
  | "Blocked";

// Quantities are no longer sent: the server reserves what the shelf can actually cover
// and derives the split itself. `decision` is optional — omit it to accept whatever the
// stock supports, or send one to assert an expectation the server will verify (and
// reject with 409 if the shelf cannot back it).
export type PreparationReviewItemInput = {
  orderItemId: string;
  decision?: PreparationDecisionValue;
};

/** What can cover one order item right now. Mirrors GET /api/order-items/[id]/fulfillment-options. */
export type FulfillmentOptions = {
  orderItemId: string;
  requiredQtyKg: number;
  deliveredQty: number;
  reservedQty: number;
  outstandingQty: number;
  freeToPromiseQty: number;
  coverableFromShelfQty: number;
  shortageQty: number;
  matchingLots: {
    id: string;
    batchNumber: string;
    availableQty: number;
    reservedQty: number;
    freeQty: number;
  }[];
};

export async function fetchFulfillmentOptions(
  orderItemId: string
): Promise<ApiResult<FulfillmentOptions>> {
  let res: Response;
  try {
    res = await fetch(`/api/order-items/${orderItemId}/fulfillment-options`);
  } catch {
    return { ok: false, error: { status: 0, message: "Network error. Please check your connection and try again." } };
  }
  if (res.ok) return { ok: true, data: (await res.json()) as FulfillmentOptions };
  let message = "Could not load stock availability.";
  try {
    const errBody = await res.json();
    if (errBody && typeof errBody.error === "string") message = errBody.error;
  } catch { /* non-JSON error body */ }
  return { ok: false, error: { status: res.status, message } };
}

/**
 * The decision the numbers support — the same rule the server applies, evaluated against
 * the state a submission would LEAVE BEHIND rather than the state it starts from.
 *
 * The distinction matters for an item that is already covered: its outstanding demand is
 * 0 and there is nothing left to cover, so judging on `coverableQty <= 0` alone would
 * label a fully reserved item "Needs Production" — the opposite of both the stored value
 * and what the server would record on a re-submit.
 */
export function derivePreparationDecision(
  outstandingQty: number,
  coverableQty: number,
  alreadyReservedQty = 0
): PreparationDecisionValue {
  const willBeReserved = alreadyReservedQty + coverableQty;
  const willStillNeed = Math.max(0, outstandingQty - coverableQty);
  if (willStillNeed <= 0) return "Available on Shelf";
  if (willBeReserved <= 0) return "Needs Production";
  return "Partially Available";
}

/** Rounded to the repo-wide 3-decimal kg convention. Kept here so client components do
 *  not have to import the server-side allocation service (and its Prisma types) to get it. */
export const roundKg = (v: number): number => Number(v.toFixed(3));

export type PreparationReviewResponse = {
  id: string;
  status: string;
  items: {
    id: string;
    preparationDecision: string | null;
    availableQuantity: number | null;
    productionRequiredQuantity: number | null;
  }[];
};

export function submitPreparationReview(
  orderId: string,
  items: PreparationReviewItemInput[],
  note?: string
): Promise<ApiResult<PreparationReviewResponse>> {
  return postJson(`/api/orders/${orderId}/preparation-review`, note ? { items, note } : { items });
}

export type OrderStatusAction = "hold" | "resume" | "cancel" | "complete";

export type OrderStatusActionResponse = { id: string; status: string; ownerId: string | null };

export function submitOrderStatusAction(
  orderId: string,
  action: OrderStatusAction,
  reason?: string
): Promise<ApiResult<OrderStatusActionResponse>> {
  return postJson(`/api/orders/${orderId}/status`, reason !== undefined ? { action, reason } : { action });
}

export type OrderNoteDepartment = "Sales" | "Online" | "Preparation" | "Production" | "Operations" | "Shipping";

export type OrderActivityResponse = {
  id: string;
  type: string;
  message: string;
  department: string | null;
  authorId: string | null;
  authorName: string;
  createdAt: string;
};

export function submitOrderNote(
  orderId: string,
  department: OrderNoteDepartment,
  message: string
): Promise<ApiResult<OrderActivityResponse>> {
  return postJson(`/api/orders/${orderId}/activities`, { department, message });
}

// ─── Shared status-machine helpers (client-side, UI-only — backend is authoritative) ──

export const ORDER_STATUSES_NEEDING_ATTENTION = new Set(["On Hold"]);

export function orderNeedsAttention(order: {
  status: string;
  items: { preparationDecision: string | null }[];
}): boolean {
  return order.status === "On Hold" || order.items.some((i) => i.preparationDecision === "Blocked");
}

const HOLD_FROM_STATUSES = new Set(["Waiting Preparation Review", "Preparing", "Ready for Shipping"]);
const TERMINAL_STATUSES = new Set(["Completed", "Cancelled", "Rejected"]);

export function canHold(status: string): boolean {
  return HOLD_FROM_STATUSES.has(status);
}
export function canResume(status: string): boolean {
  return status === "On Hold";
}
export function canCancel(status: string): boolean {
  return !TERMINAL_STATUSES.has(status);
}
export function canComplete(status: string): boolean {
  return status === "Ready for Shipping";
}
