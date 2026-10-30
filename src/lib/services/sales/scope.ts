import { hasModuleAccess, hasSubPrivilege, type Permissions } from "@/lib/auth-shared";

/**
 * Who may see whose records.
 *
 * One place, because the answer must be identical on every endpoint. Two endpoints that
 * disagree about scope are not a style inconsistency — they are a leak, and the one that is
 * wrong is whichever one somebody reads the customer list out of.
 *
 * The rule: a rep sees what they own. Seeing everybody's leads, deals, quotations and
 * activities is its own privilege, because the customer list is the commercially sensitive
 * part of a sales system and the person most likely to walk out with it is a salesperson
 * who is leaving.
 *
 * `lead_assign` is the key rather than a new one, so the privilege that lets somebody move
 * work between reps is the same privilege that lets them see the work. Splitting the two
 * would create a role that can reassign leads it cannot read.
 */
export function seesAllSales(permissions: Permissions | Record<string, unknown>): boolean {
  return hasSubPrivilege(permissions as Permissions, "sales", "lead_assign");
}

/**
 * Who may read the TEAM's sales reports (GET /api/sales/reports, the «تقارير المبيعات» tab) —
 * owner decision, batch Sales B: the sales manager and the admin, never a rep.
 *
 * `lead_assign` is the existing permission that marks a sales manager: it is the one that
 * already lets somebody see every rep's leads, deals and quotations (`seesAllSales`). There is
 * no reports-specific permission, and inventing one would leave every current manager without
 * the reports until somebody granted it. The admin role passes whatever its stored document
 * says (with SIMPLE MODE on it holds every permission anyway).
 *
 * Pure, so the screen asks the same question the endpoint does.
 */
export function seesTeamReports(permissions: Permissions | Record<string, unknown>, role: string | null | undefined): boolean {
  return role === "admin" || seesAllSales(permissions);
}

/**
 * Who may see and set a customer's «مستثنى من عمولة العميل الجديد» flag (commission plan builder):
 * the sales manager (`lead_assign`, the same mark as the team reports), the admin, and the holder of
 * `commissions › manage_plans`. Never a rep — the flag decides somebody's commission, and the rep it
 * would pay is the person who must not set it.
 */
export function managesNewClientExclusion(permissions: Permissions | Record<string, unknown>, role: string | null | undefined): boolean {
  return seesTeamReports(permissions, role) || hasSubPrivilege(permissions as Permissions, "commissions", "manage_plans")
    || hasSubPrivilege(permissions as Permissions, "commissions", "manage_settings");
}

/** A Prisma `where` fragment scoping by owner, or `{}` for someone who sees everything. */
export function ownerScope(
  permissions: Permissions | Record<string, unknown>,
  userId: string,
): { ownerId?: string } {
  return seesAllSales(permissions) ? {} : { ownerId: userId };
}

/**
 * The refusal used when an id from the URL points at somebody else's record.
 *
 * 404, not 403. Telling a rep "that deal exists but is not yours" confirms the existence of
 * a customer relationship they have no business knowing about — which is how a departing
 * salesperson enumerates the pipeline one id at a time.
 */
export const NOT_FOUND_MESSAGE = "Not found.";

/**
 * Who may see which collections.
 *
 * Three widening rings, and the order matters:
 *
 *   Finance    — anyone who can verify, refuse or reverse must see the whole queue, because
 *                a queue you cannot see is a queue you cannot work.
 *   Team       — `collection_view_team`, or the existing all-sales privilege. A manager who
 *                can already read every deal can read the money against them.
 *   Own        — everybody else sees what they themselves submitted, and nothing more.
 *
 * Deliberately NOT "the deals I own": a rep who is reassigned a deal should not thereby
 * gain the history of somebody else's receipts against it, and a rep whose deal is
 * reassigned away should not lose sight of what they themselves recorded.
 */
export function collectionScope(
  permissions: Permissions | Record<string, unknown>,
  userId: string,
): { all: true } | { all: false; submittedById: string } {
  const p = permissions as Permissions;
  const finance =
    hasSubPrivilege(p, "commissions", "collection_verify") ||
    hasSubPrivilege(p, "commissions", "collection_reject") ||
    hasSubPrivilege(p, "commissions", "collection_reverse") ||
    // BATCH22 WP-D: the accountant who confirms «سندات القبض» sees every collection, like Finance.
    hasSubPrivilege(p, "accounting", "receipts_confirm");
  const team = hasSubPrivilege(p, "sales", "collection_view_team") || seesAllSales(p);
  return finance || team ? { all: true } : { all: false, submittedById: userId };
}

/** The Prisma `where` fragment for the above. */
export function collectionWhere(
  permissions: Permissions | Record<string, unknown>,
  userId: string,
): { submittedById?: string } {
  const scope = collectionScope(permissions, userId);
  return scope.all ? {} : { submittedById: scope.submittedById };
}

// ─── Customer and order visibility (P0 — sales CRM optimization) ──────────────────────────────
//
// GET /api/customers and GET /api/orders used to answer every holder of `customers` or `orders`
// with the whole book, while leads, deals and quotations were already owner-scoped above. A rep
// who could not open another rep's deal could still read that rep's customers and order history
// by asking the customer and order endpoints instead. Same rule, applied to both now.
//
// Who is scoped: a SALES persona without the all-sales mark (`isScopedSalesRep`, the rule the
// order-owner matrix already uses) — and only that persona. Everybody else keeps exactly the
// reach they had:
//   - production, dispatch, packaging and QC work the whole order queue: an operations login,
//     or a rep who also holds one of those duties, is never narrowed (owner policy F4 already
//     trims what they see of the customer);
//   - order approval and preparation review decide on every order, so they keep every order;
//   - accounting › ar reads every customer's balance, and customers › sales_hold (the credit
//     controller) decides holds and grace on any customer;
//   - the admin role and `lead_assign` (the sales manager) see everything.

/** Duties that need the whole order queue whatever else the holder has. */
export function worksWholeOrderQueue(permissions: Permissions | Record<string, unknown>): boolean {
  const p = permissions as Permissions;
  return ["production", "dispatch", "packaging", "qc"].some((m) => hasModuleAccess(p, m))
    || hasSubPrivilege(p, "orders", "approve")
    || hasSubPrivilege(p, "orders", "prepare_review")
    || (hasModuleAccess(p, "accounting") && hasSubPrivilege(p, "accounting", "ar"))
    || hasSubPrivilege(p, "customers", "sales_hold");
}

/** True when this viewer sees only the customers (and their orders) in their own book. */
export function customersScopedToOwner(user: { role?: string | null; permissions: Permissions | Record<string, unknown> }): boolean {
  const p = user.permissions as Permissions;
  if (user.role === "admin") return false;
  if (!hasModuleAccess(p, "sales") || seesAllSales(p)) return false;
  return !worksWholeOrderQueue(p);
}

/**
 * A rep's book: the accounts they are responsible for («المسؤول»), plus any customer they hold a
 * deal or an order for — a lead converted by the rep creates the customer before anybody names
 * an account owner, and the rep must not lose sight of their own new customer meanwhile.
 *
 * And the unassigned pool: a customer with no account owner (walk-in and legacy customers). Nobody's
 * account is not another rep's account, and the order desk has always let any rep take such a
 * customer's order (the order-owner matrix, tests/ops/http/order-owner.test.ts). What other reps did
 * there stays theirs — deals, quotations, activities and collections keep their own owner scope.
 * A converted lead now gets its owner as account owner, so new customers never land in the pool;
 * assigning an owner to the legacy ones empties it (decision for the owner, docs/sales/RBAC_MATRIX.md).
 */
export function ownedCustomerWhere(userId: string) {
  return {
    OR: [
      { accountOwnerId: userId },
      { opportunities: { some: { ownerId: userId } } },
      { orders: { some: { ownerId: userId } } },
      { accountOwnerId: null },
    ],
  };
}

/**
 * The ONE "is this person scoped to their own book?" predicate (council gate S4). The order-owner matrix,
 * the customer files, the delivery-note print and every customer / order endpoint ask it — the older
 * `isScopedSalesRep` (services/orders/owner-access.ts) is this function under its old name.
 */
export function isScopedSalesRep(permissions: Permissions | Record<string, unknown>, role?: string | null): boolean {
  return customersScopedToOwner({ role, permissions });
}

/** The Prisma `where` fragment for customers, or `{}` for somebody who sees every customer. */
export function customerVisibilityWhere(user: { id: string; role?: string | null; permissions: Permissions | Record<string, unknown> }) {
  return customersScopedToOwner(user) ? ownedCustomerWhere(user.id) : {};
}

/**
 * The orders a rep sees: their own orders, and the orders of the customers they are responsible for or hold
 * a deal on. NOT every order of an unassigned (pool) customer — the pool lets any rep find and serve such a
 * customer, but another rep's order there stays theirs (the delivery-note rule, tests/print/http).
 */
export function orderedByOrForWhere(userId: string) {
  return {
    OR: [
      { ownerId: userId },
      { customer: { accountOwnerId: userId } },
      { customer: { opportunities: { some: { ownerId: userId } } } },
    ],
  };
}

/** The Prisma `where` fragment for orders, or `{}` for somebody who sees every order. */
export function orderVisibilityWhere(user: { id: string; role?: string | null; permissions: Permissions | Record<string, unknown> }) {
  return customersScopedToOwner(user) ? orderedByOrForWhere(user.id) : {};
}
