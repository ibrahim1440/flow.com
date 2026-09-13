import { NextResponse } from "next/server";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireEdit } from "@/lib/auth-server";
import { isValidTransition } from "@/lib/batch-transitions";
import { handlePrismaError } from "@/lib/api-error";
import { recalcProductionOrderStatus } from "@/lib/services/production-planning";
import {
  ALLOCATABLE_ITEM_SELECT,
  outstandingForItem,
  reserveShelfStock,
  roundKg,
} from "@/lib/services/shelf-allocation";
import {
  readLineReservationState,
  canReserveToOrderLine,
  casUpdateOrderItem,
  assertOrderStillAcceptsReservation,
} from "@/lib/services/order-operations";
import { PACKABLE_BATCH_STATUSES } from "@/lib/services/finished-products";
import {
  readRequestKey,
  packagingRequestHash,
  guardIdempotency,
  recordOperation,
  isReplaySignal,
} from "@/lib/services/packaging-idempotency";

// Tolerance on "is this roast fully packaged?". Bag sizes rarely divide a roast exactly,
// so the last 100 g decides Packaged vs Partially Packaged rather than refusing the pack.
const MARGIN = 0.1;

/** Net weight of each bag size, in kilograms. A 1 kg bag holds 1 kg of roasted coffee. */
const BAG_KG = { bags3kg: 3, bags1kg: 1, bags250g: 0.25, bags150g: 0.15 } as const;
type BagField = keyof typeof BAG_KG;
const BAG_FIELDS = Object.keys(BAG_KG) as BagField[];

/** The columns this route decides from. Read once, under the batch lock. */
type LockedBatch = {
  id: string;
  batchNumber: string;
  status: string;
  productId: string | null;
  orderItemId: string | null;
  productionOrderId: string | null;
  roastedBeanQuantity: number;
  roastedAvailableKg: number;
  bags3kg: number;
  bags1kg: number;
  bags250g: number;
  bags150g: number;
  samplesGrams: number;
};

/**
 * Pack a roast into legacy kilogram bags.
 *
 * Everything that depends on database state happens inside ONE transaction, and the first
 * thing that transaction does is take the RoastingBatch row lock. That ordering is the
 * whole point of this route's shape:
 *
 *   - the batch used to be read, and every quantity derived from it, before the
 *     transaction opened. Two packers on one roast each computed their new bag counters
 *     from the same stale snapshot and the last writer won, silently discarding the
 *     other's bags while the ledger still recorded both of them;
 *   - the lot's availableQty was ASSIGNED the cumulative packed weight rather than
 *     incremented by this pack's delta, so once anything had shipped off the lot the next
 *     pack put the shipped kilograms back: 10 kg roasted, 6 packed, 4 dispatched, 4 more
 *     packed left 10 kg on a shelf holding 6;
 *   - and the roasted balance the coffee came out of was never drawn down at all, so the
 *     same kilograms stayed on the books as packable after they had been packed.
 *
 * RoastingBatch may be locked ahead of every stock and order lock — see the lock-order
 * invariant in order-operations.ts — so taking it first costs nothing and makes the batch
 * the single point of serialisation for its own packaging.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { error, user } = await requireEdit("packaging");
  if (error) return error;

  const { id } = await params;

  // Malformed keys are refused before anything is read or locked: a key that cannot be
  // stored is a caller bug, and executing the pack anyway would leave an operation the
  // caller can never safely retry.
  const key = readRequestKey(request);
  if (!key.ok) return NextResponse.json({ error: key.message }, { status: 400 });

  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; } catch { body = {}; }

  // ── Input validation ──────────────────────────────────────────────────────
  // Pure: nothing here reads the database, so it stays outside the transaction.
  const counts: Record<BagField, number> = {
    bags3kg:  Number(body.bags3kg  ?? 0),
    bags1kg:  Number(body.bags1kg  ?? 0),
    bags250g: Number(body.bags250g ?? 0),
    bags150g: Number(body.bags150g ?? 0),
  };
  const samplesGrams = Number(body.samplesGrams ?? 0);

  const inputChecks: [string, number][] = [
    ...BAG_FIELDS.map((f) => [f, counts[f]] as [string, number]),
    ["samplesGrams", samplesGrams],
  ];
  for (const [name, value] of inputChecks) {
    if (!Number.isFinite(value) || value < 0) {
      return NextResponse.json({ error: `${name} must be a non-negative number.` }, { status: 400 });
    }
  }

  // The weight THIS request adds, and nothing else. Every balance below moves by this
  // figure; the cumulative packed total is only ever used to decide whether the roast is
  // finished, never as an inventory quantity.
  const packagedDeltaKg = roundKg(
    BAG_FIELDS.reduce((sum, f) => sum + counts[f] * BAG_KG[f], 0) + samplesGrams / 1000
  );

  if (packagedDeltaKg <= 0) {
    return NextResponse.json(
      { error: "At least one package quantity must be greater than zero." },
      { status: 400 }
    );
  }

  // What this request ASKED FOR, independent of how it was serialised. Resending the same
  // submit reproduces this hash; a different pack under a reused key does not, and is
  // refused rather than silently answered with the first pack's result.
  const requestHash = packagingRequestHash({
    method: "KG",
    batchId: id,
    bags3kg: counts.bags3kg,
    bags1kg: counts.bags1kg,
    bags250g: counts.bags250g,
    bags150g: counts.bags150g,
    samplesGrams,
    productId: typeof body.productId === "string" && body.productId ? body.productId : null,
    productSkuId: typeof body.productSkuId === "string" && body.productSkuId ? body.productSkuId : null,
  });

  try {
    const updated = await prisma.$transaction(async (tx) => {
      // ── 1. Lock the batch, then read the state every decision below uses ────
      const locked = await tx.$queryRaw<LockedBatch[]>`
        SELECT "id", "batchNumber", "status", "productId", "orderItemId", "productionOrderId",
               "roastedBeanQuantity", "roastedAvailableKg",
               "bags3kg", "bags1kg", "bags250g", "bags150g", "samplesGrams"
          FROM "RoastingBatch"
         WHERE "id" = ${id}
           FOR UPDATE
      `;
      const batch = locked[0];
      if (!batch) throw { _appCode: 404, message: "Batch not found" };

      // ── 1a. Has this exact operation already run? ──────────────────────────
      // Deliberately INSIDE the transaction and AFTER the lock, with no cheaper check in
      // front of it. A lookup before the transaction could only ever be an optimisation
      // for an already-committed retry, and it would cost every genuine pack an extra
      // round trip on a database that is a sixth of a second away. Behind the lock the
      // answer is also authoritative rather than advisory: two retries of one submit
      // arriving together queue here, and the second reads what the first committed
      // instead of racing it.
      await guardIdempotency(tx, batch.id, key.key, requestHash);

      const orderItem = batch.orderItemId
        ? await tx.orderItem.findUnique({
            where: { id: batch.orderItemId },
            select: { productId: true, productSkuId: true },
          })
        : null;

      // ── 2. Which coffee this lot is ────────────────────────────────────────
      const effectiveProductId =
        batch.productId ??
        orderItem?.productId ??
        (typeof body.productId === "string" && body.productId ? body.productId : null);

      if (!effectiveProductId) {
        throw { _appCode: 400, message: "Cannot package batch: select a product for this order." };
      }

      // Validate the client's product only when it is the fallback source.
      if (!batch.productId && !orderItem?.productId && body.productId) {
        const product = await tx.coffeeProduct.findUnique({
          where: { id: effectiveProductId },
          select: { id: true },
        });
        if (!product) throw { _appCode: 400, message: "Product not found." };
      }

      // ── 3. Which SKU the lot is stamped with ───────────────────────────────
      // The SKU decides which order lines this lot can later be matched to. Taken from the
      // order item it is already trustworthy; taken from the request body it went through
      // unchecked, so any caller could stamp an unrelated product's SKU — or an id that
      // does not exist — onto a lot of somebody else's coffee. It must exist, and it must
      // belong to the coffee actually being packed.
      //
      // Deliberately narrower than a full coffee-identity resolver: this refuses a foreign
      // SKU, it does not try to infer the batch's coffee from one.
      let effectiveProductSkuId: string | null = orderItem?.productSkuId ?? null;
      if (
        effectiveProductSkuId === null &&
        body.productSkuId !== undefined &&
        body.productSkuId !== null &&
        body.productSkuId !== ""
      ) {
        if (typeof body.productSkuId !== "string") {
          throw { _appCode: 400, message: "productSkuId must be a string." };
        }
        const sku = await tx.productSKU.findUnique({
          where: { id: body.productSkuId },
          select: { id: true, productId: true },
        });
        if (!sku) throw { _appCode: 400, message: "Product SKU not found." };
        if (sku.productId !== effectiveProductId) {
          throw {
            _appCode: 400,
            message: "That product SKU belongs to a different coffee than this batch.",
          };
        }
        effectiveProductSkuId = sku.id;
      }

      // ── 4. Is this batch packable at all? ──────────────────────────────────
      if (!PACKABLE_BATCH_STATUSES.includes(batch.status)) {
        throw {
          _appCode: 400,
          message: `Cannot package batch with status "${batch.status}". Only QC-passed or partially packaged batches can be packaged.`,
        };
      }

      // Reciprocal of the guard in ../pack-sku: a batch is packed either the legacy
      // kilogram way or into SKU units, never both. Checked here, inside the transaction
      // and under the batch lock, rather than before either existed.
      const unitLot = await tx.finishedGoodsLot.findFirst({
        where: { packedFromBatchId: batch.id },
        select: { id: true },
      });
      if (unitLot) {
        throw {
          _appCode: 409,
          message: `Batch ${batch.batchNumber} was already packed into finished product units. A batch cannot be packed both ways.`,
        };
      }

      // ── 5. Cumulative totals, derived from the locked row ──────────────────
      // Used only to answer "is the roast finished?" and to keep the bag counters honest.
      const newCounts: Record<BagField, number> = {
        bags3kg:  batch.bags3kg  + counts.bags3kg,
        bags1kg:  batch.bags1kg  + counts.bags1kg,
        bags250g: batch.bags250g + counts.bags250g,
        bags150g: batch.bags150g + counts.bags150g,
      };
      const newSamplesGrams = batch.samplesGrams + samplesGrams;
      const totalPackagedKg = roundKg(
        BAG_FIELDS.reduce((sum, f) => sum + newCounts[f] * BAG_KG[f], 0) + newSamplesGrams / 1000
      );

      if (totalPackagedKg > batch.roastedBeanQuantity + MARGIN) {
        throw {
          _appCode: 400,
          message: `Total packaged weight (${totalPackagedKg}kg) would exceed roasted quantity (${batch.roastedBeanQuantity}kg).`,
        };
      }

      const fullyPackaged = totalPackagedKg >= batch.roastedBeanQuantity - MARGIN;
      const newStatus = fullyPackaged ? "Packaged" : "Partially Packaged";

      if (!isValidTransition(batch.status, newStatus)) {
        throw {
          _appCode: 409,
          message: `Cannot transition batch from "${batch.status}" to "${newStatus}".`,
        };
      }

      // ── 6. Consume the roasted coffee this pack is made of ─────────────────
      // Finished stock may not be created unless the roasted balance behind it was
      // actually drawn down, in this same transaction. Conditional even though the row is
      // already locked: the WHERE clause is what makes the balance impossible to overdraw
      // and keeps the non-negative CHECK constraint out of reach. The 0.0005 slack is half
      // a gram, below the 3-decimal storage precision — the same tolerance the unit path
      // uses on a value that was read rounded.
      const drawn = await tx.$executeRaw`
        UPDATE "RoastingBatch"
           SET "roastedAvailableKg" = "roastedAvailableKg" - ${packagedDeltaKg}
         WHERE "id" = ${batch.id}
           AND ("roastedAvailableKg" + 0.0005) >= ${packagedDeltaKg}
      `;
      if (drawn !== 1) {
        throw {
          _appCode: 409,
          message:
            `Not enough roasted coffee on batch ${batch.batchNumber}: packing ${packagedDeltaKg}kg ` +
            `needs more than the ${roundKg(batch.roastedAvailableKg)}kg still unpacked.`,
        };
      }

      // ── 7. Bag counters and batch status ───────────────────────────────────
      // Incremented rather than assigned. Under the lock either form is correct; the
      // increment keeps it correct on its own if the lock is ever moved.
      const updatedBatch = await tx.roastingBatch.update({
        where: { id: batch.id },
        data: {
          bags3kg:      { increment: counts.bags3kg },
          bags1kg:      { increment: counts.bags1kg },
          bags250g:     { increment: counts.bags250g },
          bags150g:     { increment: counts.bags150g },
          samplesGrams: { increment: samplesGrams },
          status:       newStatus,
        },
      });

      // ── 8. The shelf grows by this pack's delta ────────────────────────────
      // THE FIX: availableQty is a live balance, not a running total of everything ever
      // packed. Assigning the cumulative figure put dispatched kilograms back on the shelf.
      const existingLot = await tx.finishedGoodsLot.findUnique({
        where: { roastingBatchId: batch.id },
        select: { id: true, availableQty: true },
      });
      const lotBalanceBefore = existingLot ? existingLot.availableQty : 0;

      const lot = existingLot
        ? await tx.finishedGoodsLot.update({
            where: { id: existingLot.id },
            data: { availableQty: { increment: packagedDeltaKg } },
          })
        : await tx.finishedGoodsLot.create({
            data: {
              productId:       effectiveProductId,
              productSkuId:    effectiveProductSkuId,
              batchNumber:     batch.batchNumber,
              roastingBatchId: batch.id,
              quantityKg:      batch.roastedBeanQuantity,
              availableQty:    packagedDeltaKg,
              status:          "AVAILABLE",
            },
          });

      // ── 9. Ledger ──────────────────────────────────────────────────────────
      // previous/new are the LOT's balance either side of this pack, not the running
      // packed total. The two diverge the moment anything ships, and the ledger has to
      // reconcile against the shelf rather than against the bag counters.
      await tx.inventoryMovement.create({
        data: {
          type:              "IN",
          category:          "FINISHED_GOODS",
          referenceEntityId: lot.id,
          quantityChanged:   packagedDeltaKg,
          previousQuantity:  roundKg(lotBalanceBefore),
          newQuantity:       roundKg(lotBalanceBefore + packagedDeltaKg),
          sourceDocType:     "PACKING",
          sourceDocId:       batch.id,
          userId:            user.id,
          notes:             null,
        },
      });

      // ── 9a. Record the operation ───────────────────────────────────────────
      // In this transaction, and here rather than at the end, for two separate reasons.
      //
      // Atomicity: the row and the stock it describes commit or roll back together, so a
      // pack that fails below leaves no operation behind and the key stays usable. A row
      // in this table always means the kilograms behind it are really on the shelf.
      //
      // Lock order: the insert's foreign keys take FOR KEY SHARE on RoastingBatch, on the
      // lot, and on the SKU. The first two this transaction already holds. The SKU is a
      // genuinely new acquisition and is safe for a different reason: FOR KEY SHARE yields
      // only to locks of FOR UPDATE strength, the products endpoint "deletes" a SKU by
      // deactivating it — a non-key UPDATE, which does not conflict — and the one path that
      // really removes SKU rows, the admin reset, takes the batches and the lots before the
      // SKUs, the same order as here. So nothing is acquired after Order, which has to stay
      // this transaction's last.
      await recordOperation(tx, {
        batchId: batch.id,
        requestKey: key.key,
        requestHash,
        method: "KG",
        quantityKg: packagedDeltaKg,
        productSkuId: effectiveProductSkuId,
        finishedGoodsLotId: lot.id,
        responseStatus: 200,
        responseBody: updatedBatch,
        userId: user.id,
      });

      // ── 10. Claim the packaged coffee for the order it was roasted for ─────
      // Reserving here is what keeps the shelf honest: only the genuine surplus — coffee
      // beyond what this order still needs — stays free for other orders to draw on.
      //
      // A stock batch has no order item at all. Nothing is reserved, so its whole output
      // lands on the shelf free-to-promise, which is the point of roasting to stock.
      const owner = batch.orderItemId
        ? await tx.orderItem.findUnique({
            where: { id: batch.orderItemId },
            select: {
              ...ALLOCATABLE_ITEM_SELECT,
              preparationDecision: true,
              quantityUnits: true,
              order: { select: { status: true } },
            },
          })
        : null;

      // A SKU line is reserved in UNITS, through the unit path only. Auto-reserving
      // kilograms for it here produces an allocation in the wrong denomination: the unit
      // path cannot see it, preparation review still reports the line as needing
      // production, and the kilograms sit locked on a legacy lot helping nobody.
      const ownerIsUnitLine = owner !== null && owner.quantityUnits !== null;

      // Packaging itself is never blocked by the owner's state: the coffee was roasted and
      // packed and belongs on the shelf either way. Only the decision to PROMISE it to the
      // owning order is gated, and an ineligible owner simply means the lot stays
      // free-to-promise — which is what roast-to-stock produces anyway.
      // Set when a reservation was actually written, so the Order barrier below knows it
      // has something to validate. It is deliberately NOT taken inline with the
      // reservation: Order must be this transaction's last acquisition, and the production
      // order recalculation still has to happen in between.
      let reservedLineId: string | null = null;

      if (owner && !ownerIsUnitLine) {
        // Transaction-current, and re-read here rather than trusted from the snapshot
        // above: the outstanding figure below is derived from quantity and delivered, and
        // a delivery committing since that read would make this reserve against demand
        // that no longer exists.
        const fresh = await readLineReservationState(tx, owner.id);
        if (fresh && canReserveToOrderLine(fresh)) {
          const outstanding = await outstandingForItem(tx, {
            ...owner,
            quantityKg: fresh.quantityKg,
            deliveredQty: fresh.deliveredQty,
          });
          if (outstanding > 0) {
            await reserveShelfStock(tx, owner, outstanding, user.id);
            // Compare-and-swap on the line this reservation was computed from. Packaging
            // writes no other OrderItem field, so this guard write exists purely to make
            // the reservation atomic with respect to the demand it was based on. It runs
            // AFTER the allocation and lot work above, preserving ALLOC -> OrderItem.
            await casUpdateOrderItem(
              tx,
              { id: fresh.id, updatedAt: fresh.updatedAt, deliveredUnits: fresh.deliveredUnits, deliveredQty: fresh.deliveredQty },
              {}
            );
            reservedLineId = fresh.id;
          }
        }
      }

      // ── 11. Production order, BEFORE the Order barrier ─────────────────────
      // Ordering here is not cosmetic. Every other path that touches both resources takes
      // ProductionOrder before Order: roasting recalculates the production order and only
      // then asserts the order still accepts production, and both production-order routes
      // write the production order before appending an activity row, whose foreign key
      // takes FOR KEY SHARE on Order. Taking Order first here and reaching back for the
      // production order afterwards is the one inversion that would let packaging hold
      // Order while waiting for a production order that a concurrent roast holds while
      // waiting for Order — a genuine cycle, and the reason this call sits above the
      // barrier rather than after it.
      if (batch.productionOrderId) {
        await recalcProductionOrderStatus(batch.productionOrderId, tx);
      }

      // ── 12. Order: the last acquisition of this transaction ────────────────
      // The CAS above proves the LINE did not move, and a cancellation never writes the
      // line — it writes Order and StockAllocation. So the token still matched while the
      // cancel's release ran before these rows existed, and the reservation was committed
      // onto a dead order. This is the barrier for that, and it is taken last so packaging
      // ends on the same StockAllocation -> FinishedGoodsLot -> OrderItem -> ProductionOrder
      // -> Order sequence every other lifecycle path uses.
      if (reservedLineId) {
        await assertOrderStillAcceptsReservation(tx, reservedLineId);
      }

      return updatedBatch;
    }, TX_OPTS);

    return NextResponse.json(updated);
  } catch (err) {
    // A replay is signalled by a throw so that the transaction it was detected in rolls
    // back — the point of a replay is that it changes nothing. The stored snapshot is
    // returned verbatim, so a retry sees exactly what the first execution answered.
    if (isReplaySignal(err)) {
      return NextResponse.json(err._replayBody, {
        status: err._replayStatus,
        headers: { "X-Idempotent-Replay": "true" },
      });
    }
    // The reservation compare-and-swap, the lifecycle barrier and every guard above throw
    // the `{ _appCode, message }` shape the newer routes use. handlePrismaError does not
    // understand it and would turn a deliberate 409 into a generic 500, so it is handled
    // locally here as the other routes do.
    if (err && typeof err === "object" && "_appCode" in err) {
      const e = err as { _appCode: number; message: string };
      return NextResponse.json({ error: e.message }, { status: e._appCode });
    }
    return handlePrismaError(err);
  }
}
