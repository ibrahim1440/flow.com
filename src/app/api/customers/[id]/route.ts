import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAnyModule, requireEdit } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { error } = await requireAnyModule("customers", "orders");
  if (error) return error;

  const { id } = await params;
  const customer = await prisma.customer.findUnique({
    where: { id },
    include: {
      _count: { select: { orders: true } },
      roastPreferences: {
        include: { greenBean: { select: { id: true, beanType: true, serialNumber: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
  });
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
    };
    if (body.name !== undefined && !body.name?.trim()) {
      return NextResponse.json({ error: "name cannot be empty" }, { status: 400 });
    }

    const customer = await prisma.customer.update({
      where: { id },
      data: {
        ...(body.name !== undefined && { name: body.name.trim() }),
        ...(body.nameAr !== undefined && { nameAr: body.nameAr.trim() || null }),
        ...(body.phone !== undefined && { phone: body.phone.trim() || null }),
        ...(body.email !== undefined && { email: body.email.trim() || null }),
        ...(body.address !== undefined && { address: body.address.trim() || null }),
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
