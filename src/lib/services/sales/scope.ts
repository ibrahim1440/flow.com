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
