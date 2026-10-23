import type { Prisma } from "@/generated/prisma/client";
import { automationListens, emitAutomationEvent } from "@/lib/automation/emit";
import { deliveryProgressTransition, linesBeforeDelivery, orderDeliveryState } from "@/lib/automation/order-progress";

type Tx = Prisma.TransactionClient;

/**
 * «سُلِّم جزئياً» for the order as a whole (feat/wa-status-rules), raised by the delivery route in
 * the delivery's own transaction, after the line's delivered quantity was claimed.
 *
 * Order level: the order's lines now, and the same lines without this delivery, decide whether the
 * ORDER just moved «لم يُسلّم» → «سُلِّم جزئياً». A second partial shipment, on the same line or
 * another, is no transition and raises nothing; the shipment that completes the order is announced
 * as «مكتمل» by the auto-close. Reads nothing when no rule listens.
 */
export async function emitDeliveryProgress(
  tx: Tx,
  input: { orderId: string; orderItemId: string; deliveryId: string; units: number | null; kg: number; actorId: string | null },
): Promise<void> {
  if (!(await automationListens("order.progress_changed"))) return;
  const lines = await tx.orderItem.findMany({
    where: { orderId: input.orderId },
    select: { id: true, quantityUnits: true, deliveredUnits: true, quantityKg: true, deliveredQty: true },
  });
  const after = orderDeliveryState(lines);
  const before = orderDeliveryState(linesBeforeDelivery(lines, { orderItemId: input.orderItemId, units: input.units, kg: input.kg }));
  const t = deliveryProgressTransition(before, after);
  if (!t) return;
  await emitAutomationEvent(tx, {
    eventType: "order.progress_changed",
    subjectType: "Order",
    subjectId: input.orderId,
    payload: { from: t.from, to: t.to, orderItemId: input.orderItemId, deliveryId: input.deliveryId },
    actorId: input.actorId,
  });
}
