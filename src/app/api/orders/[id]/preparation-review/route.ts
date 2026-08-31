import { NextResponse } from "next/server";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import {
  appendOrderActivity,
  aggregatePreparationStatus,
  isPreparationDecision,
  PREPARATION_REVIEW_ENTRY_STATUSES,
  NOTE_MESSAGE_MAX_LENGTH,
  type PreparationDecision,
} from "@/lib/services/order-operations";
import {
  ALLOCATABLE_ITEM_SELECT,
  decisionFor,
  kgEqual,
  releaseShelfStock,
  reserveShelfStock,
  roundKg,
} from "@/lib/services/shelf-allocation";
import { kgForUnits, releaseFinishedUnits, reserveFinishedUnits } from "@/lib/services/finished-products";

type Params = { params: Promise<{ id: string }> };

type RawItem = {
  orderItemId?: unknown;
  decision?: unknown;
  availableQuantity?: unknown;
  productionRequiredQuantity?: unknown;
};

type ParsedItem = {
  orderItemId: string;
  // null = "you work it out from stock". Non-null = a claim the server must be able to back.
  decision: PreparationDecision | null;
  availableQuantity: number | null;
  productionRequiredQuantity: number | null;
};

const ENTRY_STATUSES = PREPARATION_REVIEW_ENTRY_STATUSES as string[];

export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireSub("orders", "prepare_review");
  if (error) return error;

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { items, note } = (body ?? {}) as { items?: unknown; note?: unknown };

  if (!Array.isArray(items) || items.length === 0) {
    return NextResponse.json({ error: "items must be a non-empty array." }, { status: 400 });
  }

  const trimmedNote = typeof note === "string" ? note.trim() : "";
  if (trimmedNote.length > NOTE_MESSAGE_MAX_LENGTH) {
    return NextResponse.json(
      { error: `note must be at most ${NOTE_MESSAGE_MAX_LENGTH} characters.` },
      { status: 400 }
    );
  }

  // Structural + value validation of every submitted item before any DB access.
  const seenIds = new Set<string>();
  const parsedItems: ParsedItem[] = [];

  for (const raw of items as RawItem[]) {
    if (typeof raw.orderItemId !== "string" || !raw.orderItemId) {
      return NextResponse.json({ error: "Each item requires a valid orderItemId." }, { status: 400 });
    }
    if (seenIds.has(raw.orderItemId)) {
      return NextResponse.json(
        { error: `Duplicate orderItemId in request: ${raw.orderItemId}` },
        { status: 400 }
      );
    }
    seenIds.add(raw.orderItemId);

    // The decision is now OPTIONAL. Omit it and the server derives it from real stock;
    // send it and it is treated as a claim that must match what the shelf can back.
    const decisionValue = raw.decision === undefined || raw.decision === null || raw.decision === ""
      ? null
      : raw.decision;
    if (decisionValue !== null && !isPreparationDecision(decisionValue)) {
      return NextResponse.json(
        {
          error: `Invalid decision for item ${raw.orderItemId}. Must be one of: Available on Shelf, Needs Production, Partially Available, Blocked.`,
        },
        { status: 400 }
      );
    }

    let availableQuantity: number | null = null;
    if (raw.availableQuantity !== undefined && raw.availableQuantity !== null && raw.availableQuantity !== "") {
      const n = Number(raw.availableQuantity);
      if (!Number.isFinite(n)) {
        return NextResponse.json(
          { error: `availableQuantity for item ${raw.orderItemId} must be a number.` },
          { status: 400 }
        );
      }
      availableQuantity = n;
    }

    let productionRequiredQuantity: number | null = null;
    if (
      raw.productionRequiredQuantity !== undefined &&
      raw.productionRequiredQuantity !== null &&
      raw.productionRequiredQuantity !== ""
    ) {
      const n = Number(raw.productionRequiredQuantity);
      if (!Number.isFinite(n)) {
        return NextResponse.json(
          { error: `productionRequiredQuantity for item ${raw.orderItemId} must be a number.` },
          { status: 400 }
        );
      }
      productionRequiredQuantity = n;
    }

    parsedItems.push({
      orderItemId: raw.orderItemId,
      decision: decisionValue,
      availableQuantity,
      productionRequiredQuantity,
    });
  }

  if (parsedItems.some((i) => i.decision === "Blocked") && !trimmedNote) {
    return NextResponse.json(
      { error: "note is required when any item is marked Blocked." },
      { status: 400 }
    );
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id },
        select: {
          id: true,
          status: true,
          items: { select: { id: true, quantityKg: true } },
        },
      });
      if (!order) throw { _appCode: 404, message: "Order not found." };

      if (!ENTRY_STATUSES.includes(order.status)) {
        throw {
          _appCode: 409,
          message: `Preparation review is not allowed while the order is in status "${order.status}".`,
        };
      }

      const itemsById = new Map(order.items.map((i) => [i.id, i]));
      for (const p of parsedItems) {
        if (!itemsById.has(p.orderItemId)) {
          throw { _appCode: 400, message: `Order item ${p.orderItemId} does not belong to this order.` };
        }
      }

      // ── Shelf-first allocation ────────────────────────────────────────────
      // The split between "already on the shelf" and "must be roasted" is no longer
      // taken on trust from the request body. For every item the server reserves what
      // the shelf can actually cover — atomically, so two reviews racing for the same
      // kilograms cannot both win — and derives the decision from what it managed to
      // hold. A decision supplied by the client is then only a claim, and a claim the
      // stock cannot back is refused rather than silently stored.
      const outcomes: {
        orderItemId: string;
        decision: PreparationDecision;
        availableQuantity: number;
        productionRequiredQuantity: number;
        reservedFromLots: { lotId: string; batchNumber: string; quantityKg: number }[];
      }[] = [];

      // Every line's row in one query rather than one query per line. Against a database
      // where a round trip costs about 167 ms, fetching them inside the loop made a
      // three-line review pay three round trips before it had reserved anything. The rows
      // are only read here — the atomic claims below are unchanged, so nothing about
      // concurrency depends on when they were fetched.
      const itemRows = await tx.orderItem.findMany({
        where: { id: { in: parsedItems.map((p) => p.orderItemId) } },
        select: {
          ...ALLOCATABLE_ITEM_SELECT,
          quantityUnits: true,
          deliveredUnits: true,
          productSku: { select: { weightGrams: true } },
        },
      });
      const itemRowsById = new Map(itemRows.map((r) => [r.id, r]));

      for (const p of parsedItems) {
        const item = itemRowsById.get(p.orderItemId);
        if (!item) throw { _appCode: 404, message: `Order item ${p.orderItemId} not found.` };

        // ── SKU lines reserve whole units ──────────────────────────────────
        // A line created through the Finished Products flow is a quantity of one SKU,
        // and finished goods are counted in units. It draws on unit-tracked lots through
        // reserveFinishedUnits; the kilogram path below is for the legacy bean-based
        // lines only, and the two pools are disjoint so neither can spend the other's
        // stock. availableQuantity / productionRequiredQuantity stay in kilograms in both
        // cases — they are Float columns that have always meant kg — derived here from
        // the units actually reserved.
        if (item.quantityUnits !== null && item.productSkuId && item.productSku) {
          const sku = item.productSku;
          await releaseFinishedUnits(tx, item.id);

          const demandUnits = Math.max(0, item.quantityUnits - item.deliveredUnits);

          if (p.decision === "Blocked") {
            outcomes.push({
              orderItemId: item.id,
              decision: "Blocked",
              availableQuantity: 0,
              productionRequiredQuantity: kgForUnits(sku, demandUnits),
              reservedFromLots: [],
            });
            continue;
          }

          const takenUnits = await reserveFinishedUnits(
            tx,
            { id: item.id, productSkuId: item.productSkuId, productSku: sku },
            demandUnits,
            user.id
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
          continue;
        }

        // Re-reviewing an item starts from a clean slate: hand back what it holds, then
        // take a fresh reservation against the shelf as it stands now.
        await releaseShelfStock(tx, item.id);

        const demand = roundKg(Math.max(0, item.quantityKg - item.deliveredQty));

        // Blocked means "do not proceed with this item" — it must not sit on stock.
        if (p.decision === "Blocked") {
          outcomes.push({
            orderItemId: item.id,
            decision: "Blocked",
            availableQuantity: 0,
            productionRequiredQuantity: demand,
            reservedFromLots: [],
          });
          continue;
        }

        const taken = await reserveShelfStock(tx, item, demand, user.id);
        const reserved = taken.reservedKg;
        const stillNeeded = roundKg(Math.max(0, demand - reserved));
        const derived = decisionFor(stillNeeded, reserved) as PreparationDecision;

        // A client-supplied decision is honoured only when the shelf agrees with it.
        if (p.decision !== null && p.decision !== derived) {
          throw {
            _appCode: 409,
            message:
              `Item ${item.id}: "${p.decision}" is not supported by stock. ` +
              `${reserved}kg of ${demand}kg can be covered from the shelf, so the decision is "${derived}".`,
            computed: { orderItemId: item.id, decision: derived, availableQuantity: reserved, productionRequiredQuantity: stillNeeded },
          };
        }

        // Quantities sent by the client are cross-checked, never trusted.
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
      }

      for (const o of outcomes) {
        await tx.orderItem.update({
          where: { id: o.orderItemId },
          data: {
            preparationDecision: o.decision,
            // Server-derived, at the repo-wide 3-decimal kg precision.
            availableQuantity: o.availableQuantity,
            productionRequiredQuantity: o.productionRequiredQuantity,
            // productionStatus, deliveryStatus, remainingQty intentionally omitted —
            // these remain system-derived (recalcOrderItemStatus) and must never be
            // written by preparation review.
          },
        });
      }

      const refreshedItems = await tx.orderItem.findMany({
        where: { orderId: id },
        select: { preparationDecision: true },
      });
      const newStatus = aggregatePreparationStatus(refreshedItems);

      // Conditional guard: only applies if the order is still in an entry status we
      // already verified above. Catches a concurrent Hold/Cancel that landed between
      // our read and this write.
      const updateResult = await tx.order.updateMany({
        where: { id, status: { in: ENTRY_STATUSES } },
        data: { status: newStatus },
      });
      if (updateResult.count === 0) {
        throw { _appCode: 409, message: "Order status changed during review. Please reload and retry." };
      }

      await appendOrderActivity(tx, {
        orderId: id,
        type: "PREPARATION_REVIEWED",
        message: `Preparation review submitted by ${user.name} for ${parsedItems.length} item(s). Order status set to ${newStatus}.`,
        department: "Preparation",
        authorId: user.id,
        authorName: user.name,
        metadata: {
          // The server-derived outcome, including which lots were actually reserved —
          // the audit trail now records what the shelf gave, not what was typed.
          items: outcomes.map((o) => ({
            orderItemId: o.orderItemId,
            decision: o.decision,
            availableQuantity: o.availableQuantity,
            productionRequiredQuantity: o.productionRequiredQuantity,
            reservedFromLots: o.reservedFromLots,
          })),
        },
      });

      if (trimmedNote) {
        await appendOrderActivity(tx, {
          orderId: id,
          type: "MANUAL_NOTE",
          message: trimmedNote,
          department: "Preparation",
          authorId: user.id,
          authorName: user.name,
        });
      }

      return tx.order.findUnique({
        where: { id },
        select: {
          id: true,
          status: true,
          items: {
            select: {
              id: true,
              preparationDecision: true,
              availableQuantity: true,
              productionRequiredQuantity: true,
            },
          },
        },
      });
    }, TX_OPTS);

    return NextResponse.json(result);
  } catch (err: unknown) {
    if (err && typeof err === "object" && "_appCode" in err) {
      const e = err as { _appCode: number; message: string; computed?: unknown };
      // On a rejected claim the server hands back what it actually computed, so the
      // review screen can correct itself without a second round trip.
      return NextResponse.json(
        e.computed === undefined ? { error: e.message } : { error: e.message, computed: e.computed },
        { status: e._appCode }
      );
    }
    return handlePrismaError(err);
  }
}
