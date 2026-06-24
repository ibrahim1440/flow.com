import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAnyModule } from "@/lib/auth-server";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { error } = await requireAnyModule("orders", "dispatch", "inventory");
  if (error) return error;

  const { id } = await params;

  const orderItem = await prisma.orderItem.findUnique({
    where: { id },
    select: {
      id: true,
      productId: true,
      productSkuId: true,
      quantityKg: true,
      deliveredQty: true,
      remainingQty: true,
    },
  });

  if (!orderItem) {
    return NextResponse.json({ error: "Order item not found." }, { status: 404 });
  }

  const matchFilter = orderItem.productId
    ? { productId: orderItem.productId }
    : { roastingBatch: { orderItemId: orderItem.id } };

  const skuFilter = orderItem.productSkuId
    ? { OR: [{ productSkuId: null }, { productSkuId: orderItem.productSkuId }] }
    : {};

  const lots = await prisma.finishedGoodsLot.findMany({
    where: {
      availableQty: { gt: 0 },
      status: "AVAILABLE",
      ...matchFilter,
      ...skuFilter,
    },
    select: {
      id: true,
      batchNumber: true,
      availableQty: true,
      productId: true,
      productSkuId: true,
    },
  });

  const totalAvailableQty = +lots.reduce((sum, lot) => sum + lot.availableQty, 0).toFixed(3);
  const shortageQty = +Math.max(0, orderItem.remainingQty - totalAvailableQty).toFixed(3);

  return NextResponse.json({
    orderItemId: orderItem.id,
    productId: orderItem.productId,
    productSkuId: orderItem.productSkuId,
    requiredQtyKg: orderItem.quantityKg,
    deliveredQty: orderItem.deliveredQty,
    remainingQty: orderItem.remainingQty,
    matchingLots: lots,
    totalAvailableQty,
    shortageQty,
  });
}
