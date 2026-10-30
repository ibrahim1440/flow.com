// Sales samples issued from finished-goods stock — the TRANSACTION (docs/sales/SAMPLES_INVENTORY.md).
//
// The rules (who may move a sample where, which lots, what it cost) are pure and live in sample-rules.ts; this file
// is the part that touches the shelf. It follows the delivery route (api/deliveries/route.ts) step for step, because
// a sample leaving the building is, for the shelf, a delivery with no order behind it:
//
//   1. lock the sample row (FOR UPDATE) and re-read it — the arbiter for a retry, a double click and two dispatchers
//      pressing «صرف» together: whoever waits behind the lock reads SENT and gets the original issue back (a replay),
//      never a second deduction;
//   2. lock the candidate lots in canonical id order (lockLotsInIdOrder — the shared FinishedGoodsLot order, so this
//      never deadlocks against a delivery, a reservation or a cancellation) and re-read their balances under the lock;
//   3. plan FIFO over FREE units only (unitsAvailable − unitsReserved): a unit promised to an order stays promised;
//   4. refuse a lot packed from a batch on QC hold (assertLotsNotHeld, the one guard every consuming path calls);
//   5. deduct with a conditional UPDATE that re-checks `unitsAvailable - unitsReserved >= n` — the same inequality the
//      reservation path uses, and the database's own "FinishedGoodsLot_units_ordered" check behind it — so stock can
//      never go below zero nor below what is reserved;
//   6. one InventoryMovement per lot (OUT · FINISHED_GOODS · SAMPLE, sourceDocId = the sample) — and the unique index
//      "InventoryMovement_sample_lot_once" (20261204090100) makes a second movement per (sample, lot) impossible;
//   6b. move the cost out of each lot's cost holder exactly as a delivery's COGS does (onSampleIssue, the units' share
//      at the moving average, the whole remainder when the lot empties) and queue Dr SAMPLES_EXPENSE / Cr
//      INVENTORY_PACKED (skipped before go-live; the holders move regardless) — the cost the sample records;
//   7. move the sample REQUESTED/PREPARING → SENT with a conditional update, record the movements, the lots and the
//      cost, schedule the rep's follow-up, and post the queued entry last (flushPostings) — all in the same
//      transaction, so either everything happened or nothing.
//
// Lock order: SampleShipment → FinishedGoodsLot (id ASC) → CostItem FG_LOT (kind, id) → the ledger counter (at the
// flush). Nothing else locks a sample row and then a lot, nothing that holds a lot ever waits for a sample row, and
// lot → holder → counter is the order every delivery already takes, so the new order cannot invert an existing one.
import { prisma, TX_OPTS } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { lockLotsInIdOrder } from "@/lib/services/order-operations";
import { assertLotsNotHeld, heldLotIds, heldRefusal } from "@/lib/services/qc/hold-guard";
import { atPromiseSite } from "@/lib/services/fg-site";
import { productionLocation, setStockLocation } from "@/lib/services/stock-locations";
import { kgForUnits } from "@/lib/services/finished-products";
import { Decimal } from "@/lib/services/commissions/engine";
import { flushPostings } from "@/lib/accounting/ops/cost-ledger";
import { onSampleIssue } from "@/lib/accounting/ops/inventory-events";
import {
  AWAITING_APPROVAL_REFUSAL, DISPATCHABLE_APPROVAL, planSampleLots, sampleTransitionRefusal, wholeUnits, type SampleLotCandidate,
} from "./sample-rules";

type Tx = Prisma.TransactionClient;

export type IssuedLot = { lotId: string; batchNumber: string; units: number; kg: number; movementId: string };
export type IssueOutcome = {
  replayed: boolean;
  sample: { id: string; status: string; issuedAt: Date | null; sentAt: Date | null; quantity: string; lots: IssuedLot[] };
  /** Internal: the cost the issue recorded. The routes decide whether a caller may see it (never a sales-only caller). */
  costValue: string | null;
};

type LockedSample = {
  id: string; status: string; fromStock: boolean; quantity: Prisma.Decimal; unit: string; productSkuId: string | null;
  opportunityId: string; description: string | null; createdById: string | null; issuedAt: Date | null; sentAt: Date | null;
  issueLots: unknown; costValue: Prisma.Decimal | null;
  /** A second sample of the product for the customer (20261205090000_sample_approval): issued only once approved. */
  approvalRequired: boolean; approvedAt: Date | null;
};

const NOT_FOUND = { _appCode: 404, code: "SAMPLE_NOT_FOUND", message: "العيّنة غير موجودة.", errorEn: "Sample not found." };

async function lockSample(tx: Tx, id: string): Promise<LockedSample | null> {
  const rows = await tx.$queryRaw<LockedSample[]>`
    SELECT "id", "status"::text AS "status", "fromStock", "quantity", "unit", "productSkuId", "opportunityId",
           "description", "createdById", "issuedAt", "sentAt", "issueLots", "costValue", "approvalRequired", "approvedAt"
      FROM "SampleShipment" WHERE "id" = ${id} FOR UPDATE`;
  return rows[0] ?? null;
}

function outcomeOf(s: LockedSample, replayed: boolean): IssueOutcome {
  return {
    replayed,
    sample: {
      id: s.id, status: s.status, issuedAt: s.issuedAt, sentAt: s.sentAt, quantity: new Decimal(s.quantity).toString(),
      lots: Array.isArray(s.issueLots) ? (s.issueLots as IssuedLot[]) : [],
    },
    costValue: s.costValue === null ? null : new Decimal(s.costValue).toFixed(2),
  };
}

/** A sample the dispatch queue may act on: a stock sample, not cancelled. */
function assertStockSample(s: LockedSample) {
  if (!s.fromStock) {
    throw {
      _appCode: 409, code: "SAMPLE_RECORD_ONLY",
      message: "هذه عيّنة للتسجيل فقط (بلا منتج بالعبوة)؛ لا تُصرف من المخزون.",
      errorEn: "This is a record-only sample (no product in units); it is not issued from stock.",
    };
  }
}

/**
 * Dispatch has started preparing a requested sample (REQUESTED → PREPARING). Moves no stock. Idempotent: a sample
 * already PREPARING answers as it is.
 */
export async function prepareSample(sampleId: string, db: typeof prisma = prisma) {
  return db.$transaction(async (tx) => {
    const s = await lockSample(tx, sampleId);
    if (!s) throw NOT_FOUND;
    assertStockSample(s);
    if (s.status === "PREPARING") return { id: s.id, status: s.status, replayed: true };
    // A second sample of the product waits for the sales manager: dispatch does not start on it either.
    if (s.status === "REQUESTED" && s.approvalRequired && !s.approvedAt) throw AWAITING_APPROVAL_REFUSAL;
    const refusal = sampleTransitionRefusal(true, s.status, "PREPARING", "dispatch");
    if (refusal) throw refusal;
    await tx.sampleShipment.update({ where: { id: s.id }, data: { status: "PREPARING" } });
    return { id: s.id, status: "PREPARING", replayed: false };
  }, TX_OPTS);
}

/**
 * Issue a requested stock sample: deduct its units from finished goods, once. See the file header for the steps.
 *
 * Replays (same answer, nothing written) when the sample was already issued — a retry after a lost answer, a double
 * click, or the loser of two concurrent issues. Refuses (409, coded) a record-only or cancelled sample, a shortfall of
 * free units (SAMPLE_STOCK_SHORT, with the free count) and stock on QC hold (BATCH_QC_HOLD).
 */
export async function issueSample(sampleId: string, actorId: string, db: typeof prisma = prisma): Promise<IssueOutcome> {
  return db.$transaction(async (tx) => {
    // ── 1. The sample, locked: the replay probe comes before every state-dependent refusal ──
    const s = await lockSample(tx, sampleId);
    if (!s) throw NOT_FOUND;
    assertStockSample(s);
    if (s.issuedAt) return outcomeOf(s, true);
    if (s.status === "CANCELLED") {
      throw {
        _appCode: 409, code: "SAMPLE_CANCELLED",
        message: "ألغى المندوب طلب هذه العيّنة؛ لا تُصرف.", errorEn: "The rep cancelled this sample request; it is not issued.",
      };
    }
    // Anything else that is not waiting (SENT / FEEDBACK_RECEIVED without an issue) is impossible under the CHECK
    // "SampleShipment_issued"; refused through the table so it is a coded 409, not a deduction.
    if (s.status !== "PREPARING" && s.status !== "REQUESTED") throw sampleTransitionRefusal(true, s.status, "SENT", "dispatch");
    // «للعميل من كل محصول عيّنة واحدة»: a second sample of the product is issued only once a sales manager approved it.
    // Checked here, under the sample's lock, so an approval and an issue racing each other cannot slip past it; the
    // CHECK "SampleShipment_approval_before_issue" refuses it again at the database.
    if (s.approvalRequired && !s.approvedAt) throw AWAITING_APPROVAL_REFUSAL;
    const units = wholeUnits(new Decimal(s.quantity));
    if (!units || !s.productSkuId) {
      // The CHECK "SampleShipment_from_stock_shape" makes this unreachable; kept so a broken row is a refusal, not a crash.
      throw { _appCode: 409, code: "SAMPLE_SHAPE", message: "كمية العيّنة ليست عددًا صحيحًا من العبوات.", errorEn: "The sample's quantity is not a whole number of units." };
    }
    const sku = await tx.productSKU.findUnique({ where: { id: s.productSkuId }, select: { id: true, skuCode: true, weightGrams: true, productId: true } });
    if (!sku) throw { _appCode: 409, code: "SAMPLE_SKU_GONE", message: "منتج العيّنة لم يعد موجودًا.", errorEn: "The sample's product no longer exists." };

    // ── 2. Where it leaves from, and the lots it may draw on ──
    // The production site — the dispatch default and the only site finished goods are promised from (fg-site.ts,
    // council F1). The movements take it as their location.
    const site = await productionLocation(tx);
    await setStockLocation(tx, site.id);
    const where: Prisma.FinishedGoodsLotWhereInput = {
      productSkuId: sku.id, isUnitTracked: true, status: "AVAILABLE", ...(await atPromiseSite(tx)),
    };
    // Unlocked read of the SET to lock; every balance is re-read after the locks are held.
    const ids = (await tx.finishedGoodsLot.findMany({ where, select: { id: true } })).map((l) => l.id);
    await lockLotsInIdOrder(tx, ids);
    const lots = ids.length
      ? await tx.finishedGoodsLot.findMany({
          where: { ...where, id: { in: ids } },
          select: { id: true, batchNumber: true, unitsAvailable: true, unitsReserved: true },
          // FIFO, the same order as reserveFinishedUnits: roasted coffee degrades, the oldest free lot leaves first.
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        })
      : [];
    // QC W3: held lots are never candidates. heldLotIds also covers the multi-source packing link that the
    // LOT_NOT_HELD filter does not, so it decides here; assertLotsNotHeld below is the explicit guard on the plan.
    const held = await heldLotIds(tx, lots.map((l) => l.id));
    const candidates: SampleLotCandidate[] = lots.map((l) => ({ ...l, held: held.has(l.id) }));

    // ── 3. The plan: free units only, oldest first ──
    const plan = planSampleLots(candidates, units);
    if (!plan.ok) {
      // Coffee is on the shelf but packed from a batch on QC hold: say so, rather than «not enough».
      if (plan.heldBatch && plan.free + plan.heldFree >= units) throw heldRefusal(plan.heldBatch, "deliver");
      throw {
        _appCode: 409, code: "SAMPLE_STOCK_SHORT",
        message: `المتاح غير المحجوز من ${sku.skuCode} ${plan.free} عبوة، والعيّنة ${units}. لم يُصرف شيء.`,
        errorEn: `Only ${plan.free} free unit(s) of ${sku.skuCode} (not reserved for an order); the sample needs ${units}. Nothing was issued.`,
        location: { locationId: site.id, free: plan.free, requested: units },
      };
    }
    // ── 4. QC hold: the one guard, on exactly the lots that will be drawn ──
    await assertLotsNotHeld(tx, plan.lots.map((p) => p.lotId), "deliver");

    // ── 5–6. Deduct lot by lot, one movement each ──
    const issued: IssuedLot[] = [];
    const costLines: { lotId: string; kg: number; units: number; unitsBefore: number; emptied: boolean; movementId: string }[] = [];
    for (const p of plan.lots) {
      const after = await tx.$queryRaw<{ unitsAvailable: number }[]>`
        UPDATE "FinishedGoodsLot"
           SET "unitsAvailable" = "unitsAvailable" - ${p.units},
               "status" = CASE WHEN "unitsAvailable" - ${p.units} <= 0 THEN 'SHIPPED'::"LotStatus" ELSE "status" END
         WHERE "id" = ${p.lotId}
           AND "status" = 'AVAILABLE'
           AND "isUnitTracked" = true
           AND ("unitsAvailable" - "unitsReserved") >= ${p.units}
     RETURNING "unitsAvailable"`;
      // Unreachable while the lots are locked; if it ever happens nothing commits (the throw rolls everything back).
      if (after.length !== 1) {
        throw { _appCode: 409, code: "SAMPLE_STOCK_CHANGED", message: "تغيّر المخزون أثناء الصرف. أعد المحاولة.", errorEn: "The stock changed while the sample was being issued. Please retry." };
      }
      const newUnits = after[0].unitsAvailable;
      const prevUnits = newUnits + p.units;
      const kg = kgForUnits(sku, p.units);
      const movement = await tx.inventoryMovement.create({
        data: {
          type: "OUT",
          category: "FINISHED_GOODS",
          referenceEntityId: p.lotId,
          quantityChanged: -kg,
          previousQuantity: kgForUnits(sku, prevUnits),
          newQuantity: kgForUnits(sku, newUnits),
          sourceDocType: "SAMPLE",
          sourceDocId: s.id,
          userId: actorId,
          notes: `${p.units} x ${sku.skuCode} · عيّنة مبيعات`,
        },
        select: { id: true },
      });
      issued.push({ lotId: p.lotId, batchNumber: p.batchNumber, units: p.units, kg, movementId: movement.id });
      costLines.push({ lotId: p.lotId, kg, units: p.units, unitsBefore: prevUnits, emptied: newUnits <= 0, movementId: movement.id });
    }

    // ── 6b. The cost leaves the lots' cost holders (accounting/ops/inventory-events.ts onSampleIssue) ──
    // Exactly as a delivery's COGS issues a lot (the units' share of the holder, the whole remainder when the lot is
    // emptied), so the sample's cost never leaks into the next delivery's COGS nor strands on an emptied lot; posted
    // Dr SAMPLES_EXPENSE / Cr INVENTORY_PACKED once accounting is live (skipped before go-live, the holders still
    // move). The deal's customer is the entry's party. `costValue` is exactly the value that left the holders.
    const deal = await tx.opportunity.findUnique({ where: { id: s.opportunityId }, select: { ownerId: true, customerId: true } });
    // Read under the lots' locks (a holder only moves with its lot locked), before the issue moves it.
    const hadCost = (await tx.costItem.count({
      where: { tenantId: "hiqbah", kind: "FG_LOT", entityId: { in: costLines.map((l) => l.lotId) }, OR: [{ qty: { gt: 0 } }, { value: { gt: 0 } }] },
    })) > 0;
    // «الموقع» of the entry: the branch the issuing site is mapped to (release gate N4).
    const siteBranch = await tx.stockLocation.findUnique({ where: { id: site.id }, select: { finBranchId: true } });
    const moved = await onSampleIssue(tx, {
      sampleId: s.id, skuId: sku.id, productId: sku.productId, customerId: deal?.customerId ?? null,
      label: `${units} x ${sku.skuCode}`, lines: costLines, actor: actorId, branchId: siteBranch?.finBranchId ?? null,
    });
    // Null only when no lot drawn had any cost on record (a holder with neither quantity nor value): unknown, not free.
    const cost: Decimal | null = moved.value.isZero() && !hadCost ? null : new Decimal(moved.value.toFixed(2));

    // ── 7. The sample becomes SENT, with everything the issue produced ──
    const now = new Date();
    const won = await tx.sampleShipment.updateMany({
      where: { id: s.id, status: { in: ["REQUESTED", "PREPARING"] }, issuedAt: null },
      data: {
        status: "SENT", sentAt: now, issuedAt: now, issuedById: actorId,
        movementIds: issued.map((l) => l.movementId),
        issueLots: issued as unknown as Prisma.InputJsonValue,
        costValue: cost ? cost.toFixed(2) : null,
      },
    });
    // Unreachable under the row lock; a refusal (and a full rollback) rather than a second deduction if it ever is.
    if (won.count !== 1) throw { _appCode: 409, code: "SAMPLE_STATE_CHANGED", message: "تغيّرت حالة العيّنة أثناء الصرف.", errorEn: "The sample changed while it was being issued." };

    // A sample that nobody follows up is a sample that was given away. The task goes to the deal's owner (the rep who
    // will hear what the customer thought), in this same transaction.
    const ownerId = deal?.ownerId ?? s.createdById;
    if (ownerId) {
      await tx.activity.create({
        data: {
          type: "SAMPLE_FOLLOW_UP",
          subject: `Follow up on sample: ${s.description || sku.skuCode}`,
          opportunityId: s.opportunityId,
          dueAt: new Date(now.getTime() + 7 * 86400_000),
          ownerId,
        },
      });
    }

    // Accounting A3: the queued SAMPLES_EXPENSE entry posts last, after every row this transaction locks (flushPostings).
    await flushPostings(tx);
    return outcomeOf({ ...s, status: "SENT", issuedAt: now, sentAt: now, issueLots: issued, costValue: cost ? new Prisma.Decimal(cost.toFixed(2)) : null }, false);
  }, TX_OPTS);
}

/** The dispatch queue's rows: stock samples requested and not yet issued (oldest first — the first asked, the first served). */
export async function pendingSamples(db: typeof prisma = prisma) {
  const rows = await db.sampleShipment.findMany({
    // A second sample of a product that waits for the sales manager is not dispatch's yet (DISPATCHABLE_APPROVAL).
    where: { fromStock: true, status: { in: ["REQUESTED", "PREPARING"] }, ...DISPATCHABLE_APPROVAL },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 200,
    select: {
      id: true, status: true, quantity: true, description: true, createdAt: true,
      productSku: { select: { id: true, skuCode: true, name: true, nameAr: true, weightGrams: true } },
      opportunity: { select: { customer: { select: { name: true, nameAr: true } }, owner: { select: { name: true } } } },
    },
  });
  return rows;
}
