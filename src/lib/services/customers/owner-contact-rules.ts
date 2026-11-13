// The pure half of owner-contact.ts (readiness review P1-3): which fields the account owner may change, and who is an
// editor at all. Client- and test-safe (no server imports).
import { canEdit, hasModuleAccess, type Permissions } from "@/lib/auth-shared";
import { IDENTITY_FIELDS } from "./customer-identity";

/** The contact fields the account owner changes freely (audited) through PUT /api/customers/[id]. */
export const OWNER_CONTACT_FIELDS = ["phone", "email", "address", "city"] as const;
/**
 * Everything the account owner may send (round 2): the contact fields, the «مسلّمات» (VAT, CR, unified number, national
 * address — each change with a reason, customer-identity.ts) and that reason. Name, credit, terms, owner, tier, opt-outs
 * stay refused.
 */
// P2 ERR-06: `expectedUpdatedAt` is the stale-copy check, not a field (lib/http/stale-record.ts).
export const OWNER_ALLOWED_KEYS: readonly string[] = [...OWNER_CONTACT_FIELDS, ...IDENTITY_FIELDS, "reason", "expectedUpdatedAt", "baseline"]; // the version + the values the form was loaded with (P2 ERR-06, gate E1)

type Viewer = { id: string; permissions: Permissions | Record<string, unknown> };

/** Customers at edit: the full editor. Otherwise the account owner of THIS customer, holding the customers module. Pure. */
export function contactEditorKind(user: Viewer, accountOwnerId: string | null | undefined): "full" | "owner" | null {
  const p = user.permissions as Permissions;
  if (canEdit(p, "customers")) return "full";
  if (hasModuleAccess(p, "customers") && !!accountOwnerId && accountOwnerId === user.id) return "owner";
  return null;
}

/** Keys present in the body that the account owner may not change (the refusal lists them). Pure. */
export function forbiddenOwnerKeys(body: Record<string, unknown>): string[] {
  return Object.keys(body).filter((k) => !OWNER_ALLOWED_KEYS.includes(k));
}

