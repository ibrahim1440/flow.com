import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAnyModule } from "@/lib/auth-server";

export async function GET() {
  // Packaging reads the lots it just made (gap G19: a packaging-only role must work).
  const { error } = await requireAnyModule("dispatch", "inventory", "packaging");
  if (error) return error;

  const lots = await prisma.finishedGoodsLot.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
    include: {
      product: { select: { productNameEn: true, productNameAr: true } },
      roastingBatch: { select: { orderItemId: true } },
    },
  });

  return NextResponse.json(lots);
}
