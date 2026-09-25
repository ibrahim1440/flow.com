import { hasSubPrivilege, type Permissions } from "@/lib/auth-shared";

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
    hasSubPrivilege(p, "commissions", "collection_reverse");
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
