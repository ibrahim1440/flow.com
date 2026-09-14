// A value import, not a type-only one: Prisma.join below builds the IN list for the
// FOR UPDATE query, and Prisma.InventoryMovementCreateManyInput is used as a type from the
// same namespace.
import { Prisma } from "@/generated/prisma/client";

type PrismaTx = Prisma.TransactionClient;

/**
 * Blending as a stock transformation.
 *
 * Roasted coffee leaves several batches and the same quantity arrives in one. That sentence
 * is the whole specification, and the route did not implement any half of it: it never
 * decremented a source, and it created the output with no usable roasted balance at all.
 * What it did instead was flip each source's status to "Blended" and sum their ORIGINAL
 * roast weights into the output's roastedBeanQuantity.
 *
 * The consequences compound. Every roasted-stock figure counted the coffee twice, because
 * the sources kept their balances and the output carried its own quantity. The output could
 * never be packed, because pack-sku spends roastedAvailableKg and the output's was zero.
 * And blending a partly-packed batch claimed its full original roast — coffee that had
 * already been sold.
 *
 * ── No blend loss ───────────────────────────────────────────────────────────
 * The domain has no transformation-loss rule anywhere, so this conserves mass exactly:
 * what comes out is what went in, to the kilogram. Inventing a yield figure here would be
 * inventing stock.
 */

export type BlendSourceRequest = { batchId: string; quantityKg: number | null };

export type LockedSource = {
  id: string;
  batchNumber: string;
  status: string;
  isBlend: boolean;
  productId: string | null;
  orderItemId: string | null;
  productionOrderId: string | null;
  roastedAvailableKg: number;
};

/** Half a gram — below the 3-decimal storage precision, matching the packaging routes. */
const EPSILON = 0.0005;

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Turn either request shape into one canonical list.
 *
 * Two shapes exist because the original contract blends WHOLE batches — the production
 * screen simply sends the ids it has ticked — while anything that needs to move part of a
 * batch has to say how much. A null quantity means "all of it", resolved once the source's
 * real balance is known and locked, never from the client's idea of it.
 *
 * Sorted by id so that every caller, whatever order the operator clicked in, produces the
 * same acquisition order downstream. Duplicates are refused rather than merged: a request
 * naming the same batch twice is a caller bug, and silently adding the quantities together
 * would hide it.
 */
export function normalizeBlendSources(body: {
  batchIds?: unknown;
  sources?: unknown;
}): BlendSourceRequest[] {
  let list: BlendSourceRequest[];

  if (Array.isArray(body.sources) && body.sources.length > 0) {
    list = body.sources.map((raw) => {
      const s = (raw ?? {}) as { batchId?: unknown; quantityKg?: unknown };
      if (typeof s.batchId !== "string" || !s.batchId) {
        throw { _appCode: 400, message: "Each blend source needs a batchId." };
      }
      if (s.quantityKg === undefined || s.quantityKg === null) {
        return { batchId: s.batchId, quantityKg: null };
      }
      const qty = Number(s.quantityKg);
      if (!Number.isFinite(qty) || qty <= 0) {
        throw {
          _appCode: 400,
          message: "Each blend source quantity must be a number greater than zero.",
        };
      }
      return { batchId: s.batchId, quantityKg: round3(qty) };
    });
  } else if (Array.isArray(body.batchIds) && body.batchIds.length > 0) {
    list = body.batchIds.map((id) => {
      if (typeof id !== "string" || !id) {
        throw { _appCode: 400, message: "Each blend source needs a batchId." };
      }
      return { batchId: id, quantityKg: null };
    });
  } else {
    throw { _appCode: 400, message: "Select at least 2 batches to blend" };
  }

  if (list.length < 2) {
    throw { _appCode: 400, message: "Select at least 2 batches to blend" };
  }

  const seen = new Set<string>();
  for (const s of list) {
    if (seen.has(s.batchId)) {
      throw {
        _appCode: 400,
        message: "The same batch is listed twice in this blend. List each source once.",
      };
    }
    seen.add(s.batchId);
  }

  return [...list].sort((a, b) => (a.batchId < b.batchId ? -1 : a.batchId > b.batchId ? 1 : 0));
}

/**
 * Take every source's row lock, in one canonical order.
 *
 * A blend is the only operation in this system that holds several RoastingBatch rows at
 * once, which makes it the only one that can deadlock against ITSELF: two operators blending
 * the same two batches in opposite orders would each hold what the other needs. Ordering by
 * id removes that possibility outright, and it is the order the caller's list was already
 * normalised into.
 *
 * RoastingBatch sits at the top of the certified hierarchy, so taking several of them before
 * anything else costs no ordering guarantees.
 */
export async function lockBlendSources(
  tx: PrismaTx,
  batchIds: readonly string[],
): Promise<LockedSource[]> {
  if (batchIds.length === 0) return [];
  return tx.$queryRaw<LockedSource[]>`
    SELECT "id", "batchNumber", "status", "isBlend", "productId", "orderItemId",
           "productionOrderId", "roastedAvailableKg"
      FROM "RoastingBatch"
     WHERE "id" IN (${Prisma.join([...batchIds])})
     ORDER BY "id" ASC
       FOR UPDATE
  `;
}

export type ValidatedBlend = {
  /** Per source, the exact kilograms this blend will take. */
  plan: { source: LockedSource; quantityKg: number }[];
  totalKg: number;
  commonStatus: string;
};

/**
 * Decide what may be taken, from rows that are already locked.
 *
 * Availability is read from roastedAvailableKg — the balance that has not yet been spent —
 * and never from roastedBeanQuantity, which is the batch's original roast output and stays
 * fixed for life. Using the latter as spendable stock is what let a half-packed batch be
 * blended as though it were whole.
 */
export function validateBlendSources(
  requested: readonly BlendSourceRequest[],
  locked: readonly LockedSource[],
): ValidatedBlend {
  if (locked.length !== requested.length) {
    throw { _appCode: 404, message: "One or more batches not found" };
  }

  const byId = new Map(locked.map((l) => [l.id, l]));

  if (locked.some((l) => l.isBlend)) {
    throw { _appCode: 400, message: "Cannot blend a batch that is already a blend output" };
  }

  const statuses = new Set(locked.map((l) => l.status));
  if (statuses.size > 1) {
    throw {
      _appCode: 400,
      message:
        'Cannot mix batches with different statuses. All selected batches must be either "Pending QC" or "Passed".',
    };
  }
  const commonStatus = locked[0].status;

  const plan = requested.map((r) => {
    const source = byId.get(r.batchId);
    if (!source) throw { _appCode: 404, message: "One or more batches not found" };

    // A null quantity means the whole batch, resolved from the locked balance rather than
    // from whatever the client believed it to be.
    const quantityKg = r.quantityKg ?? round3(source.roastedAvailableKg);

    if (quantityKg <= 0) {
      throw {
        _appCode: 409,
        message: `Batch ${source.batchNumber} has no roasted coffee left to blend.`,
      };
    }
    if (quantityKg > source.roastedAvailableKg + EPSILON) {
      throw {
        _appCode: 409,
        message:
          `Batch ${source.batchNumber} only has ${round3(source.roastedAvailableKg)}kg of roasted ` +
          `coffee left, so ${quantityKg}kg cannot be taken from it.`,
      };
    }
    return { source, quantityKg };
  });

  return { plan, totalKg: round3(plan.reduce((s, p) => s + p.quantityKg, 0)), commonStatus };
}

/**
 * Spend the coffee.
 *
 * Conditional even though every row is already locked: the WHERE clause is what makes the
 * balance impossible to overdraw, and it keeps working if the lock is ever moved. Same
 * pattern, and the same half-gram tolerance, the packaging routes use.
 *
 * A source is only marked "Blended" when nothing is left of it. Flipping a partly-consumed
 * batch would strand its remainder: "Blended" is not in PACKABLE_BATCH_STATUSES, so the
 * coffee still sitting in it could never be packed or blended again. parentBatchId follows
 * the same rule — a batch that survives belongs to no single blend, and BlendIngredient is
 * the record of where its coffee went.
 */
export async function consumeBlendSources(
  tx: PrismaTx,
  plan: ValidatedBlend["plan"],
  blendBatchId: string,
): Promise<{ sourceId: string; before: number; after: number; taken: number }[]> {
  const consumed: { sourceId: string; before: number; after: number; taken: number }[] = [];

  for (const { source, quantityKg } of plan) {
    const drawn = await tx.$executeRaw`
      UPDATE "RoastingBatch"
         SET "roastedAvailableKg" = "roastedAvailableKg" - ${quantityKg}
       WHERE "id" = ${source.id}
         AND ("roastedAvailableKg" + ${EPSILON}) >= ${quantityKg}
    `;
    if (drawn !== 1) {
      throw {
        _appCode: 409,
        message:
          `Batch ${source.batchNumber} no longer has ${quantityKg}kg of roasted coffee ` +
          "available — it was used while this blend was being prepared. Nothing was blended.",
      };
    }

    const after = round3(source.roastedAvailableKg - quantityKg);
    if (after <= EPSILON) {
      await tx.roastingBatch.update({
        where: { id: source.id },
        data: { status: "Blended", parentBatchId: blendBatchId },
      });
    }

    consumed.push({
      sourceId: source.id,
      before: round3(source.roastedAvailableKg),
      after,
      taken: quantityKg,
    });
  }

  return consumed;
}

/**
 * The ledger for the transformation.
 *
 * One OUT per source and one IN for the blend, so the movement of the coffee can be
 * reconstructed from the ledger alone. SourceDocType.BLEND already existed in the schema and
 * had never been written by anything — no new movement type is invented here, and no
 * migration is needed to record this.
 *
 * Every row carries a source document, which is what the regression harness checks when it
 * looks for movements that cannot be traced back to the operation that caused them.
 */
export async function recordBlendMovements(
  tx: PrismaTx,
  params: {
    blendBatchId: string;
    blendBatchNumber: string;
    consumed: { sourceId: string; before: number; after: number; taken: number }[];
    totalKg: number;
    userId: string | null;
  },
): Promise<void> {
  const rows: Prisma.InventoryMovementCreateManyInput[] = params.consumed.map((c) => ({
    type: "OUT" as const,
    category: "ROASTED_COFFEE" as const,
    referenceEntityId: c.sourceId,
    quantityChanged: -c.taken,
    previousQuantity: c.before,
    newQuantity: c.after,
    sourceDocType: "BLEND" as const,
    sourceDocId: params.blendBatchId,
    userId: params.userId,
    notes: `Blended into ${params.blendBatchNumber}`,
  }));

  rows.push({
    type: "IN",
    category: "ROASTED_COFFEE",
    referenceEntityId: params.blendBatchId,
    quantityChanged: params.totalKg,
    // A blend output is a new batch, so it starts from nothing and receives the whole
    // transformation in one movement.
    previousQuantity: 0,
    newQuantity: params.totalKg,
    sourceDocType: "BLEND",
    sourceDocId: params.blendBatchId,
    userId: params.userId,
    notes: `Blended from ${params.consumed.length} batch(es)`,
  });

  await tx.inventoryMovement.createMany({ data: rows });
}
