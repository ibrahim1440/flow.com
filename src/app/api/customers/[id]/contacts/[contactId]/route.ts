import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireEdit } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { parseContact } from "@/lib/services/customers/fields";

type Params = { params: Promise<{ id: string; contactId: string }> };

const SELECT = { id: true, name: true, role: true, phone: true, email: true, position: true } as const;

/**
 * PUT /api/customers/[id]/contacts/[contactId] — correct a contact. Keys left out of the body
 * are unchanged; "" clears an optional one. The contact must belong to the customer in the URL:
 * a contact id from another customer reads as 404, never as somebody else's record.
 */
export async function PUT(request: Request, { params }: Params) {
  const { error } = await requireEdit("customers");
  if (error) return error;
  const { id, contactId } = await params;
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }
  const b = (body ?? {}) as Record<string, unknown>;
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
    const existing = await prisma.customerContact.findFirst({ where: { id: contactId, customerId: id }, select: { id: true } });
    if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const contact = await prisma.customerContact.update({
      where: { id: contactId },
      data: { ...parsed.data, ...(position !== undefined ? { position } : {}) },
      select: SELECT,
    });
    return NextResponse.json(contact);
  } catch (err) {
    return handlePrismaError(err);
  }
}

/** DELETE /api/customers/[id]/contacts/[contactId] — remove a contact. */
export async function DELETE(_req: Request, { params }: Params) {
  const { error } = await requireEdit("customers");
  if (error) return error;
  const { id, contactId } = await params;
  try {
    const gone = await prisma.customerContact.deleteMany({ where: { id: contactId, customerId: id } });
    if (gone.count === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ deleted: true });
  } catch (err) {
    return handlePrismaError(err);
  }
}
