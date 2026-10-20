import { Prisma } from "@/generated/prisma/client";
import { prisma, TX_OPTS } from "@/lib/db";
import {
  createProductionOrderFromSales,
  outstandingDemandForItem,
  productionProgressMany,
  advisoryKey,
} from "@/lib/services/production-planning";
import {
  appendOrderActivity,
  assertOrderStillAcceptsProduction,
  productionGateRefusal,
} from "@/lib/services/order-operations";
import { explodeBom, kgForUnits } from "@/lib/services/finished-products";
import { emitAutomationEvent } from "@/lib/automation/emit";

type PrismaTx = Prisma.TransactionClient;
type Actor = { id: string | null; name: string };

/**
 * Production orders as an internal record (production simplification, Phase C item 3, O4).
 *
 * The roaster no longer raises, releases, links or closes production orders. The system does:
 *
 *   create   — whenever automatic preparation leaves a line short (autoScheduleShortfalls);
 *   link     — the roast route links a batch to its line's live production order (unchanged);
 *   close    — settleProductionOrders: COMPLETED once its units are packed, or once its line no
 *              longer needs anything (delivered or covered from the shelf); a plan that never
 *              had a roast behind it is CANCELLED instead, because «complete» certifies work.
 *
 * scheduleShortfallInTx is the transaction of POST /api/order-items/[id]/production-requirement,
 * moved here unchanged so the route and the automatic path are one implementation.
 */

export type ScheduledShortfall = {
  order: Prisma.ProductionOrderGetPayload<object>;
  live: Awaited<ReturnType<typeof outstandingDemandForItem>>;
  liveKg: number;
};

/**
 * Raise a production order for what this line still lacks — inside the caller's transaction.
 *
 * Lock order: advisory 7762 keyed on the line (the same key roasting and the requirement route
 * take), then 7761 inside createProductionOrderFromSales, then the Order row (late barrier).
 */
export async function scheduleShortfallInTx(
  tx: PrismaTx,
  item: { id: string; orderId: string; skuCode: string; weightGrams: number },
  actor: Actor,
  opts: { automatic?: boolean } = {},
): Promise<ScheduledShortfall> {
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
      message: "Nothing further to produce — this line was covered while the request was in flight.",
    };
  }

  const liveKg = kgForUnits({ weightGrams: item.weightGrams }, live.outstandingUnits);
  const order = await createProductionOrderFromSales(item.id, tx, liveKg);

  // Late lifecycle barrier: a Hold or Cancel committed meanwhile rolls the production order back.
  await assertOrderStillAcceptsProduction(tx, item.id, "schedule");

  const settled = await outstandingDemandForItem(tx, {
    id: fresh.id,
    quantityUnits: fresh.quantityUnits ?? 0,
    deliveredUnits: fresh.deliveredUnits,
  });
  const committedUnits =
    settled.orderedUnits - settled.deliveredUnits - settled.reservedUnits - settled.scheduledUnits;
  if (committedUnits < 0) {
    throw {
      _appCode: 409,
      message:
        `Coverage for this line changed while the request was in flight: ` +
        `${settled.reservedUnits} unit(s) reserved and ${settled.scheduledUnits} scheduled ` +
        `now exceed the ${settled.orderedUnits - settled.deliveredUnits} still owed. Nothing was scheduled.`,
    };
  }

  await appendOrderActivity(tx, {
    orderId: item.orderId,
    type: "PRODUCTION_ORDER_CREATED",
    message:
      `Production order ${order.productionNumber} raised for ${order.targetUnits} × ${item.skuCode} ` +
      `(${order.targetWeightKg} kg finished, ${order.expectedGreenBeanKg} kg green) ` +
      (opts.automatic ? "automatically for the shortfall." : `by ${actor.name}.`),
    authorId: actor.id,
    authorName: opts.automatic ? "System" : actor.name,
    metadata: {
      productionOrderId: order.id,
      productionNumber: order.productionNumber,
      targetUnits: order.targetUnits,
      outstandingBefore: live.outstandingUnits,
      reservedUnits: live.reservedUnits,
      scheduledUnits: live.scheduledUnits,
      ...(opts.automatic ? { automatic: true } : {}),
    },
  });

  await emitAutomationEvent(tx, {
    eventType: "production.order_created",
    subjectType: "ProductionOrder",
    subjectId: order.id,
    actorId: actor.id,
  });

  return { order, live, liveKg };
}

/**
 * After automatic preparation: one production order per short line, for exactly the shortfall.
 *
 * Idempotent by the demand equation (outstanding = ordered − delivered − reserved − scheduled):
 * a line already covered by an open production order schedules nothing. Lines whose SKU has no
 * bill of materials are skipped (the manual route refuses them too). Each line is its own
 * transaction; a line that lost a race is simply left for the next event.
 */
export async function autoScheduleShortfalls(orderId: string, actor: Actor): Promise<number> {
  const lines = await prisma.orderItem.findMany({
    where: {
      orderId,
      quantityUnits: { not: null },
      productSkuId: { not: null },
      preparationDecision: { in: ["Needs Production", "Partially Available"] },
    },
    select: {
      id: true, orderId: true, quantityUnits: true, deliveredUnits: true, productSkuId: true, preparationDecision: true,
      productSku: { select: { skuCode: true, weightGrams: true } },
      order: { select: { status: true, approvalStatus: true } },
    },
    orderBy: { id: "asc" },
  });
  let created = 0;
  for (const line of lines) {
    if (!line.productSku || !line.productSkuId || line.quantityUnits === null) continue;
    if (productionGateRefusal({ preparationDecision: line.preparationDecision, order: line.order }, "schedule")) continue;
    const demand = await outstandingDemandForItem(prisma, { id: line.id, quantityUnits: line.quantityUnits, deliveredUnits: line.deliveredUnits });
    if (demand.outstandingUnits <= 0) continue;
    const bom = await explodeBom(prisma, line.productSkuId, demand.outstandingUnits);
    if (bom.length === 0) continue;
    try {
      await prisma.$transaction(
        (tx) => scheduleShortfallInTx(
          tx,
          { id: line.id, orderId: line.orderId, skuCode: line.productSku!.skuCode, weightGrams: line.productSku!.weightGrams },
          actor,
          { automatic: true },
        ),
        TX_OPTS,
      );
      created++;
    } catch (err) {
      const code = err && typeof err === "object" && "_appCode" in err ? (err as { _appCode: number })._appCode : null;
      if (code !== 409) console.error(`[auto-schedule] line ${line.id}:`, err);
    }
  }
  return created;
}

const TERMINAL_ORDER = new Set(["Completed", "Cancelled", "Rejected"]);

/**
 * Close the internal production orders that have nothing left to do.
 *
 *   produced (packed units of its own SKU) ≥ target            → COMPLETED
 *   its line is blocked and nothing was roasted for it (PENDING)   → CANCELLED
 *   its line is delivered / covered, or its order is closed:
 *     with roasting behind it (IN_PRODUCTION)                   → COMPLETED (closing short is
 *                                                                 allowed and safe)
 *     with none (PENDING)                                       → CANCELLED
 *
 * Each order is its own short transaction: a guarded status write on the ProductionOrder row
 * (ProductionOrder may be locked after OrderItem; nothing here locks an OrderItem) and the
 * activity on the customer order's timeline.
 */
export async function settleProductionOrders(
  scope: { orderId?: string; productionOrderIds?: string[] },
  actor: Actor,
): Promise<number> {
  const where: Prisma.ProductionOrderWhereInput = { status: { in: ["PENDING", "IN_PRODUCTION"] } };
  if (scope.productionOrderIds) where.id = { in: scope.productionOrderIds };
  else if (scope.orderId) where.sourceOrderItem = { orderId: scope.orderId };
  else return 0;

  const pos = await prisma.productionOrder.findMany({
    where,
    select: {
      id: true, productionNumber: true, status: true, targetUnits: true, targetWeightKg: true,
      productSku: { select: { skuCode: true } },
      sourceOrderItem: {
        select: { id: true, orderId: true, quantityUnits: true, deliveredUnits: true, preparationDecision: true, order: { select: { status: true } } },
      },
    },
  });
  if (pos.length === 0) return 0;
  const progress = await productionProgressMany(prisma, pos);
  let settled = 0;

  for (const po of pos) {
    const produced = progress.get(po.id)?.producedUnits ?? 0;
    let to: "COMPLETED" | "CANCELLED" | null = null;
    let why = "";
    if (produced >= po.targetUnits && po.targetUnits > 0) {
      to = "COMPLETED"; why = `all ${po.targetUnits} unit(s) packed`;
    } else if (po.sourceOrderItem && po.sourceOrderItem.preparationDecision === "Blocked" && po.status === "PENDING") {
      // A supervisor blocked the line before anything was roasted for it: the plan goes.
      to = "CANCELLED"; why = "its order line is blocked";
    } else if (po.sourceOrderItem) {
      const line = po.sourceOrderItem;
      let lineCovered = TERMINAL_ORDER.has(line.order.status);
      if (!lineCovered && line.quantityUnits !== null) {
        const reserved = await prisma.stockAllocation.aggregate({
          where: { orderItemId: line.id, status: "RESERVED", quantityUnits: { not: null } },
          _sum: { quantityUnits: true },
        });
        lineCovered = line.quantityUnits - line.deliveredUnits - (reserved._sum.quantityUnits ?? 0) <= 0;
      }
      if (lineCovered) {
        to = po.status === "IN_PRODUCTION" ? "COMPLETED" : "CANCELLED";
        why = TERMINAL_ORDER.has(line.order.status)
          ? `its order is ${line.order.status}`
          : "its order line is covered";
      }
    }
    if (!to) continue;

    try {
      await prisma.$transaction(async (tx) => {
        const updated = await tx.productionOrder.updateMany({
          where: { id: po.id, status: po.status },
          data: { status: to! },
        });
        if (updated.count === 0) return;
        settled++;
        if (po.sourceOrderItem) {
          await appendOrderActivity(tx, {
            orderId: po.sourceOrderItem.orderId,
            type: to === "COMPLETED" ? "PRODUCTION_ORDER_COMPLETED" : "PRODUCTION_ORDER_CANCELLED",
            message:
              `Production order ${po.productionNumber} (${po.targetUnits} × ${po.productSku.skuCode}) ` +
              `${to === "COMPLETED" ? "completed" : "cancelled"} automatically: ${why}.`,
            authorId: actor.id,
            authorName: "System",
            metadata: { productionOrderId: po.id, productionNumber: po.productionNumber, from: po.status, to, automatic: true, producedUnits: produced },
          });
        }
      }, TX_OPTS);
    } catch (err) {
      console.error(`[auto-settle] production order ${po.id}:`, err);
    }
  }
  return settled;
}

/** The live production orders a set of batches is linked to (for settling after packaging). */
export async function productionOrdersOfBatches(batchIds: string[]): Promise<string[]> {
  if (batchIds.length === 0) return [];
  const rows = await prisma.roastingBatch.findMany({
    where: { id: { in: batchIds }, productionOrderId: { not: null } },
    select: { productionOrderId: true },
  });
  return [...new Set(rows.map((r) => r.productionOrderId!))];
}

/**
 * A manual requirement replaces the system's provisional plan (production simplification C).
 *
 * The automatic shortfall scheduling raises a plan the moment an order is prepared. A
 * supervisor (or the API) asking for the line's requirement explicitly must not be told
 * "already scheduled" by a plan nobody asked for and nothing was roasted against, so such a
 * plan — PENDING, automatic (its creation activity says so), no batch linked — is withdrawn
 * first: removed, with a PRODUCTION_ORDER_CANCELLED entry on the order's timeline that names
 * it. A plan with any roast behind it, or one a person raised, is never touched.
 *
 * Own transaction, advisory 7762 keyed on the line (the key the requirement and the roast
 * take), then the ProductionOrder rows.
 */
export async function withdrawProvisionalPlans(
  item: { id: string; orderId: string },
  actor: Actor,
): Promise<number> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(7762, ${advisoryKey(item.id)}::int)`;
    return withdrawProvisionalPlansInTx(tx, [item.id], item.orderId, actor, "a plan requested by " + actor.name);
  }, TX_OPTS);
}

/**
 * The same, inside the caller's transaction — for an order edit or delete, which hold the
 * line's 7762 key and its row locks already (ProductionOrder is locked after OrderItem, the
 * canonical place). An automatic plan nothing was roasted against is the system's own
 * provisional record, not production history: it must not stop a fresh order from being
 * corrected, shrunk or deleted. The next automatic preparation raises what is still needed.
 */
export async function withdrawProvisionalPlansInTx(
  tx: PrismaTx,
  orderItemIds: string[],
  orderId: string,
  actor: Actor,
  because = "an edit to the order",
): Promise<number> {
  let n = 0;
  for (const itemId of [...new Set(orderItemIds)].sort()) {
    const rows = await tx.$queryRaw<{ id: string; productionNumber: string; targetUnits: number }[]>`
      SELECT po."id", po."productionNumber", po."targetUnits"
        FROM "ProductionOrder" po
       WHERE po."sourceOrderItemId" = ${itemId}
         AND po."status" = 'PENDING'
         AND NOT EXISTS (SELECT 1 FROM "RoastingBatch" rb WHERE rb."productionOrderId" = po."id")
         AND EXISTS (SELECT 1 FROM "OrderActivity" a
                      WHERE a."orderId" = ${orderId} AND a."type" = 'PRODUCTION_ORDER_CREATED'
                        AND a."metadata"->>'productionOrderId' = po."id"
                        AND a."metadata"->>'automatic' = 'true')
       ORDER BY po."id"
         FOR UPDATE OF po`;
    for (const po of rows) {
      await tx.productionOrder.deleteMany({ where: { id: po.id, status: "PENDING" } });
      await appendOrderActivity(tx, {
        orderId,
        type: "PRODUCTION_ORDER_CANCELLED",
        message: `Automatic production order ${po.productionNumber} (${po.targetUnits} unit(s)) withdrawn: replaced by ${because}.`,
        authorId: actor.id,
        authorName: "System",
        metadata: { productionOrderId: po.id, productionNumber: po.productionNumber, withdrawn: true, automatic: true },
      });
    }
    n += rows.length;
  }
  return n;
}

/**
 * What production orders still owe a line, in units: all live plans, and the FIRM part — plans
 * a person raised, or with roasting behind them. A provisional plan (automatic, PENDING, nothing
 * roasted) is the system's own placeholder: shelf stock that appears later takes precedence over
 * it (automatic preparation reserves it, and rebalanceProvisionalPlans then withdraws the
 * placeholder), so it is left out of the firm figure.
 */
export async function planCoverage(
  db: PrismaTx,
  item: { id: string; orderId: string },
): Promise<{ scheduledAll: number; scheduledFirm: number; provisionalIds: string[] }> {
  const pos = await db.productionOrder.findMany({
    where: { sourceOrderItemId: item.id, status: { in: ["PENDING", "IN_PRODUCTION"] } },
    select: { id: true, status: true, targetUnits: true, targetWeightKg: true, _count: { select: { roastingBatches: true } } },
  });
  if (pos.length === 0) return { scheduledAll: 0, scheduledFirm: 0, provisionalIds: [] };
  const pendingBare = pos.filter((p) => p.status === "PENDING" && p._count.roastingBatches === 0).map((p) => p.id);
  const automatic = pendingBare.length === 0 ? [] : await db.$queryRaw<{ id: string }[]>`
    SELECT a."metadata"->>'productionOrderId' AS id FROM "OrderActivity" a
     WHERE a."orderId" = ${item.orderId} AND a."type" = 'PRODUCTION_ORDER_CREATED'
       AND a."metadata"->>'automatic' = 'true'
       AND a."metadata"->>'productionOrderId' IN (${Prisma.join(pendingBare)})`;
  const provisional = new Set(automatic.map((r) => r.id));
  const progress = await productionProgressMany(db, pos);
  let all = 0, firm = 0;
  for (const p of pos) {
    const owed = Math.max(0, p.targetUnits - (progress.get(p.id)?.producedUnits ?? 0));
    all += owed;
    if (!provisional.has(p.id)) firm += owed;
  }
  return { scheduledAll: all, scheduledFirm: firm, provisionalIds: [...provisional] };
}

/**
 * After automatic preparation: a line now covered by the shelf beyond what its provisional plan
 * assumed (delivered + reserved + scheduled > ordered) loses that placeholder; the shortfall
 * scheduling that follows raises exactly what is still missing. Keeps the coverage invariant
 * delivered + reserved + scheduled ≤ ordered that the order edit and the requirement route keep.
 */
export async function rebalanceProvisionalPlans(orderId: string, actor: Actor): Promise<number> {
  const lines = await prisma.orderItem.findMany({
    where: { orderId, quantityUnits: { not: null }, productionOrders: { some: { status: "PENDING" } } },
    select: { id: true, orderId: true, quantityUnits: true, deliveredUnits: true },
  });
  let withdrawn = 0;
  for (const l of lines) {
    const cover = await planCoverage(prisma, l);
    if (cover.provisionalIds.length === 0) continue;
    const reserved = await prisma.stockAllocation.aggregate({
      where: { orderItemId: l.id, status: "RESERVED", quantityUnits: { not: null } },
      _sum: { quantityUnits: true },
    });
    if (l.deliveredUnits + (reserved._sum.quantityUnits ?? 0) + cover.scheduledAll <= (l.quantityUnits ?? 0)) continue;
    withdrawn += await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(7762, ${advisoryKey(l.id)}::int)`;
      return withdrawProvisionalPlansInTx(tx, [l.id], l.orderId, actor, "stock found on the shelf");
    }, TX_OPTS);
  }
  return withdrawn;
}
