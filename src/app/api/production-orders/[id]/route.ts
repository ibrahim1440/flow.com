import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAnyModule } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import {
  productionProgress,
  PRODUCTION_ORDER_ACTIONS,
  isProductionTransitionAllowed,
  type ProductionOrderStatusValue,
} from "@/lib/services/production-planning";

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/production-orders/[id]
 *
 * The detail view: the plan, what has actually been produced against it, the roasting
 * batches behind that, and which state actions are legal right now. Sending the allowed
 * actions with the record keeps the UI from having to reimplement the state machine —
 * the server stays the single authority on what may happen next.
 */
export async function GET(_request: Request, { params }: Params) {
  const { error } = await requireAnyModule("production", "orders", "qc", "packaging");
  if (error) return error;

  const { id } = await params;

  try {
    const order = await prisma.productionOrder.findUnique({
      where: { id },
      select: {
        id: true,
        productionNumber: true,
        status: true,
        targetUnits: true,
        targetWeightKg: true,
        expectedGreenBeanKg: true,
        surplusHandled: true,
        createdAt: true,
        updatedAt: true,
        productSku: {
          select: {
            id: true, skuCode: true, name: true, weightGrams: true,
            product: { select: { id: true, productNameEn: true, countryEn: true, expectedRoastLoss: true } },
          },
        },
        greenBean: { select: { id: true, serialNumber: true, beanType: true, quantityKg: true } },
        sourceOrderItem: {
          select: {
            id: true, quantityUnits: true, deliveredUnits: true, preparationDecision: true,
            order: {
              select: {
                id: true, orderNumber: true, status: true,
                customer: { select: { id: true, name: true } },
              },
            },
          },
        },
        roastingBatches: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true, batchNumber: true, status: true, isBlend: true,
            greenBeanQuantity: true, roastedBeanQuantity: true, wasteQuantity: true,
            roastedAvailableKg: true, date: true, createdAt: true,
            greenBean: { select: { id: true, serialNumber: true, beanType: true } },
          },
        },
      },
    });

    if (!order) return NextResponse.json({ error: "Production order not found." }, { status: 404 });

    const progress = await productionProgress(prisma, order);

    // Per-batch packed units, so the detail page can show what each batch actually
    // yielded rather than only the roast weight. Scoped to this order's SKU for the same
    // reason the aggregate is: a batch packed into two SKUs owes this order only one.
    const packed = await prisma.finishedGoodsLot.groupBy({
      by: ["packedFromBatchId"],
      where: {
        packedFromBatchId: { in: order.roastingBatches.map((b) => b.id) },
        productSkuId: order.productSku.id,
        isUnitTracked: true,
      },
      _sum: { unitsProduced: true },
    });
    const packedByBatch = new Map(
      packed.map((p) => [p.packedFromBatchId as string, p._sum.unitsProduced ?? 0])
    );

    const status = order.status as ProductionOrderStatusValue;

    return NextResponse.json({
      ...order,
      progress,
      roastingBatches: order.roastingBatches.map((b) => ({
        ...b,
        packedUnits: packedByBatch.get(b.id) ?? 0,
      })),
      allowedActions: PRODUCTION_ORDER_ACTIONS.filter((a) => isProductionTransitionAllowed(status, a)),
    });
  } catch (err) {
    return handlePrismaError(err);
  }
}
