import type { Prisma } from "@/generated/prisma/client";

type PrismaTx = Prisma.TransactionClient;

/**
 * Which coffee a roasting batch actually is, and which order line it was roasted for.
 *
 * Both questions used to be answered inline, differently, by each packaging route, and both
 * answers were wrong in the same direction: they trusted a nullable field and fell back to
 * the request body when it was null.
 *
 * ── Why batch.productId cannot be the answer ────────────────────────────────
 * An order-backed roast is created with productId left undefined — the roasting route says
 * so in as many words: "Stock batches carry the product on the batch itself; order-backed
 * ones keep inheriting it from their order item at packaging time". So the column is NULL
 * for every batch raised against an order, which is most of them, and the SKU route's guard
 *
 *     r.coffeeProductId && batch.productId && r.coffeeProductId !== batch.productId
 *
 * short-circuits on that null and matches nothing. A guard written to stop an Ethiopian SKU
 * being packed out of a Brazilian roast could not fire on the batches it existed for.
 *
 * The identity is knowable — it is just not on the batch. It is in the order line the roast
 * was raised against, or in the production order it was raised under, and the shape of those
 * relations is what this module reads.
 */

/** The columns identity is derived from. Both routes already select them under the lock. */
export type IdentifiableBatch = {
  productId: string | null;
  orderItemId: string | null;
  productionOrderId: string | null;
};

export type CoffeeIdentity =
  | { ok: true; productId: string; sources: readonly string[] }
  | { ok: false; status: number; message: string };

/**
 * Prove which coffee this batch is, from backend records only.
 *
 * Every source consulted is authoritative: a foreign key the backend wrote, not something a
 * caller supplied. They are COLLECTED rather than ranked, because ranking is what hides a
 * contradiction — a batch whose own productId says one coffee while its order line says
 * another is a database that disagrees with itself, and quietly preferring whichever source
 * was checked first would stamp a lot with a coffee nobody can vouch for.
 *
 * Deliberately does NOT walk BlendIngredient. A blend output's composition is R2.5's
 * subject, and inferring identity from ingredients needs attribution rules that do not exist
 * yet. A blend that carries an explicit productId resolves through source A like anything
 * else; one that does not fails closed, which is the honest answer today.
 */
export async function resolveBatchCoffeeIdentity(
  tx: PrismaTx,
  batch: IdentifiableBatch,
): Promise<CoffeeIdentity> {
  // productId -> the human-readable sources that vouch for it.
  const candidates = new Map<string, string[]>();
  const add = (productId: string | null | undefined, source: string) => {
    if (!productId) return;
    const seen = candidates.get(productId);
    if (seen) seen.push(source);
    else candidates.set(productId, [source]);
  };

  // A — the batch's own coffee. Set on stock roasts, null on order-backed ones.
  add(batch.productId, "the batch");

  // B — the order line the roast was raised against. Its SKU carries a non-nullable
  // productId, and the orders API writes productId and productSkuId from the same SKU, so
  // for any line created through the API these two agree by construction. They are both
  // read anyway: if they ever disagree, that is a contradiction worth stopping for.
  if (batch.orderItemId) {
    const line = await tx.orderItem.findUnique({
      where: { id: batch.orderItemId },
      select: { productId: true, productSku: { select: { productId: true } } },
    });
    add(line?.productSku?.productId, "the order line's product");
    add(line?.productId, "the order line");
  }

  // C — the production order the roast was raised under. ProductionOrder.productSkuId is
  // NOT NULL, so this is a direct and unambiguous coffee: no traversal through
  // sourceOrderItemId is needed, and none is done.
  if (batch.productionOrderId) {
    const po = await tx.productionOrder.findUnique({
      where: { id: batch.productionOrderId },
      select: { productSku: { select: { productId: true } } },
    });
    add(po?.productSku?.productId, "the production order");
  }

  if (candidates.size === 0) {
    return {
      ok: false,
      status: 409,
      message:
        "Coffee identity for this roasting batch cannot be proven. It carries no product, " +
        "no order line and no production order, so there is nothing to check a finished " +
        "product against.",
    };
  }

  if (candidates.size > 1) {
    // Names the disagreeing records, never their ids: the operator needs to know which
    // screens to go and look at, not internal keys.
    const where = [...candidates.values()].map((s) => s[0]).join(" and ");
    return {
      ok: false,
      status: 409,
      message:
        `This roasting batch is attributed to more than one coffee — ${where} do not agree — ` +
        "so it cannot be packaged until the records are corrected.",
    };
  }

  const [productId, sources] = [...candidates.entries()][0];
  return { ok: true, productId, sources };
}

/**
 * The order line freshly packed stock should be promised to, if there is one.
 *
 * Returns null for a roast to stock, which has no owner and whose output is meant to land
 * free-to-promise. Returns null too when the attribution is ambiguous: a batch that is
 * somehow tied to two different lines is not a reservation decision this code should be
 * making on its own, and reserving to the wrong order is worse than reserving to none.
 *
 * Separate from identity on purpose. "Which coffee is this?" gates whether packaging may
 * happen at all; "whose is it?" only decides where the units are promised. Conflating them
 * would mean an ambiguous owner blocked packaging that is otherwise perfectly legitimate.
 */
export async function resolvePackagingReservationTarget(
  tx: PrismaTx,
  batch: IdentifiableBatch,
): Promise<string | null> {
  const owners = new Set<string>();
  if (batch.orderItemId) owners.add(batch.orderItemId);

  if (batch.productionOrderId) {
    const po = await tx.productionOrder.findUnique({
      where: { id: batch.productionOrderId },
      select: { sourceOrderItemId: true },
    });
    if (po?.sourceOrderItemId) owners.add(po.sourceOrderItemId);
  }

  return owners.size === 1 ? [...owners][0] : null;
}

/**
 * How many more units this line may still have promised to it.
 *
 * ordered − delivered − already reserved, in units, and never from quantityKg: a SKU line's
 * kilogram figure is derived from its units for reporting, so using it as the ceiling would
 * reintroduce the denomination confusion the unit columns exist to remove.
 *
 * Blocked lines are not handled here — a blocked line is refused by canReserveToOrderLine
 * before this is reached, which keeps "how much is wanted" separate from "may it be
 * promised at all".
 */
export async function outstandingUnitsForLine(
  tx: PrismaTx,
  line: { id: string; quantityUnits: number; deliveredUnits: number },
): Promise<number> {
  const reserved = await tx.stockAllocation.aggregate({
    where: { orderItemId: line.id, status: "RESERVED", quantityUnits: { not: null } },
    _sum: { quantityUnits: true },
  });
  const alreadyReserved = reserved._sum.quantityUnits ?? 0;
  return Math.max(0, line.quantityUnits - line.deliveredUnits - alreadyReserved);
}
