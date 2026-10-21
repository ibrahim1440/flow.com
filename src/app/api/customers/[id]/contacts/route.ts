import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireEdit, requireModule } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { parseContact } from "@/lib/services/customers/fields";

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
  const { error } = await requireModule("customers");
  if (error) return error;
  const { id } = await params;
  const customer = await prisma.customer.findUnique({ where: { id }, select: { id: true } });
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const contacts = await prisma.customerContact.findMany({
    where: { customerId: id }, orderBy: [{ position: "asc" }, { createdAt: "asc" }], select: SELECT,
  });
  return NextResponse.json(contacts);
}

/** POST /api/customers/[id]/contacts — add a contact at the end of the list. */
export async function POST(request: Request, { params }: Params) {
  const { error } = await requireEdit("customers");
  if (error) return error;
  const { id } = await params;
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
    return NextResponse.json(contact, { status: 201 });
  } catch (err) {
    return handlePrismaError(err);
  }
}
