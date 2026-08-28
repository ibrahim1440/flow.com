import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { checkOrderAvailability, releaseShelfStock } from "@/lib/services/shelf-allocation";

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { error } = await requireSub("orders", "edit");
  if (error) return error;

  const { id } = await params;
  const body = await request.json();
  const { items } = body;

  const orderData: Record<string, unknown> = {};
  if (body.customerId !== undefined)        orderData.customerId        = body.customerId;
  if (body.quotationNumber !== undefined)   orderData.quotationNumber   = body.quotationNumber ?? null;
  if (body.quotationSentDate !== undefined) orderData.quotationSentDate = body.quotationSentDate ? new Date(body.quotationSentDate) : null;
  if (body.notes !== undefined)             orderData.notes             = body.notes ?? null;
  // approvalStatus, approvalDate, paymentStatus, vatInvoiceStatus INTENTIONALLY EXCLUDED
  // must be handled through dedicated transition routes with authorization and audit

  if (items) {
    type RawItem = {
      id?:          string;
      beanTypeName: string;
      quantityKg:   unknown;
      greenBeanId?: string;
      productId?:   string;
      productSkuId?: string;
    };

    type ResolvedItem = {
      id?:          string;
      beanTypeName: string;
      quantityKg:   number;
      greenBeanId:  string | null;
      productId:    string | null;
      productSkuId: string | null;
    };

    const resolvedItems: ResolvedItem[] = [];
    for (const item of items as RawItem[]) {
      const qty = Number(item.quantityKg);
      if (!Number.isFinite(qty) || qty <= 0) {
        return NextResponse.json({ error: "quantityKg must be a positive number." }, { status: 400 });
      }

      let resolvedProductId:    string | null = null;
      let resolvedProductSkuId: string | null = null;

      if (typeof item.productSkuId === "string" && item.productSkuId) {
        const sku = await prisma.productSKU.findUnique({ where: { id: item.productSkuId } });
        if (!sku)
          return NextResponse.json({ error: "Product SKU not found." }, { status: 400 });
        if (typeof item.productId === "string" && item.productId && sku.productId !== item.productId)
          return NextResponse.json({ error: "SKU does not belong to the specified product." }, { status: 400 });
        resolvedProductId    = sku.productId;
        resolvedProductSkuId = sku.id;
      } else if (typeof item.productId === "string" && item.productId) {
        const product = await prisma.coffeeProduct.findUnique({ where: { id: item.productId } });
        if (!product)
          return NextResponse.json({ error: "Product not found." }, { status: 400 });
        resolvedProductId = product.id;
      }

      resolvedItems.push({
        id:           typeof item.id === "string" ? item.id : undefined,
        beanTypeName: item.beanTypeName,
        quantityKg:   qty,
        greenBeanId:  item.greenBeanId || null,
        productId:    resolvedProductId,
        productSkuId: resolvedProductSkuId,
      });
    }

    // Shelf first, green beans for the remainder — see checkOrderAvailability.
    {
      const insufficient = await checkOrderAvailability(prisma, resolvedItems);
      if (insufficient.length > 0) {
        return NextResponse.json({ error: "Insufficient stock", details: insufficient }, { status: 400 });
      }
    }

    const existing = await prisma.orderItem.findMany({ where: { orderId: id } });
    const existingMap = new Map(existing.map((e) => [e.id, e]));
    const existingIds = existing.map((e) => e.id);
    const incomingIds = resolvedItems.filter((i) => i.id).map((i) => i.id as string);
    const toDelete = existingIds.filter((eid) => !incomingIds.includes(eid));

    if (toDelete.length > 0) {
      const operationalItems = await prisma.orderItem.findMany({
        where: { id: { in: toDelete } },
        select: {
          id: true,
          deliveredQty: true,
          _count: { select: { roastingBatches: true, deliveries: true } },
        },
      });
      const blocked = operationalItems.filter(
        (i) => i.deliveredQty > 0 || i._count.roastingBatches > 0 || i._count.deliveries > 0
      );
      if (blocked.length > 0) {
        return NextResponse.json(
          { error: "Cannot remove order items that have active production batches or delivery records. Deactivate the order instead." },
          { status: 400 }
        );
      }
      // Hand back the shelf before the rows vanish. StockAllocation cascades from OrderItem,
    // but FinishedGoodsLot.reservedQty is a denormalised counter that only this service
    // maintains — letting the cascade run first would leave those kilograms permanently
    // marked as promised to an order item that no longer exists.
    await prisma.$transaction(async (tx) => {
      for (const itemId of toDelete) await releaseShelfStock(tx, itemId);
      await tx.orderItem.deleteMany({ where: { id: { in: toDelete } } });
    });
    }

    for (const item of resolvedItems) {
      if (item.id) {
        const existingItem = existingMap.get(item.id);
        if (!existingItem) {
          return NextResponse.json({ error: "Order item not found." }, { status: 404 });
        }
        if (item.quantityKg < existingItem.deliveredQty) {
          return NextResponse.json(
            { error: "quantityKg cannot be less than already delivered quantity." },
            { status: 400 }
          );
        }
        await prisma.orderItem.update({
          where: { id: item.id },
          data: {
            beanTypeName: item.beanTypeName,
            quantityKg:   item.quantityKg,
            greenBeanId:  item.greenBeanId,
            productId:    item.productId,
            productSkuId: item.productSkuId,
            // remainingQty intentionally omitted — recalcOrderItemStatus owns this field
            // after any production event; writing quantityKg here corrupts post-production values.
          },
        });
      } else {
        await prisma.orderItem.create({
          data: {
            orderId:      id,
            beanTypeName: item.beanTypeName,
            quantityKg:   item.quantityKg,
            greenBeanId:  item.greenBeanId,
            productId:    item.productId,
            productSkuId: item.productSkuId,
            remainingQty: item.quantityKg,
          },
        });
      }
    }
  }

  try {
    const order = await prisma.order.update({
      where: { id },
      data: orderData,
      include: { customer: true, items: true },
    });
    return NextResponse.json(order);
  } catch (err) {
    return handlePrismaError(err);
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { error } = await requireSub("orders", "delete");
  if (error) return error;

  const { id } = await params;

  const order = await prisma.order.findUnique({
    where: { id },
    select: {
      id: true,
      items: {
        select: {
          deliveredQty: true,
          _count: {
            select: {
              roastingBatches: true,
              deliveries: true,
              productionOrders: true,
            },
          },
        },
      },
    },
  });

  if (!order) {
    return NextResponse.json({ error: "Order not found." }, { status: 404 });
  }

  const isOperational = order.items.some(
    (item) =>
      item.deliveredQty > 0 ||
      item._count.roastingBatches > 0 ||
      item._count.deliveries > 0 ||
      item._count.productionOrders > 0
  );

  if (isOperational) {
    return NextResponse.json(
      { error: "Cannot delete this order because it has production, QC, delivery, or inventory history. Cancel or close the order instead." },
      { status: 400 }
    );
  }

  try {
    // Same reason as the item-delete path above: release before the cascade.
    await prisma.$transaction(async (tx) => {
      const items = await tx.orderItem.findMany({ where: { orderId: id }, select: { id: true } });
      for (const item of items) await releaseShelfStock(tx, item.id);
      await tx.order.delete({ where: { id } });
    });
    return NextResponse.json({ success: true });
  } catch (err) {
    return handlePrismaError(err);
  }
}
