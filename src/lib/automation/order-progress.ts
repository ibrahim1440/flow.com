/**
 * The order as a whole, for WhatsApp status notifications (feat/wa-status-rules).
 *
 * Pure and client-safe: no database, no Next. The hook points (deliveries, preparation) compute
 * the order-level state before and after their change with these functions and raise
 * `order.progress_changed` only on a real transition; tests/automation/order-progress.test.ts pins
 * every rule here under plain Node.
 *
 * ── Order level, never per line ──
 * A multi-line order delivered line by line moves «لم يُسلّم» → «سُلِّم جزئياً» ONCE, on the first
 * shipment that leaves something still to deliver; further partial shipments are not transitions.
 * The last shipment closes the order («مكتمل», owner decision O2), which `order.status_changed`
 * already announces — so there is no separate "delivered in full" message to send twice.
 *
 * ── Silent events ──
 * The one-time «إعادة حساب حالات الطلبات» corrects statuses that were already true in the past. Its
 * events still describe what changed (the audit trail and the order's history keep them), but they
 * carry `silent: true` and the dispatcher turns them into no message at all.
 */

export type OrderDeliveryState = "not_delivered" | "part_delivered" | "delivered";

export type DeliveryLine = {
  quantityUnits: number | null;
  deliveredUnits: number;
  quantityKg: number;
  deliveredQty: number;
};

const KG_EPSILON = 0.0005;

const lineDelivered = (l: DeliveryLine) =>
  l.quantityUnits != null ? l.deliveredUnits >= l.quantityUnits : l.deliveredQty >= l.quantityKg - KG_EPSILON;
const lineStarted = (l: DeliveryLine) => (l.quantityUnits != null ? l.deliveredUnits > 0 : l.deliveredQty > KG_EPSILON);

/** The order-level delivery state from its lines (an order with no line has nothing delivered). */
export function orderDeliveryState(lines: readonly DeliveryLine[]): OrderDeliveryState {
  if (lines.length === 0 || !lines.some(lineStarted)) return "not_delivered";
  return lines.every(lineDelivered) ? "delivered" : "part_delivered";
}

/**
 * The lines as they were before one delivery was recorded against one of them: the same lines
 * with that delivery's units / kilograms taken back off.
 */
export function linesBeforeDelivery<T extends DeliveryLine & { id: string }>(
  after: readonly T[],
  delivery: { orderItemId: string; units: number | null; kg: number },
): T[] {
  return after.map((l) =>
    l.id !== delivery.orderItemId
      ? l
      : {
          ...l,
          deliveredUnits: Math.max(0, l.deliveredUnits - (delivery.units ?? 0)),
          deliveredQty: Math.max(0, l.deliveredQty - delivery.kg),
        },
  );
}

/** A delivery's order-level transition worth announcing, or null. */
export function deliveryProgressTransition(before: OrderDeliveryState, after: OrderDeliveryState): { from: OrderDeliveryState; to: "part_delivered" } | null {
  return after === "part_delivered" && before !== "part_delivered" ? { from: before, to: "part_delivered" } : null;
}

/** Preparation decisions that mean a line has to be produced (roasted) before it can ship. */
export const NEEDS_PRODUCTION_DECISIONS: readonly string[] = ["Needs Production", "Partially Available"];

/** «بانتظار الإنتاج» at order level: some line still has to be produced. Blocked lines do not count. */
export function orderNeedsProduction(items: readonly { preparationDecision: string | null }[]): boolean {
  return items.some((i) => NEEDS_PRODUCTION_DECISIONS.includes(i.preparationDecision ?? ""));
}

/** Order statuses a resumed order cannot land in (it is resumed into an open status). */
const NOT_A_RESUME = new Set(["On Hold", "Cancelled", "Rejected", "Completed"]);

/** `order.status_changed` from «معلّق مؤقتاً» back into an open status. */
export function isResume(from: unknown, to: unknown): boolean {
  return from === "On Hold" && typeof to === "string" && to !== "" && !NOT_A_RESUME.has(to);
}

/** Preparation / auto-close triggers that only correct the past (the one-time recompute). */
export const SILENT_TRIGGERS: readonly string[] = ["recompute", "release_recompute"];

/** An automation event that must produce no message (written by the recompute). */
export function isSilentEventPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const p = payload as Record<string, unknown>;
  return p.silent === true || (typeof p.trigger === "string" && SILENT_TRIGGERS.includes(p.trigger));
}
