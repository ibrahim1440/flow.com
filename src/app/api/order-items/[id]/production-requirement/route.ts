import { NextResponse } from "next/server";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireSub, requireAnyModule } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { createProductionOrderFromSales } from "@/lib/services/production-planning";
import { explodeBom, kgForUnits } from "@/lib/services/finished-products";

type Params = { params: Promise<{ id: string }> };

/**
 * The production requirement for a SKU order line: only the shortfall.
 *
 * Section 6. The line is covered first by the finished goods already reserved to it, and
 * only what the shelf could not cover reaches production. An order for 20 with 8 on the
 * shelf schedules 12, never 20.
 *
 * Shortfall = ordered - delivered - reserved-from-finished-goods.
 */
async function shortfallFor(orderItemId: string) {
  const item = await prisma.orderItem.findUnique({
    where: { id: orderItemId },
    select: {
      id: true,
      quantityUnits: true,
      deliveredUnits: true,
      productSkuId: true,
      productSku: { select: { id: true, skuCode: true, weightGrams: true } },
      order: { select: { status: true } },
      productionOrders: { select: { id: true, productionNumber: true, status: true, targetUnits: true } },
    },
  });
  if (!item) return { ok: false as const, error: { _appCode: 404, message: "Order item not found." } };

  if (item.quantityUnits === null || !item.productSkuId || !item.productSku)
    return {
      ok: false as const,
      error: {
        _appCode: 409,
        message:
          "This is a legacy kilogram order line, not a finished-product line. Production requirements are only derived for SKU lines.",
      },
    };

  const reserved = await prisma.stockAllocation.aggregate({
    where: { orderItemId, status: "RESERVED", quantityUnits: { not: null } },
    _sum: { quantityUnits: true },
  });

  const reservedUnits = reserved._sum.quantityUnits ?? 0;
  const shortfallUnits = Math.max(0, item.quantityUnits - item.deliveredUnits - reservedUnits);

  return { ok: true as const, item, reservedUnits, shortfallUnits };
}

export async function GET(_request: Request, { params }: Params) {
  const { error } = await requireAnyModule("orders", "production");
  if (error) return error;

  const { id } = await params;

  try {
    const result = await shortfallFor(id);
    if (!result.ok)
      return NextResponse.json({ error: result.error.message }, { status: result.error._appCode });

    const { item, reservedUnits, shortfallUnits } = result;
    const components = shortfallUnits > 0 ? await explodeBom(prisma, item.productSkuId!, shortfallUnits) : [];

    return NextResponse.json({
      orderItemId: item.id,
      skuCode: item.productSku!.skuCode,
      orderedUnits: item.quantityUnits,
      deliveredUnits: item.deliveredUnits,
      reservedUnits,
      shortfallUnits,
      shortfallKg: kgForUnits(item.productSku!, shortfallUnits),
      components,
      hasBom: components.length > 0,
      blockedBy: components.filter((c) => c.shortfall > 0).map((c) => c.label),
      existingProductionOrders: item.productionOrders,
    });
  } catch (err) {
    return handlePrismaError(err);
  }
}

/**
 * Create a ProductionOrder for the shortfall.
 *
 * Reuses createProductionOrderFromSales, which already derives target units and the green
 * bean draw from the SKU's pack size and the coffee's expected roast loss. Its
 * `overrideTargetWeightKg` parameter exists exactly for this: it is passed the shortfall
 * rather than the whole line.
 */
export async function POST(_request: Request, { params }: Params) {
  const { error } = await requireSub("production", "start_batch");
  if (error) return error;

  const { id } = await params;

  try {
    const result = await shortfallFor(id);
    if (!result.ok)
      return NextResponse.json({ error: result.error.message }, { status: result.error._appCode });

    const { item, shortfallUnits } = result;

    if (item.order.status === "Cancelled" || item.order.status === "Rejected")
      return NextResponse.json(
        { error: `Cannot schedule production for an order in status "${item.order.status}".` },
        { status: 409 }
      );

    if (shortfallUnits <= 0)
      return NextResponse.json(
        { error: "Nothing to produce: finished goods already cover this line." },
        { status: 409 }
      );

    // Re-running the calculation must not stack duplicate runs for the same line.
    const openOrder = item.productionOrders.find(
      (p) => p.status === "PENDING" || p.status === "IN_PRODUCTION"
    );
    if (openOrder)
      return NextResponse.json(
        {
          error: `Production order ${openOrder.productionNumber} is already open for this line (${openOrder.targetUnits} units).`,
        },
        { status: 409 }
      );

    const components = await explodeBom(prisma, item.productSkuId!, shortfallUnits);
    if (components.length === 0)
      return NextResponse.json(
        { error: `"${item.productSku!.skuCode}" has no bill of materials, so its production needs cannot be derived.` },
        { status: 409 }
      );

    const shortfallKg = kgForUnits(item.productSku!, shortfallUnits);

    const created = await prisma.$transaction((tx) =>
      createProductionOrderFromSales(item.id, tx, shortfallKg)
    , TX_OPTS);

    return NextResponse.json(
      {
        productionOrder: created,
        shortfallUnits,
        shortfallKg,
        components,
        // Reported, not enforced: a short component means the roastery has to buy or
        // roast more, which is a purchasing/roasting decision rather than a reason to
        // refuse to schedule the work.
        blockedBy: components.filter((c) => c.shortfall > 0).map((c) => c.label),
      },
      { status: 201 }
    );
  } catch (err) {
    return handlePrismaError(err);
  }
}
