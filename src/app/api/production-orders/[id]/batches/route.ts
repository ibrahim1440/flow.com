import { NextResponse } from "next/server";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { appendOrderActivity } from "@/lib/services/order-operations";
import {
  recalcProductionOrderStatus,
  TERMINAL_PRODUCTION_STATUSES,
  type ProductionOrderStatusValue,
} from "@/lib/services/production-planning";

type Params = { params: Promise<{ id: string }> };

/**
 * Associating roasting batches with a production order.
 *
 * One production order, many roasting batches: a 30 kg requirement is routinely three
 * roaster loads, so the link is deliberately many-to-one. It is also a single column on
 * RoastingBatch, which is what makes double counting structurally impossible — a batch
 * cannot be attached to two production orders at once, so its output can only ever be
 * credited to one of them.
 *
 * Linking moves no stock and writes no inventory movement. The batch already consumed its
 * green coffee and already produced its roasted weight when it was created; associating it
 * with a plan afterwards changes what we know about the work, not what happened. Writing a
 * movement here would manufacture inventory out of a bookkeeping action.
 */

type LoadedContext = {
  order: {
    id: string; productionNumber: string; status: string; targetUnits: number;
    productSku: { id: string; skuCode: string; productId: string };
    sourceOrderItem: { orderId: string } | null;
  };
  batch: {
    id: string; batchNumber: string; status: string; isBlend: boolean;
    productionOrderId: string | null; productId: string | null;
    roastedBeanQuantity: number;
    orderItem: { productSku: { productId: string } | null } | null;
  };
};

async function load(tx: Parameters<typeof recalcProductionOrderStatus>[1], orderId: string, batchId: unknown): Promise<LoadedContext> {
  if (typeof batchId !== "string" || !batchId) {
    throw { _appCode: 400, message: "roastingBatchId is required." };
  }

  const order = await tx.productionOrder.findUnique({
    where: { id: orderId },
    select: {
      id: true, productionNumber: true, status: true, targetUnits: true,
      productSku: { select: { id: true, skuCode: true, productId: true } },
      sourceOrderItem: { select: { orderId: true } },
    },
  });
  if (!order) throw { _appCode: 404, message: "Production order not found." };

  if (TERMINAL_PRODUCTION_STATUSES.has(order.status as ProductionOrderStatusValue)) {
    throw {
      _appCode: 409,
      message: `Production order ${order.productionNumber} is ${order.status}. A closed order's batches cannot be changed.`,
    };
  }

  const batch = await tx.roastingBatch.findUnique({
    where: { id: batchId },
    select: {
      id: true, batchNumber: true, status: true, isBlend: true,
      productionOrderId: true, productId: true, roastedBeanQuantity: true,
      orderItem: { select: { productSku: { select: { productId: true } } } },
    },
  });
  if (!batch) throw { _appCode: 404, message: "Roasting batch not found." };

  return { order, batch };
}

/** POST — link a batch to this production order. */
export async function POST(request: Request, { params }: Params) {
  const { error, user } = await requireSub("production", "start_batch");
  if (error) return error;

  const { id } = await params;
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }
  const { roastingBatchId } = (body ?? {}) as { roastingBatchId?: unknown };

  try {
    const result = await prisma.$transaction(async (tx) => {
      const { order, batch } = await load(tx, id, roastingBatchId);

      if (batch.productionOrderId === order.id) {
        throw { _appCode: 409, message: `Batch ${batch.batchNumber} is already linked to this production order.` };
      }
      if (batch.productionOrderId !== null) {
        throw {
          _appCode: 409,
          message: `Batch ${batch.batchNumber} already belongs to another production order. Unlink it there first.`,
        };
      }
      if (batch.status === "Rejected") {
        throw { _appCode: 409, message: `Batch ${batch.batchNumber} failed QC and cannot count towards production.` };
      }
      // A blend's output is already represented by the batches that went into it, which is
      // why the progress aggregate excludes blends. Linking one would attach a batch that
      // contributes nothing and reads as a bug from the operator's side.
      if (batch.isBlend) {
        throw {
          _appCode: 409,
          message: `Batch ${batch.batchNumber} is a blend. Link the source batches it was made from instead.`,
        };
      }

      // The coffee has to match, or a Brazilian roast would be credited to an Ethiopian
      // requirement and the order would look satisfied by the wrong bean.
      const batchProductId = batch.productId ?? batch.orderItem?.productSku?.productId ?? null;
      if (batchProductId === null) {
        throw {
          _appCode: 409,
          message: `Batch ${batch.batchNumber} does not identify which coffee it is, so it cannot be matched to this order.`,
        };
      }
      if (batchProductId !== order.productSku.productId) {
        throw {
          _appCode: 409,
          message: `Batch ${batch.batchNumber} is a different coffee from ${order.productSku.skuCode}.`,
        };
      }

      // Conditional write: only claims a batch that is still unlinked, so two operators
      // linking the same batch to different orders cannot both succeed.
      const claimed = await tx.roastingBatch.updateMany({
        where: { id: batch.id, productionOrderId: null },
        data: { productionOrderId: order.id },
      });
      if (claimed.count === 0) {
        throw { _appCode: 409, message: `Batch ${batch.batchNumber} was linked elsewhere while this request was in flight.` };
      }

      // Actual production has changed, so the derived status follows it: an order with
      // real roasting behind it is IN_PRODUCTION, and one that has met its target closes.
      await recalcProductionOrderStatus(order.id, tx);

      if (order.sourceOrderItem) {
        await appendOrderActivity(tx, {
          orderId: order.sourceOrderItem.orderId,
          type: "PRODUCTION_BATCH_LINKED",
          message: `Batch ${batch.batchNumber} (${batch.roastedBeanQuantity} kg roasted) linked to production order ${order.productionNumber} by ${user.name}.`,
          authorId: user.id,
          authorName: user.name,
          metadata: { productionOrderId: order.id, roastingBatchId: batch.id, batchNumber: batch.batchNumber },
        });
      }

      return tx.productionOrder.findUnique({
        where: { id: order.id },
        select: { id: true, productionNumber: true, status: true, _count: { select: { roastingBatches: true } } },
      });
    }, TX_OPTS);

    return NextResponse.json(result, { status: 201 });
  } catch (err: unknown) {
    if (err && typeof err === "object" && "_appCode" in err) {
      const e = err as { _appCode: number; message: string };
      return NextResponse.json({ error: e.message }, { status: e._appCode });
    }
    return handlePrismaError(err);
  }
}

/** DELETE — unlink a batch from this production order. */
export async function DELETE(request: Request, { params }: Params) {
  const { error, user } = await requireSub("production", "start_batch");
  if (error) return error;

  const { id } = await params;
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }
  const { roastingBatchId } = (body ?? {}) as { roastingBatchId?: unknown };

  try {
    const result = await prisma.$transaction(async (tx) => {
      const { order, batch } = await load(tx, id, roastingBatchId);

      if (batch.productionOrderId !== order.id) {
        throw { _appCode: 409, message: `Batch ${batch.batchNumber} is not linked to this production order.` };
      }

      // Once a batch has been packed, its output is finished goods that this order is
      // credited with having produced. Detaching it would rewrite that history and make
      // the order's progress disagree with the lots physically on the shelf, so the answer
      // is no — cancel or close the order instead.
      const packed = await tx.finishedGoodsLot.aggregate({
        where: { packedFromBatchId: batch.id },
        _sum: { unitsProduced: true },
      });
      if ((packed._sum.unitsProduced ?? 0) > 0) {
        throw {
          _appCode: 409,
          message: `Batch ${batch.batchNumber} has already been packed into finished goods and cannot be unlinked.`,
        };
      }

      await tx.roastingBatch.updateMany({
        where: { id: batch.id, productionOrderId: order.id },
        data: { productionOrderId: null },
      });

      await recalcProductionOrderStatus(order.id, tx);

      if (order.sourceOrderItem) {
        await appendOrderActivity(tx, {
          orderId: order.sourceOrderItem.orderId,
          type: "PRODUCTION_BATCH_UNLINKED",
          message: `Batch ${batch.batchNumber} unlinked from production order ${order.productionNumber} by ${user.name}.`,
          authorId: user.id,
          authorName: user.name,
          metadata: { productionOrderId: order.id, roastingBatchId: batch.id, batchNumber: batch.batchNumber },
        });
      }

      return tx.productionOrder.findUnique({
        where: { id: order.id },
        select: { id: true, productionNumber: true, status: true, _count: { select: { roastingBatches: true } } },
      });
    }, TX_OPTS);

    return NextResponse.json(result);
  } catch (err: unknown) {
    if (err && typeof err === "object" && "_appCode" in err) {
      const e = err as { _appCode: number; message: string };
      return NextResponse.json({ error: e.message }, { status: e._appCode });
    }
    return handlePrismaError(err);
  }
}
