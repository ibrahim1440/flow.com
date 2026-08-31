import { NextResponse } from "next/server";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { appendOrderActivity, REASON_MAX_LENGTH } from "@/lib/services/order-operations";
import {
  isProductionOrderAction,
  isProductionTransitionAllowed,
  PRODUCTION_TRANSITIONS,
  type ProductionOrderAction,
  type ProductionOrderStatusValue,
} from "@/lib/services/production-planning";

type Params = { params: Promise<{ id: string }> };

const ACTIVITY_TYPE_BY_ACTION = {
  release: "PRODUCTION_ORDER_RELEASED",
  complete: "PRODUCTION_ORDER_COMPLETED",
  cancel: "PRODUCTION_ORDER_CANCELLED",
} as const satisfies Record<ProductionOrderAction, string>;

/**
 * POST /api/production-orders/[id]/status  { action: "release" | "complete" | "cancel", reason? }
 *
 * Moves a production order through its state machine. The transitions are declared in
 * PRODUCTION_TRANSITIONS and enforced here, which is what makes COMPLETED and CANCELLED
 * genuinely terminal rather than merely unreachable through the buttons.
 *
 * What this route deliberately does NOT do is touch stock. A production order is a
 * planning and execution record; the roasting and packaging routes remain the only things
 * that move inventory. Cancelling an order that already consumed green coffee through a
 * completed roast must therefore leave that consumption exactly where it is — the coffee
 * was really roasted, and the finished goods it became are really on the shelf, available
 * to any order that needs them.
 */
export async function POST(request: Request, { params }: Params) {
  // Cancelling production work is governed by the same privilege that cancels a roasting
  // batch; releasing and closing are governed by the one that starts production. Both are
  // existing keys — a new sub-privilege key would read as false for every employee whose
  // stored permissions predate it, locking out even an admin.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { action, reason } = (body ?? {}) as { action?: unknown; reason?: unknown };

  if (!isProductionOrderAction(action)) {
    return NextResponse.json(
      { error: "action must be one of: release, complete, cancel." },
      { status: 400 }
    );
  }

  const { error, user } = await requireSub(
    "production",
    action === "cancel" ? "cancel_batch" : "start_batch"
  );
  if (error) return error;

  const trimmedReason = typeof reason === "string" ? reason.trim() : "";
  if (action === "cancel" && !trimmedReason) {
    return NextResponse.json({ error: "reason is required for 'cancel'." }, { status: 400 });
  }
  if (trimmedReason.length > REASON_MAX_LENGTH) {
    return NextResponse.json(
      { error: `reason must be at most ${REASON_MAX_LENGTH} characters.` },
      { status: 400 }
    );
  }

  const { id } = await params;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const order = await tx.productionOrder.findUnique({
        where: { id },
        select: {
          id: true,
          productionNumber: true,
          status: true,
          targetUnits: true,
          targetWeightKg: true,
          productSku: { select: { skuCode: true } },
          sourceOrderItem: { select: { orderId: true } },
        },
      });
      if (!order) throw { _appCode: 404, message: "Production order not found." };

      const current = order.status as ProductionOrderStatusValue;
      const { from, to } = PRODUCTION_TRANSITIONS[action];

      if (!isProductionTransitionAllowed(current, action)) {
        throw {
          _appCode: 409,
          message: `Cannot ${action} a production order in status "${current}". Allowed from: ${from.join(", ")}.`,
        };
      }

      // Closing an order that produced nothing would record work that never happened and
      // leave the demand it was covering unschedulable-looking. That situation is a
      // cancellation, and the message says so.
      if (action === "complete") {
        const agg = await tx.roastingBatch.aggregate({
          where: { productionOrderId: id, isBlend: false, status: { not: "Rejected" } },
          _sum: { roastedBeanQuantity: true },
        });
        if ((agg._sum.roastedBeanQuantity ?? 0) <= 0) {
          throw {
            _appCode: 409,
            message:
              "Cannot complete a production order with no roasting behind it. Link the batches that produced it, or cancel the order instead.",
          };
        }
      }

      // Conditional guard: the same expected-from set re-checked atomically, so a
      // concurrent transition landing between the read and this write is caught rather
      // than silently overwritten. Same technique as the order status route.
      const updated = await tx.productionOrder.updateMany({
        where: { id, status: { in: from } },
        data: { status: to },
      });
      if (updated.count === 0) {
        throw {
          _appCode: 409,
          message: "Production order status changed before this action could be applied. Please reload and retry.",
        };
      }

      // Audit onto the customer order's timeline — the existing activity architecture.
      // A production order raised for stock rather than for a line has no timeline to
      // write to; the status change is still recorded on the row itself via updatedAt.
      if (order.sourceOrderItem) {
        const verb = action === "release" ? "released to production" : action === "complete" ? "completed" : "cancelled";
        await appendOrderActivity(tx, {
          orderId: order.sourceOrderItem.orderId,
          type: ACTIVITY_TYPE_BY_ACTION[action],
          message:
            `Production order ${order.productionNumber} (${order.targetUnits} × ${order.productSku.skuCode}) ` +
            `${verb} by ${user.name}` + (trimmedReason ? `: ${trimmedReason}` : "."),
          authorId: user.id,
          authorName: user.name,
          metadata: {
            productionOrderId: order.id,
            productionNumber: order.productionNumber,
            from: current,
            to,
          },
        });
      }

      return tx.productionOrder.findUnique({
        where: { id },
        select: { id: true, productionNumber: true, status: true },
      });
    }, TX_OPTS);

    return NextResponse.json(result);
  } catch (err: unknown) {
    if (err && typeof err === "object" && "_appCode" in err) {
      const e = err as { _appCode: number; message: string };
      return NextResponse.json({ error: e.message }, { status: e._appCode });
    }
    return handlePrismaError(err);
  }
}
