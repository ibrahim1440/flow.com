// Readiness review P1-3 (owner, Nov 2026): the rep who owns a customer (its account owner) corrects that customer's
// CONTACT details — phone, e-mail, address, city, and the contact people (add / edit; never delete) — without the
// customers module at edit, which would also let them create and delete customers. Nothing else: not the name, the tax /
// CR numbers, the credit terms, the owner, the tier or segment, the consent switches. Every such change is audited.
import { prisma } from "@/lib/db";
import { hasModuleAccess } from "@/lib/auth-shared";
import { contactEditorKind } from "./owner-contact-rules";
import { customerInScope } from "@/lib/services/sales/customer-access";

export { OWNER_CONTACT_FIELDS, OWNER_ALLOWED_KEYS, contactEditorKind, forbiddenOwnerKeys } from "./owner-contact-rules";
import { requireAuth } from "@/lib/auth-server";
import { NextResponse } from "@/lib/api-response";

/**
 * The door of the customer write routes the owner may use: customers at edit, or the account owner of the customer.
 * 404 when the customer does not exist or is outside a scoped rep's book (never a 403 that would confirm it exists);
 * 403 NOT_ACCOUNT_OWNER for a customer in the book that the caller does not own.
 */
export async function requireContactEditor(customerId: string) {
  const { user, error } = await requireAuth();
  if (error) return { user: null as never, kind: null, error };
  if (!hasModuleAccess(user.permissions, "customers")) {
    return { user: null as never, kind: null, error: NextResponse.json({ error: "Insufficient permissions" }, { status: 403 }) };
  }
  const c = await prisma.customer.findUnique({ where: { id: customerId }, select: { accountOwnerId: true } });
  if (!c || !(await customerInScope(user, customerId))) return { user: null as never, kind: null, error: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  const kind = contactEditorKind(user, c.accountOwnerId);
  if (!kind) {
    return { user: null as never, kind: null, error: NextResponse.json({ error: "تعديل بيانات العميل للمندوب المسؤول عنه أو لمن يملك تعديل العملاء.", errorEn: "Only the customer's account owner, or someone who edits customers, changes its details.", code: "NOT_ACCOUNT_OWNER" }, { status: 403 }) };
  }
  return { user, kind, error: null };
}
