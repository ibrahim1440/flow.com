import { NextResponse } from "next/server";
import { Prisma } from "@/generated/prisma/client";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireAnyModule, requireSub } from "@/lib/auth-server";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { handlePrismaError } from "@/lib/api-error";
import { recalcOrderItemStatus } from "@/lib/services/order-fulfillment";
import {
  recalcProductionOrderStatus,
  assertProductionOrderAcceptsRoast,
  roastingCeilingForItem,
  advisoryKey,
} from "@/lib/services/production-planning";
import {
  productionGateRefusal,
  assertOrderStillAcceptsProduction,
  appendOrderActivity,
  REASON_MAX_LENGTH,
} from "@/lib/services/order-operations";

/**
 * The single live production order raised from this order line, or null when there is
 * none — or more than one, which is a choice this function refuses to make silently.
 *
 * Used only to decide how much of the line's scheduled work this roast may be credited
 * with. The stricter, throwing resolution of the SAME question lives in the transaction
 * below, where the batch actually gets its link.
 */
async function soleLiveProductionOrderId(
  db: Prisma.TransactionClient | typeof prisma,
  orderItemId: string,
): Promise<string | null> {
  const candidates = await db.productionOrder.findMany({
    where: {
      sourceOrderItemId: orderItemId,
      status: { in: ["PENDING", "IN_PRODUCTION"] },
    },
    select: { id: true },
    take: 2,
  });
  return candidates.length === 1 ? candidates[0].id : null;
}

/**
 * Authorization to roast past the ceiling.
 *
 * Being an admin used to be the whole test: `excess > 0 && user.role !== "admin"` let an
 * administrator through in silence, with no flag, no reason and nothing written down. One
 * mis-click could materially overproduce and leave nothing in the record to show that a
 * limit had been crossed at all.
 *
 * Surplus roasting is legitimate — batch minimums, drum capacity, a roaster who would
 * rather not stop at 7.4kg — so the answer is not to forbid it. The answer is that it has
 * to be asked for. Privilege is necessary and no longer sufficient: the request must say
 * that it means to exceed the ceiling, and say why, and the why is kept.
 */
const SURPLUS_REASON_MIN_LENGTH = 8;

type SurplusDecision =
  | { ok: true; reason: string }
  | { ok: false; status: number; message: string };

function evaluateSurplusOverride(
  role: string,
  overrideRequested: unknown,
  rawReason: unknown,
): SurplusDecision {
  if (overrideRequested !== true) {
    return {
      ok: false,
      status: 422,
      message:
        role === "admin"
          ? "This roast exceeds what the order still needs. An admin may authorize it, but " +
            "the request must ask for it explicitly: send surplusOverride together with a " +
            "surplusReason. Nothing was roasted."
          : "Only an admin can authorize surplus production.",
    };
  }

  // Checked after the flag so that a non-admin who sends the flag is told the truth about
  // privilege rather than being sent away to write a better reason.
  if (role !== "admin") {
    return { ok: false, status: 403, message: "Only an admin can authorize surplus production." };
  }

  const reason = typeof rawReason === "string" ? rawReason.trim() : "";
  if (reason.length < SURPLUS_REASON_MIN_LENGTH) {
    return {
      ok: false,
      status: 400,
      message:
        `surplusReason is required when authorizing surplus production and must be at ` +
        `least ${SURPLUS_REASON_MIN_LENGTH} characters. Nothing was roasted.`,
    };
  }
  if (reason.length > REASON_MAX_LENGTH) {
    return {
      ok: false,
      status: 400,
      message: `surplusReason must be at most ${REASON_MAX_LENGTH} characters.`,
    };
  }

  return { ok: true, reason };
}

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
  const { orderItemId, greenBeanId, productId, greenBeanQuantity, roastedBeanQuantity, wasteQuantity, roastProfile, productionOrderId, surplusOverride, surplusReason } = data;

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
  //
  // The ceiling itself now comes from the canonical planning service rather than from a
  // formula kept here. The local one subtracted neither delivered quantity nor scheduled
  // production, and its reserved term was computed by reservedForItem, which only sums
  // kilogram-denominated allocations — on a SKU line, where every allocation is in units,
  // that silently evaluated to zero and the gate believed nothing was covered.
  // The plan this roast is being made for, resolved the same way the transaction below
  // resolves it: what the caller named, or the single live plan of this line. Passing it to
  // the ceiling is what stops a plan covering the whole line from making the roast that
  // executes it look like surplus. Ambiguity is not resolved here — two live plans simply
  // credit nothing, and the transaction refuses the roast outright with an explanation.
  const creditPoId = isStockBatch
    ? null
    : ((productionOrderId as string | undefined) ?? (await soleLiveProductionOrderId(prisma, orderItemId as string)));
  const ceiling = isStockBatch
    ? null
    : await roastingCeilingForItem(prisma, orderItemId, creditPoId);
  if (!isStockBatch && !ceiling) {
    return NextResponse.json({ error: "Order item not found." }, { status: 404 });
  }

  // Roasted output, not green input. The ceiling is expressed in the finished kilograms the
  // order still needs, so the thing measured against it has to be the coffee that will
  // actually become those kilograms. Comparing green input to a finished ceiling made every
  // correct roast look like surplus, because roasting always loses weight.
  //
  // roastingCeilingForItem has already subtracted delivered, reserved, scheduled production
  // and any roasted output not held by a production order, so what remains is simply whether
  // THIS roast fits inside it.
  const productionCeiling = ceiling ? ceiling.ceilingKg : Infinity;
  const excess = +(roastedQty - productionCeiling).toFixed(3);

  // The decision is taken once, here, and re-taken inside the transaction against live
  // numbers. Both use the same function, so "admin, explicitly, with a reason" means the
  // same thing in both places.
  const surplus = excess > 0
    ? evaluateSurplusOverride(user.role, surplusOverride, surplusReason)
    : null;

  if (surplus && !surplus.ok) {
    const d = ceiling?.demand;
    const covered = d
      ? [
          d.deliveredUnits > 0 ? `${d.deliveredUnits} delivered` : null,
          d.reservedUnits > 0 ? `${d.reservedUnits} reserved` : null,
          d.scheduledUnits > 0 ? `${d.scheduledUnits} already on production orders` : null,
        ].filter(Boolean).join(", ")
      : "";
    // The quantity explanation is worth having on the refusal an operator will actually
    // read; the validation refusals speak for themselves.
    const prefix = surplus.status === 400
      ? ""
      : `Batch would exceed the ${productionCeiling}kg still to be produced for this item by ${excess}kg` +
        (covered ? ` — ${covered}, out of ${d!.orderedUnits} unit(s) ordered.` : ".") + " ";
    return NextResponse.json({ error: prefix + surplus.message }, { status: surplus.status });
  }
  // ─────────────────────────────────────────────────────────────────────────

  try {
  const batch = await prisma.$transaction(async (tx) => {
    // Set only when this roast is committed as an authorized surplus, and used twice
    // below: once on the ledger note and once on the order timeline. It lives inside the
    // transaction so a rollback takes the evidence with the roast.
    let overrideEvidence:
      | { ceilingKg: number; requestedKg: number; excessKg: number; reason: string }
      | null = null;

    // ── Production entry gate ────────────────────────────────────────────────
    // First statement in the transaction, before the serial is allocated and well before
    // the green-bean decrement below, so a roast against an order that is not approved or
    // not reviewed cannot move inventory, write a ledger row or consume a batch number.
    //
    // ── Serialize roasts for this order line ───────────────────────────────
    // FIRST statement of the transaction, and the reason the ceiling above is only a fast
    // rejection rather than the decision.
    //
    // That ceiling is read before the transaction opens and takes no lock, so two operators
    // starting a roast at the same moment both read the same remaining demand and both pass.
    // Nothing downstream caught it: the only advisory lock in this transaction is keyed on
    // the DATE, for batch-number allocation, and it re-checks no demand at all. Measured on
    // a 4-unit line, both requests were accepted and 8 kg was roasted against a 4 kg demand.
    //
    // The lock class and key are deliberately the ones the production-requirement route
    // already uses — 7762, keyed on the order line. Scheduling a production order and
    // roasting against the line consume the SAME demand, so they have to serialize against
    // each other and not merely each against themselves. Held until commit; unrelated order
    // lines are untouched.
    if (!isStockBatch) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(7762, ${advisoryKey(orderItemId as string)}::int)`;

      // Re-asked now that this transaction is the only one that can be asking. Everything
      // before the transaction was advisory; this is the answer that counts.
      // Re-resolved inside the lock: another transaction may have raised or completed a
      // plan since the pre-check, and the credit has to match the world this roast commits
      // into rather than the one it arrived in.
      const liveCreditPoId =
        (productionOrderId as string | undefined) ??
        (await soleLiveProductionOrderId(tx, orderItemId as string));
      const live = await roastingCeilingForItem(tx, orderItemId as string, liveCreditPoId);
      if (!live) throw new AppError(404, "Order item not found.");
      const liveExcess = +(roastedQty - live.ceilingKg).toFixed(3);
      if (liveExcess > 0) {
        // Re-asked under the lock. A request that was inside the ceiling when it arrived
        // and is outside it now needs the same explicit authorization as one that was
        // outside it from the start — being early is not an authorization.
        const liveDecision = evaluateSurplusOverride(user.role, surplusOverride, surplusReason);
        if (!liveDecision.ok) {
          throw {
            _appCode: liveDecision.status === 400 ? 400 : 409,
            message:
              `This line was covered while the request was in flight — only ${live.ceilingKg}kg ` +
              `still needs producing, and this roast would exceed it by ${liveExcess}kg. ` +
              liveDecision.message,
          };
        }
        overrideEvidence = {
          ceilingKg: live.ceilingKg,
          requestedKg: roastedQty,
          excessKg: liveExcess,
          reason: liveDecision.reason,
        };
      }
    }

    // Order-backed roasts only. A stock batch has no customer order to be in a valid state
    // — roast-to-stock is bounded instead by its own admin-only privilege and by the
    // atomic green-stock check further down, both unchanged.
    //
    // This supplements assertProductionOrderAcceptsRoast rather than replacing it: that
    // guard validates the PRODUCTION order's own status and coffee, and still runs below.
    if (!isStockBatch) {
      const gateSubject = await tx.orderItem.findUnique({
        where: { id: orderItemId },
        select: {
          preparationDecision: true,
          order: { select: { status: true, approvalStatus: true } },
        },
      });
      if (!gateSubject) throw new AppError(404, "Order item not found.");
      const refusal = productionGateRefusal(gateSubject, "start");
      if (refusal) throw refusal;
    }

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

      // ── The production order and the order line must be the same work ──────
      // assertProductionOrderAcceptsRoast checks the production order's status and its
      // coffee. It cannot check WHOSE order this is, and a roast carrying line B's id while
      // pointing at a production order raised from line A is two different claims about who
      // the coffee is for. Both are backend-meaningful, so neither may be quietly preferred
      // — the roast is refused and the operator re-picks.
      if (!isStockBatch) {
        const po = await tx.productionOrder.findUnique({
          where: { id: productionOrderId },
          select: { productionNumber: true, sourceOrderItemId: true },
        });
        if (po?.sourceOrderItemId && po.sourceOrderItemId !== orderItemId) {
          throw {
            _appCode: 409,
            message:
              `Production order ${po.productionNumber} was raised for a different order line, ` +
              "so this roast cannot be recorded against both. Start the roast from that " +
              "production order, or raise one for this line.",
          };
        }
      }
    }

    // ── Traceability without asking the operator for an id ─────────────────
    // The production screen never sent productionOrderId — the field appears nowhere in it —
    // so every roast started from a production plan was stored with no link back to the plan
    // it came from, and the production order could never tell what had been roasted for it.
    //
    // Rather than depend on a screen remembering to send it, the link is derived here when
    // the answer is unambiguous: exactly one live production order raised from this very
    // line. Two would be a choice, and choices are not made silently — the batch is simply
    // left unlinked, as before, and can be attached explicitly afterwards.
    let effectiveProductionOrderId: string | null = (productionOrderId as string) ?? null;
    if (!effectiveProductionOrderId && !isStockBatch) {
      const candidates = await tx.productionOrder.findMany({
        where: {
          sourceOrderItemId: orderItemId,
          status: { in: ["PENDING", "IN_PRODUCTION"] },
        },
        select: { id: true },
        take: 2,
      });
      if (candidates.length === 1) {
        effectiveProductionOrderId = candidates[0].id;
      } else if (candidates.length > 1) {
        // Storing the batch unlinked is not the neutral option it looks like. This roast
        // really was made for one of these plans, and recording it against neither loses the
        // attribution just as completely as recording it against the wrong one — the
        // difference being that nobody is told. The operator knows which plan they are
        // working to; the server does not, and says so.
        throw {
          _appCode: 409,
          message:
            "This order line has more than one live production order, so it is not clear " +
            "which one this roast belongs to. Start the roast from the production order " +
            "itself, or name it in the request. Nothing was roasted.",
        };
      }
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
        productionOrderId:   effectiveProductionOrderId,
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
          // The ledger row is where somebody reconciling green stock will be standing when
          // they ask why this draw was larger than the order justified.
          notes: overrideEvidence
            ? `Surplus authorized: ${overrideEvidence.requestedKg}kg roasted against a ` +
              `${overrideEvidence.ceilingKg}kg ceiling (+${overrideEvidence.excessKg}kg). ` +
              `Reason: ${overrideEvidence.reason}`
            : null,
        },
      });
    }

    if (!isStockBatch) await recalcOrderItemStatus(orderItemId, tx);

    if (newBatch.productionOrderId) {
      await recalcProductionOrderStatus(newBatch.productionOrderId, tx);
    }

    // ── Late lifecycle-serialization barrier ──────────────────────────────────
    // Last thing before commit, and deliberately after recalcOrderItemStatus above: this
    // transaction already holds the OrderItem row lock by then, so acquiring the Order row
    // lock here keeps roasting in the OrderItem-then-Order direction that preparation
    // review uses. Taking Order first instead would invert against review and deadlock.
    //
    // The gate at the top of this transaction read committed state as of its own start; a
    // Hold or Cancel committing during the roast is invisible to it. This re-check sees
    // that, and because it runs before commit the rollback takes the green decrement, the
    // batch, the inventory movement and the order-item recalculation with it — a refused
    // roast leaves stock exactly as it was.
    //
    // Stock batches are excluded: they have no customer order whose lifecycle could
    // invalidate them, and are bounded by their own privilege and the atomic stock check.
    if (!isStockBatch) await assertOrderStillAcceptsProduction(tx, orderItemId, "start");

    // Written last, and deliberately after the barrier above: the OrderActivity insert
    // takes FOR KEY SHARE on Order through its foreign key, and that barrier has just
    // taken the Order row, so this adds no new lock and no new ordering edge. Same
    // transaction as the roast, so a refused roast leaves no record of an override that
    // never happened.
    if (overrideEvidence && newBatch.orderItem) {
      await appendOrderActivity(tx, {
        orderId: newBatch.orderItem.orderId,
        type: "PRODUCTION_SURPLUS_OVERRIDDEN",
        message:
          `${user.name} authorized surplus production on batch ${newBatch.batchNumber}: ` +
          `${overrideEvidence.requestedKg}kg roasted against a ${overrideEvidence.ceilingKg}kg ` +
          `ceiling, exceeding it by ${overrideEvidence.excessKg}kg. Reason: ${overrideEvidence.reason}`,
        authorId: user.id,
        authorName: user.name,
        metadata: {
          batchId: newBatch.id,
          batchNumber: newBatch.batchNumber,
          orderItemId: newBatch.orderItemId,
          productionOrderId: newBatch.productionOrderId,
          ceilingKg: overrideEvidence.ceilingKg,
          requestedKg: overrideEvidence.requestedKg,
          excessKg: overrideEvidence.excessKg,
          reason: overrideEvidence.reason,
        },
      });
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
