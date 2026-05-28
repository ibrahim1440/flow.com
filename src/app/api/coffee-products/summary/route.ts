import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";

export async function GET() {
  const { error } = await requireModule("orders");
  if (error) return error;

  const products = await prisma.coffeeProduct.findMany({
    select: {
      id:            true,
      productNameEn: true,
      productNameAr: true,
      productSkus: {
        select: { id: true, skuCode: true, weightGrams: true, isBulk: true, price: true },
      },
    },
    orderBy: { productNameEn: "asc" },
  });

  return NextResponse.json(products);
}
