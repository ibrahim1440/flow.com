import { flushPostings } from "@/lib/accounting/ops/cost-ledger";
import { onDelivery } from "@/lib/accounting/ops/inventory-events";
import { productionLocation, setStockLocation } from "@/lib/services/stock-locations";
import { autoCloseAfterDelivery, autoPrepareOrder } from "@/lib/services/orders/preparation";
import { settleProductionOrders } from "@/lib/services/production-schedule";
import { assertLotsNotHeld } from "@/lib/services/qc/hold-guard";
import { NextResponse } from "@/lib/api-response";
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
  kgCandidateLotIds, kgPlanCandidates, planDispatch, splitKg, unitCandidateLotIds, unitPlanCandidates, withDeliveryLots,
} from "@/lib/services/delivery-lots";
import {
  DELIVERY_ALLOWED_STATUSES,
  isDeliveryAllowedFrom,
  lockDeliveryResources,
  assertOrderStillAcceptsDelivery,
  type OrderStatus,
} from "@/lib/services/order-operations";
import { emitAutomationEvent } from "@/lib/automation/emit";
import { draftOnDelivery } from "@/lib/services/invoicing/service";
import { emitDeliveryProgress } from "@/lib/services/orders/progress-events";
import { canSeeCustomerContact, CUSTOMER_DELIVERY_SELECT } from "@/lib/auth/customer-detail";
import { settlePicksOnDelivery } from "@/lib/services/station/prep-settle";

export async function GET() {
  const { user, error } = await requireModule("dispatch");
  if (error) return error;
  // F4 / review F-1: only dispatch holders reach this list, and they get the customer's name
  // only — no phone, email or address (a dispatch holder may also be production/QC/packaging).
  // The full record goes only to holders of the customer contact right (customers module).
  const customerContact = canSeeCustomerContact(user.permissions);

  const deliveries = await prisma.delivery.findMany({
    orderBy: { date: "desc" },
    take: 500,
    include: {
      orderItem: { include: { order: { include: { customer: customerContact ? true : { select: CUSTOMER_DELIVERY_SELECT } } } } },
    },
  });
  // Phase D: each row also carries `lots` — its DeliveryLine rows, or for a delivery recorded
  // before them, the single lot its ledger row names.
  return NextResponse.json(await withDeliveryLots(prisma, deliveries));
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
type DeliveryOutcome = { delivery: { id: string }; replayed: boolean; orderId?: string; closed?: boolean };

/**
 * The response is the Delivery row as before, plus `lots`: which lots it drew from (read-only
 * detail for the dispatcher, Phase D). A replay answers with the same lots as the original.
 */
async function withLines<T extends { id: string }>(delivery: T) {
  const [row] = await withDeliveryLots(prisma, [delivery]);
  return row;
}

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
  const { orderItemId, finishedGoodsLotId, notes } = intent;

  // ── Fast replay probe ───────────────────────────────────────────────────
  // An optimisation, not the concurrency control: it spares the ordinary retry from
  // taking any locks. Two requests can still both miss it, which is what the post-lock
  // probe and the unique index below are for.
  const alreadyDone = await prisma.delivery.findUnique({ where: { requestKey } });
  if (alreadyDone) {
    if (alreadyDone.intentHash !== intentHash) {
      return NextResponse.json({ error: IDEMPOTENCY_MISMATCH }, { status: 422 });
    }
    return NextResponse.json(await withLines(alreadyDone), { status: 200 });
  }

  try {
    const outcome: DeliveryOutcome = await prisma.$transaction(async (tx) => {
      // Phase 3 (stock locations): a dispatch ships from the production site, where the finished lots are
      // (Delivery.locationId and its movements take it; finished lots are not moved between sites yet).
      await setStockLocation(tx, (await productionLocation(tx)).id);
      const orderItem = await tx.orderItem.findUnique({
        where: { id: orderItemId },
        include: {
          productSku: { select: { id: true, skuCode: true, weightGrams: true } },
          order: { select: { status: true } },
        },
      });
      if (!orderItem) throw { _appCode: 404, message: "Order item not found" };

      const unitLine = orderItem.quantityUnits !== null && !!orderItem.productSku;

      // ── Which lots this dispatch may touch ───────────────────────────────
      // A named lot (the request shape before Phase D) is the only one. A lot-less dispatch may
      // draw from every lot of the line's coffee that still holds stock, plus the lots the line
      // holds a reservation on — the server picks among them below. Read unlocked: this is only
      // the set to lock; every balance is re-read after the locks are held.
      const lockSet: string[] = finishedGoodsLotId
        ? [finishedGoodsLotId]
        : unitLine
        ? await unitCandidateLotIds(tx, orderItemId, orderItem.productSku!.id)
        : await kgCandidateLotIds(tx, orderItem);

      // ── Canonical lock order ──────────────────────────────────────────────
      // StockAllocation → FinishedGoodsLot (id ASC) → OrderItem → Order, the shared order of
      // every lifecycle transaction (order-operations.ts). The allocation and lot locks are
      // taken here, before the claim on the OrderItem, so dispatch never reaches backwards for
      // a lot while holding the line — whether it ships from one lot or from several. Scoped to
      // this line and its lots rather than the whole order, so two lines of one order can still
      // be dispatched at the same time.
      await lockDeliveryResources(tx, orderItemId, lockSet);

      // ── Post-lock replay probe ──────────────────────────────────────────
      // Mandatory, and before any state-dependent rejection: a retry that waited on the
      // winner's locks must be told the dispatch happened, not that nothing is left to ship.
      // A named-lot retry always shares that lot with the winner; a lot-less retry shares the
      // line's reservations and shelf lots, and in the worst case reaches the unique index on
      // requestKey, which converts the conflict into the same replay below.
      const committed = await tx.delivery.findUnique({ where: { requestKey } });
      if (committed) {
        if (committed.intentHash !== intentHash) {
          throw { _appCode: 422, message: IDEMPOTENCY_MISMATCH };
        }
        return { delivery: committed, replayed: true };
      }

      // Shipping is an order-level decision, not a line-level one: never against an order
      // still Waiting Approval, On Hold, Cancelled or Rejected.
      if (!isDeliveryAllowedFrom(orderItem.order.status as OrderStatus)) {
        throw {
          _appCode: 409,
          message: `Cannot record a delivery for an order in status "${orderItem.order.status}". Only ${DELIVERY_ALLOWED_STATUSES.map((s) => `"${s}"`).join(" or ")} orders can be dispatched.`,
        };
      }

      // A blocked line receives no allocation and must not ship either.
      if (orderItem.preparationDecision === "Blocked") {
        throw {
          _appCode: 409,
          message: "Cannot record a delivery for a blocked line. Unblock it in preparation first.",
        };
      }

      // ── SKU lines ship whole units ────────────────────────────────────────
      if (unitLine) {
        const sku = orderItem.productSku!;
        // The axis is decided by the line, not by the caller.
        if (intent.quantityUnits === null) {
          throw {
            _appCode: 400,
            message: `"${sku.skuCode}" is sold in units, so this dispatch needs quantityUnits, not quantityKg.`,
          };
        }
        const units = intent.quantityUnits;

        // Over-delivery guard (read): the conditional increment below is the enforcement.
        const outstandingUnits = (orderItem.quantityUnits ?? 0) - orderItem.deliveredUnits;
        if (outstandingUnits <= 0) {
          throw { _appCode: 400, message: "This order item has already been delivered in full." };
        }
        if (units > outstandingUnits) {
          throw {
            _appCode: 400,
            message: `Cannot deliver ${units} unit(s). Only ${outstandingUnits} of this line is still undelivered.`,
          };
        }

        // ── The lots, and how much from each ───────────────────────────────
        let plan: { lotId: string; units: number }[];
        if (finishedGoodsLotId) {
          const lot = await tx.finishedGoodsLot.findUnique({
            where: { id: finishedGoodsLotId },
            select: { id: true, productSkuId: true, isUnitTracked: true },
          });
          if (!lot) throw { _appCode: 404, message: "Finished goods lot not found." };
          if (!lot.isUnitTracked || lot.productSkuId !== sku.id) {
            throw { _appCode: 409, message: `Selected lot does not hold units of ${sku.skuCode}.` };
          }
          plan = [{ lotId: finishedGoodsLotId, units }];
        } else {
          const picked = planDispatch(await unitPlanCandidates(tx, orderItemId, sku.id, lockSet), units);
          if (picked.covered < units) {
            throw {
              _appCode: 409,
              message: `Only ${picked.ready} unit(s) of ${sku.skuCode} are ready to ship for this line (its reservations plus free stock). Nothing was delivered.`,
            };
          }
          plan = picked.lots.map((l) => ({ lotId: l.lotId, units: l.quantity }));
        }
        // QC W3: nothing packed from a held batch ships (hold-guard.ts).
        await assertLotsNotHeld(tx, plan.map((p) => p.lotId), "deliver");

        const shippedKg = kgForUnits(sku, units);

        // The claim, and the first write of the transaction: the unique index on requestKey is
        // the final arbiter for two requests that both passed the probes. The type is
        // provisional until the claim below says whether this dispatch completes the line.
        const newDelivery = await tx.delivery.create({
          data: {
            orderItemId, quantityUnits: units, quantityKg: shippedKg,
            deliveryType: units >= outstandingUnits ? "full" : "partial", notes,
            requestKey, intentHash,
          },
        });

        // Over-delivery guard (write): conditional increment, so two dispatchers that both
        // passed the unlocked outstanding check cannot both ship.
        const claimed = await tx.orderItem.updateMany({
          where: { id: orderItemId, deliveredUnits: { lte: (orderItem.quantityUnits ?? 0) - units } },
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
        const lineDone = (updated.quantityUnits ?? 0) - updated.deliveredUnits <= 0;
        await tx.orderItem.update({
          where: { id: orderItemId },
          data: { deliveryStatus: lineDone ? "Delivered" : "Partial Delivered" },
        });
        // Derived from the quantity, never taken from the caller: full = this dispatch
        // completed the line.
        const derivedType = lineDone ? "full" : "partial";
        const delivery = derivedType === newDelivery.deliveryType
          ? newDelivery
          : await tx.delivery.update({ where: { id: newDelivery.id }, data: { deliveryType: derivedType } });

        // ── Ship lot by lot: reservation first, then free units (consumeFinishedUnits) ──
        const kgShares = splitKg(shippedKg, plan.map((p) => kgForUnits(sku, p.units)));
        const lines: { lotId: string; batchNumber: string; units: number; kg: number }[] = [];
        const costLines: { lotId: string; kg: number; emptied: boolean; units: number; unitsBefore: number }[] = [];
        for (const [i, p] of plan.entries()) {
          const shipped = await consumeFinishedUnits(tx, orderItem, p.lotId, p.units, user.id);
          if (!shipped) {
            throw {
              _appCode: 409,
              message: finishedGoodsLotId
                ? "Insufficient free units on the selected lot — they may be reserved for another order."
                : "The ready units changed while this delivery was being recorded. Please reload and retry.",
            };
          }
          const lot = await tx.finishedGoodsLot.update({
            where: { id: p.lotId },
            data: { status: shipped.newUnits <= 0 ? "SHIPPED" : "AVAILABLE" },
            select: { batchNumber: true },
          });
          // One ledger row per lot: the inventory ledger records every lot this dispatch drew on.
          await tx.inventoryMovement.create({
            data: {
              type: "OUT",
              category: "FINISHED_GOODS",
              referenceEntityId: p.lotId,
              quantityChanged: -kgShares[i],
              previousQuantity: kgForUnits(sku, shipped.previousUnits),
              newQuantity: kgForUnits(sku, shipped.newUnits),
              sourceDocType: "DELIVERY",
              sourceDocId: delivery.id,
              userId: user.id,
              notes: `${p.units} x ${sku.skuCode}`,
            },
          });
          lines.push({ lotId: p.lotId, batchNumber: lot.batchNumber, units: p.units, kg: kgShares[i] });
          costLines.push({ lotId: p.lotId, kg: kgShares[i], emptied: shipped.newUnits <= 0, units: p.units, unitsBefore: shipped.previousUnits });
        }
        // Accounting A3: COGS at each lot's cost (Dr COGS · customer / Cr INVENTORY_PACKED), with the delivery.
        await onDelivery(tx, { deliveryId: delivery.id, lines: costLines, actor: user.id });
        // Traceability (gap G09): which lots, how much from each. Sums equal the Delivery.
        await tx.deliveryLine.createMany({
          data: lines.map((l) => ({ deliveryId: delivery.id, finishedGoodsLotId: l.lotId, quantityUnits: l.units, quantityKg: l.kg })),
        });
        // Workstations W4: the units the preparation station picked (and handed to dispatch) for this
        // line are settled by what was delivered — the handoff never moved stock; this does not either.
        await settlePicksOnDelivery(tx, { orderItemId, units, lotIds: lines.map((l) => l.lotId), deliveryId: delivery.id });

        // Hand back units this line no longer needs — it may hold reservations on lots this
        // shipment never touched.
        await trimUnitReservationToDemand(tx, {
          id: orderItemId,
          quantityUnits: updated.quantityUnits ?? 0,
          deliveredUnits: updated.deliveredUnits,
        });

        await recalcOrderItemStatus(orderItemId, tx);

        // Late lifecycle barrier: locks the Order and re-reads its status; a hold or cancel
        // that committed while this dispatch was in flight rolls all of it back.
        await assertOrderStillAcceptsDelivery(tx, orderItemId);
        await emitAutomationEvent(tx, {
          eventType: "delivery.recorded",
          subjectType: "Delivery",
          subjectId: delivery.id,
          // Backward compatible: the fields a rule could read before stay as they were; `lots`
          // is added for rules that want the traceability.
          payload: { orderItemId, units, deliveryType: derivedType, lots: lines.map((l) => ({ lotId: l.lotId, batchNumber: l.batchNumber, units: l.units, kg: l.kg })) },
          actorId: user.id,
        });
        // feat/wa-status-rules: the ORDER (not this line) became «سُلِّم جزئياً».
        await emitDeliveryProgress(tx, { orderId: orderItem.orderId, orderItemId, deliveryId: delivery.id, units, kg: shippedKg, actorId: user.id });
        // Owner decision O2 (Phase B item 8): the last delivery closes the order, in this same
        // transaction, when completionRefusal passes — never while a reservation is live.
        const closed = await autoCloseAfterDelivery(tx, orderItem.orderId, { id: user.id, name: user.name });
        // Accounting A3: the COGS entry posts last, after every row this transaction locks.
        await flushPostings(tx);
        return { delivery, replayed: false, orderId: orderItem.orderId, closed };
      }

      // ── Kilogram lines (legacy bulk) ──────────────────────────────────────
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

      let kgPlan: { lotId: string; kg: number }[];
      if (finishedGoodsLotId) {
        const lot = await tx.finishedGoodsLot.findUnique({ where: { id: finishedGoodsLotId }, select: { id: true } });
        if (!lot) throw { _appCode: 404, message: "Finished goods lot not found." };
        // lotMatchFilter is the one predicate for "may this lot serve this line" — the same one
        // the reservation path uses.
        const matches = await tx.finishedGoodsLot.findFirst({
          where: { id: finishedGoodsLotId, ...lotMatchFilter(orderItem) },
          select: { id: true },
        });
        if (!matches) {
          throw { _appCode: 409, message: "Selected finished goods lot does not match this order item." };
        }
        kgPlan = [{ lotId: finishedGoodsLotId, kg: qty }];
      } else {
        const picked = planDispatch(await kgPlanCandidates(tx, orderItem, lockSet), qty, true);
        if (picked.covered + 0.0005 < qty) {
          throw {
            _appCode: 409,
            message: `Only ${picked.ready}kg is ready to ship for this line (its reservations plus free stock). Nothing was delivered.`,
          };
        }
        kgPlan = picked.lots.map((l) => ({ lotId: l.lotId, kg: l.quantity }));
      }
      await assertLotsNotHeld(tx, kgPlan.map((p) => p.lotId), "deliver");

      // The claim, before any consumption — see the unit branch.
      const newDelivery = await tx.delivery.create({
        data: {
          orderItemId, quantityKg: qty, deliveryType: qty >= outstanding - 0.0005 ? "full" : "partial",
          notes, requestKey, intentHash,
        },
      });

      // Over-delivery guard (write).
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
      const kgLineDone = updatedItem.quantityKg - updatedItem.deliveredQty <= 0;
      await tx.orderItem.update({
        where: { id: orderItemId },
        data: { deliveryStatus: kgLineDone ? "Delivered" : "Partial Delivered" },
      });
      const kgType = kgLineDone ? "full" : "partial";
      const delivery = kgType === newDelivery.deliveryType
        ? newDelivery
        : await tx.delivery.update({ where: { id: newDelivery.id }, data: { deliveryType: kgType } });

      // Ship the kilograms lot by lot. consumeShelfStock draws down this item's own
      // reservation on the lot first and only touches free stock for the remainder.
      const kgShares = splitKg(qty, kgPlan.map((p) => p.kg));
      const kgLines: { lotId: string; batchNumber: string; kg: number }[] = [];
      const kgCostLines: { lotId: string; kg: number; emptied: boolean }[] = [];
      for (const [i, p] of kgPlan.entries()) {
        const shipped = await consumeShelfStock(tx, orderItem, p.lotId, kgShares[i], user.id);
        if (!shipped) {
          throw {
            _appCode: 409,
            message: finishedGoodsLotId
              ? "Insufficient free quantity on the selected finished goods lot — it may be reserved for another order."
              : "The ready stock changed while this delivery was being recorded. Please reload and retry.",
          };
        }
        const lot = await tx.finishedGoodsLot.update({
          where: { id: p.lotId },
          data: { status: shipped.newQuantity <= 0 ? "SHIPPED" : "AVAILABLE" },
          select: { batchNumber: true },
        });
        await tx.inventoryMovement.create({
          data: {
            type: "OUT",
            category: "FINISHED_GOODS",
            referenceEntityId: p.lotId,
            quantityChanged: -kgShares[i],
            previousQuantity: shipped.previousQuantity,
            newQuantity: shipped.newQuantity,
            sourceDocType: "DELIVERY",
            sourceDocId: delivery.id,
            userId: user.id,
            notes: null,
          },
        });
        kgLines.push({ lotId: p.lotId, batchNumber: lot.batchNumber, kg: kgShares[i] });
        kgCostLines.push({ lotId: p.lotId, kg: kgShares[i], emptied: shipped.newQuantity <= 0 });
      }
      // Accounting A3: COGS at each lot's cost, with the delivery.
      await onDelivery(tx, { deliveryId: delivery.id, lines: kgCostLines, actor: user.id });
      await tx.deliveryLine.createMany({
        data: kgLines.map((l) => ({ deliveryId: delivery.id, finishedGoodsLotId: l.lotId, quantityUnits: null, quantityKg: l.kg })),
      });

      // Hand back any promise this item no longer needs (it may hold kg on lots it never drew on).
      await trimReservationToDemand(tx, {
        ...orderItem,
        deliveredQty: updatedItem.deliveredQty,
      });

      await recalcOrderItemStatus(orderItemId, tx);

      // Late lifecycle barrier — the last acquisition, after ALLOC, lots and OrderItem.
      await assertOrderStillAcceptsDelivery(tx, orderItemId);

      await emitAutomationEvent(tx, {
        eventType: "delivery.recorded",
        subjectType: "Delivery",
        subjectId: delivery.id,
        payload: { orderItemId, kg: qty, deliveryType: kgType, lots: kgLines.map((l) => ({ lotId: l.lotId, batchNumber: l.batchNumber, units: null, kg: l.kg })) },
        actorId: user.id,
      });
      await emitDeliveryProgress(tx, { orderId: orderItem.orderId, orderItemId, deliveryId: delivery.id, units: null, kg: qty, actorId: user.id });
      const closed = await autoCloseAfterDelivery(tx, orderItem.orderId, { id: user.id, name: user.name });
      await flushPostings(tx);

      return { delivery, replayed: false, orderId: orderItem.orderId, closed };
    }, TX_OPTS);

    // Phase B item 4: an order the delivery did not close is recomputed after the commit (its
    // remaining lines' cover, and the production orders behind it); a closed one has its open
    // production orders settled.
    if (!outcome.replayed && outcome.orderId) {
      const actor = { id: user.id, name: user.name };
      if (outcome.closed) await settleProductionOrders({ orderId: outcome.orderId }, actor);
      else await autoPrepareOrder(outcome.orderId, "delivery", actor);
    }
    // Sales invoicing A2 — the invoicing point «عند التسليم» (Settings › Invoicing): what shipped opens (or extends)
    // the order's draft invoice, reviewed and issued by a person. After the commit: a failure never undoes the
    // delivery (the quantity stays on «إنشاء فاتورة من الطلب»). A no-op when the point is MANUAL (the default).
    if (!outcome.replayed) {
      await draftOnDelivery(outcome.delivery.id, user.id).catch((e: unknown) => console.error("[deliveries] invoice draft on delivery not created:", e instanceof Error ? e.message : e));
    }
    return NextResponse.json(await withLines(outcome.delivery), { status: outcome.replayed ? 200 : 201 });
  } catch (err: unknown) {
    if (err && typeof err === "object" && "_appCode" in err) {
      const e = err as { _appCode: number; message: string; errorEn?: string; code?: string };
      return NextResponse.json({ error: e.message, ...(e.errorEn ? { errorEn: e.errorEn } : {}), ...(e.code ? { code: e.code } : {}) }, { status: e._appCode });
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
        return NextResponse.json(await withLines(winner), { status: 200 });
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
