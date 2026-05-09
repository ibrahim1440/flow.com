import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireModule, requireEdit } from "@/lib/auth-server";

export async function GET() {
  const { error } = await requireModule("labels");
  if (error) return error;

  const products = await prisma.coffeeProduct.findMany({ orderBy: { productNameEn: "asc" } });
  return NextResponse.json(products);
}

export async function POST(request: Request) {
  const { error } = await requireEdit("labels");
  if (error) return error;

  const data = await request.json();
  const product = await prisma.coffeeProduct.create({ data });
  return NextResponse.json(product, { status: 201 });
}
