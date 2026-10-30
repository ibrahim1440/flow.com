import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireAnyModule, requireEdit } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { canSeeCustomerContact, CUSTOMER_NAME_SELECT } from "@/lib/auth/customer-detail";
import { customerVisibilityWhere } from "@/lib/services/sales/scope";

export async function GET() {
  const { user, error } = await requireAnyModule("customers", "orders");
  if (error) return error;

  const related = {
    _count: { select: { orders: true, roastPreferences: true } },
    roastPreferences: {
      include: { greenBean: { select: { id: true, beanType: true, serialNumber: true } } },
      orderBy: { createdAt: "asc" as const },
    },
  };
  // A scoped sales rep lists their own book only (services/sales/scope.ts); everyone else as before.
  const where = customerVisibilityWhere(user);
  // F4 / review F-1: orders:view alone (production, dispatch) lists customers by name for the
  // order screens; the contact record (phone, email, address, opt-out) is the customers module's.
  const customers = canSeeCustomerContact(user.permissions)
    ? await prisma.customer.findMany({ where, orderBy: { name: "asc" }, take: 200, include: related })
    : await prisma.customer.findMany({ where, orderBy: { name: "asc" }, take: 200, select: { ...CUSTOMER_NAME_SELECT, ...related } });
  return NextResponse.json(customers);
}

export async function POST(request: Request) {
  const { error } = await requireEdit("customers");
  if (error) return error;

  try {
    const body = await request.json() as {
      name: string; nameAr?: string; phone?: string; email?: string; address?: string;
      whatsappOptOut?: boolean;
    };
    if (!body.name?.trim()) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }

    const customer = await prisma.customer.create({
      data: {
        name: body.name.trim(),
        nameAr: body.nameAr?.trim() || null,
        phone: body.phone?.trim() || null,
        email: body.email?.trim() || null,
        address: body.address?.trim() || null,
        whatsappOptOut: body.whatsappOptOut === true,
      },
    });
    return NextResponse.json(customer, { status: 201 });
  } catch (err) {
    return handlePrismaError(err);
  }
}
