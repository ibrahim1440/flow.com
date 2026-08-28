import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAnyModule } from "@/lib/auth-server";
import {
  ALLOCATABLE_ITEM_SELECT,
  candidateLots,
  outstandingForItem,
  reservedForItem,
  roundKg,
} from "@/lib/services/shelf-allocation";

type Params = { params: Promise<{ id: string }> };

/**
 * What can cover this order item right now, and what has to be roasted.
 *
 * This is the read model behind the shelf-first rule: the preparation review screen and
 * the preparation workstation both call it before anyone commits to a decision.
 */
export async function GET(_request: Request, { params }: Params) {
  const { error } = await requireAnyModule("orders", "dispatch", "inventory", "production");
  if (error) return error;

  const { id } = await params;

  const orderItem = await prisma.orderItem.findUnique({
    where: { id },
    select: { ...ALLOCATABLE_ITEM_SELECT, remainingQty: true },
  });

  if (!orderItem) {
    return NextResponse.json({ error: "Order item not found." }, { status: 404 });
  }

  const lots = await candidateLots(prisma, orderItem);
  const reservedQty = await reservedForItem(prisma, orderItem.id);
  const outstandingQty = await outstandingForItem(prisma, orderItem);
  const freeToPromiseQty = roundKg(lots.reduce((sum, l) => sum + l.freeQty, 0));

  // Lots this item already holds a promise on. They may have zero free quantity — a batch
  // roasted for this very order is reserved to it in full the moment it is packaged — so
  // they will not appear in candidateLots. The dispatch screen still has to offer them,
  // otherwise the ordinary roast -> package -> deliver path has nothing to pick.
  const heldRows = await prisma.stockAllocation.groupBy({
    by: ["finishedGoodsLotId"],
    where: { orderItemId: orderItem.id, status: "RESERVED" },
    _sum: { quantityKg: true },
  });
  const heldByLot = new Map(heldRows.map((r) => [r.finishedGoodsLotId, roundKg(r._sum.quantityKg ?? 0)]));

  const extraLots = heldByLot.size
    ? await prisma.finishedGoodsLot.findMany({
        where: {
          id: { in: [...heldByLot.keys()].filter((id) => !lots.some((l) => l.id === id)) },
        },
        select: {
        id: true, batchNumber: true, availableQty: true, reservedQty: true,
        productId: true, productSkuId: true,
        product: { select: { productNameEn: true, productNameAr: true } },
      },
      })
    : [];

  // Everything this item could actually ship from, with the quantity it may take:
  // its own reservation on that lot plus whatever is free to anyone.
  const deliverableLots = [
    ...lots.map((l) => ({ ...l, reservedForThisItem: heldByLot.get(l.id) ?? 0 })),
    ...extraLots.map((l) => ({
      ...l,
      freeQty: roundKg(l.availableQty - l.reservedQty),
      reservedForThisItem: heldByLot.get(l.id) ?? 0,
    })),
  ].map((l) => ({ ...l, deliverableQty: roundKg(l.freeQty + l.reservedForThisItem) }));

  // What the shelf can still take off this item, and what is left for the roaster.
  const coverableFromShelfQty = roundKg(Math.min(outstandingQty, freeToPromiseQty));
  const shortageQty = roundKg(Math.max(0, outstandingQty - freeToPromiseQty));

  return NextResponse.json({
    orderItemId: orderItem.id,
    productId: orderItem.productId,
    productSkuId: orderItem.productSkuId,
    requiredQtyKg: orderItem.quantityKg,
    deliveredQty: orderItem.deliveredQty,

    // Produced but not yet delivered. Written by recalcOrderItemStatus; kept in the
    // response because the dispatch screen reads it. NOT the same thing as outstanding
    // demand — see outstandingQty below.
    remainingQty: orderItem.remainingQty,

    // Already promised to this item and waiting on the shelf.
    reservedQty,
    // Neither shipped nor promised: the part of the order still to be sourced.
    outstandingQty,
    // On the shelf, matching this item, promised to nobody.
    freeToPromiseQty,
    // How much of the outstanding demand the shelf can absorb today.
    coverableFromShelfQty,
    // What is left for the roaster after the shelf has been drawn down.
    shortageQty,

    matchingLots: deliverableLots.map((l) => ({
      id: l.id,
      batchNumber: l.batchNumber,
      availableQty: l.availableQty,
      reservedQty: l.reservedQty,
      freeQty: l.freeQty,
      // Promised to THIS item — shippable by it, invisible to everyone else.
      reservedForThisItem: l.reservedForThisItem,
      // What this item may actually take off this lot right now.
      deliverableQty: l.deliverableQty,
      productId: l.productId,
      productSkuId: l.productSkuId,
      product: "product" in l ? l.product : null,
    })),

    // Retained for callers written against the previous shape.
    totalAvailableQty: freeToPromiseQty,
  });
}
