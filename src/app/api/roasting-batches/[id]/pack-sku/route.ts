import { NextResponse } from "next/server";
import { Prisma } from "@/generated/prisma/client";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireEdit } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { recalcProductionOrderStatus } from "@/lib/services/production-planning";
import { recalcOrderItemStatus } from "@/lib/services/order-fulfillment";
import {
  explodeBom, kgForUnits, roundKg, reserveFinishedUnitsFromLot,
} from "@/lib/services/finished-products";
import {
  resolveBatchCoffeeIdentity,
  resolvePackagingReservationTarget,
  outstandingUnitsForLine,
} from "@/lib/services/batch-identity";
import {
  canReserveToOrderLine,
  casUpdateOrderItem,
  assertOrderStillAcceptsReservation,
  appendOrderActivity,
} from "@/lib/services/order-operations";
import {
  readRequestKey,
  packagingRequestHash,
  guardIdempotency,
  recordOperation,
  isReplaySignal,
} from "@/lib/services/packaging-idempotency";

type Params = { params: Promise<{ id: string }> };

/**
 * Pack a roast into whole units of one finished SKU.
 *
 * This is the step that closes the chain the redesign asks for:
 *   GreenBean -> Roasting -> roasted stock -> Packaging (BOM) -> Finished Goods SKU
 *
 * It consumes the SKU's bill of materials — roasted coffee in kilograms from this batch,
 * and packaging materials in pieces from MaterialItem — and produces a unit-tracked
 * FinishedGoodsLot. Green coffee is never touched here; it was already consumed by the
 * roast that created this batch's roasted stock.
 *
 * Deliberately a NEW endpoint rather than a rewrite of PUT ../package. That route is the
 * legacy kilogram path (fixed 3kg/1kg/250g/150g bag counters, one lot per batch) and it
 * still serves the legacy bean-based order lines. Rewriting it would have put the
 * recently stabilised shelf-allocation behaviour at risk for no benefit; the two paths
 * are kept apart, and a lot produced here is unit-tracked while a lot produced there is
 * not.
 */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireEdit("packaging");
  if (error) return error;

  const { id } = await params;

  // Refused before anything is read or locked — a key that cannot be stored is a caller
  // bug, and packing anyway would leave an operation the caller can never safely retry.
  const key = readRequestKey(request);
  if (!key.ok) return NextResponse.json({ error: key.message }, { status: 400 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  if (typeof b.productSkuId !== "string" || !b.productSkuId)
    return NextResponse.json({ error: "productSkuId is required." }, { status: 400 });

  const units = Number(b.units);
  if (!Number.isInteger(units) || units <= 0)
    return NextResponse.json(
      { error: "units must be a whole number greater than zero." },
      { status: 400 }
    );

  // What this request ASKED FOR, independent of how it was serialised. A resent submit
  // reproduces this hash; a different pack under a reused key does not, and is refused
  // rather than answered with the first pack's result.
  const requestHash = packagingRequestHash({
    method: "UNIT",
    batchId: id,
    productSkuId: b.productSkuId,
    units,
  });

  try {
    const result = await prisma.$transaction(async (tx) => {
      // ── Lock the batch first ───────────────────────────────────────────────
      // The same row lock the kilogram path takes as its first statement, and the reason
      // both paths can no longer run on one roast. Before this, each route checked for the
      // other's lot through an unlocked read: two requests arriving together both saw no
      // lot, both proceeded, and the batch ended up packed twice — once as kilograms and
      // once as units — with the same roasted coffee counted for both. The batch row is
      // the single point of serialisation, and RoastingBatch may be locked ahead of every
      // stock and order lock (see the hierarchy in order-operations.ts), so taking it here
      // costs no ordering guarantees.
      //
      // Everything state-dependent below — status, the other path's lot, the SKU, the
      // bill of materials, the roasted balance — is then decided while holding it.
      const locked = await tx.$queryRaw<{
        id: string; batchNumber: string; status: string; productId: string | null;
        roastedAvailableKg: number; productionOrderId: string | null; orderItemId: string | null;
      }[]>`
        SELECT "id", "batchNumber", "status", "productId", "roastedAvailableKg",
               "productionOrderId", "orderItemId"
          FROM "RoastingBatch"
         WHERE "id" = ${id}
           FOR UPDATE
      `;
      const batch = locked[0];
      if (!batch) throw { _appCode: 404, message: "Batch not found." };

      // ── Has this exact operation already run? ──────────────────────────────
      // Inside the transaction and behind the lock, with nothing cheaper in front of it.
      // Two retries of one submit arriving together queue on the batch row, and the second
      // reads what the first committed rather than racing it. See the note on
      // guardIdempotency for why a pre-transaction lookup is deliberately not used.
      await guardIdempotency(tx, batch.id, key.key, requestHash);

      if (batch.status !== "Passed" && batch.status !== "Partially Packaged")
        throw {
          _appCode: 409,
          message: `Cannot package a batch with status "${batch.status}". Only QC-passed or partially packaged batches can be packed.`,
        };

      // The legacy kilogram path and this one must never both run on the same batch.
      // That route records bag counters and creates a kg lot without drawing down
      // roastedAvailableKg, so allowing both would let one roast be sold twice — once as
      // kilograms on the legacy shelf and again as units here.
      const legacyLot = await tx.finishedGoodsLot.findFirst({
        where: { roastingBatchId: batch.id },
        select: { id: true },
      });
      if (legacyLot)
        throw {
          _appCode: 409,
          message: `Batch ${batch.batchNumber} was already packed through the legacy kilogram flow. A batch cannot be packed both ways.`,
        };

      const sku = await tx.productSKU.findUnique({
        where: { id: b.productSkuId as string },
        select: { id: true, skuCode: true, weightGrams: true, isActive: true, productId: true },
      });
      if (!sku) throw { _appCode: 404, message: "Product SKU not found." };
      if (!sku.isActive)
        throw { _appCode: 409, message: `"${sku.skuCode}" is inactive and cannot be packed.` };

      // ── Which coffee is this, really? ──────────────────────────────────────
      // Asked here, before a single balance moves, and answered from backend records only.
      // The guard this replaces compared the bill of materials against batch.productId,
      // which is NULL on every order-backed roast — so it short-circuited and matched
      // nothing on exactly the batches it was written to protect.
      const identity = await resolveBatchCoffeeIdentity(tx, batch);
      if (!identity.ok) throw { _appCode: identity.status, message: identity.message };

      if (sku.productId !== identity.productId) {
        throw {
          _appCode: 409,
          message:
            `"${sku.skuCode}" is not made from the coffee on batch ${batch.batchNumber}, ` +
            "so it cannot be packed from it.",
        };
      }

      // ── Bill of materials ──────────────────────────────────────────────────
      const requirements = await explodeBom(tx, sku.id, units);
      if (requirements.length === 0)
        throw {
          _appCode: 409,
          message: `"${sku.skuCode}" has no bill of materials. Define its components before packing.`,
        };

      // Roasted coffee must come from THIS batch — that is what makes the lot traceable
      // back to a specific roast. explodeBom reports stock across every batch, so the
      // per-batch check is done here rather than taken from its shortfall figure.
      const coffeeNeeded = roundKg(
        requirements
          .filter((r) => r.type === "ROASTED_COFFEE")
          .reduce((sum, r) => sum + r.quantityRequired, 0)
      );

      if (coffeeNeeded > 0) {
        // Belt and braces behind the SKU check above. That one proves the SKU's own coffee
        // matches the batch; this catches a bill of materials that names a DIFFERENT coffee
        // from the SKU it belongs to. It compares against the resolved identity rather than
        // batch.productId, so unlike before it can actually fire on an order-backed roast.
        const coffeeLines = requirements.filter((r) => r.type === "ROASTED_COFFEE");
        const mismatched = coffeeLines.find(
          (r) => r.coffeeProductId && r.coffeeProductId !== identity.productId
        );
        if (mismatched)
          throw {
            _appCode: 409,
            message: `This batch is not the coffee "${sku.skuCode}" is made from. Its BOM needs ${mismatched.label}.`,
          };

        // Conditional UPDATE: re-checks the balance in the WHERE clause so two packers
        // drawing on the same roast cannot both succeed on the same kilograms. Same
        // atomic pattern as the shelf reservation. The 0.0005 slack is half a gram,
        // below the 3-decimal storage precision, absorbing float error on a value that
        // was read rounded.
        const drawn = await tx.$executeRaw`
          UPDATE "RoastingBatch"
             SET "roastedAvailableKg" = "roastedAvailableKg" - ${coffeeNeeded}
           WHERE "id" = ${batch.id}
             AND ("roastedAvailableKg" + 0.0005) >= ${coffeeNeeded}
        `;
        if (drawn !== 1)
          throw {
            _appCode: 409,
            message: `Not enough roasted coffee on batch ${batch.batchNumber}: ${units} x ${sku.skuCode} needs ${coffeeNeeded}kg but only ${batch.roastedAvailableKg}kg is unpacked.`,
          };

        await tx.inventoryMovement.create({
          data: {
            type: "OUT",
            category: "ROASTED_COFFEE",
            referenceEntityId: batch.id,
            quantityChanged: -coffeeNeeded,
            previousQuantity: batch.roastedAvailableKg,
            newQuantity: roundKg(batch.roastedAvailableKg - coffeeNeeded),
            sourceDocType: "BOM_CONSUMPTION",
            sourceDocId: batch.id,
            userId: user.id,
            notes: `Packed ${units} x ${sku.skuCode}`,
          },
        });
      }

      // ── Packaging materials ────────────────────────────────────────────────
      // Three round trips per component — look it up, claim it, record the movement —
      // added up fast on a bill of materials of any size, and this database is across the
      // public internet. Only the middle one has to be per-component: the conditional
      // UPDATE is the atomic claim and stays exactly as it was. The lookups are collapsed
      // into one query before the loop, and the movements into one insert after it, so a
      // three-component pack costs five round trips instead of nine.
      const materialLines = requirements.filter((r) => r.type === "MATERIAL" && r.materialItemId);

      const materials = new Map(
        (
          await tx.materialItem.findMany({
            where: { id: { in: materialLines.map((l) => l.materialItemId as string) } },
            select: { id: true, code: true, name: true, quantityOnHand: true },
          })
        ).map((m) => [m.id, m])
      );

      const materialMovements: Prisma.InventoryMovementCreateManyInput[] = [];

      for (const line of materialLines) {
        const material = materials.get(line.materialItemId as string);
        if (!material)
          throw { _appCode: 409, message: `Material ${line.label} no longer exists.` };

        const consumed = await tx.$executeRaw`
          UPDATE "MaterialItem"
             SET "quantityOnHand" = "quantityOnHand" - ${line.quantityRequired}
           WHERE "id" = ${line.materialItemId}
             AND "quantityOnHand" >= ${line.quantityRequired}
        `;
        if (consumed !== 1)
          throw {
            _appCode: 409,
            message: `Not enough ${material.name} (${material.code}): need ${line.quantityRequired}, have ${material.quantityOnHand}.`,
          };

        materialMovements.push({
          type: "OUT",
          category: "PACKAGING_MATERIAL",
          referenceEntityId: material.id,
          quantityChanged: -line.quantityRequired,
          previousQuantity: material.quantityOnHand,
          newQuantity: Number((material.quantityOnHand - line.quantityRequired).toFixed(3)),
          sourceDocType: "BOM_CONSUMPTION",
          sourceDocId: batch.id,
          userId: user.id,
          notes: `Packed ${units} x ${sku.skuCode}`,
        });
      }

      // Written after the loop, inside the same transaction: if any component came up
      // short the throw above aborts before this runs, and nothing is left behind.
      if (materialMovements.length > 0) {
        await tx.inventoryMovement.createMany({ data: materialMovements });
      }

      // ── Finished goods ─────────────────────────────────────────────────────
      // One lot per (batch, SKU) packing run. Units are authoritative; quantityKg is
      // written as the derived kg-equivalent so the ledger and reports keep one field to
      // read, and availableQty/reservedQty stay at 0 because this lot is not kg-tracked.
      const producedKg = kgForUnits(sku, units);

      // status AVAILABLE is not decoration. A PARTIAL lot — an under-filled package made
      // by the unified workflow — is also unit-tracked and also carries this batch and
      // this SKU, so without the filter it matches here and units get merged into a bag
      // that does not hold them. The lot would then claim sellable units while its
      // actualContentGrams still said 300 g of a 500 g package. Partial packages are
      // completed by topping them up, never by adding units to them from another path.
      const existing = await tx.finishedGoodsLot.findFirst({
        where: {
          packedFromBatchId: batch.id,
          productSkuId: sku.id,
          isUnitTracked: true,
          status: "AVAILABLE",
        },
        select: { id: true, unitsProduced: true, unitsAvailable: true, quantityKg: true },
      });

      const lot = existing
        ? await tx.finishedGoodsLot.update({
            where: { id: existing.id },
            data: {
              unitsProduced: existing.unitsProduced + units,
              unitsAvailable: existing.unitsAvailable + units,
              quantityKg: roundKg(existing.quantityKg + producedKg),
            },
          })
        : await tx.finishedGoodsLot.create({
            data: {
              productId: sku.productId,
              productSkuId: sku.id,
              batchNumber: batch.batchNumber,
              // roastingBatchId deliberately left null — see the note on packedFromBatchId
              // in schema.prisma. That column is the legacy 1:1 link and is UNIQUE.
              packedFromBatchId: batch.id,
              quantityKg: producedKg,
              availableQty: 0,
              reservedQty: 0,
              isUnitTracked: true,
              unitsProduced: units,
              unitsAvailable: units,
              unitsReserved: 0,
              status: "AVAILABLE",
            },
          });

      await tx.inventoryMovement.create({
        data: {
          type: "IN",
          category: "FINISHED_GOODS",
          referenceEntityId: lot.id,
          quantityChanged: producedKg,
          previousQuantity: existing ? existing.quantityKg : 0,
          newQuantity: lot.quantityKg,
          sourceDocType: "PACKING",
          sourceDocId: batch.id,
          userId: user.id,
          notes: `${units} x ${sku.skuCode}`,
        },
      });

      // Mark the roast packed out once nothing meaningful is left to pack (under 50g).
      const after = await tx.roastingBatch.findUniqueOrThrow({
        where: { id: batch.id },
        select: { roastedAvailableKg: true, status: true },
      });
      if (after.roastedAvailableKg < 0.05 && after.status !== "Packaged") {
        await tx.roastingBatch.update({ where: { id: batch.id }, data: { status: "Packaged" } });
      } else if (after.status === "Passed") {
        await tx.roastingBatch.update({
          where: { id: batch.id },
          data: { status: "Partially Packaged" },
        });
      }

      // ── Claim the units for the order they were roasted for ────────────────
      // Coffee packed to fulfil a specific order used to land free-to-promise: the route
      // created the lot and stopped. Preparation review still reported the line as needing
      // production, and any other order could be promised the units first.
      //
      // Reserving is gated, never assumed. A roast to stock has no owner. A line that
      // ordered a different SKU of the same coffee is not fulfilled by these units — a
      // 250 g pack does not satisfy a 1 kg line, and pretending otherwise would be an
      // oversell dressed up as a convenience. And an order that has stopped accepting stock
      // gets nothing, exactly as the kilogram path already behaves.
      let reservedUnits = 0;
      let reservedLineId: string | null = null;
      let reservedOrderId: string | null = null;

      const ownerId = await resolvePackagingReservationTarget(tx, batch);
      if (ownerId) {
        // One read, not three. Everything the reservation needs — eligibility, the demand
        // ceiling, the SKU to match against and the order to write the activity to — comes
        // from the same row, and this database is a sixth of a second away: reading it once
        // per question would spend three round trips inside a transaction that is holding a
        // pooled connection and a row lock on the batch the whole time.
        //
        // Read here rather than trusted from a snapshot taken at the top of the transaction:
        // the ceiling below is derived from quantity and delivered, and a delivery
        // committing in between would make this reserve against demand that no longer
        // exists. The compare-and-swap further down closes the remaining window.
        const owner = await tx.orderItem.findUnique({
          where: { id: ownerId },
          select: {
            id: true,
            orderId: true,
            productSkuId: true,
            updatedAt: true,
            quantityUnits: true,
            deliveredUnits: true,
            deliveredQty: true,
            preparationDecision: true,
            order: { select: { status: true, approvalStatus: true } },
          },
        });

        if (
          owner &&
          owner.quantityUnits !== null &&
          owner.productSkuId === sku.id &&
          canReserveToOrderLine(owner)
        ) {
          const outstanding = await outstandingUnitsForLine(tx, {
            id: owner.id,
            quantityUnits: owner.quantityUnits,
            deliveredUnits: owner.deliveredUnits,
          });
          const take = Math.min(units, outstanding);
          if (take > 0) {
            reservedUnits = await reserveFinishedUnitsFromLot(
              tx,
              { id: owner.id, productSkuId: sku.id, productSku: { weightGrams: sku.weightGrams } },
              lot.id,
              take,
              user.id
            );
            if (reservedUnits > 0) {
              // Compare-and-swap on the line the ceiling was computed from. Packaging writes
              // no other OrderItem field; this guard write exists purely to make the
              // reservation atomic with respect to the demand behind it, and it runs AFTER
              // the allocation and lot work so StockAllocation -> FinishedGoodsLot ->
              // OrderItem is preserved.
              await casUpdateOrderItem(
                tx,
                {
                  id: owner.id,
                  updatedAt: owner.updatedAt,
                  deliveredUnits: owner.deliveredUnits,
                  deliveredQty: owner.deliveredQty,
                },
                {}
              );
              reservedLineId = owner.id;
              reservedOrderId = owner.orderId;
            }
          }
        }
      }

      const response = {
        lotId: lot.id,
        skuCode: sku.skuCode,
        unitsPacked: units,
        unitsAvailableOnLot: lot.unitsAvailable,
        reservedUnits,
        reservedToOrderItemId: reservedLineId,
        freeUnits: Math.max(0, units - reservedUnits),
        roastedCoffeeConsumedKg: coffeeNeeded,
        roastedAvailableKgRemaining: roundKg(after.roastedAvailableKg),
        materialsConsumed: requirements
          .filter((r) => r.type === "MATERIAL")
          .map((r) => ({ label: r.label, quantity: r.quantityRequired })),
      };

      // ── Record the operation ───────────────────────────────────────────────
      // In this transaction, so the row and the stock it describes commit or roll back
      // together: a pack that fails leaves no operation behind and the key stays usable.
      // Written before the production-order recalculation because the insert's foreign
      // keys take FOR KEY SHARE on the batch, the lot and the SKU, all of which sit above
      // the production-order and order tiers this transaction ends on.
      await recordOperation(tx, {
        batchId: batch.id,
        requestKey: key.key,
        requestHash,
        method: "UNIT",
        quantityUnits: units,
        productSkuId: sku.id,
        finishedGoodsLotId: lot.id,
        responseStatus: 201,
        responseBody: response,
        userId: user.id,
      });

      // ── The line's own production state ────────────────────────────────────
      // Packing is what completes production for a unit line, and this route was the only
      // production-affecting path that never said so: roasting, QC finalize, blending,
      // batch deletion and delivery all recalculate it. Without this a SKU line could
      // never leave "In Production" however many units were packed for it, and the
      // ready-to-ship dashboards — which count Completed-but-not-Delivered — stayed empty.
      //
      // At the OrderItem tier, before the production order and the Order barrier below, so
      // the certified acquisition order is unchanged.
      if (batch.orderItemId) await recalcOrderItemStatus(batch.orderItemId, tx);

      // ── Production order, then Order: the last two acquisitions ────────────
      // Same ordering the kilogram path was corrected to. Every path that touches both takes
      // ProductionOrder before Order, and the activity row appended below has a foreign key
      // to Order, so it belongs here at the very end rather than next to the reservation.
      if (batch.productionOrderId) await recalcProductionOrderStatus(batch.productionOrderId, tx);

      if (reservedLineId && reservedOrderId) {
        await assertOrderStillAcceptsReservation(tx, reservedLineId);

        // Packaging that promises stock is a decision somebody will later ask about, and
        // until now it left no trace on the order's timeline. Written after the barrier: the
        // insert's foreign key takes a lock on Order, which this transaction now holds.
        {
          await appendOrderActivity(tx, {
            orderId: reservedOrderId,
            type: "STOCK_RESERVED_FROM_PACKAGING",
            message:
              `${reservedUnits} × ${sku.skuCode} reserved to this order straight from ` +
              `packaging batch ${batch.batchNumber}, by ${user.name}.`,
            authorId: user.id,
            authorName: user.name,
            metadata: {
              orderItemId: reservedLineId,
              roastingBatchId: batch.id,
              finishedGoodsLotId: lot.id,
              reservedUnits,
              unitsPacked: units,
              skuCode: sku.skuCode,
            },
          });
        }
      }

      return response;
    }, TX_OPTS);

    return NextResponse.json(result, { status: 201 });
  } catch (err: unknown) {
    // Signalled by a throw so the detecting transaction rolls back — a replay must change
    // nothing. The stored snapshot is returned verbatim, so a retry sees exactly what the
    // first execution answered.
    if (isReplaySignal(err)) {
      return NextResponse.json(err._replayBody, {
        status: err._replayStatus,
        headers: { "X-Idempotent-Replay": "true" },
      });
    }
    if (err && typeof err === "object" && "_appCode" in err) {
      const e = err as { _appCode: number; message: string };
      return NextResponse.json({ error: e.message }, { status: e._appCode });
    }
    return handlePrismaError(err);
  }
}
