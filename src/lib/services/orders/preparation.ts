import { Prisma } from "@/generated/prisma/client";
import { prisma, TX_OPTS } from "@/lib/db";
import {
  appendOrderActivity,
  aggregatePreparationStatus,
  readLineReservationState,
  casUpdateOrderItem,
  PREPARATION_REVIEW_ENTRY_STATUSES,
  DELIVERY_ALLOWED_STATUSES,
  completionRefusal,
  type PreparationDecision,
} from "@/lib/services/order-operations";
import { autoScheduleShortfalls, settleProductionOrders, planCoverage, rebalanceProvisionalPlans } from "@/lib/services/production-schedule";
import {
  ALLOCATABLE_ITEM_SELECT,
  decisionFor,
  kgEqual,
  releaseShelfStock,
  reserveShelfStock,
  reservedForItem,
  roundKg,
} from "@/lib/services/shelf-allocation";
import {
  kgForUnits,
  releaseFinishedUnits,
  reserveFinishedUnits,
} from "@/lib/services/finished-products";
import { emitAutomationEvent } from "@/lib/automation/emit";
import { orderNeedsProduction } from "@/lib/automation/order-progress";

type PrismaTx = Prisma.TransactionClient;

/**
 * Preparation — reserving the shelf for an order and deriving its decision and status.
 *
 * Extracted from POST /api/orders/[id]/preparation-review (production simplification, Phase B
 * item 4). The same arithmetic now runs in two modes:
 *
 *   manual — the route, exactly as before: the supervisor's request, every line released and
 *            re-reserved, a client decision honoured only when the shelf agrees, "Blocked" (the
 *            one decision that stays manual) and the first-commit ownership claim.
 *   auto   — the system after every event that moves stock or demand (order created, roast, QC
 *            decision, pack, delivery, resume). No request body: every line that is not Blocked
 *            is derived from stock. A line's reservation is TOPPED UP to its demand or TRIMMED
 *            down to it rather than released and re-taken, so repeated recomputes neither churn
 *            allocation rows nor move a line off lots it already holds. A Blocked line is left
 *            exactly as the supervisor set it.
 *
 * ── Locks (both modes) ──
 * The canonical order StockAllocation → FinishedGoodsLot → OrderItem → Order is kept: reserve and
 * trim take allocation and lot locks (in id order) first, the line is written by compare-and-swap
 * (OrderItem), and the Order row is written last. No advisory lock is taken here — 7761–7764 are
 * untouched — and the automatic mode runs in its OWN transaction after the triggering one has
 * committed (see autoPrepareOrder), so roast, pack and delivery do not hold their locks for it.
 * The one decision taken inside a hot transaction is the auto-close in the delivery route, which
 * only reads rows that transaction already holds plus a status write on the Order it has locked.
 *
 * ── The Order row is always written when a decision changes ──
 * assertOrderStillAcceptsProduction's lock argument relies on it: a decision never changes without
 * the same transaction writing the parent Order row. Auto mode keeps that — whenever any line's
 * decision or quantities are written, the Order row is written too (status the same or new).
 */

export type PreparationItemInput = {
  orderItemId: string;
  // null = "you work it out from stock". Non-null = a claim the server must be able to back.
  decision: PreparationDecision | null;
  availableQuantity: number | null;
  productionRequiredQuantity: number | null;
};

export type PreparationActor = { id: string | null; name: string };

/** Statuses the automatic recompute runs from. Legacy "Waiting Approval" orders stay manual. */
export const AUTO_PREPARATION_STATUSES = ["Waiting Preparation Review", "Preparing", "Ready for Shipping"] as const;

/** What triggered an automatic recompute; recorded on the activity and the automation payload. */
export type PreparationTrigger =
  | "order_created"
  | "roast"
  | "qc_decision"
  | "pack"
  | "delivery"
  | "resume"
  | "order_edited"
  | "review"
  /** «إعادة حساب حالات الطلبات»: corrects the past, so its automation events are silent. */
  | "recompute";

type Outcome = {
  orderItemId: string;
  decision: PreparationDecision;
  availableQuantity: number;
  productionRequiredQuantity: number;
  reservedFromLots: { lotId: string; batchNumber: string; quantityKg: number }[];
};

export type PreparationResult = {
  skipped: boolean;
  changed: boolean;
  from: string | null;
  to: string | null;
  order: {
    id: string;
    status: string;
    items: { id: string; preparationDecision: string | null; availableQuantity: number | null; productionRequiredQuantity: number | null }[];
  } | null;
};

const MANUAL_ENTRY = PREPARATION_REVIEW_ENTRY_STATUSES as string[];
const AUTO_ENTRY = AUTO_PREPARATION_STATUSES as readonly string[];

/**
 * Run preparation for an order inside the caller's transaction.
 *
 * Throws `{ _appCode, message, computed? }` refusals (manual mode) and the compare-and-swap 409
 * (both modes). Auto mode returns `{ skipped: true }` instead of refusing an order that is not in
 * a preparable status — holding, terminal and legacy orders are simply not its business.
 */
export async function reviewOrderPreparation(
  tx: PrismaTx,
  input: {
    orderId: string;
    mode: "manual" | "auto";
    actor: PreparationActor;
    /** manual: the request's lines. auto: ignored — every non-Blocked line is derived. */
    items?: PreparationItemInput[];
    note?: string;
    trigger?: PreparationTrigger;
  },
): Promise<PreparationResult> {
  const { orderId: id, mode, actor } = input;
  const auto = mode === "auto";

  const order = await tx.order.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      items: { select: { id: true, quantityKg: true, preparationDecision: true }, orderBy: { id: "asc" } },
    },
  });
  if (!order) {
    if (auto) return { skipped: true, changed: false, from: null, to: null, order: null };
    throw { _appCode: 404, message: "Order not found." };
  }

  const entry = auto ? AUTO_ENTRY : MANUAL_ENTRY;
  if (!entry.includes(order.status)) {
    if (auto) return { skipped: true, changed: false, from: order.status, to: order.status, order: null };
    throw {
      _appCode: 409,
      message: `Preparation review is not allowed while the order is in status "${order.status}".`,
    };
  }

  const parsedItems: PreparationItemInput[] = auto
    ? order.items
        .filter((i) => i.preparationDecision !== "Blocked")
        .map((i) => ({ orderItemId: i.id, decision: null, availableQuantity: null, productionRequiredQuantity: null }))
    : input.items ?? [];

  const itemsById = new Map(order.items.map((i) => [i.id, i]));
  for (const p of parsedItems) {
    if (!itemsById.has(p.orderItemId)) {
      throw { _appCode: 400, message: `Order item ${p.orderItemId} does not belong to this order.` };
    }
  }

  const outcomes: Outcome[] = [];
  // Auto mode writes a line only when something about it changed.
  const writes = new Set<string>();

  // Every line's row in one query rather than one query per line (see the route's history: a
  // round trip costs about 167 ms on this deployment). Read-only; the claims below are atomic.
  const itemRows = parsedItems.length === 0 ? [] : await tx.orderItem.findMany({
    where: { id: { in: parsedItems.map((p) => p.orderItemId) } },
    select: {
      ...ALLOCATABLE_ITEM_SELECT,
      quantityUnits: true,
      deliveredUnits: true,
      preparationDecision: true,
      availableQuantity: true,
      productionRequiredQuantity: true,
      productSku: { select: { weightGrams: true } },
    },
  });
  const itemRowsById = new Map(itemRows.map((r) => [r.id, r]));
  const casTokens = new Map<string, { id: string; updatedAt: Date; deliveredUnits: number; deliveredQty: number }>();

  for (const p of parsedItems) {
    const stale = itemRowsById.get(p.orderItemId);
    if (!stale) throw { _appCode: 404, message: `Order item ${p.orderItemId} not found.` };

    // Transaction-current demand, re-read immediately before the ceiling is derived; its
    // token is what the compare-and-swap at the end proves nothing moved underneath.
    const fresh = await readLineReservationState(tx, p.orderItemId);
    if (!fresh) throw { _appCode: 404, message: `Order item ${p.orderItemId} not found.` };
    const item = { ...stale, ...fresh, productSku: stale.productSku };
    casTokens.set(item.id, {
      id: fresh.id,
      updatedAt: fresh.updatedAt,
      deliveredUnits: fresh.deliveredUnits,
      deliveredQty: fresh.deliveredQty,
    });

    // ── SKU lines reserve whole units ──────────────────────────────────────
    if (item.quantityUnits !== null && item.productSkuId && item.productSku) {
      const sku = item.productSku;
      const demandUnits = Math.max(0, item.quantityUnits - item.deliveredUnits);

      if (auto) {
        // Top up or trim — never release and re-take.
        const held = await tx.stockAllocation.aggregate({
          where: { orderItemId: item.id, status: "RESERVED", quantityUnits: { not: null } },
          _sum: { quantityUnits: true },
        });
        const heldUnits = held._sum.quantityUnits ?? 0;
        // A line holding MORE than it still needs is left exactly as it is: delivery and order
        // edits trim their own reservations, and a surplus surviving them is an anomaly the
        // completion gate reports rather than one a background recompute quietly repairs.
        let reservedUnits = Math.min(heldUnits, demandUnits);
        const lots: Outcome["reservedFromLots"] = [];
        // Production a person raised, or with roasting behind it, keeps its share of the demand
        // (delivered + reserved + scheduled ≤ ordered, as the order edit keeps it); a provisional
        // automatic plan does not — the shelf comes first, and the plan is rebalanced after.
        const firm = (await planCoverage(tx, { id: item.id, orderId: id })).scheduledFirm;
        const cap = Math.max(0, demandUnits - firm);
        if (heldUnits >= cap) {
          // nothing to take
        } else {
          const taken = await reserveFinishedUnits(
            tx,
            { id: item.id, productSkuId: item.productSkuId, productSku: sku },
            cap - heldUnits,
            actor.id,
          );
          reservedUnits = heldUnits + taken.reservedUnits;
          for (const l of taken.lots) lots.push({ lotId: l.lotId, batchNumber: l.batchNumber, quantityKg: kgForUnits(sku, l.units) });
          if (taken.reservedUnits > 0) writes.add(item.id);
        }
        const stillNeededUnits = Math.max(0, demandUnits - reservedUnits);
        const outcome: Outcome = {
          orderItemId: item.id,
          decision: decisionFor(stillNeededUnits, reservedUnits) as PreparationDecision,
          availableQuantity: kgForUnits(sku, reservedUnits),
          productionRequiredQuantity: kgForUnits(sku, stillNeededUnits),
          reservedFromLots: lots,
        };
        if (
          outcome.decision !== stale.preparationDecision ||
          stale.availableQuantity === null || !kgEqual(stale.availableQuantity, outcome.availableQuantity) ||
          stale.productionRequiredQuantity === null || !kgEqual(stale.productionRequiredQuantity, outcome.productionRequiredQuantity)
        ) writes.add(item.id);
        outcomes.push(outcome);
        continue;
      }

      await releaseFinishedUnits(tx, item.id);

      if (p.decision === "Blocked") {
        outcomes.push({
          orderItemId: item.id,
          decision: "Blocked",
          availableQuantity: 0,
          productionRequiredQuantity: kgForUnits(sku, demandUnits),
          reservedFromLots: [],
        });
        writes.add(item.id);
        continue;
      }

      const takenUnits = await reserveFinishedUnits(
        tx,
        { id: item.id, productSkuId: item.productSkuId, productSku: sku },
        demandUnits,
        actor.id,
      );
      const reservedUnits = takenUnits.reservedUnits;
      const stillNeededUnits = Math.max(0, demandUnits - reservedUnits);
      const derived = decisionFor(stillNeededUnits, reservedUnits) as PreparationDecision;

      if (p.decision !== null && p.decision !== derived) {
        throw {
          _appCode: 409,
          message:
            `Item ${item.id}: "${p.decision}" is not supported by stock. ` +
            `${reservedUnits} of ${demandUnits} unit(s) can be covered from finished goods, so the decision is "${derived}".`,
          computed: {
            orderItemId: item.id,
            decision: derived,
            availableUnits: reservedUnits,
            productionRequiredUnits: stillNeededUnits,
          },
        };
      }

      outcomes.push({
        orderItemId: item.id,
        decision: derived,
        availableQuantity: kgForUnits(sku, reservedUnits),
        productionRequiredQuantity: kgForUnits(sku, stillNeededUnits),
        reservedFromLots: takenUnits.lots.map((l) => ({
          lotId: l.lotId,
          batchNumber: l.batchNumber,
          quantityKg: kgForUnits(sku, l.units),
        })),
      });
      writes.add(item.id);
      continue;
    }

    // ── Legacy kilogram lines ──────────────────────────────────────────────
    const demand = roundKg(Math.max(0, item.quantityKg - item.deliveredQty));

    if (auto) {
      // Legacy lines can no longer be created; the automatic mode only re-derives their
      // decision from what they already hold and leaves their reservations alone.
      const held = await reservedForItem(tx, item.id);
      const stillNeeded = roundKg(Math.max(0, demand - held));
      const outcome: Outcome = {
        orderItemId: item.id,
        decision: decisionFor(stillNeeded, held) as PreparationDecision,
        availableQuantity: held,
        productionRequiredQuantity: stillNeeded,
        reservedFromLots: [],
      };
      if (
        outcome.decision !== stale.preparationDecision ||
        stale.availableQuantity === null || !kgEqual(stale.availableQuantity, held) ||
        stale.productionRequiredQuantity === null || !kgEqual(stale.productionRequiredQuantity, stillNeeded)
      ) writes.add(item.id);
      outcomes.push(outcome);
      continue;
    }

    // Re-reviewing an item starts from a clean slate: hand back what it holds, then take a
    // fresh reservation against the shelf as it stands now.
    await releaseShelfStock(tx, item.id);

    if (p.decision === "Blocked") {
      outcomes.push({
        orderItemId: item.id,
        decision: "Blocked",
        availableQuantity: 0,
        productionRequiredQuantity: demand,
        reservedFromLots: [],
      });
      writes.add(item.id);
      continue;
    }

    const taken = await reserveShelfStock(tx, item, demand, actor.id);
    const reserved = taken.reservedKg;
    const stillNeeded = roundKg(Math.max(0, demand - reserved));
    const derived = decisionFor(stillNeeded, reserved) as PreparationDecision;

    if (p.decision !== null && p.decision !== derived) {
      throw {
        _appCode: 409,
        message:
          `Item ${item.id}: "${p.decision}" is not supported by stock. ` +
          `${reserved}kg of ${demand}kg can be covered from the shelf, so the decision is "${derived}".`,
        computed: { orderItemId: item.id, decision: derived, availableQuantity: reserved, productionRequiredQuantity: stillNeeded },
      };
    }
    if (p.availableQuantity !== null && !kgEqual(p.availableQuantity, reserved)) {
      throw {
        _appCode: 409,
        message: `Item ${item.id}: availableQuantity ${p.availableQuantity}kg does not match the ${reserved}kg actually available on the shelf.`,
      };
    }
    if (p.productionRequiredQuantity !== null && !kgEqual(p.productionRequiredQuantity, stillNeeded)) {
      throw {
        _appCode: 409,
        message: `Item ${item.id}: productionRequiredQuantity ${p.productionRequiredQuantity}kg does not match the ${stillNeeded}kg that must be produced.`,
      };
    }

    outcomes.push({
      orderItemId: item.id,
      decision: derived,
      availableQuantity: reserved,
      productionRequiredQuantity: stillNeeded,
      reservedFromLots: taken.lots,
    });
    writes.add(item.id);
  }

  for (const o of outcomes) {
    if (!writes.has(o.orderItemId)) continue;
    // Compare-and-swap, not a plain update: a delivery, a packaging reservation or another
    // review that committed in between makes this match zero rows and throw, rolling back
    // every reservation made above.
    const seen = casTokens.get(o.orderItemId);
    if (!seen) throw { _appCode: 500, message: `Missing CAS token for item ${o.orderItemId}.` };
    await casUpdateOrderItem(tx, seen, {
      preparationDecision: o.decision,
      availableQuantity: o.availableQuantity,
      productionRequiredQuantity: o.productionRequiredQuantity,
    });
  }

  const refreshedItems = await tx.orderItem.findMany({
    where: { orderId: id },
    select: { preparationDecision: true },
  });
  const newStatus = aggregatePreparationStatus(refreshedItems);
  const changed = writes.size > 0 || newStatus !== order.status;

  if (auto && !changed) {
    return { skipped: false, changed: false, from: order.status, to: order.status, order: null };
  }

  // Conditional guard: a concurrent Hold/Cancel/Complete that landed between the read and this
  // write is caught here, and the transaction rolls back.
  const updateResult = await tx.order.updateMany({
    where: { id, status: { in: entry as string[] } },
    data: { status: newStatus },
  });
  if (updateResult.count === 0) {
    throw { _appCode: 409, message: "Order status changed during review. Please reload and retry." };
  }

  // ── Operational ownership (manual only) ──
  // The first successful manual Commit Allocation claims the order for whoever ran it. The
  // system claims nobody: an automatic recompute is not somebody taking the order on.
  let claimedOwnership = false;
  if (!auto && actor.id) {
    const ownerClaim = await tx.order.updateMany({
      where: { id, ownerId: null },
      data: { ownerId: actor.id },
    });
    claimedOwnership = ownerClaim.count === 1;
  }

  await appendOrderActivity(tx, {
    orderId: id,
    type: "PREPARATION_REVIEWED",
    message: auto
      ? `Preparation recomputed automatically (${input.trigger ?? "event"}). Order status ${newStatus}.`
      : `Preparation review submitted by ${actor.name} for ${parsedItems.length} item(s). ` +
        `Order status set to ${newStatus}.` +
        (claimedOwnership ? ` Order claimed by ${actor.name}.` : ""),
    department: "Preparation",
    authorId: actor.id,
    authorName: auto ? "System" : actor.name,
    metadata: {
      ...(auto ? { automatic: true, trigger: input.trigger ?? null } : {}),
      items: outcomes.map((o) => ({
        orderItemId: o.orderItemId,
        decision: o.decision,
        availableQuantity: o.availableQuantity,
        productionRequiredQuantity: o.productionRequiredQuantity,
        reservedFromLots: o.reservedFromLots,
      })),
    },
  });

  const note = input.note?.trim() ?? "";
  if (!auto && note) {
    await appendOrderActivity(tx, {
      orderId: id,
      type: "MANUAL_NOTE",
      message: note,
      department: "Preparation",
      authorId: actor.id,
      authorName: actor.name,
    });
  }

  // A re-review that lands on the same status is not news to anyone outside. The payload keeps
  // its two fields; `automatic` and `trigger` are additive.
  // feat/wa-status-rules: the recompute's events are kept but produce no WhatsApp message.
  const silent = input.trigger === "recompute";
  if (newStatus !== order.status) {
    await emitAutomationEvent(tx, {
      eventType: "order.status_changed",
      subjectType: "Order",
      subjectId: id,
      payload: auto
        ? { from: order.status, to: newStatus, automatic: true, trigger: input.trigger ?? null, ...(silent ? { silent: true } : {}) }
        : { from: order.status, to: newStatus },
      actorId: actor.id,
    });
  }
  // «بانتظار الإنتاج» for the order as a whole: announced when the order STARTS needing production
  // (no line did before this review, one does now) — not again while it keeps needing it.
  if (!orderNeedsProduction(order.items) && orderNeedsProduction(refreshedItems)) {
    await emitAutomationEvent(tx, {
      eventType: "order.progress_changed",
      subjectType: "Order",
      subjectId: id,
      payload: { from: null, to: "pending_production", automatic: auto, trigger: input.trigger ?? null, ...(silent ? { silent: true } : {}) },
      actorId: actor.id,
    });
  }

  const result = await tx.order.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      items: {
        select: { id: true, preparationDecision: true, availableQuantity: true, productionRequiredQuantity: true },
      },
    },
  });
  return { skipped: false, changed: true, from: order.status, to: newStatus, order: result };
}

const RETRYABLE_PRISMA = new Set(["P2034", "P2028"]);

function isRetryable(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { _appCode?: number; code?: string; message?: string };
  if (e._appCode === 409) return true;
  if (e.code && RETRYABLE_PRISMA.has(e.code)) return true;
  return typeof e.message === "string" && /deadlock detected|could not serialize/i.test(e.message);
}

/**
 * The automatic recompute, in its own transaction, after the triggering event has committed.
 *
 * Best-effort by design: the event it follows (an order, a roast, a pack, a delivery) is already
 * durable, and refusing it now would be refusing something that happened. A lost race — the
 * line moved under the compare-and-swap — is retried twice; anything else is logged and the next
 * event recomputes again. Never throws.
 *
 * Then, outside that transaction: production orders for whatever the shelf could not cover
 * (Phase C item 3), and the internal production orders that no longer have work to do.
 */
export async function autoPrepareOrder(
  orderId: string,
  trigger: PreparationTrigger,
  actor: PreparationActor,
): Promise<PreparationResult | null> {
  let result: PreparationResult | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      result = await prisma.$transaction(
        (tx) => reviewOrderPreparation(tx, { orderId, mode: "auto", actor, trigger }),
        TX_OPTS,
      );
      break;
    } catch (err) {
      if (attempt < 2 && isRetryable(err)) continue;
      console.error(`[auto-preparation] order ${orderId} after ${trigger} was not recomputed:`, err);
      return null;
    }
  }
  try {
    await rebalanceProvisionalPlans(orderId, actor);
    await autoScheduleShortfalls(orderId, actor);
    await settleProductionOrders({ orderId }, actor);
  } catch (err) {
    console.error(`[auto-preparation] production orders for ${orderId} were not reconciled:`, err);
  }
  return result;
}

/** Recompute several orders, oldest first — so freed shelf stock goes to the oldest order. */
export async function autoPrepareOrders(
  orderIds: Iterable<string>,
  trigger: PreparationTrigger,
  actor: PreparationActor,
): Promise<void> {
  const ids = [...new Set(orderIds)].filter(Boolean);
  if (ids.length === 0) return;
  const ordered = await prisma.order.findMany({
    where: { id: { in: ids }, status: { in: [...AUTO_PREPARATION_STATUSES] } },
    select: { id: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  for (const o of ordered) await autoPrepareOrder(o.id, trigger, actor);
}

/**
 * Open orders that could use units of these SKUs: preparable status, a non-Blocked line of the
 * SKU still short of its demand. Oldest first. Used after packaging, whose fresh units may cover
 * orders other than the one the roast was made for.
 */
export async function ordersWaitingForSkus(skuIds: Iterable<string>, limit = 50): Promise<string[]> {
  const ids = [...new Set(skuIds)].filter(Boolean);
  if (ids.length === 0) return [];
  const rows = await prisma.orderItem.findMany({
    where: {
      productSkuId: { in: ids },
      quantityUnits: { not: null },
      OR: [{ preparationDecision: null }, { preparationDecision: { in: ["Needs Production", "Partially Available"] } }],
      order: { status: { in: [...AUTO_PREPARATION_STATUSES] } },
    },
    select: { orderId: true, order: { select: { createdAt: true } } },
    orderBy: [{ order: { createdAt: "asc" } }, { orderId: "asc" }],
    take: limit * 4,
  });
  return [...new Set(rows.map((r) => r.orderId))].slice(0, limit);
}

// ─── Auto-close (owner decision O2) ─────────────────────────────────────────

/**
 * Close the order when the delivery just recorded fulfilled it — inside the delivery
 * transaction, after its late barrier has locked the Order row.
 *
 * completionRefusal is the same gate the manual «complete» uses: every line delivered exactly,
 * and no live reservation. A reservation still attached means the order is NOT auto-closed (it
 * stays open for a supervisor, exactly as the manual gate would refuse it). The reads take no
 * locks; they run after the delivery's allocation, lot, line and Order locks, and every writer
 * that could add a reservation to this order has to write this Order row (or re-check its status
 * under its lock) before it commits, so it waits here and then sees Completed.
 */
export async function autoCloseAfterDelivery(
  tx: PrismaTx,
  orderId: string,
  actor: PreparationActor,
  trigger: "delivery" | "release_recompute" = "delivery",
): Promise<boolean> {
  const order = await tx.order.findUnique({ where: { id: orderId }, select: { status: true } });
  if (!order || !(DELIVERY_ALLOWED_STATUSES as string[]).includes(order.status)) return false;

  const lines = await tx.orderItem.findMany({
    where: { orderId },
    select: { quantityUnits: true, deliveredUnits: true, quantityKg: true, deliveredQty: true },
  });
  const held = await tx.stockAllocation.aggregate({
    where: { orderItem: { orderId }, status: "RESERVED" },
    _count: { _all: true },
    _sum: { quantityUnits: true, quantityKg: true },
  });
  const refusal = completionRefusal(lines, {
    rows: held._count._all,
    units: held._sum.quantityUnits ?? 0,
    kg: held._sum.quantityKg ?? 0,
  });
  if (refusal) return false;

  const updated = await tx.order.updateMany({
    where: { id: orderId, status: { in: DELIVERY_ALLOWED_STATUSES as string[] } },
    data: { status: "Completed" },
  });
  if (updated.count === 0) return false;

  await appendOrderActivity(tx, {
    orderId,
    type: "ORDER_COMPLETED",
    message: "Order completed automatically: every line is delivered in full and nothing remains reserved.",
    authorId: actor.id,
    authorName: "System",
    metadata: { automatic: true, trigger },
  });
  await emitAutomationEvent(tx, {
    eventType: "order.status_changed",
    subjectType: "Order",
    subjectId: orderId,
    payload: { from: order.status, to: "Completed", reason: null, automatic: true, trigger, ...(trigger === "release_recompute" ? { silent: true } : {}) },
    actorId: actor.id,
  });
  return true;
}

/**
 * After a batch event (roast, QC decision, pack): recompute the orders the batches were made
 * for, then — when packaging produced units of some SKUs — every other open order still short
 * of those SKUs, oldest first. Finally settle the production orders those batches belong to.
 */
export async function autoPrepareAfterBatches(
  batchIds: string[],
  trigger: PreparationTrigger,
  actor: PreparationActor,
  opts: { producedSkuIds?: string[] } = {},
): Promise<void> {
  try {
    const rows = batchIds.length === 0 ? [] : await prisma.roastingBatch.findMany({
      where: { id: { in: batchIds } },
      select: { productionOrderId: true, orderItem: { select: { orderId: true } } },
    });
    const orderIds = rows.map((r) => r.orderItem?.orderId).filter((x): x is string => !!x);
    const waiting = opts.producedSkuIds?.length ? await ordersWaitingForSkus(opts.producedSkuIds) : [];
    await autoPrepareOrders([...orderIds, ...waiting], trigger, actor);
    const poIds = [...new Set(rows.map((r) => r.productionOrderId).filter((x): x is string => !!x))];
    if (poIds.length) await settleProductionOrders({ productionOrderIds: poIds }, actor);
  } catch (err) {
    console.error(`[auto-preparation] after ${trigger}:`, err);
  }
}
