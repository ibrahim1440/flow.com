import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireAnyModule, requireEdit } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { canSeeCustomerContact, CUSTOMER_NAME_SELECT } from "@/lib/auth/customer-detail";
import { parseAccountFields } from "@/lib/services/customers/fields";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireAnyModule("customers", "orders");
  if (error) return error;

  const { id } = await params;
  const related = {
    _count: { select: { orders: true } },
    roastPreferences: {
      include: { greenBean: { select: { id: true, beanType: true, serialNumber: true } } },
      orderBy: { createdAt: "asc" as const },
    },
  };
  // F4 / review F-1: without the customers module, the name and roast targets only.
  const customer = canSeeCustomerContact(user.permissions)
    ? await prisma.customer.findUnique({ where: { id }, include: related })
    : await prisma.customer.findUnique({ where: { id }, select: { ...CUSTOMER_NAME_SELECT, ...related } });
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(customer);
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { error } = await requireEdit("customers");
  if (error) return error;

  const { id } = await params;
  try {
    const body = await request.json() as {
      name?: string; nameAr?: string; phone?: string; email?: string; address?: string;
      whatsappOptOut?: boolean;
    };
    if (body.name !== undefined && !body.name?.trim()) {
      return NextResponse.json({ error: "name cannot be empty" }, { status: 400 });
    }
    if (body.whatsappOptOut !== undefined && typeof body.whatsappOptOut !== "boolean") {
      return NextResponse.json({ error: "whatsappOptOut must be true or false" }, { status: 400 });
    }
    // The account particulars (customer account page; migration 20261019120000). Same gate as
    // the rest of this record: customers at edit. Absent keys are unchanged; "" clears one.
    const account = parseAccountFields(body as Record<string, unknown>);
    if (!account.ok) return NextResponse.json({ error: account.errorAr, errorEn: account.error }, { status: 400 });
    if (account.data.accountOwnerId) {
      const owner = await prisma.employee.findFirst({ where: { id: account.data.accountOwnerId, active: true }, select: { id: true } });
      if (!owner) return NextResponse.json({ error: "المسؤول غير موجود أو غير نشط.", errorEn: "The account owner is not an active employee." }, { status: 400 });
    }

    const customer = await prisma.customer.update({
      where: { id },
      data: {
        ...(body.name !== undefined && { name: body.name.trim() }),
        ...(body.nameAr !== undefined && { nameAr: body.nameAr.trim() || null }),
        ...(body.phone !== undefined && { phone: body.phone.trim() || null }),
        ...(body.email !== undefined && { email: body.email.trim() || null }),
        ...(body.address !== undefined && { address: body.address.trim() || null }),
        ...(body.whatsappOptOut !== undefined && { whatsappOptOut: body.whatsappOptOut }),
        ...account.data,
      },
    });
    return NextResponse.json(customer);
  } catch (err) {
    return handlePrismaError(err);
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { error } = await requireEdit("customers");
  if (error) return error;

  const { id } = await params;
  try {
    await prisma.customer.delete({ where: { id } });
    return NextResponse.json({ deleted: true });
  } catch (err) {
    // P2003 = foreign key constraint: customer has orders
    const code = err && typeof err === "object" && "code" in err ? (err as { code: string }).code : null;
    if (code === "P2003" || code === "P2014") {
      return NextResponse.json(
        { error: "Cannot delete a customer with existing orders. Archive or reassign orders first." },
        { status: 409 }
      );
    }
    return handlePrismaError(err);
  }
}
