import { NextResponse } from "next/server";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireModule, requireSub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import {
  readDeliveryRequestKey,
  normalizeDeliveryIntent,
  deliveryIntentHash,
  type DeliveryIntent,
} from "@/lib/services/delivery-idempotency";
import { recalcOrderItemStatus } from "@/lib/services/order-fulfillment";
import { consumeShelfStock, lotMatchFilter, roundKg, trimReservationToDemand } from "@/lib/services/shelf-allocation";
import { consumeFinishedUnits, kgForUnits, trimUnitReservationToDemand } from "@/lib/services/finished-products";
import {
  DELIVERY_ALLOWED_STATUSES,
  isDeliveryAllowedFrom,
  lockDeliveryResources,
  assertOrderStillAcceptsDelivery,
  type OrderStatus,
} from "@/lib/services/order-operations";

export async function GET() {
  const { error } = await requireModule("dispatch");
  if (error) return error;

  const deliveries = await prisma.delivery.findMany({
    orderBy: { date: "desc" },
    take: 500,
    include: {
      orderItem: { include: { order: { include: { customer: true } } } },
    },
  });
  return NextResponse.json(deliveries);
}

const IDEMPOTENCY_MISMATCH =
  "This Idempotency-Key has already been used for a different dispatch. Use a new key for " +
  "a new dispatch, or resend the original request unchanged.";

/** Only the requestKey index converts a conflict into a replay; anything else is an error. */
function isRequestKeyConflict(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; meta?: { target?: unknown } };
  if (e.code !== "P2002") return false;
  const target = e.meta?.target;
  const fields = Array.isArray(target) ? target.map(String) : [String(target ?? "")];
  return fields.some((f) => f === "requestKey" || f.includes("Delivery_requestKey_key"));
}

/** A replay carries the original row; a fresh dispatch is created. 200 vs 201 says which. */
type DeliveryOutcome = { delivery: unknown; replayed: boolean };

export async function POST(request: Request) {
  // Authorization first, before the key is even read: possession of an Idempotency-Key
  // is not authority, and an unauthorized caller must not be able to learn whether one
  // exists by watching the status change.
  const { error, user } = await requireSub("dispatch", "mark_delivered");
  if (error) return error;

  const keyResult = readDeliveryRequestKey(request);
  if (!keyResult.ok) return NextResponse.json({ error: keyResult.message }, { status: 400 });
  const requestKey = keyResult.key;

  let data: Record<string, unknown>;
  try { data = (await request.json()) as Record<string, unknown>; } catch { data = {}; }

  const normalized = normalizeDeliveryIntent(data);
  if (!normalized.ok) return NextResponse.json({ error: normalized.message }, { status: 400 });
  const intent: DeliveryIntent = normalized.intent;
  const intentHash = deliveryIntentHash(intent);

  // Everything below reads the canonical intent, never the raw body — the values that are
  // hashed are the values that get executed and persisted.
  const { orderItemId, finishedGoodsLotId, deliveryType, notes } = intent;

  // ── Fast replay probe ───────────────────────────────────────────────────
  // An optimisation, not the concurrency control: it spares the ordinary retry from
  // taking any locks. Two requests can still both miss it, which is what the post-lock
  // probe and the unique index below are for.
  const alreadyDone = await prisma.delivery.findUnique({ where: { requestKey } });
  if (alreadyDone) {
    if (alreadyDone.intentHash !== intentHash) {
      return NextResponse.json({ error: IDEMPOTENCY_MISMATCH }, { status: 422 });
    }
    return NextResponse.json(alreadyDone, { status: 200 });
  }

  try {
    const outcome: DeliveryOutcome = await prisma.$transaction(async (tx) => {
      const orderItem = await tx.orderItem.findUnique({
        where: { id: orderItemId },
        include: {
          productSku: { select: { id: true, skuCode: true, weightGrams: true } },
          order: { select: { status: true } },
        },
      });
      if (!orderItem) throw { _appCode: 404, message: "Order item not found" };

      // ── Canonical lock order ──────────────────────────────────────────────
      // This route used to claim the OrderItem first and only then consume allocations and
      // the lot, which is OrderItem → ALLOC — the exact reverse of preparation review, and
      // a deadlock whenever a dispatcher shipped a line while preparation re-reviewed the
      // same order. Taking the allocation and lot locks here, before the claim, puts
      // dispatch on the shared ALLOC → OrderItem → Order order.
      //
      // Scoped to this line and this lot rather than the whole order, so two lines of one
      // order can still be dispatched at the same time.
      await lockDeliveryResources(tx, orderItemId, finishedGoodsLotId);

      // ── Post-lock replay probe ──────────────────────────────────────────
      // Mandatory, and it must run BEFORE any state-dependent rejection.
      //
      // Two identical requests can both pass the fast probe. One wins the lot lock; the
      // other waits. When the winner commits, the loser is granted the lock and — under
      // READ COMMITTED, where each statement takes a fresh snapshot — its next statement
      // sees the winner's committed Delivery. Without this probe the loser would instead
      // walk into the outstanding-quantity check, find nothing left to ship because the
      // winner just shipped it, and return 409: a retry of a dispatch that succeeded,
      // told it failed. The lot is always locked by both (it is part of the intent), so
      // this ordering is guaranteed rather than hoped for.
      const committed = await tx.delivery.findUnique({ where: { requestKey } });
      if (committed) {
        if (committed.intentHash !== intentHash) {
          throw { _appCode: 422, message: IDEMPOTENCY_MISMATCH };
        }
        return { delivery: committed, replayed: true };
      }

      // Shipping is an order-level decision, not a line-level one. Without this check the
      // route would record a delivery against any order at all: one still Waiting Approval,
      // one a manager put On Hold, one already Cancelled or Rejected. Coffee physically
      // leaves the shelf in every case, and for a cancelled order it leaves against
      // reservations the cancellation has already handed back — so the same units can be
      // promised to somebody else and shipped here at the same time.
      if (!isDeliveryAllowedFrom(orderItem.order.status as OrderStatus)) {
        throw {
          _appCode: 409,
          message: `Cannot record a delivery for an order in status "${orderItem.order.status}". Only ${DELIVERY_ALLOWED_STATUSES.map((s) => `"${s}"`).join(" or ")} orders can be dispatched.`,
        };
      }

      // Blocking a line is the operator saying this item cannot be prepared. It receives no
      // allocation and it holds the order out of Ready for Shipping — but the order itself
      // stays in "Preparing", which the status check above allows, so without this a blocked
      // line on an otherwise live order could still be dispatched. Line-level, because
      // blocking is a line-level decision.
      if (orderItem.preparationDecision === "Blocked") {
        throw {
          _appCode: 409,
          message: "Cannot record a delivery for a blocked line. Unblock it in preparation first.",
        };
      }

      // ── SKU lines ship whole units ────────────────────────────────────────
      // The kilogram path below draws on availableQty/reservedQty, which stay at 0 on a
      // unit-tracked lot — so it could never ship a SKU line at all, and the units the
      // preparation review had reserved would sit there forever. Everything here is in
      // units; quantityKg is written alongside as the derived equivalent, because the
      // ledger, recalcOrderItemStatus and every dispatch report read it.
      if (orderItem.quantityUnits !== null && orderItem.productSku) {
        const sku = orderItem.productSku;
        // The axis is decided by the line, not by the caller. An irrelevant field is
        // refused rather than ignored: two bodies describing one dispatch would otherwise
        // hash differently and defeat the key.
        if (intent.quantityUnits === null) {
          throw {
            _appCode: 400,
            message: `"${sku.skuCode}" is sold in units, so this dispatch needs quantityUnits, not quantityKg.`,
          };
        }
        const units = intent.quantityUnits;

        const outstandingUnits = orderItem.quantityUnits - orderItem.deliveredUnits;
        if (outstandingUnits <= 0) {
          throw { _appCode: 400, message: "This order item has already been delivered in full." };
        }
        if (units > outstandingUnits) {
          throw {
            _appCode: 400,
            message: `Cannot deliver ${units} unit(s). Only ${outstandingUnits} of this line is still undelivered.`,
          };
        }

        const lot = await tx.finishedGoodsLot.findUnique({
          where: { id: finishedGoodsLotId },
          select: { id: true, productSkuId: true, isUnitTracked: true },
        });
        if (!lot) throw { _appCode: 404, message: "Finished goods lot not found." };
        if (!lot.isUnitTracked || lot.productSkuId !== sku.id) {
          throw {
            _appCode: 409,
            message: `Selected lot does not hold units of ${sku.skuCode}.`,
          };
        }

        const shippedKg = kgForUnits(sku, units);

        // The claim, and the first write of the transaction: the unique index on
        // requestKey is the final arbiter for two requests that both passed the probes,
        // and placing it before any consumption means the loser aborts having spent
        // nothing.
        const newDelivery = await tx.delivery.create({
          data: {
            orderItemId, quantityUnits: units, quantityKg: shippedKg, deliveryType, notes,
            requestKey, intentHash,
          },
        });

        // Conditional increment, same reasoning as the kilogram path: the outstanding
        // check above was an unlocked read, so two dispatchers could both pass it.
        const claimed = await tx.orderItem.updateMany({
          where: { id: orderItemId, deliveredUnits: { lte: orderItem.quantityUnits - units } },
          data: { deliveredUnits: { increment: units }, deliveredQty: { increment: shippedKg } },
        });
        if (claimed.count === 0) {
          throw {
            _appCode: 409,
            message: "This order item was delivered by someone else while this delivery was being recorded. Please reload and retry.",
          };
        }

        const updated = await tx.orderItem.findUniqueOrThrow({
          where: { id: orderItemId },
          select: { deliveredUnits: true, quantityUnits: true },
        });
        await tx.orderItem.update({
          where: { id: orderItemId },
          data: {
            deliveryStatus:
              (updated.quantityUnits ?? 0) - updated.deliveredUnits <= 0 ? "Delivered" : "Partial Delivered",
          },
        });

        const shipped = await consumeFinishedUnits(tx, orderItem, finishedGoodsLotId, units, user.id);
        if (!shipped) {
          throw {
            _appCode: 409,
            message: "Insufficient free units on the selected lot — they may be reserved for another order.",
          };
        }

        await tx.finishedGoodsLot.update({
          where: { id: finishedGoodsLotId },
          data: { status: shipped.newUnits <= 0 ? "SHIPPED" : "AVAILABLE" },
        });

        await tx.inventoryMovement.create({
          data: {
            type: "OUT",
            category: "FINISHED_GOODS",
            referenceEntityId: finishedGoodsLotId,
            quantityChanged: -shippedKg,
            previousQuantity: kgForUnits(sku, shipped.previousUnits),
            newQuantity: kgForUnits(sku, shipped.newUnits),
            sourceDocType: "DELIVERY",
            sourceDocId: newDelivery.id,
            userId: user.id,
            notes: `${units} x ${sku.skuCode}`,
          },
        });

        // Hand back units this line no longer needs — it may hold reservations on lots
        // this shipment never touched.
        await trimUnitReservationToDemand(tx, {
          id: orderItemId,
          quantityUnits: updated.quantityUnits ?? 0,
          deliveredUnits: updated.deliveredUnits,
        });

        await recalcOrderItemStatus(orderItemId, tx);

        // Late lifecycle barrier for the unit path — same reasoning as the kilogram path
        // below. Both branches return their own delivery, so both need the check.
        await assertOrderStillAcceptsDelivery(tx, orderItemId);
        return { delivery: newDelivery, replayed: false };
      }

      // Same rule on the legacy axis, and the quantity is the one canonical value that was
      // hashed — rounded once, in normalizeDeliveryIntent, then persisted, delivered,
      // drawn from the lot and written to the ledger unchanged.
      if (intent.quantityKg === null) {
        throw {
          _appCode: 400,
          message: "This is a bulk kilogram line, so this dispatch needs quantityKg, not quantityUnits.",
        };
      }
      const qty = intent.quantityKg;
      if (!Number.isFinite(qty) || qty <= 0) {
        throw { _appCode: 400, message: "quantityKg must be a positive number." };
      }

      // Eligibility is a property of the SHELF, not of this order item's own roasting
      // history. The previous rule measured packaged bags of batches belonging to this
      // order item and then deducted from whichever lot the operator picked — so a new
      // order could never draw on a full shelf, while a delivery that did pass could
      // reduce a lot the check never looked at. Both halves now speak about the same
      // kilograms: the lot must actually be able to cover the shipment.
      const outstanding = +(orderItem.quantityKg - orderItem.deliveredQty).toFixed(3);
      if (outstanding <= 0) {
        throw { _appCode: 400, message: "This order item has already been delivered in full." };
      }
      if (qty > outstanding) {
        throw {
          _appCode: 400,
          message: `Cannot deliver ${qty}kg. Only ${outstanding}kg of this order item is still undelivered.`,
        };
      }

      // Validate FGL existence upfront (fail-fast, before any writes). Quantity is NOT read here;
      // it is checked atomically in the conditional update below.
      if (finishedGoodsLotId) {
        const lot = await tx.finishedGoodsLot.findUnique({
          where: { id: finishedGoodsLotId },
          select: { id: true },
        });
        if (!lot) throw { _appCode: 404, message: "Finished goods lot not found." };

        // Whether this lot may serve this order item is decided by lotMatchFilter — the
        // same predicate the reservation path uses. Restating the rule here is how the two
        // sides drifted apart once lotMatchFilter grew its green-bean tier: an order line
        // naming a bean but no product could reserve a stock lot and then be refused
        // delivery of it, stranding the coffee and deadlocking the order.
        const matches = await tx.finishedGoodsLot.findFirst({
          where: { id: finishedGoodsLotId, ...lotMatchFilter(orderItem) },
          select: { id: true },
        });

        if (!matches) {
          throw { _appCode: 409, message: "Selected finished goods lot does not match this order item." };
        }
      }

      // 1. Create delivery record — needed first so its ID is available for the ledger
      // The claim, before any consumption — see the unit branch.
      const newDelivery = await tx.delivery.create({
        data: { orderItemId, quantityKg: qty, deliveryType, notes, requestKey, intentHash },
      });

      // 2. Update delivery tracking on the order item.
      //    Conditional increment: the `outstanding` check above was an unlocked read, so
      //    two dispatchers submitting the same shipment at once would both pass it. The
      //    WHERE clause re-checks the ceiling at write time and the count tells us who won.
      const claimed = await tx.orderItem.updateMany({
        where: { id: orderItemId, deliveredQty: { lte: roundKg(orderItem.quantityKg - qty) } },
        data: { deliveredQty: { increment: qty } },
      });
      if (claimed.count === 0) {
        throw {
          _appCode: 409,
          message: "This order item was delivered by someone else while this delivery was being recorded. Please reload and retry.",
        };
      }
      const updatedItem = await tx.orderItem.findUniqueOrThrow({
        where: { id: orderItemId },
        select: { deliveredQty: true, quantityKg: true },
      });
      const newDeliveryStatus = updatedItem.quantityKg - updatedItem.deliveredQty <= 0
        ? "Delivered"
        : "Partial Delivered";
      await tx.orderItem.update({
        where: { id: orderItemId },
        data: { deliveryStatus: newDeliveryStatus },
      });

      // 3. Ship the kilograms off the shelf. consumeShelfStock draws down this item's own
      //    reservation first and only touches free stock for the remainder, so a delivery
      //    can never ship coffee that is promised to a different order.
      const shipped = await consumeShelfStock(tx, orderItem, finishedGoodsLotId, qty, user.id);
      if (!shipped) {
        throw {
          _appCode: 409,
          message: "Insufficient free quantity on the selected finished goods lot — it may be reserved for another order.",
        };
      }

      const newLotStatus = shipped.newQuantity <= 0 ? "SHIPPED" : "AVAILABLE";
      await tx.finishedGoodsLot.update({
        where: { id: finishedGoodsLotId },
        data: { status: newLotStatus },
      });

      await tx.inventoryMovement.create({
        data: {
          type: "OUT",
          category: "FINISHED_GOODS",
          referenceEntityId: finishedGoodsLotId,
          quantityChanged: -qty,
          previousQuantity: shipped.previousQuantity,
          newQuantity: shipped.newQuantity,
          sourceDocType: "DELIVERY",
          sourceDocId: newDelivery.id,
          userId: user.id,
          notes: null,
        },
      });

      // 4. Hand back any promise this item no longer needs. An item may hold reservations
      //    on several lots while a delivery draws on only one of them; without this the
      //    leftovers stay promised to an order that is already satisfied, and the coffee
      //    behind them is invisible to every other order forever.
      await trimReservationToDemand(tx, {
        ...orderItem,
        deliveredQty: updatedItem.deliveredQty,
      });

      // 5. Recalculate productionStatus + remainingQty (reads the new deliveredQty committed above)
      await recalcOrderItemStatus(orderItemId, tx);

      // 6. Late lifecycle barrier — the last acquisition, after ALLOC and OrderItem.
      // The order-status check at the top of this transaction read through an unlocked
      // nested select, so a cancellation committing while this delivery was in flight was
      // invisible to it and the shipment went out against a dead order. This locks the
      // Order row and re-reads the status as of now; a cancel that got there first is seen
      // here and the rollback takes the delivery row, the delivered units, the allocation
      // consumption and the lot decrement with it.
      await assertOrderStillAcceptsDelivery(tx, orderItemId);

      return { delivery: newDelivery, replayed: false };
    }, TX_OPTS);

    return NextResponse.json(outcome.delivery, { status: outcome.replayed ? 200 : 201 });
  } catch (err: unknown) {
    if (err && typeof err === "object" && "_appCode" in err) {
      const e = err as { _appCode: number; message: string };
      return NextResponse.json({ error: e.message }, { status: e._appCode });
    }

    // ── The unique index had the last word ────────────────────────────────
    // Two requests passed both probes and both reached the insert. One committed; this
    // one lost the race on Delivery_requestKey_key and its transaction has rolled back
    // in full — no delivery, no claimed quantity, no stock drawn, no ledger row. The
    // winner is now committed and readable, so the correct answer is the replay the
    // caller was asking for.
    //
    // Narrowed to THIS index on purpose: any other uniqueness failure is a real error
    // and must not be laundered into a successful-looking replay.
    if (isRequestKeyConflict(err)) {
      const winner = await prisma.delivery.findUnique({ where: { requestKey } });
      if (winner) {
        if (winner.intentHash !== intentHash) {
          return NextResponse.json({ error: IDEMPOTENCY_MISMATCH }, { status: 422 });
        }
        return NextResponse.json(winner, { status: 200 });
      }
      // The row that caused the conflict is gone — a concurrent delete, or a rollback
      // between the conflict and this read. Retryable, and emphatically NOT a second
      // unguarded dispatch.
      return NextResponse.json(
        { error: "This dispatch could not be confirmed. Please retry with the same request." },
        { status: 503 }
      );
    }

    return handlePrismaError(err);
  }
}
