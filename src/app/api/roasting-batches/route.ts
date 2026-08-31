import { NextResponse } from "next/server";
import { Prisma } from "@/generated/prisma/client";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireAnyModule, requireSub } from "@/lib/auth-server";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { handlePrismaError } from "@/lib/api-error";
import { recalcOrderItemStatus } from "@/lib/services/order-fulfillment";
import { reservedForItem } from "@/lib/services/shelf-allocation";
import { recalcProductionOrderStatus, assertProductionOrderAcceptsRoast } from "@/lib/services/production-planning";

class AppError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/**
 * The day's next batch serial.
 *
 * The sequence is per DAY, not per green bean. It used to count only batches of the same
 * bean, so the first Colombia roast and the first Kenya roast on one morning were both
 * numbered ...01 — two physically different batches sharing the serial that operators,
 * QC cards, packaging cards and labels all identify a lot by. Nothing was corrupted,
 * because every write goes through the row id, but the number stopped identifying anything.
 *
 * Derived from the highest serial issued today rather than from a count, for the same
 * reason the production numbering is: a count silently reissues a number as soon as the
 * table has a gap. The advisory lock serialises the read-then-insert so two roasts
 * recorded at the same moment cannot claim the same serial; it is released at commit.
 */
async function generateBatchNumber(tx: Prisma.TransactionClient): Promise<string> {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");

  await tx.$executeRaw`SELECT pg_advisory_xact_lock(7763, ${Number(dateStr) % 2147483647}::int)`;

  const [{ max }] = await tx.$queryRaw<{ max: number | null }[]>`
    SELECT MAX(CAST(SUBSTRING("batchNumber" FROM 9) AS INTEGER)) AS max
      FROM "RoastingBatch"
     WHERE "batchNumber" ~ ${`^${dateStr}[0-9]+$`}`;

  return `${dateStr}${String((max ?? 0) + 1).padStart(2, "0")}`;
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
      orderItem: {
        include: {
          order: { include: { customer: { include: { roastPreferences: true } } } },
          // Which coffee an order-backed batch is. A stock batch carries productId
          // directly; a batch roasted against an order carries nothing and has to be
          // identified through its line's SKU. Without this the production-order screen
          // could not tell what any order-backed batch was, so its "link a roasting batch"
          // picker was permanently empty — exactly the batches most worth linking.
          productSku: { select: { id: true, skuCode: true, productId: true } },
        },
      },
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

  // Roasted output, not green input. The ceiling below is expressed in the finished
  // kilograms the order needs, so the thing measured against it has to be the coffee that
  // will actually become those kilograms. Summing green here compared an input to an
  // output: since roasting always loses weight, every correct roast looked like surplus.
  // A 12 kg order needs about 14.3 kg of green at a 16 % loss, and that produced
  // "would exceed the order quantity by 2.3kg — only an admin can authorize surplus
  // production", which stopped non-admin roasters from working at all.
  const existingAgg = isStockBatch
    ? { _sum: { roastedBeanQuantity: 0 } }
    : await prisma.roastingBatch.aggregate({
        where: {
          orderItemId,
          isBlend: false,
          status: { not: "Rejected" },
        },
        _sum: { roastedBeanQuantity: true },
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

  const alreadyKg = existingAgg._sum.roastedBeanQuantity ?? 0;
  const excess = +(alreadyKg + roastedQty - productionCeiling).toFixed(3);

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

  try {
  const batch = await prisma.$transaction(async (tx) => {
    // Generated inside the transaction so the advisory lock it takes is held until commit,
    // which is what stops two concurrent roasts being handed the same serial.
    const batchNumber = await generateBatchNumber(tx);

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

    // A batch may be roasted directly against a production order. Validate the pairing
    // before creating it: an order that is closed, or one for a different coffee, must not
    // silently absorb this roast into its progress.
    if (productionOrderId) {
      const batchProductId = isStockBatch
        ? (productId as string)
        : (
            await tx.orderItem.findUnique({
              where: { id: orderItemId },
              select: { productSku: { select: { productId: true } } },
            })
          )?.productSku?.productId ?? null;
      await assertProductionOrderAcceptsRoast(tx, productionOrderId, batchProductId);
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
        // Roasted output starts fully available as intermediate stock. Packing a SKU
        // draws this down through the BOM. The legacy kg packaging path does not
        // decrement it, so the two paths are kept mutually exclusive per batch — each
        // refuses to run on a batch the other has already packed — and the same roasted
        // coffee can never be spent twice.
        roastedAvailableKg:  roastedQty,
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
  }, TX_OPTS);

  return NextResponse.json(batch, { status: 201 });
  } catch (err: unknown) {
    if (err instanceof AppError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    // The production-planning guards throw the `{ _appCode, message }` shape the newer
    // routes use, rather than this file's older AppError class.
    if (err && typeof err === "object" && "_appCode" in err) {
      const e = err as { _appCode: number; message: string };
      return NextResponse.json({ error: e.message }, { status: e._appCode });
    }
    return handlePrismaError(err);
  }
}
