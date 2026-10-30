/**
 * Who may act on an order's lifecycle (hold / resume / cancel / complete) and who may change its
 * owner — the order-ownership decision (fix/order-owner), pure so the screen and the routes ask
 * the same question and the unit tests can ask it without a server.
 *
 * ── Why an owner at all ──
 * Since the production simplification (Phases B/C) preparation is automatic: nobody "claims" an
 * order any more, so under the frozen claim-on-commit rule a new order never had an owner and only
 * the administrator could hold, resume or cancel it. An order now gets its owner at creation, from
 * the person who created it: the creating user for a manual order, the quotation's owner (the sales
 * rep) for an order raised from a quotation — falling back to whoever converted it — and the acting
 * user for every other path. The first manual Commit Allocation still claims an order that has no
 * owner (pre-release rows), and only those.
 *
 * ── The matrix ──
 *   owner (order.ownerId = me) with orders at edit     → hold / resume / cancel / complete own order
 *   orders › manage_status (the "manager" of orders)   → any order; a scoped sales rep (sales module
 *                                                        without lead_assign) only an order of a
 *                                                        customer they are the account owner of
 *   the admin role                                     → any order, through the admin-role gate
 *                                                        (`orders.status_override`, identity only)
 *   anyone else                                        → refused (403)
 * Changing the owner is the manager / admin rows only (never the owner handing it on alone).
 * The lifecycle barriers (a cancel with live reservations or deliveries, the completion gate, the
 * from-status rules) are unchanged and apply after this decision, to everybody.
 */
import { canEdit, hasSubPrivilege, type Permissions } from "@/lib/auth-shared";
import { isScopedSalesRep } from "@/lib/services/sales/scope";

export type OrderAccessUser = { id: string; role: string; permissions: Permissions };
export type OrderAccessSubject = {
  ownerId: string | null;
  /** The customer's account owner (Customer.accountOwnerId), for the sales-rep scope rule. */
  customerAccountOwnerId?: string | null;
};

export type OrderAccessDecision =
  | { ok: true; as: "owner" | "manager" | "admin" }
  | { ok: false; status: 403; message: string };

export const STATUS_REFUSAL_NOT_ALLOWED = "Only the order owner, an orders manager or an admin can change order status.";
export const OWNER_CHANGE_REFUSAL = "Only an orders manager or an admin can change the order owner.";
export const SCOPE_REFUSAL = "This order belongs to another rep's customer.";

/**
 * A sales rep who sees only their own customers — one predicate for the whole system (council gate S4):
 * services/sales/scope.ts. Re-exported here under the name the order matrix has always used.
 */
export { isScopedSalesRep } from "@/lib/services/sales/scope";

/** The manager / admin rows of the matrix (shared by the status actions and the owner change). */
function managerAccess(user: OrderAccessUser, order: OrderAccessSubject, refusal: string): OrderAccessDecision {
  if (hasSubPrivilege(user.permissions, "orders", "manage_status")) {
    if (isScopedSalesRep(user.permissions, user.role) && (order.customerAccountOwnerId ?? null) !== user.id) {
      return { ok: false, status: 403, message: SCOPE_REFUSAL };
    }
    return { ok: true, as: "manager" };
  }
  if (user.role === "admin") return { ok: true, as: "admin" };
  return { ok: false, status: 403, message: refusal };
}

/** May `user` hold / resume / cancel / complete `order`? */
export function statusActionAccess(user: OrderAccessUser, order: OrderAccessSubject): OrderAccessDecision {
  if (order.ownerId !== null && order.ownerId === user.id && canEdit(user.permissions, "orders")) {
    return { ok: true, as: "owner" };
  }
  return managerAccess(user, order, STATUS_REFUSAL_NOT_ALLOWED);
}

/** May `user` change the owner of `order`? */
export function ownerChangeAccess(user: OrderAccessUser, order: OrderAccessSubject): OrderAccessDecision {
  return managerAccess(user, order, OWNER_CHANGE_REFUSAL);
}

/**
 * The owner of an order raised from a quotation: the deal's owner (the sales rep) while that
 * account is active, else the converting user.
 */
export function ownerForConvertedOrder(
  deal: { ownerId: string | null; owner?: { active: boolean } | null },
  actorId: string,
): string {
  return deal.ownerId && deal.owner?.active ? deal.ownerId : actorId;
}
