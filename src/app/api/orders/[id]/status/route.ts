import { NextResponse } from "next/server";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { releaseShelfStock } from "@/lib/services/shelf-allocation";
import { releaseFinishedUnits } from "@/lib/services/finished-products";
import {
  appendOrderActivity,
  aggregatePreparationStatus,
  completionRefusal,
  isStatusAction,
  isCancelAllowedFrom,
  HOLD_FROM_STATUSES,
  RESUME_FROM_STATUS,
  COMPLETE_FROM_STATUSES,
  REASON_MAX_LENGTH,
  lockOrderLifecycleResources,
  type OrderStatus,
  type StatusAction,
} from "@/lib/services/order-operations";

type Params = { params: Promise<{ id: string }> };

const ACTIVITY_TYPE_BY_ACTION = {
  hold: "ORDER_HELD",
  resume: "ORDER_RESUMED",
  cancel: "ORDER_CANCELLED",
  complete: "ORDER_COMPLETED",
} as const satisfies Record<StatusAction, string>;

export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireSub("orders", "manage_status");
  if (error) return error;

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { action, reason } = (body ?? {}) as { action?: unknown; reason?: unknown };

  if (!isStatusAction(action)) {
    return NextResponse.json(
      { error: "action must be one of: hold, resume, cancel, complete." },
      { status: 400 }
    );
  }

  const trimmedReason = typeof reason === "string" ? reason.trim() : "";
  if ((action === "hold" || action === "cancel") && !trimmedReason) {
    return NextResponse.json({ error: `reason is required for '${action}'.` }, { status: 400 });
  }
  if (trimmedReason.length > REASON_MAX_LENGTH) {
    return NextResponse.json(
      { error: `reason must be at most ${REASON_MAX_LENGTH} characters.` },
      { status: 400 }
    );
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id },
        select: {
          id: true,
          status: true,
          ownerId: true,
          items: { select: { preparationDecision: true } },
        },
      });
      if (!order) throw { _appCode: 404, message: "Order not found." };

      const isOwner = order.ownerId !== null && order.ownerId === user.id;
      const isAdmin = user.role === "admin";
      if (!isOwner && !isAdmin) {
        throw { _appCode: 403, message: "Only the order owner or an admin can change order status." };
      }

      const currentStatus = order.status as OrderStatus;
      let expectedFromStatuses: OrderStatus[];
      let newStatus: OrderStatus;

      if (action === "hold") {
        expectedFromStatuses = HOLD_FROM_STATUSES;
        newStatus = "On Hold";
      } else if (action === "resume") {
        expectedFromStatuses = [RESUME_FROM_STATUS];
        newStatus = aggregatePreparationStatus(order.items);
      } else if (action === "cancel") {
        if (!isCancelAllowedFrom(currentStatus)) {
          throw { _appCode: 409, message: `Cannot cancel an order in status "${currentStatus}".` };
        }
        expectedFromStatuses = [currentStatus];
        newStatus = "Cancelled";
      } else {
        expectedFromStatuses = COMPLETE_FROM_STATUSES;
        newStatus = "Completed";
      }

      if (action !== "cancel" && !expectedFromStatuses.includes(currentStatus)) {
        throw {
          _appCode: 409,
          message: `Action '${action}' is not allowed from status "${currentStatus}".`,
        };
      }

      // ── Canonical lock order ────────────────────────────────────────────────
      // Cancel and complete release this order's reservations further down. Taking those
      // allocation, lot and line locks HERE, before the Order row is touched, is what keeps
      // this route on the ALLOC → OrderItem → Order order that preparation review and
      // roasting already use. Acquiring Order first and reaching back for allocations
      // afterwards is the inversion that made this route deadlock against a concurrent
      // review; see lockOrderLifecycleResources for the full invariant.
      //
      // Only for the two actions that release. Hold and resume touch no allocations, so
      // locking them would serialise those against unrelated work for nothing.
      if (action === "cancel" || action === "complete") {
        await lockOrderLifecycleResources(tx, id);
      }

      // ── Completion integrity gate ───────────────────────────────────────────
      // Both reads happen AFTER lockOrderLifecycleResources, which has just taken
      // FOR UPDATE across StockAllocation → FinishedGoodsLot → OrderItem for this order.
      // That ordering is the whole point, and it is why this gate acquires NO lock of its
      // own: it reads rows the transaction already holds, so it adds no edge to the lock
      // graph and cannot introduce the OrderItem → StockAllocation inversion.
      //
      // Why a reservation can neither appear nor vanish between this check and the status
      // write. Every operational writer of StockAllocation — preparation review, the legacy
      // packaging reservation, delivery, cancel/complete, and order edit/delete — must
      // write an OrderItem row of this order in the same transaction before it can commit
      // (review and packaging through casUpdateOrderItem, delivery through its conditional
      // deliveredUnits claim, edit/delete through the row deletion itself). Holding every
      // OrderItem row therefore blocks all of them: one that committed earlier is visible
      // to these fresh statement snapshots, and one still in flight cannot commit until
      // this transaction ends — at which point its own guard sees a Completed order and
      // refuses. The single writer not serialised this way is the admin factory/training
      // reset, which deletes every allocation in the database and is not an operational
      // path a single order can race against.
      //
      // Throwing rolls the transaction back, so a refused completion releases nothing,
      // writes no status and records no activity.
      if (action === "complete") {
        const lines = await tx.orderItem.findMany({
          where: { orderId: id },
          select: {
            quantityUnits: true,
            deliveredUnits: true,
            quantityKg: true,
            deliveredQty: true,
          },
        });
        const held = await tx.stockAllocation.aggregate({
          where: { orderItem: { orderId: id }, status: "RESERVED" },
          _count: { _all: true },
          _sum: { quantityUnits: true, quantityKg: true },
        });
        const refusal = completionRefusal(lines, {
          rows: held._count._all,
          units: held._sum.quantityUnits ?? 0,
          kg: held._sum.quantityKg ?? 0,
        });
        if (refusal) throw refusal;
      }

      // Conditional guard: re-checks the same expected-from set atomically, so a
      // concurrent transition landing between our read and this write is caught
      // instead of silently overwritten. Same technique as deliveries/route.ts.
      const updateResult = await tx.order.updateMany({
        where: { id, status: { in: expectedFromStatuses } },
        data: { status: newStatus },
      });
      if (updateResult.count === 0) {
        throw {
          _appCode: 409,
          message: "Order status changed before this action could be applied. Please reload and retry.",
        };
      }

      // A terminal order must stop holding shelf stock, otherwise its reservations sit
      // there forever and quietly starve every other order of coffee that is physically
      // present. Released rows are kept for audit rather than deleted.
      //
      // "complete" is included alongside "cancel": completing an order whose lines were
      // never fully delivered used to leave the undelivered units reserved to a closed
      // order, invisible to everyone and unrecoverable without editing the database by
      // hand. Where a line WAS delivered its allocation is already CONSUMED, so the
      // release is a no-op there and only genuine leftovers are handed back.
      if (action === "cancel" || action === "complete") {
        const cancelledItems = await tx.orderItem.findMany({
          where: { orderId: id },
          select: { id: true },
        });
        for (const item of cancelledItems) {
          // Both pools: legacy lines hold kilograms, SKU lines hold units. An order can
          // in principle contain either, so release from both rather than guessing.
          await releaseShelfStock(tx, item.id);
          await releaseFinishedUnits(tx, item.id);
        }
      }

      let message: string;
      if (action === "resume") {
        message = `Order resumed by ${user.name}. Status recomputed to ${newStatus}.`;
      } else {
        const verb = action === "hold" ? "held" : action === "cancel" ? "cancelled" : "completed";
        message = `Order ${verb} by ${user.name}` + (trimmedReason ? `: ${trimmedReason}` : ".");
      }

      await appendOrderActivity(tx, {
        orderId: id,
        type: ACTIVITY_TYPE_BY_ACTION[action],
        message,
        authorId: user.id,
        authorName: user.name,
      });

      return tx.order.findUnique({
        where: { id },
        select: { id: true, status: true, ownerId: true },
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
