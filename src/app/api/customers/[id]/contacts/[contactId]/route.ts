import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireEdit } from "@/lib/auth-server";
import { handleDomainError, handlePrismaError } from "@/lib/api-error";
import { mergeAgainst, staleRefusal, versionRequired } from "@/lib/http/stale-record";
import { parseContact } from "@/lib/services/customers/fields";
import { customerInScope } from "@/lib/services/sales/customer-access";
import { requireContactEditor } from "@/lib/services/customers/owner-contact";
import { writeSettingsAudit } from "@/lib/services/settings/audit";

type Params = { params: Promise<{ id: string; contactId: string }> };

const SELECT = { id: true, name: true, role: true, phone: true, email: true, position: true, updatedAt: true } as const;

/**
 * PUT /api/customers/[id]/contacts/[contactId] — correct a contact. Keys left out of the body
 * are unchanged; "" clears an optional one. The contact must belong to the customer in the URL:
 * a contact id from another customer reads as 404, never as somebody else's record.
 */
export async function PUT(request: Request, { params }: Params) {
  // Customers at edit, or the customer's account owner (readiness review P1-3: correcting a contact). DELETE stays
  // customers at edit.
  const { id: cid } = await params;
  const { user, kind, error } = await requireContactEditor(cid);
  if (error) return error;
  const { id, contactId } = await params;
  // A scoped sales rep reaches only the customers in their own book (services/sales/scope.ts) — 404 otherwise.
  if (!(await customerInScope(user, id))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }
  const b = (body ?? {}) as Record<string, unknown>;
  // P2 ERR-06 (gate E1): the version the form was loaded with — required from the screens; merged field by field.
  const noVersion = versionRequired(request, b.expectedUpdatedAt);
  if (noVersion) return handleDomainError(noVersion);
  const stored = await prisma.customerContact.findFirst({ where: { id: contactId, customerId: id } });
  if (!stored) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const merged = mergeAgainst(b, { expected: b.expectedUpdatedAt, baseline: b.baseline, current: stored as unknown as Record<string, unknown> & { updatedAt: Date } });
  if (!merged.ok) return handleDomainError(merged.refusal);
  const parsed = parseContact(b, true);
  if (!parsed.ok) return NextResponse.json({ error: parsed.errorAr, errorEn: parsed.error }, { status: 400 });
  let position: number | undefined;
  if (b.position !== undefined) {
    if (!Number.isInteger(b.position) || (b.position as number) < 0 || (b.position as number) > 10_000) {
      return NextResponse.json({ error: "ترتيب غير صالح.", errorEn: "position must be a whole number from 0." }, { status: 400 });
    }
    position = b.position as number;
  }
  try {
    // Atomic (gate E1): only over the version read above.
    const written = await prisma.customerContact.updateMany({
      where: { id: contactId, customerId: id, updatedAt: stored.updatedAt },
      data: { ...parsed.data, ...(position !== undefined ? { position } : {}) },
    });
    if (written.count === 0) return handleDomainError(staleRefusal(stored.updatedAt));
    const contact = await prisma.customerContact.findUniqueOrThrow({ where: { id: contactId }, select: SELECT });
    if (kind === "owner") {
      await writeSettingsAudit(prisma, {
        section: "organisation", action: "SETTINGS_UPDATED", entityType: "Customer", entityId: id, changed: ["contact"],
        before: { contactId }, after: { contactId, ...parsed.data }, reason: "CUSTOMER_CONTACT_BY_OWNER", actor: { id: user.id, name: user.name },
      });
    }
    return NextResponse.json(contact);
  } catch (err) {
    return handlePrismaError(err);
  }
}

/** DELETE /api/customers/[id]/contacts/[contactId] — remove a contact. */
export async function DELETE(_req: Request, { params }: Params) {
  const { user, error } = await requireEdit("customers");
  if (error) return error;
  const { id, contactId } = await params;
  // A scoped sales rep reaches only the customers in their own book (services/sales/scope.ts) — 404 otherwise.
  if (!(await customerInScope(user, id))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    const gone = await prisma.customerContact.deleteMany({ where: { id: contactId, customerId: id } });
    if (gone.count === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ deleted: true });
  } catch (err) {
    return handlePrismaError(err);
  }
}
