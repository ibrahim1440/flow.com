import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { appendOrderActivity, APPROVAL_ENTRY_STATUSES, type OrderStatus } from "@/lib/services/order-operations";

const APPROVAL_ENTRY_SET = new Set<string>(APPROVAL_ENTRY_STATUSES);

type Params = { params: Promise<{ id: string }> };

const VALID_DECISIONS = new Set(["Yes", "No", "Pending"]);
const REASON_MAX_LENGTH = 500;

export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireSub("orders", "approve");
  if (error) return error;

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { decision, reason } = (body ?? {}) as { decision?: unknown; reason?: unknown };

  if (typeof decision !== "string" || !VALID_DECISIONS.has(decision)) {
    return NextResponse.json({ error: "decision must be 'Yes', 'No', or 'Pending'." }, { status: 400 });
  }

  const trimmedReason = typeof reason === "string" ? reason.trim() : "";

  if (decision === "No" && !trimmedReason) {
    return NextResponse.json({ error: "reason is required when rejecting an order." }, { status: 400 });
  }

  if (trimmedReason.length > REASON_MAX_LENGTH) {
    return NextResponse.json({ error: `reason must be at most ${REASON_MAX_LENGTH} characters.` }, { status: 400 });
  }

  const targetOrderStatus: OrderStatus =
    decision === "Yes" ? "Waiting Preparation Review" : decision === "No" ? "Rejected" : "Waiting Approval";

  try {
    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.order.findUnique({
        where: { id },
        select: {
          id: true,
          notes: true,
          status: true,
          ownerId: true,
          approvalStatus: true,
          approvalDate: true,
          items: { select: { preparationDecision: true } },
        },
      });
      if (!existing) {
        throw { _appCode: 404, message: "Order not found." };
      }

      // Idempotent repeat: the requested decision already fully matches the order's
      // current state (repeated Yes/No/Pending with nothing to change). Return the
      // current row as-is, in the same shape as the normal path — no write, no
      // duplicate activity.
      if (existing.approvalStatus === decision && existing.status === targetOrderStatus) {
        return {
          id: existing.id,
          approvalStatus: existing.approvalStatus,
          approvalDate: existing.approvalDate,
          notes: existing.notes,
          status: existing.status,
          ownerId: existing.ownerId,
        };
      }

      // Terminal/downstream-status guard: approval decisions may only be made while the
      // order is still within the approval route's own domain. This blocks the approve
      // route from silently rewinding real operational progress (e.g. an order already
      // in "Preparing", "Completed", or "On Hold" cannot be forced back to
      // "Waiting Preparation Review" via a stray "Yes" call).
      if (!APPROVAL_ENTRY_SET.has(existing.status)) {
        throw {
          _appCode: 409,
          message: `Approval decision cannot be changed while the order is in status "${existing.status}".`,
        };
      }

      const data: {
        approvalStatus: string;
        approvalDate: Date | null;
        notes?: string;
        status: string;
        ownerId: string | null;
      } = {
        approvalStatus: decision,
        approvalDate: decision === "Pending" ? null : new Date(),
        status: targetOrderStatus,
        ownerId: existing.ownerId,
      };

      if (decision === "Yes") {
        // Fresh approval or reconsidering a prior rejection: ownership transfers to
        // whoever approved it (no dedicated Operations Coordinator pool exists yet).
        data.ownerId = user.id;
      } else if (decision === "No") {
        const auditLine = `[Approval Rejected] ${new Date().toISOString()} by ${user.id}: ${trimmedReason}`;
        data.notes = existing.notes ? `${existing.notes}\n${auditLine}` : auditLine;
        // Rejected is terminal — an owner left assigned here would be misleading, since
        // there is nothing left for them to own.
        data.ownerId = null;
      } else {
        // Pending (revert). ownerId is cleared only when it is safe to do so: no item on
        // the order has been preparation-reviewed yet, i.e. Operations has not started
        // acting on this order. If preparation review already began, stripping ownership
        // would orphan real progress, so the existing ownerId is left untouched.
        const noPreparationProgress = existing.items.every((i) => !i.preparationDecision);
        if (noPreparationProgress) {
          data.ownerId = null;
        }
      }

      // Guarded write, keyed on the exact snapshot just read (status AND approvalStatus).
      // Any concurrent change to either field between the read above and this write —
      // by this same route or by /status (hold/cancel) — makes this match zero rows.
      const updateResult = await tx.order.updateMany({
        where: { id, status: existing.status, approvalStatus: existing.approvalStatus },
        data,
      });

      if (updateResult.count === 0) {
        const current = await tx.order.findUnique({
          where: { id },
          select: { id: true, approvalStatus: true, approvalDate: true, notes: true, status: true, ownerId: true },
        });
        if (current && current.approvalStatus === decision && current.status === targetOrderStatus) {
          // A concurrent call already landed the exact same outcome — treat as an
          // idempotent success rather than an error.
          return current;
        }
        throw {
          _appCode: 409,
          message: "Order changed before this decision could be applied. Please reload and retry.",
        };
      }

      const updated = await tx.order.findUnique({
        where: { id },
        select: { id: true, approvalStatus: true, approvalDate: true, notes: true, status: true, ownerId: true },
      });

      if (decision === "Yes") {
        await appendOrderActivity(tx, {
          orderId: id,
          type: "ORDER_APPROVED",
          message: `Order approved. Ownership transferred to ${user.name}.`,
          authorId: user.id,
          authorName: user.name,
        });
      } else if (decision === "No") {
        await appendOrderActivity(tx, {
          orderId: id,
          type: "ORDER_REJECTED",
          message: `Order rejected: ${trimmedReason}`,
          authorId: user.id,
          authorName: user.name,
        });
      } else {
        await appendOrderActivity(tx, {
          orderId: id,
          type: "STATUS_CHANGED",
          message: `Approval decision reverted to Pending by ${user.name}. Status set to Waiting Approval.`,
          authorId: user.id,
          authorName: user.name,
        });
      }

      return updated;
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
