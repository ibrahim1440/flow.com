import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { assertAdminRoleGate, forbidden, requireAuth } from "@/lib/auth-server";
import { hasModuleAccess } from "@/lib/auth-shared";
import { handleDomainError } from "@/lib/api-error";
import { appendOrderActivity, TERMINAL_ORDER_STATUSES, type OrderStatus } from "@/lib/services/order-operations";
import { ownerChangeAccess } from "@/lib/services/orders/owner-access";

type Params = { params: Promise<{ id: string }> };

const OWNER_SELECT = { id: true, name: true, role: true } as const;

/**
 * PUT /api/orders/[id]/owner — «تغيير المسؤول»: a manager (orders › manage_status; a scoped sales
 * rep only on their own customers' orders) or the admin role hands an open order to another active
 * employee, or clears the owner. Audited on the order's timeline (OWNER_CHANGED, with the two
 * names in the metadata). Never the owner alone: handing an order on is a manager's call.
 *
 * Body: { ownerId: string | null }. A terminal order (Completed / Cancelled / Rejected) is refused
 * — there is nothing left to own. The same owner again is a no-op: no write, no activity.
 */
export async function PUT(request: Request, { params }: Params) {
  const { user, error } = await requireAuth();
  if (error) return error;
  if (!hasModuleAccess(user.permissions, "orders")) return forbidden();

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { ownerId } = (body ?? {}) as { ownerId?: unknown };
  if (!(ownerId === null || (typeof ownerId === "string" && ownerId.trim()))) {
    return NextResponse.json({ error: "ownerId must be an employee id or null." }, { status: 400 });
  }
  const nextOwnerId = ownerId === null ? null : (ownerId as string).trim();

  try {
    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.order.findUnique({
        where: { id },
        select: {
          id: true, status: true, ownerId: true,
          owner: { select: OWNER_SELECT },
          customer: { select: { accountOwnerId: true } },
        },
      });
      if (!existing) throw { _appCode: 404, message: "Order not found." };

      const access = ownerChangeAccess(user, { ownerId: existing.ownerId, customerAccountOwnerId: existing.customer.accountOwnerId });
      if (!access.ok) throw { _appCode: access.status, message: access.message };
      if (access.as === "admin") await assertAdminRoleGate(user, "orders.owner_override");

      if (TERMINAL_ORDER_STATUSES.has(existing.status as OrderStatus)) {
        throw { _appCode: 409, message: `Cannot change the owner of an order in status "${existing.status}".` };
      }

      const next = nextOwnerId
        ? await tx.employee.findFirst({ where: { id: nextOwnerId, active: true }, select: OWNER_SELECT })
        : null;
      if (nextOwnerId && !next) throw { _appCode: 400, message: "The owner is not an active employee." };

      if ((existing.ownerId ?? null) === nextOwnerId) {
        return { id: existing.id, ownerId: existing.ownerId, owner: existing.owner, changed: false };
      }

      // Keyed on the owner just read: a concurrent change makes this match nothing.
      const updated = await tx.order.updateMany({
        where: { id, ownerId: existing.ownerId },
        data: { ownerId: nextOwnerId },
      });
      if (updated.count === 0) {
        throw { _appCode: 409, message: "Order changed before this action could be applied. Please reload and retry." };
      }

      const fromName = existing.owner?.name ?? "unassigned";
      const toName = next?.name ?? "unassigned";
      const message = `Order owner changed by ${user.name}: ${fromName} → ${toName}.`;
      await appendOrderActivity(tx, {
        orderId: id,
        type: "OWNER_CHANGED",
        message,
        authorId: user.id,
        authorName: user.name,
        metadata: {
          fromOwnerId: existing.ownerId, fromOwnerName: existing.owner?.name ?? null,
          toOwnerId: nextOwnerId, toOwnerName: next?.name ?? null,
        },
      });

      return { id, ownerId: nextOwnerId, owner: next, changed: true };
    }, TX_OPTS);

    return NextResponse.json(result);
  } catch (err: unknown) {
    return handleDomainError(err);
  }
}
