import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireModule, requireSub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";

export async function GET() {
  const { error } = await requireModule("orders");
  if (error) return error;

  const customers = await prisma.customer.findMany({
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { orders: true } } },
  });
  return NextResponse.json(customers);
}

export async function POST(request: Request) {
  const { error } = await requireSub("orders", "create");
  if (error) return error;

  try {
    const data = await request.json();
    const customer = await prisma.customer.create({ data });
    return NextResponse.json(customer, { status: 201 });
  } catch (err) {
    return handlePrismaError(err);
  }
}
