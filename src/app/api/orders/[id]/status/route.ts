import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { releaseShelfStock } from "@/lib/services/shelf-allocation";
import {
  appendOrderActivity,
  aggregatePreparationStatus,
  isStatusAction,
  isCancelAllowedFrom,
  HOLD_FROM_STATUSES,
  RESUME_FROM_STATUS,
  COMPLETE_FROM_STATUSES,
  REASON_MAX_LENGTH,
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

      // A cancelled order must stop holding shelf stock, otherwise its reservations sit
      // there forever and quietly starve every other order of coffee that is physically
      // present. Released rows are kept for audit rather than deleted.
      if (action === "cancel") {
        const cancelledItems = await tx.orderItem.findMany({
          where: { orderId: id },
          select: { id: true },
        });
        for (const item of cancelledItems) {
          await releaseShelfStock(tx, item.id);
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
    });

    return NextResponse.json(result);
  } catch (err: unknown) {
    if (err && typeof err === "object" && "_appCode" in err) {
      const e = err as { _appCode: number; message: string };
      return NextResponse.json({ error: e.message }, { status: e._appCode });
    }
    return handlePrismaError(err);
  }
}
