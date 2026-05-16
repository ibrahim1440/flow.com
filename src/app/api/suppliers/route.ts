import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireModule, requireSub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";

export async function GET() {
  const { error } = await requireModule("inventory");
  if (error) return error;

  const suppliers = await prisma.supplier.findMany({
    orderBy: { name: "asc" },
    include: { _count: { select: { purchases: true } } },
  });
  return NextResponse.json(suppliers);
}

export async function POST(request: Request) {
  const { error } = await requireSub("inventory", "adjust");
  if (error) return error;

  const { name, contact } = await request.json();

  if (!name?.trim()) {
    return NextResponse.json({ error: "Supplier name is required." }, { status: 400 });
  }

  try {
    const supplier = await prisma.supplier.create({
      data: { name: name.trim(), contact: contact?.trim() || null },
    });
    return NextResponse.json(supplier, { status: 201 });
  } catch (err) {
    return handlePrismaError(err);
  }
}
