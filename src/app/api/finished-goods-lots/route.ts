import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";

export async function GET() {
  const { error } = await requireModule("inventory");
  if (error) return error;

  const lots = await prisma.finishedGoodsLot.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      product: { select: { productNameEn: true, productNameAr: true } },
    },
  });

  return NextResponse.json(lots);
}
