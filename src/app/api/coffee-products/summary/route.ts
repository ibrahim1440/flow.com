import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAnyModule } from "@/lib/auth-server";

export async function GET() {
  // Also readable by production and packaging: both have to name the product a batch is
  // being roasted or packaged as, and neither implies access to the orders module. This is
  // a name-and-id catalogue projection with no order or customer data in it.
  const { error } = await requireAnyModule("orders", "production", "packaging");
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
