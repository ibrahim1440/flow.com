import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAnyModule, requireSub } from "@/lib/auth-server";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { handlePrismaError } from "@/lib/api-error";
import { recalcOrderItemStatus } from "@/lib/services/order-fulfillment";
import { reservedForItem } from "@/lib/services/shelf-allocation";
import { recalcProductionOrderStatus } from "@/lib/services/production-planning";

class AppError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function generateBatchNumber(greenBeanId: string | null | undefined): Promise<string> {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, "");

  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(now);
  dayEnd.setUTCHours(23, 59, 59, 999);

  const existing = await prisma.roastingBatch.findMany({
    where: {
      greenBeanId: greenBeanId ?? null,
      createdAt: { gte: dayStart, lte: dayEnd },
    },
    select: { id: true },
  });

  return `${dateStr}${String(existing.length + 1).padStart(2, "0")}`;
}

export async function GET(request: Request) {
  // QC and Packaging workers need to read batches for their own workflow stages
  const { error } = await requireAnyModule("production", "qc", "packaging");
  if (error) return error;

  const { searchParams } = new URL(request.url);
  const statusParam = searchParams.get("statuses");
  const where = statusParam ? { status: { in: statusParam.split(",") } } : undefined;

  const batches = await prisma.roastingBatch.findMany({
    where,
    orderBy: { date: "desc" },
    take: 500,
    include: {
      orderItem: { include: { order: { include: { customer: { include: { roastPreferences: true } } } } } },
      greenBean: true,
      qcRecords: {
        include: {
          employee: { select: { id: true, name: true } },
          _count: { select: { correctionHistory: true } },
        },
        orderBy: { createdAt: "asc" as const },
      },
      childBatches: { select: { id: true, batchNumber: true } },
      parentBatch: { select: { id: true, batchNumber: true } },
      blendInputs: { select: { id: true, sourceBatchId: true, quantityUsed: true, sourceBatch: { select: { batchNumber: true } } } },
      blendOutputs: { select: { id: true, targetBlendBatchId: true, quantityUsed: true, targetBlendBatch: { select: { batchNumber: true } } } },
    },
  });
  return NextResponse.json(batches);
}

export async function POST(request: Request) {
  const { error, user } = await requireSub("production", "start_batch");
  if (error) return error;

  const data = await request.json();
  const { orderItemId, greenBeanId, productId, greenBeanQuantity, roastedBeanQuantity, wasteQuantity, roastProfile, productionOrderId } = data;

  // A direct roast must always name the green bean it consumes. Without it the whole
  // stock-deduction + ledger block below is skipped, so roasted kilograms appear on the
  // shelf while raw stock never moves and InventoryMovement has no matching OUT row.
  // Blends are the deliberate exception and are created by /api/roasting-batches/blend,
  // which composes already-roasted source batches and touches no green stock.
  if (typeof greenBeanId !== "string" || !greenBeanId) {
    return NextResponse.json(
      { error: "greenBeanId is required — a roasting batch must consume a specific green bean lot." },
      { status: 400 }
    );
  }

  const qty = Number(greenBeanQuantity);
  if (!Number.isFinite(qty) || qty <= 0) {
    return NextResponse.json({ error: "greenBeanQuantity must be a positive number." }, { status: 400 });
  }

  const roastedQty = Number(roastedBeanQuantity ?? 0);
  const wasteQty   = Number(wasteQuantity ?? 0);
  if (!Number.isFinite(roastedQty) || roastedQty <= 0) {
    return NextResponse.json({ error: "Roasted quantity must be greater than 0." }, { status: 400 });
  }
  if (!Number.isFinite(wasteQty) || wasteQty < 0) {
    return NextResponse.json({ error: "wasteQuantity must be a non-negative number." }, { status: 400 });
  }
  if (roastedQty + wasteQty > qty) {
    return NextResponse.json({ error: "roastedBeanQuantity + wasteQuantity cannot exceed greenBeanQuantity." }, { status: 400 });
  }

  // ── Roast to stock ───────────────────────────────────────────────────────
  // Omitting orderItemId means "roast for the shelf": a deliberate replenishment with
  // no customer order behind it. It consumes green stock and writes the same ledger
  // entries as any other roast; the difference is downstream, where packaging finds no
  // owner to reserve the output to and the whole lot becomes free-to-promise.
  //
  // Such a batch must name the product it is being roasted as. An order-backed batch can
  // fall back to its order item's product at packaging time, but a stock batch has no
  // order item, and a lot nothing can identify is a lot no order can ever be matched to.
  const isStockBatch = typeof orderItemId !== "string" || !orderItemId;

  // Roasting to stock deliberately produces coffee no order asked for — which is exactly
  // what the surplus gate below exists to control. Since that gate cannot apply (there is
  // no order to exceed), the authority to do it is an explicit, separately revocable
  // privilege rather than a side effect of being allowed to roast at all.
  if (isStockBatch && !hasSubPrivilege(user.permissions, "production", "roast_to_stock")) {
    return NextResponse.json(
      { error: "You do not have permission to roast to stock." },
      { status: 403 }
    );
  }

  if (isStockBatch && (typeof productId !== "string" || !productId)) {
    return NextResponse.json(
      { error: "productId is required when roasting to stock — without it the resulting lot cannot be matched to any order." },
      { status: 400 }
    );
  }

  if (isStockBatch) {
    const product = await prisma.coffeeProduct.findUnique({ where: { id: productId as string } });
    if (!product) return NextResponse.json({ error: "Product not found." }, { status: 400 });
  }

  // ── Surplus gate ─────────────────────────────────────────────────────────
  // Backend enforcement: non-admin users cannot create batches that exceed the
  // order item's required quantity. UI warning alone is bypassable via direct API.
  // A stock batch has no order to exceed, so the gate does not apply to it — what it
  // may consume is bounded by real green stock, checked atomically further down.
  const surplusOrderItem = isStockBatch
    ? null
    : await prisma.orderItem.findUnique({
        where: { id: orderItemId },
        select: { quantityKg: true },
      });
  if (!isStockBatch && !surplusOrderItem) {
    return NextResponse.json({ error: "Order item not found." }, { status: 404 });
  }

  const existingAgg = isStockBatch
    ? { _sum: { greenBeanQuantity: 0 } }
    : await prisma.roastingBatch.aggregate({
        where: {
          orderItemId,
          isBlend: false,
          status: { not: "Rejected" },
        },
        _sum: { greenBeanQuantity: true },
      });

  // What this item is actually allowed to consume from the roaster: the ordered quantity
  // minus whatever the shelf is already holding for it. Only the shortfall should ever be
  // roasted — roasting the full ordered amount on top of reserved stock would produce the
  // exact surplus the shelf was meant to absorb.
  //
  // Derived from live reservations rather than the stored productionRequiredQuantity on
  // purpose. That column is written only by preparation review, so it goes stale the
  // moment coverage moves (another order is cancelled and frees stock, a partial batch is
  // packaged and claims some), and every value written before reservations existed came
  // from a number a clerk typed with nothing behind it — trusting those would refuse
  // legitimate roasts on historical rows, some of which carry a stored 0.
  const alreadyReserved = isStockBatch ? 0 : await reservedForItem(prisma, orderItemId);
  const productionCeiling = surplusOrderItem
    ? Math.max(0, +(surplusOrderItem.quantityKg - alreadyReserved).toFixed(3))
    : Infinity;

  const alreadyKg = existingAgg._sum.greenBeanQuantity ?? 0;
  const excess = +(alreadyKg + qty - productionCeiling).toFixed(3);

  if (excess > 0 && user.role !== "admin") {
    return NextResponse.json(
      {
        error:
          alreadyReserved <= 0
            ? `Batch would exceed the order quantity by ${excess}kg. Only an admin can authorize surplus production.`
            : `Batch would exceed the ${productionCeiling}kg still to be produced for this item by ${excess}kg — ${alreadyReserved}kg is already covered from the shelf. Only an admin can authorize surplus production.`,
      },
      { status: 422 }
    );
  }
  // ─────────────────────────────────────────────────────────────────────────

  const batchNumber = await generateBatchNumber(greenBeanId);

  try {
  const batch = await prisma.$transaction(async (tx) => {
    let previousQuantity: number | null = null;
    let newQuantity:      number | null = null;

    if (greenBeanId) {
      // Step 1: confirm existence and active status
      const bean = await tx.greenBean.findUnique({
        where:  { id: greenBeanId },
        select: { isActive: true },
      });
      if (!bean)          throw new AppError(404, "Green bean not found.");
      if (!bean.isActive) throw new AppError(400, "Cannot use an inactive green bean.");

      // Step 2: conditional update — WHERE quantityKg >= qty is evaluated atomically at write time
      const updated = await tx.greenBean.updateMany({
        where: { id: greenBeanId, quantityKg: { gte: qty } },
        data:  { quantityKg: { decrement: qty } },
      });
      if (updated.count === 0) throw new AppError(409, "Insufficient stock.");

      // Step 3: re-read post-decrement quantity inside the same transaction
      const updatedBean = await tx.greenBean.findUnique({
        where:  { id: greenBeanId },
        select: { quantityKg: true },
      });
      newQuantity      = updatedBean!.quantityKg;
      previousQuantity = newQuantity + qty;
    }

    const qcDeadline = new Date(Date.now() + 48 * 60 * 60 * 1000);
    const newBatch = await tx.roastingBatch.create({
      data: {
        orderItemId: isStockBatch ? null : orderItemId,
        // Stock batches carry the product on the batch itself; order-backed ones keep
        // inheriting it from their order item at packaging time, as before.
        productId: isStockBatch ? (productId as string) : undefined,
        greenBeanId:         greenBeanId ?? null,
        greenBeanQuantity:   qty,
        roastedBeanQuantity: roastedQty,
        wasteQuantity:       wasteQty,
        roastProfile:        roastProfile || null,
        batchNumber,
        status:              "Pending QC",
        qcDeadline,
        productionOrderId:   productionOrderId ?? null,
      },
      include: { orderItem: true, greenBean: true },
    });

    if (greenBeanId && previousQuantity !== null && newQuantity !== null) {
      await tx.inventoryMovement.create({
        data: {
          type:              "OUT",
          category:          "RAW_MATERIAL",
          referenceEntityId: greenBeanId,
          quantityChanged:   -qty,
          previousQuantity,
          newQuantity,
          sourceDocType:     "ROASTING_BATCH",
          sourceDocId:       newBatch.id,
          userId:            user.id,
          notes:             null,
        },
      });
    }

    if (!isStockBatch) await recalcOrderItemStatus(orderItemId, tx);

    if (newBatch.productionOrderId) {
      await recalcProductionOrderStatus(newBatch.productionOrderId, tx);
    }

    return newBatch;
  });

  return NextResponse.json(batch, { status: 201 });
  } catch (err: unknown) {
    if (err instanceof AppError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return handlePrismaError(err);
  }
}
