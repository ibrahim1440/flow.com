import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { parseContact } from "@/lib/services/customers/fields";
import { customerInScope } from "@/lib/services/sales/customer-access";
import { requireContactEditor } from "@/lib/services/customers/owner-contact";
import { writeSettingsAudit } from "@/lib/services/settings/audit";

type Params = { params: Promise<{ id: string }> };

const SELECT = { id: true, name: true, role: true, phone: true, email: true, position: true } as const;

/**
 * GET /api/customers/[id]/contacts — the people at a customer («جهات الاتصال»).
 *
 * Contact particulars are the customers module's (owner policy F4, lib/auth/customer-detail):
 * reading needs the module, changing them needs it at edit — the gates of GET and PUT
 * /api/customers/[id].
 */
export async function GET(_req: Request, { params }: Params) {
  const { user, error } = await requireModule("customers");
  if (error) return error;
  const { id } = await params;
  // A scoped sales rep reaches only the customers in their own book (services/sales/scope.ts) — 404 otherwise.
  if (!(await customerInScope(user, id))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const customer = await prisma.customer.findUnique({ where: { id }, select: { id: true } });
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const contacts = await prisma.customerContact.findMany({
    where: { customerId: id }, orderBy: [{ position: "asc" }, { createdAt: "asc" }], select: SELECT,
  });
  return NextResponse.json(contacts);
}

/** POST /api/customers/[id]/contacts — add a contact at the end of the list. */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  // Customers at edit, or the customer's account owner (readiness review P1-3: adding a contact person).
  const { user, kind, error } = await requireContactEditor(id);
  if (error) return error;
  // A scoped sales rep reaches only the customers in their own book (services/sales/scope.ts) — 404 otherwise.
  if (!(await customerInScope(user, id))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }
  const parsed = parseContact((body ?? {}) as Record<string, unknown>);
  if (!parsed.ok) return NextResponse.json({ error: parsed.errorAr, errorEn: parsed.error }, { status: 400 });
  try {
    const customer = await prisma.customer.findUnique({ where: { id }, select: { id: true } });
    if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const last = await prisma.customerContact.findFirst({ where: { customerId: id }, orderBy: { position: "desc" }, select: { position: true } });
    const contact = await prisma.customerContact.create({
      data: {
        customerId: id,
        name: parsed.data.name!,
        role: parsed.data.role ?? null,
        phone: parsed.data.phone ?? null,
        email: parsed.data.email ?? null,
        position: (last?.position ?? -1) + 1,
      },
      select: SELECT,
    });
    if (kind === "owner") {
      await writeSettingsAudit(prisma, {
        section: "organisation", action: "SETTINGS_UPDATED", entityType: "Customer", entityId: id, changed: ["contact"],
        before: null, after: { contactId: contact.id, name: parsed.data.name, role: parsed.data.role ?? null, phone: parsed.data.phone ?? null, email: parsed.data.email ?? null },
        reason: "CUSTOMER_CONTACT_BY_OWNER", actor: { id: user.id, name: user.name },
      });
    }
    return NextResponse.json(contact, { status: 201 });
  } catch (err) {
    return handlePrismaError(err);
  }
}
