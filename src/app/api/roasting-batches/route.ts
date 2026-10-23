import { batchProductId, resolveApprovedVersionId } from "@/lib/services/qc/profiles";
import { NextResponse } from "@/lib/api-response";
import { Prisma } from "@/generated/prisma/client";
import { prisma, TX_OPTS } from "@/lib/db";
import { adminRoleGate, assertAdminRoleGate, requireAnyModule, requireSub } from "@/lib/auth-server";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { handleDomainError } from "@/lib/api-error";
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
import { emitAutomationEvent } from "@/lib/automation/emit";
import { canSeeCustomerContact, CUSTOMER_OPERATIONS_SELECT } from "@/lib/auth/customer-detail";
import { nextRoastBatchNumber } from "@/lib/services/batch-number";
import { resolveGreenLot } from "@/lib/services/green-source";
import { autoPrepareAfterBatches } from "@/lib/services/orders/preparation";
import { roastQueue } from "@/lib/services/roast-queue";
import { checkRoasterForRoast, logRoasterControls, type RoasterCheckResult } from "@/lib/services/roaster-controls";
import { readRoastRequestKey, roastIntentHash, isRoastKeyConflict, ROAST_IDEMPOTENCY_MISMATCH, ROAST_IDEMPOTENCY_MISMATCH_AR } from "@/lib/services/roast-idempotency";
import { completeStationClaim } from "@/lib/services/station/claims";
import { linkBatchToSlot, ScheduleError } from "@/lib/services/schedule/schedule-db";
import { scheduleError } from "@/lib/services/schedule/http";
import { lossVerdict } from "@/lib/station/shared";

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

/**
 * A queue roast may come out a little over the coffee's demand: a drum load is not cut to the
 * gram, and the roaster records what physically happened (production simplification principle).
 * Up to the larger of 1 kg or 20 % of the coffee's demand, the excess simply goes to the shelf —
 * recorded on the ledger row — for anyone who may roast. Beyond it, roasting for the shelf is the
 * roast_to_stock privilege (or the admin's explicit surplus authorization), as before.
 */
const QUEUE_SURPLUS_TOLERANCE = { minKg: 1, share: 0.2 };
const queueTolerance = (demandKg: number) => Math.max(QUEUE_SURPLUS_TOLERANCE.minKg, QUEUE_SURPLUS_TOLERANCE.share * demandKg);

class AppError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Thrown inside the transaction when the key's batch already exists (rolls the attempt back). */
class ReplayFound extends Error {}

/**
 * The batch an Idempotency-Key already recorded, as a 200 replay — or a 422 when the key was used
 * for a different roast. Null when the key has recorded nothing yet.
 */
async function replayOf(requestKey: string, intentHash: string) {
  const done = await prisma.roastingBatch.findUnique({ where: { requestKey }, include: { orderItem: true, greenBean: true } });
  if (!done) return null;
  if (done.intentHash !== intentHash) {
    return NextResponse.json({ error: ROAST_IDEMPOTENCY_MISMATCH_AR, errorEn: ROAST_IDEMPOTENCY_MISMATCH, code: "IDEMPOTENCY_MISMATCH" }, { status: 422 });
  }
  return NextResponse.json({ ...done, replayed: true }, { status: 200 });
}

export async function GET(request: Request) {
  // QC and Packaging workers need to read batches for their own workflow stages
  const { user, error } = await requireAnyModule("production", "qc", "packaging");
  if (error) return error;
  // F4 / review F-1: the batch screens draw the customer's name and roast targets; the contact
  // fields go only to holders of the customer contact right (customers module).
  const customerContact = canSeeCustomerContact(user.permissions);

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
          order: {
            include: {
              customer: customerContact ? { include: { roastPreferences: true } } : { select: CUSTOMER_OPERATIONS_SELECT },
            },
          },
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
      // Guests invited to the QC panel who have not evaluated yet (D4). Name and channel only:
      // the guest's phone stays in the invite row.
      qcInvites: { where: { status: "PENDING" }, select: { id: true, name: true, channel: true, createdAt: true }, orderBy: { createdAt: "asc" as const } },
      blendInputs: { select: { id: true, sourceBatchId: true, quantityUsed: true, sourceBatch: { select: { batchNumber: true } } } },
      blendOutputs: { select: { id: true, targetBlendBatchId: true, quantityUsed: true, targetBlendBatch: { select: { batchNumber: true } } } },
    },
  });
  return NextResponse.json(batches);
}

export async function POST(request: Request) {
  const { error, user } = await requireSub("production", "start_batch");
  if (error) return error;

  // ── Idempotency (Workstations W1, D8; the Delivery.requestKey pattern) ─────────────────
  // Optional, so every caller that predates it records exactly as before. With a key, a retry of
  // the same roast answers with the batch already recorded (200, replayed) instead of a second
  // batch; the same key carrying a different roast is a 422.
  const keyRead = readRoastRequestKey(request);
  if (!keyRead.ok) return NextResponse.json({ error: keyRead.message, errorEn: keyRead.en }, { status: 400 });
  const requestKey = keyRead.key;

  const data = await request.json().catch(() => ({}));
  const { productId, greenBeanQuantity, roastedBeanQuantity, roastProfile, productionOrderId, surplusOverride, surplusReason } = data;
  let orderItemId: string | undefined = typeof data.orderItemId === "string" && data.orderItemId ? data.orderItemId : undefined;

  // ── Roaster (D5) and station claim (W1): both optional ───────────────────────────────────
  if (data.roasterId !== undefined && data.roasterId !== null && data.roasterId !== "" && typeof data.roasterId !== "string") {
    return NextResponse.json({ error: "معرّف الحمّاصة غير صالح.", errorEn: "roasterId must be a roaster id." }, { status: 400 });
  }
  const roasterId: string | null = typeof data.roasterId === "string" && data.roasterId ? data.roasterId : null;
  const claimId: string | null = typeof data.claimId === "string" && data.claimId ? data.claimId : null;
  // ── The roasting schedule (RM6–RM8): the slot this roast is recorded from, optional ─────────
  if (data.scheduledSlotId !== undefined && data.scheduledSlotId !== null && data.scheduledSlotId !== "" && typeof data.scheduledSlotId !== "string") {
    return NextResponse.json({ error: "معرّف الخانة غير صالح.", errorEn: "scheduledSlotId must be a slot id." }, { status: 400 });
  }
  const scheduledSlotId: string | null = typeof data.scheduledSlotId === "string" && data.scheduledSlotId ? data.scheduledSlotId : null;
  const lossReason: string | null = typeof data.lossReason === "string" && data.lossReason.trim() ? data.lossReason.trim().slice(0, 200) : null;
  const intentHash = requestKey ? roastIntentHash(data) : null;

  if (requestKey) {
    // Fast replay probe; the advisory lock and the unique index below are the real control.
    const done = await replayOf(requestKey, intentHash!);
    if (done) return done;
  }

  // A slot belongs to one roaster: a roast recorded on another roaster is not that slot (409).
  // The rest of the slot's rules (cancelled, already recorded, the coffee) are decided by
  // linkBatchToSlot inside the transaction, under the schedule lock.
  if (scheduledSlotId) {
    const slot = await prisma.scheduledSlot.findUnique({ where: { id: scheduledSlotId }, select: { roasterId: true } });
    if (!slot) return scheduleError(new ScheduleError(404, "الخانة غير موجودة.", "Slot not found.", "NOT_FOUND"));
    if (roasterId && slot.roasterId !== roasterId) {
      return NextResponse.json({
        error: "هذه الخانة مخططة على محمصة أخرى. سجّل الدفعة على محمصة الخانة أو دون خانة.",
        errorEn: "This slot is planned on another roaster. Record the roast on the slot's roaster, or without the slot.",
        code: "SLOT_ROASTER_MISMATCH", slotRoasterId: slot.roasterId,
      }, { status: 409 });
    }
  }

  // ── The roast queue (production simplification, Phase C item 2) ─────────────────────────
  // `allocate: "oldest"` with a productId and no order line: the roaster tapped a coffee card.
  // The server attributes the batch to the oldest order line of that coffee that still needs
  // roasting (open units − shelf free − pipeline, src/lib/services/roast-queue.ts) and that
  // production may start for. With no such line it is a roast to stock (its own privilege).
  // The surplus gate is the COFFEE's demand, not one line's: a drum load larger than what is
  // ordered goes to the shelf for whoever holds roast_to_stock, and otherwise needs the
  // explicit admin authorization the per-line gate asks for. Re-resolved under the lock below.
  const queueMode = data.allocate === "oldest" && !orderItemId;
  let queueDemandKg = 0;
  if (queueMode) {
    if (typeof productId !== "string" || !productId) {
      return NextResponse.json({ error: "productId is required to roast from the queue." }, { status: 400 });
    }
    if (productionOrderId) {
      return NextResponse.json({ error: "A queue roast is linked to its production order automatically; do not name one." }, { status: 400 });
    }
    const [coffee] = await roastQueue(prisma, { productId });
    queueDemandKg = coffee?.demandKg ?? 0;
    orderItemId = coffee?.allocateTo?.orderItemId ?? undefined;
  }

  // ── The green lot: stated, or resolved here (production simplification item 1, O1) ──────
  // A roast still always consumes a specific green lot — the stock decrement and the ledger OUT
  // row below are unconditional — but the roaster no longer has to name it. Omitted, it is
  // resolved inside the transaction from the product's default lot, falling back FIFO to the
  // oldest active lot of the same beanType + country (src/lib/green-source.ts); a 409 tells the
  // roaster to ask the supervisor when none holds enough. A stated greenBeanId is honoured as
  // before (the supervisor's «تغيير», and every existing client).
  const statedGreenBeanId: string | null =
    typeof data.greenBeanId === "string" && data.greenBeanId ? data.greenBeanId : null;
  if (data.greenBeanId !== undefined && data.greenBeanId !== null && data.greenBeanId !== "" && statedGreenBeanId === null) {
    return NextResponse.json({ error: "greenBeanId must be a green lot id." }, { status: 400 });
  }

  const qty = Number(greenBeanQuantity);
  if (!Number.isFinite(qty) || qty <= 0) {
    return NextResponse.json({ error: "greenBeanQuantity must be a positive number." }, { status: 400 });
  }

  const roastedQty = Number(roastedBeanQuantity ?? 0);
  if (!Number.isFinite(roastedQty) || roastedQty <= 0) {
    return NextResponse.json({ error: "Roasted quantity must be greater than 0." }, { status: 400 });
  }
  if (roastedQty > qty) {
    return NextResponse.json({ error: "roastedBeanQuantity cannot exceed greenBeanQuantity." }, { status: 400 });
  }
  // W1: a station roast whose loss is above the boundary carries its reason (classification only,
  // no stock). The boundary is the one the ERP roast sheet already uses (src/lib/station/shared.ts).
  if (claimId) {
    const product = typeof productId === "string" && productId ? await prisma.coffeeProduct.findUnique({ where: { id: productId }, select: { expectedRoastLoss: true } }) : null;
    const loss = lossVerdict(qty, roastedQty, product?.expectedRoastLoss ?? null);
    if (loss?.tone === "above" && !lossReason) {
      return NextResponse.json({ error: "الفاقد فوق الحد: اختر سبب الفاقد.", errorEn: "The loss is above the boundary: choose the loss reason.", code: "LOSS_REASON_REQUIRED" }, { status: 422 });
    }
  }

  // D5: a chosen roaster is checked before anything else is decided (operator, nominal, min–max).
  // No roaster chosen → nothing here runs, exactly as before.
  let roasterCheck: RoasterCheckResult | null = null;
  if (roasterId) {
    try {
      roasterCheck = await checkRoasterForRoast(prisma, { roasterId, greenKg: qty, ack: data.ack === true, user });
    } catch (err) {
      return handleDomainError(err);
    }
    // An admin who is not an assigned operator is never blocked by the operator rule; the admin
    // role is exercised as everywhere else (admin-role gate: a verified individual — SIMPLE MODE
    // waives that — no step-up), and the bypass is logged with the batch.
    if (roasterCheck.bypass) {
      const refused = await adminRoleGate(user, "production.roaster_operator_bypass");
      if (refused) return refused;
    }
  }

  // Roast loss is what physically happened: green in − roasted out. It is derived, never typed
  // (the manual «waste» input is gone from the roast sheet); a client that still sends
  // wasteQuantity has it ignored rather than stored beside a contradicting pair of weights.
  const wasteQty = +(qty - roastedQty).toFixed(3);

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
  if (queueMode && isStockBatch && !hasSubPrivilege(user.permissions, "production", "roast_to_stock")) {
    return NextResponse.json(
      { error: "Nothing is waiting to be roasted for this coffee: its orders are covered by the shelf or by batches already roasted. Roasting more would be a roast to stock, which your role does not include." },
      { status: 409 }
    );
  }
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
  const creditPoId = isStockBatch || queueMode
    ? null
    : ((productionOrderId as string | undefined) ?? (await soleLiveProductionOrderId(prisma, orderItemId as string)));
  const ceiling = isStockBatch || queueMode
    ? null
    : await roastingCeilingForItem(prisma, orderItemId as string, creditPoId);
  if (!isStockBatch && !queueMode && !ceiling) {
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
  const productionCeiling = queueMode && !isStockBatch ? queueDemandKg : ceiling ? ceiling.ceilingKg : Infinity;
  const excess = +(roastedQty - productionCeiling).toFixed(3);
  // A queue roast larger than the coffee's demand: the remainder is a roast to stock.
  const queueSurplusToStock = queueMode && excess > 0 &&
    (hasSubPrivilege(user.permissions, "production", "roast_to_stock") || excess <= queueTolerance(productionCeiling));

  // The decision is taken once, here, and re-taken inside the transaction against live
  // numbers. Both use the same function, so "admin, explicitly, with a reason" means the
  // same thing in both places.
  const surplus = excess > 0 && !queueSurplusToStock
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
  // An authorized surplus is the admin role exercised: a verified individual, after a recent
  // step-up (as the override of a batch is, inventory.override).
  if (surplus?.ok) {
    const refused = await adminRoleGate(user, "production.surplus_override", { stepUp: true });
    if (refused) return refused;
  }
  // ─────────────────────────────────────────────────────────────────────────

  try {
  const batch = await prisma.$transaction(async (tx) => {
    // Idempotency: one transaction per key at a time, then the probe again under the lock. The
    // loser of a race waits here and then finds the winner's batch (answered as a replay).
    if (requestKey) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(7763, ${advisoryKey(`roast-key:${requestKey}`)}::int)`;
      const already = await tx.roastingBatch.findUnique({ where: { requestKey }, select: { id: true } });
      if (already) throw new ReplayFound();
    }
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
    // Queue roast: serialise roasts of the same coffee (7762 keyed on the product — taken before
    // any line key, and no other path takes a product key, so no cycle), then re-resolve the
    // line and the coffee's demand as this transaction sees them.
    let queueEvidence: { demandKg: number; toStockKg: number } | null = null;
    if (queueMode && !isStockBatch) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(7762, ${advisoryKey(`product:${productId as string}`)}::int)`;
      const [liveCoffee] = await roastQueue(tx, { productId: productId as string });
      const target = liveCoffee?.allocateTo?.orderItemId ?? null;
      if (!target) {
        throw { _appCode: 409, message: "This coffee's orders were covered while the roast was being recorded. Nothing was roasted; refresh the queue." };
      }
      orderItemId = target;
      const liveDemand = liveCoffee!.demandKg;
      const liveExcess = +(roastedQty - liveDemand).toFixed(3);
      if (liveExcess > 0 && !hasSubPrivilege(user.permissions, "production", "roast_to_stock") && liveExcess > queueTolerance(liveDemand)) {
        const liveDecision = evaluateSurplusOverride(user.role, surplusOverride, surplusReason);
        if (!liveDecision.ok) {
          throw { _appCode: liveDecision.status === 400 ? 400 : 409, message: `Only ${liveDemand}kg of this coffee is still needed; this roast exceeds it by ${liveExcess}kg. ` + liveDecision.message };
        }
        if (!surplus?.ok) await assertAdminRoleGate(user, "production.surplus_override", { stepUp: true });
        overrideEvidence = { ceilingKg: liveDemand, requestedKg: roastedQty, excessKg: liveExcess, reason: liveDecision.reason };
      }
      queueEvidence = { demandKg: liveDemand, toStockKg: liveExcess > 0 && !overrideEvidence ? liveExcess : 0 };
    }

    if (!isStockBatch) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(7762, ${advisoryKey(orderItemId as string)}::int)`;

      // Re-asked now that this transaction is the only one that can be asking. Everything
      // before the transaction was advisory; this is the answer that counts.
      // Re-resolved inside the lock: another transaction may have raised or completed a
      // plan since the pre-check, and the credit has to match the world this roast commits
      // into rather than the one it arrived in.
      const liveCreditPoId = queueMode
        ? null
        : (productionOrderId as string | undefined) ??
          (await soleLiveProductionOrderId(tx, orderItemId as string));
      const live = queueMode ? null : await roastingCeilingForItem(tx, orderItemId as string, liveCreditPoId);
      if (!queueMode && !live) throw new AppError(404, "Order item not found.");
      const liveExcess = live ? +(roastedQty - live.ceilingKg).toFixed(3) : 0;
      if (live && liveExcess > 0) {
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
        // Surplus that appeared in flight was not gated above: gate it here.
        if (!surplus?.ok) await assertAdminRoleGate(user, "production.surplus_override", { stepUp: true });
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
    const batchNumber = await nextRoastBatchNumber(tx);

    let previousQuantity: number | null = null;
    let newQuantity:      number | null = null;

    // The lot, resolved under this transaction when the request did not state one.
    let greenBeanId: string = statedGreenBeanId ?? "";
    let greenSource: { source: "stated" | "default" | "fifo_fallback"; fallbackFrom: string | null } = { source: "stated", fallbackFrom: null };
    if (!statedGreenBeanId) {
      const pick = await resolveGreenLot(tx, isStockBatch ? { productId: productId as string } : { orderItemId: orderItemId as string }, qty);
      greenBeanId = pick.lot.id;
      greenSource = { source: pick.source, fallbackFrom: pick.source === "fifo_fallback" ? pick.defaultLot?.serialNumber ?? null : null };
    }

    {
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
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: 2,
      });
      // A queue roast is the system's attribution, not the operator's choice: with two live
      // plans on the line it credits the oldest rather than refusing (Phase C item 3).
      if (candidates.length === 1 || (queueMode && candidates.length > 1)) {
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
    // QC station W3 (owner decision 1): the batch is judged against the roast-profile version
    // APPROVED for its product (and green coffee) NOW, stored on the batch — never re-derived later
    // and never the batch itself. None approved → its QC shows «المواصفة قيد المعايرة».
    const profileVersionId = await resolveApprovedVersionId(
      tx,
      await batchProductId(tx, { productId: isStockBatch ? (productId as string) : null, orderItemId: isStockBatch ? null : (orderItemId as string) }),
      greenBeanId,
    );
    const newBatch = await tx.roastingBatch.create({
      data: {
        orderItemId: isStockBatch ? null : orderItemId,
        // Stock batches carry the product on the batch itself; order-backed ones keep
        // inheriting it from their order item at packaging time, as before.
        productId: isStockBatch ? (productId as string) : undefined,
        greenBeanId,
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
        roasterId:           roasterCheck ? roasterCheck.roaster.id : null,
        requestKey,
        intentHash,
        profileVersionId,
      },
      include: { orderItem: true, greenBean: true },
    });

    // The roasting schedule: the slot this roast was recorded from becomes RECORDED, in this
    // transaction (a refusal — cancelled, already recorded, another coffee — rolls the roast back).
    // A replay never reaches this line: it answers with the batch, already linked, above.
    if (scheduledSlotId) {
      await linkBatchToSlot(tx, { slotId: scheduledSlotId, batchId: newBatch.id, actor: { id: user.id, name: user.name } });
    }

    if (previousQuantity !== null && newQuantity !== null) {
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
          notes: [
            overrideEvidence
              ? `Surplus authorized: ${overrideEvidence.requestedKg}kg roasted against a ` +
                `${overrideEvidence.ceilingKg}kg ceiling (+${overrideEvidence.excessKg}kg). ` +
                `Reason: ${overrideEvidence.reason}`
              : null,
            queueEvidence && queueEvidence.toStockKg > 0
              ? `Roast queue: ${queueEvidence.toStockKg}kg beyond the coffee's ${queueEvidence.demandKg}kg demand goes to the shelf (roast to stock).`
              : null,
            // O1: the lot was chosen by the system because the product's default was short.
            greenSource.source === "fifo_fallback"
              ? `Green lot chosen automatically (FIFO, same bean and origin): the default lot ${greenSource.fallbackFrom ?? ""} held too little.`
              : null,
          ].filter(Boolean).join(" ") || null,
        },
      });
    }

    if (!isStockBatch) await recalcOrderItemStatus(orderItemId as string, tx);

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
    if (!isStockBatch) await assertOrderStillAcceptsProduction(tx, orderItemId as string, "start");

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

    // D5: the acknowledgement of a charge outside min–max, and an admin's operator bypass.
    if (roasterCheck) {
      await logRoasterControls(tx, roasterCheck, {
        batch: newBatch, requestKey, greenKg: qty, user, sourceInterface: claimId ? "STATION" : "WEB",
      });
    }
    // W1: the station's claim on this work ends with the roast it was claimed for.
    if (claimId) {
      await completeStationClaim(tx, { claimId, user, batch: newBatch, requestKey, lossReason, body: { productId, productionOrderId } });
    }

    await emitAutomationEvent(tx, {
      eventType: "production.batch_roasted",
      subjectType: "RoastingBatch",
      subjectId: newBatch.id,
      actorId: user.id,
    });

    return { ...newBatch, scheduledSlotId: scheduledSlotId ?? newBatch.scheduledSlotId, greenSource, roaster: roasterCheck ? { id: roasterCheck.roaster.id, name: roasterCheck.roaster.name, acknowledged: !!roasterCheck.ack, adminBypass: roasterCheck.bypass } : null, ...(queueMode ? { queue: { allocatedTo: newBatch.orderItemId, demandKg: queueEvidence?.demandKg ?? 0, toStockKg: queueEvidence?.toStockKg ?? 0 } } : {}) };
  }, TX_OPTS);

  // Phase B item 4: the order the roast was made for is recomputed after the commit.
  if (batch.orderItemId) await autoPrepareAfterBatches([batch.id], "roast", { id: user.id, name: user.name });

  return NextResponse.json(batch, { status: 201 });
  } catch (err: unknown) {
    // Another request with this key committed first: answer with its batch.
    if (requestKey && (err instanceof ReplayFound || isRoastKeyConflict(err))) {
      const done = await replayOf(requestKey, intentHash!);
      if (done) return done;
      return NextResponse.json({ error: "تعذّر تأكيد هذه الدفعة. أعد المحاولة بالطلب نفسه.", errorEn: "This roast could not be confirmed. Please retry with the same request." }, { status: 503 });
    }
    if (err instanceof AppError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    // The slot link (409 SLOT_RECORDED / COFFEE_MISMATCH / SLOT_CANCELLED, 404).
    if (err instanceof ScheduleError) return scheduleError(err);
    // The production-planning guards throw the `{ _appCode, message }` shape the newer
    // routes use, rather than this file's older AppError class.
    // (handleDomainError keeps a refusal's code, e.g. REAUTH_REQUIRED, for the client.)
    return handleDomainError(err);
  }
}
