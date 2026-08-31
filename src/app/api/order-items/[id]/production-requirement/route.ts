import { NextResponse } from "next/server";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireSub, requireAnyModule } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import {
  createProductionOrderFromSales,
  outstandingDemandForItem,
  productionProgressMany,
  advisoryKey,
} from "@/lib/services/production-planning";
import { appendOrderActivity } from "@/lib/services/order-operations";
import { explodeBom, kgForUnits } from "@/lib/services/finished-products";

type Params = { params: Promise<{ id: string }> };

/**
 * The production requirement for a SKU order line: only what is still outstanding.
 *
 * Section 6. The line is covered first by the finished goods already reserved to it, then
 * by production already scheduled and not yet packed, and only the remainder reaches
 * production. An order for 20 with 8 on the shelf schedules 12, never 20 — and if 12 are
 * already on a production order, it schedules nothing until the ordered quantity grows.
 *
 * The arithmetic lives in outstandingDemandForItem so that the read (GET) and the write
 * (POST) cannot drift apart.
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
      order: { select: { id: true, status: true, orderNumber: true } },
      productionOrders: {
        select: { id: true, productionNumber: true, status: true, targetUnits: true, targetWeightKg: true },
        orderBy: { createdAt: "asc" },
      },
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

  const demand = await outstandingDemandForItem(prisma, {
    id: item.id,
    quantityUnits: item.quantityUnits,
    deliveredUnits: item.deliveredUnits,
  });

  const progress = await productionProgressMany(prisma, item.productionOrders);

  return {
    ok: true as const,
    item,
    demand,
    reservedUnits: demand.reservedUnits,
    shortfallUnits: demand.outstandingUnits,
    productionOrders: item.productionOrders.map((p) => ({
      id: p.id,
      productionNumber: p.productionNumber,
      status: p.status,
      targetUnits: p.targetUnits,
      producedUnits: progress.get(p.id)?.producedUnits ?? 0,
    })),
  };
}

export async function GET(_request: Request, { params }: Params) {
  const { error } = await requireAnyModule("orders", "production");
  if (error) return error;

  const { id } = await params;

  try {
    const result = await shortfallFor(id);
    if (!result.ok)
      return NextResponse.json({ error: result.error.message }, { status: result.error._appCode });

    const { item, demand, shortfallUnits, productionOrders } = result;
    const components = shortfallUnits > 0 ? await explodeBom(prisma, item.productSkuId!, shortfallUnits) : [];

    return NextResponse.json({
      orderItemId: item.id,
      skuCode: item.productSku!.skuCode,
      orderedUnits: demand.orderedUnits,
      deliveredUnits: demand.deliveredUnits,
      reservedUnits: demand.reservedUnits,
      // What existing production orders still owe this line. Shown next to the shortfall
      // so an operator can see why a line with an obvious gap is not asking for more.
      scheduledUnits: demand.scheduledUnits,
      shortfallUnits,
      shortfallKg: kgForUnits(item.productSku!, shortfallUnits),
      components,
      hasBom: components.length > 0,
      blockedBy: components.filter((c) => c.shortfall > 0).map((c) => c.label),
      existingProductionOrders: productionOrders,
    });
  } catch (err: unknown) {
    if (err && typeof err === "object" && "_appCode" in err) {
      const e = err as { _appCode: number; message: string };
      return NextResponse.json({ error: e.message }, { status: e._appCode });
    }
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
  const { error, user } = await requireSub("production", "start_batch");
  if (error) return error;

  const { id } = await params;

  try {
    const result = await shortfallFor(id);
    if (!result.ok)
      return NextResponse.json({ error: result.error.message }, { status: result.error._appCode });

    const { item, demand, shortfallUnits } = result;

    if (item.order.status === "Cancelled" || item.order.status === "Rejected")
      return NextResponse.json(
        { error: `Cannot schedule production for an order in status "${item.order.status}".` },
        { status: 409 }
      );

    // Nothing outstanding is a legitimate, common answer — the shelf covers the line, or
    // production already scheduled covers it. The message distinguishes the two, because
    // "already covered" and "already scheduled" call for very different next actions.
    //
    // This deliberately replaces the old "an open production order exists, refuse
    // forever" rule. That rule made an increase in ordered quantity unschedulable for the
    // rest of the line's life; duplicate scheduling is now prevented by the arithmetic
    // itself, which counts what open orders still owe.
    if (shortfallUnits <= 0)
      return NextResponse.json(
        {
          error:
            demand.scheduledUnits > 0
              ? `Nothing further to produce: ${demand.reservedUnits} unit(s) reserved and ${demand.scheduledUnits} unit(s) already on open production orders cover this line.`
              : "Nothing to produce: finished goods already cover this line.",
          ...demand,
        },
        { status: 409 }
      );

    const components = await explodeBom(prisma, item.productSkuId!, shortfallUnits);
    if (components.length === 0)
      return NextResponse.json(
        { error: `"${item.productSku!.skuCode}" has no bill of materials, so its production needs cannot be derived.` },
        { status: 409 }
      );

    const created = await prisma.$transaction(async (tx) => {
      // Everything above was computed outside the transaction and is only good enough to
      // reject the obvious cases and build the error messages. The authoritative
      // calculation happens here, behind an advisory lock keyed on this order line, so
      // that two operators pressing the button at the same moment cannot both read the
      // same shortfall and both schedule it. The lock is released at commit.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(7762, ${advisoryKey(item.id)}::int)`;

      const fresh = await tx.orderItem.findUniqueOrThrow({
        where: { id: item.id },
        select: { id: true, quantityUnits: true, deliveredUnits: true },
      });
      const live = await outstandingDemandForItem(tx, {
        id: fresh.id,
        quantityUnits: fresh.quantityUnits ?? 0,
        deliveredUnits: fresh.deliveredUnits,
      });
      if (live.outstandingUnits <= 0) {
        throw {
          _appCode: 409,
          message:
            "Nothing further to produce — this line was covered while the request was in flight.",
        };
      }

      const liveKg = kgForUnits(item.productSku!, live.outstandingUnits);
      const order = await createProductionOrderFromSales(item.id, tx, liveKg);

      await appendOrderActivity(tx, {
        orderId: item.order.id,
        type: "PRODUCTION_ORDER_CREATED",
        message:
          `Production order ${order.productionNumber} raised for ${order.targetUnits} × ${item.productSku!.skuCode} ` +
          `(${order.targetWeightKg} kg finished, ${order.expectedGreenBeanKg} kg green) by ${user.name}.`,
        authorId: user.id,
        authorName: user.name,
        metadata: {
          productionOrderId: order.id,
          productionNumber: order.productionNumber,
          targetUnits: order.targetUnits,
          outstandingBefore: live.outstandingUnits,
          reservedUnits: live.reservedUnits,
          scheduledUnits: live.scheduledUnits,
        },
      });

      return { order, live, liveKg };
    }, TX_OPTS);

    return NextResponse.json(
      {
        productionOrder: created.order,
        shortfallUnits: created.live.outstandingUnits,
        shortfallKg: created.liveKg,
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
