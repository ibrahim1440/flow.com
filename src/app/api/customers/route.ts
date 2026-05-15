import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAnyModule, requireEdit } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";

export async function GET() {
  const { error } = await requireAnyModule("customers", "orders");
  if (error) return error;

  const customers = await prisma.customer.findMany({
    orderBy: { name: "asc" },
    include: {
      _count: { select: { orders: true, roastPreferences: true } },
      roastPreferences: {
        include: { greenBean: { select: { id: true, beanType: true, serialNumber: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  return NextResponse.json(customers);
}

export async function POST(request: Request) {
  const { error } = await requireEdit("customers");
  if (error) return error;

  try {
    const body = await request.json() as {
      name: string; nameAr?: string; phone?: string; email?: string; address?: string;
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
      },
    });
    return NextResponse.json(customer, { status: 201 });
  } catch (err) {
    return handlePrismaError(err);
  }
}
