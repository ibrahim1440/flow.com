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

// ─── Completion delivery gate ──────────────────────────────────────────────
//
// An order may reach "Completed" only once every line has actually shipped.
//
// Reaching Ready for Shipping is a statement about STOCK — preparation review found cover
// for the order — not about fulfilment. Completion used to check only that status plus the
// caller's authority, so an order with nothing delivered could be closed as fulfilled, and
// the release that runs immediately afterwards would hand its reserved coffee back to the
// free pool. The result was a Completed order with deliveredUnits = 0, no Delivery rows,
// and nothing in the ledger recording that anything had failed to ship.
//
// The comparison is PER LINE and discriminated on quantityUnits, because this model has
// two kinds of line and only one of them counts in units:
//
//   SKU line (quantityUnits non-null) — units are authoritative and quantityKg is a
//     projection of them (see the note at the top of finished-products.ts). Comparing
//     kilograms here would gate on a derived value rather than on the real one.
//   Legacy kilogram line (quantityUnits null) — rows predating SKU-based ordering. They
//     carry no units at all, so units cannot answer the question and kilograms are the
//     only authority they have. Gating those on units would make every one of them
//     permanently uncompletable, which is why this is not simply
//     `deliveredUnits === quantityUnits`.
//
// Stated as EXACT delivery, not "at least enough". Completed certifies an internally
// consistent fulfilment state, so the gate fails closed in both directions: a line that
// shipped MORE than it ordered is as inconsistent as one that shipped less, and an
// integrity gate must not wave it through. Deliberately not resting on "the delivery route
// makes over-delivery impossible" — that argument protects data this route creates, not
// historical or corrupted rows, which are exactly what a gate is for.
//
// Completion additionally requires that the order hold NO live RESERVED allocation. A
// fully delivered line holds none, because both delivery paths trim reservations down to
// the remaining demand as their last act; a reservation surviving full delivery is
// therefore an inconsistent state. Completion refuses it and leaves it untouched rather
// than quietly releasing it — silently normalising that state is how the original defect
// stayed invisible. Cancel keeps releasing reservations under its own contract; only
// completion is strict, because only completion claims the order was fulfilled.

export type CompletionLine = {
  quantityUnits: number | null;
  deliveredUnits: number;
  quantityKg: number;
  deliveredQty: number;
};

/** Live RESERVED allocations still attached to the order, summarised by the caller. */
export type LiveReservationSummary = {
  rows: number;
  units: number;
  kg: number;
};

/**
 * Kilogram equality tolerance for the completion gate: half a gram.
 *
 * Every kg figure in this codebase is stored at 3 decimal places — gram precision — via
 * roundKg. So the smallest difference between two genuinely different quantities is one
 * gram, 0.001. Half of that is the widest tolerance that can absorb IEEE754 noise from
 * summing several rounded deliveries (drift measured in units of 1e-16) while remaining
 * strictly below one gram, so it can never accept a line that is short or long by a real,
 * representable amount.
 *
 * Concretely: 2.5 kg ordered against 2.499 kg delivered differs by a full gram and is
 * REFUSED — it is a genuine shortfall at the precision this system stores, not noise.
 */
const COMPLETION_KG_EPSILON = 0.0005;

/** Exact fulfilment: not short, and not over. */
export function isLineFullyDelivered(line: CompletionLine): boolean {
  if (line.quantityUnits !== null) return line.deliveredUnits === line.quantityUnits;
  return Math.abs(line.deliveredQty - line.quantityKg) <= COMPLETION_KG_EPSILON;
}

function describeLine(line: CompletionLine): string {
  if (line.quantityUnits !== null) {
    return line.deliveredUnits > line.quantityUnits
      ? `${line.deliveredUnits} delivered against ${line.quantityUnits} ordered`
      : `${line.quantityUnits - line.deliveredUnits} of ${line.quantityUnits} unit(s) outstanding`;
  }
  return line.deliveredQty > line.quantityKg
    ? `${roundKg(line.deliveredQty)} kg delivered against ${line.quantityKg} kg ordered`
    : `${roundKg(line.quantityKg - line.deliveredQty)} of ${line.quantityKg} kg outstanding`;
}

/**
 * The refusal for a completion that would close an order in an inconsistent state, or null
 * when every line is delivered exactly and nothing remains reserved.
 *
 * Pure, so the route can call it inside its transaction against rows it has already locked,
 * and so both rules are testable without a database.
 *
 * Quantities are checked first because an undelivered order is the ordinary case; a
 * surviving reservation is an anomaly and gets its own, differently worded refusal so the
 * two are never confused in an operator's hands.
 */
export function completionRefusal(
  lines: CompletionLine[],
  reservations: LiveReservationSummary,
): { _appCode: number; message: string } | null {
  const inconsistent = lines.filter((line) => !isLineFullyDelivered(line));
  if (inconsistent.length > 0) {
    // Bounded: a long multi-line order must not produce an unbounded error string.
    const detail = inconsistent.slice(0, 3).map(describeLine).join("; ");
    const more = inconsistent.length > 3 ? ` and ${inconsistent.length - 3} more line(s)` : "";
    return {
      _appCode: 409,
      message:
        `Cannot complete this order: ${inconsistent.length} of ${lines.length} line(s) are not ` +
        `delivered exactly in full — ${detail}${more}. ` +
        `Every line must be delivered in full before the order can be completed.`,
    };
  }

  if (reservations.rows > 0) {
    const held = reservations.units > 0
      ? `${reservations.units} unit(s)`
      : `${roundKg(reservations.kg)} kg`;
    return {
      _appCode: 409,
      message:
        `Cannot complete this order: every line is delivered, but ${held} across ` +
        `${reservations.rows} allocation row(s) are still reserved to it. A fully delivered ` +
        `order should hold no reservation, so this is an inconsistent state. It has been left ` +
        `untouched for investigation rather than released.`,
    };
  }

  return null;
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

/**
 * Late lifecycle barrier for dispatch, mirroring the production one.
 *
 * Call as the last acquisition of the delivery transaction, after the allocation, lot and
 * OrderItem work — which keeps dispatch on ALLOC → OrderItem → Order. Locks the Order row
 * and re-reads its status as of now, so a cancellation or hold that committed while the
 * delivery was in flight is seen rather than missed by the unlocked read at the top.
 *
 * Uses isDeliveryAllowedFrom, the same source of truth the route's own entry check uses, so
 * the two cannot drift.
 */
export async function assertOrderStillAcceptsDelivery(
  tx: PrismaTx,
  orderItemId: string,
): Promise<void> {
  const rows = await tx.$queryRaw<{ status: string }[]>`
    SELECT o."status"
      FROM "OrderItem" oi
      JOIN "Order" o ON o."id" = oi."orderId"
     WHERE oi."id" = ${orderItemId}
       FOR UPDATE OF o`;
  const current = rows[0];
  if (!current) throw { _appCode: 404, message: "Order item not found" };

  if (!isOrderStatus(current.status) || !isDeliveryAllowedFrom(current.status)) {
    throw {
      _appCode: 409,
      message: `Cannot record a delivery for an order in status "${current.status}".`,
    };
  }
}

// ─── Reservation eligibility and compare-and-swap ──────────────────────────

// Statuses in which finished goods may be reserved TO a customer order line.
//
// Deliberately a separate constant from DELIVERY_ALLOWED_STATUSES and
// PRODUCTION_ENTRY_STATUSES even though all three currently hold the same two values.
// They are different questions — may we ship, may we produce, may we promise stock — and
// the codebase already keeps the first two apart for that reason. Collapsing them would
// make a future divergence in one silently change the other two.
//
// "Preparing" and "Ready for Shipping" are the only statuses aggregatePreparationStatus can
// return once every line has a decision, so they are exactly the reviewed, live states.
// Everything else is excluded for a specific reason:
//   "Waiting Approval"            — nobody has agreed to buy this yet.
//   "Waiting Preparation Review"  — no reviewed demand exists to reserve against, which is
//                                   the stale-ceiling problem in its purest form.
//   "On Hold"                     — the status whose whole purpose is to stop work.
//   "Completed"                   — its leftovers were already released; re-promising them
//                                   strands stock on a closed order.
//   "Cancelled" / "Rejected"      — terminal, reservations already released.
export const RESERVATION_ALLOWED_STATUSES: OrderStatus[] = ["Preparing", "Ready for Shipping"];

export function isReservationAllowedFrom(status: string): boolean {
  return isOrderStatus(status) && RESERVATION_ALLOWED_STATUSES.includes(status);
}

/**
 * May finished goods be reserved to this order line right now?
 *
 * A boolean rather than a throw, because the packaging path must keep packaging even when
 * the owner order cannot take a reservation — the coffee still exists and still belongs on
 * the shelf. Only the auto-reservation is skipped.
 */
export function canReserveToOrderLine(subject: {
  preparationDecision: string | null;
  order: { status: string; approvalStatus: string };
}): boolean {
  return (
    isReservationAllowedFrom(subject.order.status) &&
    subject.order.approvalStatus === "Yes" &&
    subject.preparationDecision !== null &&
    // A blocked line is one the reviewer deliberately refused to promise stock to.
    subject.preparationDecision !== "Blocked"
  );
}

/** The transaction-current state a reservation decision must be based on. */
export type LineReservationState = {
  id: string;
  updatedAt: Date;
  quantityUnits: number | null;
  deliveredUnits: number;
  quantityKg: number;
  deliveredQty: number;
  preparationDecision: string | null;
  order: { status: string; approvalStatus: string };
};

/**
 * Re-read the line inside the transaction, immediately before its demand ceiling is
 * computed.
 *
 * The defect this exists for: both preparation review and the legacy packaging reservation
 * derived their ceiling from a snapshot taken at the very top of the transaction, then
 * released and reserved against allocation state that was transaction-current. One decision,
 * two points in time — measured at 4 delivered plus 10 reserved on a line ordered 10, and at
 * 24 reserved on a line ordered 12 when two reviews ran together.
 *
 * This is a plain read: it takes no row lock and therefore cannot affect the lock order
 * frozen in dd14506. It narrows the window; casUpdateOrderItem below closes it.
 */
export async function readLineReservationState(
  tx: PrismaTx,
  orderItemId: string,
): Promise<LineReservationState | null> {
  const row = await tx.orderItem.findUnique({
    where: { id: orderItemId },
    select: {
      id: true,
      updatedAt: true,
      quantityUnits: true,
      deliveredUnits: true,
      quantityKg: true,
      deliveredQty: true,
      preparationDecision: true,
      order: { select: { status: true, approvalStatus: true } },
    },
  });
  return row ?? null;
}

/**
 * A timestamp guaranteed to differ from the token we are swapping against.
 *
 * Prisma's implicit @updatedAt is normally enough — it writes new Date() on every update —
 * but the column is timestamp(3), so an update landing in the same millisecond as the value
 * we observed would write back a byte-identical token and a second racing writer's
 * compare-and-swap would wrongly succeed. Forcing at least one millisecond past the observed
 * value removes that edge entirely rather than arguing about how unlikely it is.
 */
export function nextUpdatedAt(seen: Date): Date {
  return new Date(Math.max(Date.now(), seen.getTime() + 1));
}

/**
 * Compare-and-swap on the order line.
 *
 * The predicate is the line's identity plus the exact values the caller's reservation
 * decision was computed from. If a delivery, another review or an order edit committed in
 * between, the row no longer matches, updateMany reports zero rows, and the caller throws —
 * rolling back every allocation release, reservation insert and lot increment made in the
 * same transaction.
 *
 * Under READ COMMITTED the UPDATE blocks on any concurrent writer's row lock and then
 * re-evaluates this WHERE against the newly committed row, which is what makes the losing
 * transaction see the winner's token rather than its own stale copy.
 */
export async function casUpdateOrderItem(
  tx: PrismaTx,
  seen: { id: string; updatedAt: Date; deliveredUnits: number; deliveredQty: number },
  data: Record<string, unknown>,
): Promise<void> {
  const result = await tx.orderItem.updateMany({
    where: {
      id: seen.id,
      updatedAt: seen.updatedAt,
      deliveredUnits: seen.deliveredUnits,
      deliveredQty: seen.deliveredQty,
    },
    // updatedAt is set explicitly rather than left to @updatedAt, so the token is
    // guaranteed to move past the one just swapped against.
    data: { ...data, updatedAt: nextUpdatedAt(seen.updatedAt) },
  });
  if (result.count === 0) {
    throw {
      _appCode: 409,
      message:
        "This order line changed while the request was in flight — a delivery or another " +
        "review committed first. Nothing was reserved. Please reload and retry.",
    };
  }
}

// ─── Lifecycle lock ordering ───────────────────────────────────────────────
//
// THE INVARIANT, for every transaction that changes operational state for an order:
//
//     StockAllocation(id ASC) → FinishedGoodsLot(id ASC) → OrderItem(id ASC) → Order
//
// Equivalently, and easier to check in review: never take a StockAllocation or
// FinishedGoodsLot lock while already holding a conflicting lock on an Order or an
// OrderItem. GreenBean and RoastingBatch may be locked before all of these; ProductionOrder
// may be locked any time after OrderItem; advisory locks 7761/7762/7763 keep their places.
//
// ── Why StockAllocation before FinishedGoodsLot ───────────────────────────
// It is the order the paths that take conflicting locks on EXISTING rows already use:
// releaseShelfStock, releaseFinishedUnits and consumeFinishedUnits all update the
// allocation first and the lot second. The reserve paths look inverted — they update the
// lot and then create the allocation — but that second step is an INSERT of a new row,
// which cannot wait on a row another transaction holds, so no StockAllocation → wait edge
// exists there and the two do not form a cycle.
//
// The two release paths iterate allocations in opposite directions (releaseShelfStock
// newest-first, consumeFinishedUnits oldest-first). That is safe only because they operate
// on disjoint row sets by construction — kilogram allocations have quantityUnits NULL and
// unit allocations have it NOT NULL, and each path filters on exactly that. Their comments
// say so, and this ordering depends on it staying true.
//
// Multiple rows are always locked in primary-key order so that two transactions locking
// overlapping sets take them in the same sequence rather than whatever order the planner
// returns.

/**
 * Take the order's allocation, lot and line locks up front, in canonical order.
 *
 * Call this as the FIRST conflicting acquisition of a lifecycle transaction that will later
 * release or consume allocations — before any Order or OrderItem write. It exists so that
 * such a transaction never has to reach backwards for an allocation lock while holding
 * Order, which is the inversion that made cancel deadlock against preparation review.
 *
 * Locking the OrderItem rows here matters as much as locking the allocations: an order can
 * have no allocations at all, and FOR UPDATE over an empty set protects nothing. Preparation
 * review must take the OrderItem lock before it can commit, so holding the item rows is what
 * actually stops new reservations appearing underneath a cancellation — not the allocation
 * locks, which only cover rows that already exist.
 */
export async function lockOrderLifecycleResources(tx: PrismaTx, orderId: string): Promise<void> {
  await tx.$queryRaw`
    SELECT sa."id"
      FROM "StockAllocation" sa
      JOIN "OrderItem" oi ON oi."id" = sa."orderItemId"
     WHERE oi."orderId" = ${orderId}
       AND sa."status" = 'RESERVED'
     ORDER BY sa."id" ASC
       FOR UPDATE OF sa`;

  await tx.$queryRaw`
    SELECT f."id"
      FROM "FinishedGoodsLot" f
     WHERE f."id" IN (
             SELECT DISTINCT sa."finishedGoodsLotId"
               FROM "StockAllocation" sa
               JOIN "OrderItem" oi ON oi."id" = sa."orderItemId"
              WHERE oi."orderId" = ${orderId} AND sa."status" = 'RESERVED')
     ORDER BY f."id" ASC
       FOR UPDATE OF f`;

  await tx.$queryRaw`
    SELECT oi."id" FROM "OrderItem" oi
     WHERE oi."orderId" = ${orderId}
     ORDER BY oi."id" ASC
       FOR UPDATE OF oi`;
}

/**
 * The same, scoped to the one line and lot a delivery touches.
 *
 * A dispatch has no reason to lock the whole order, and locking only what it will consume
 * keeps two lines of the same order shippable at once. The order between the two resources
 * is identical to the whole-order helper above.
 */
export async function lockDeliveryResources(
  tx: PrismaTx,
  orderItemId: string,
  finishedGoodsLotId: string | null,
): Promise<void> {
  await tx.$queryRaw`
    SELECT sa."id" FROM "StockAllocation" sa
     WHERE sa."orderItemId" = ${orderItemId} AND sa."status" = 'RESERVED'
     ORDER BY sa."id" ASC
       FOR UPDATE OF sa`;

  // Every lot this line could touch, not only the one being shipped from. After the
  // shipment the route trims reservations back to the remaining demand, and that reaches
  // lots this delivery never drew from — locking only the target lot would leave those
  // acquired later, while the OrderItem is already held, which is the OrderItem → lot edge
  // this whole change exists to remove. The target lot is unioned in because a first
  // shipment can draw from a lot the line holds no reservation on yet.
  await tx.$queryRaw`
    SELECT f."id" FROM "FinishedGoodsLot" f
     WHERE f."id" IN (
             SELECT sa."finishedGoodsLotId" FROM "StockAllocation" sa
              WHERE sa."orderItemId" = ${orderItemId} AND sa."status" = 'RESERVED'
             UNION
             SELECT ${finishedGoodsLotId}::text WHERE ${finishedGoodsLotId}::text IS NOT NULL)
     ORDER BY f."id" ASC
       FOR UPDATE OF f`;
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
