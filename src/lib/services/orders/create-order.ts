import type { Prisma as PrismaNS } from "@/generated/prisma/client";
import { kgForUnits } from "@/lib/services/finished-products";

type Client = PrismaNS.TransactionClient;

/**
 * Creating a sales order — the one implementation.
 *
 * Extracted from POST /api/orders when quotations gained the ability to become orders.
 * There is deliberately no second path: a quote does not build its own order rows, it
 * calls this. The packaging work on this codebase established why in the most expensive
 * possible way — two routes each writing inventory their own way, one of them able to
 * fabricate sellable stock, and the difference invisible until someone read both.
 *
 * Every rule below was in the route before and is unchanged: SKU-only lines, whole units,
 * the SKU must be active, kilograms are derived and never supplied, and there is no stock
 * gate here because a sales order reserves finished goods later, at preparation review.
 */

export type RawOrderLine = {
  productSkuId?: unknown;
  quantityUnits?: unknown;
};

export type ResolvedOrderLine = {
  beanTypeName: string;
  quantityKg: number;
  quantityUnits: number;
  greenBeanId: string | null;
  remainingQty: number;
  productId: string | null;
  productSkuId: string;
};

/**
 * Turn client-supplied lines into the rows an order is made of, refusing anything that is
 * not a whole number of an active SKU.
 *
 * Refusals are thrown as `{ _appCode, message }` rather than returned as a response, so
 * this stays callable from a transaction and from a route alike. `handleDomainError` maps
 * them back to the status they asked for.
 */
export async function resolveOrderLines(
  db: Client,
  items: RawOrderLine[],
): Promise<ResolvedOrderLine[]> {
  const resolved: ResolvedOrderLine[] = [];

  for (const item of items) {
    // SKU-only. A sales line is a quantity of one finished product; the coffee, origin,
    // pack size, price and BOM all follow from the SKU, so none of them is asked for.
    // Legacy bean-based lines stay readable but cannot be created any more.
    if (typeof item.productSkuId !== "string" || !item.productSkuId) {
      throw {
        _appCode: 400,
        message: "Each order line requires a productSkuId. Select a finished product.",
      };
    }

    const units = Number(item.quantityUnits);
    if (!Number.isInteger(units) || units <= 0) {
      throw { _appCode: 400, message: "quantityUnits must be a whole number greater than zero." };
    }

    const sku = await db.productSKU.findUnique({
      where: { id: item.productSkuId },
      include: { product: { select: { id: true, productNameEn: true, defaultGreenBeanId: true } } },
    });
    if (!sku) throw { _appCode: 400, message: "Product SKU not found." };
    if (!sku.isActive) {
      throw { _appCode: 400, message: `"${sku.skuCode}" is inactive and cannot be sold.` };
    }

    resolved.push({
      // Kept populated for the dispatch, history and export screens that read it.
      beanTypeName: sku.product.productNameEn,
      // Derived from units — never supplied by the client, never a rival total.
      quantityKg: kgForUnits(sku, units),
      quantityUnits: units,
      // Traceability only. A sales order never draws on green coffee; this records which
      // bean the SKU is made from so production can follow the chain.
      greenBeanId: sku.product.defaultGreenBeanId ?? null,
      remainingQty: kgForUnits(sku, units),
      productId: sku.productId,
      productSkuId: sku.id,
    });
  }

  return resolved;
}

export type NewOrderHeader = {
  customerId: string;
  quotationNumber?: string | null;
  quotationSentDate?: Date | null;
  notes?: string | null;
};

/**
 * Serialise order-number allocation across concurrent callers.
 *
 * `orderNumber` is unique and derived from the current maximum, so two callers reading it
 * at the same moment pick the same number and one of them loses on the unique index.
 *
 * ── Why this had to be added when quotations learned to raise orders ──
 * The retry-on-P2002 loop below has always been enough for `POST /api/orders`, because that
 * route calls this on the plain client: each `create` is its own implicit transaction, so a
 * duplicate-key failure rolls back only that statement and the next attempt proceeds.
 *
 * Inside an explicit transaction that is no longer true. PostgreSQL aborts the WHOLE
 * transaction on the error, and every statement after it fails with "current transaction is
 * aborted" — so the retry cannot retry, and a routine numbering race would surface as a
 * confusing failure rather than a second attempt. The quotation-to-order path runs in a
 * transaction, because the order and the link row that makes it idempotent have to commit
 * together.
 *
 * A transaction-scoped advisory lock fixes it properly: callers queue for the number
 * instead of racing for it, so the collision does not happen at all. Namespace 7764,
 * alongside the numbering locks this codebase already uses — 7761 for production orders by
 * year, 7763 for roasting batches by date.
 *
 * Taken on the plain client the lock releases immediately (each statement is its own
 * transaction), which is harmless: that path still has its retry.
 *
 * ── Lock order ──
 * This codebase states its canonical lock order wherever two locks can be held at once, so:
 * within the quotation-to-order path the Quote row is taken `FOR UPDATE` FIRST and this
 * advisory lock second, and no caller does it the other way round. A second conversion of
 * the SAME quote therefore waits on the quote row before it can reach the advisory lock, so
 * it can never hold 7764 while waiting for a quote row somebody else holds. A conversion of
 * a DIFFERENT quote holds its own unrelated row. There is no inversion either way.
 */
const ORDER_NUMBER_LOCK_NAMESPACE = 7764;

/**
 * Write the order and its lines, taking the next order number.
 *
 * The retry loop is kept as a second line of defence, for the non-transactional path where
 * the advisory lock above cannot hold. Five attempts on P2002 is what the route has always
 * done and is preserved exactly.
 */
export async function createOrderWithNumber(
  db: Client,
  header: NewOrderHeader,
  lines: ResolvedOrderLine[],
) {
  if (lines.length === 0) {
    // An order with no lines is not a smaller order, it is a stuck one: it consumes an
    // order number, can be approved and reviewed, aggregates to "Waiting Preparation
    // Review" forever and can never reach Ready for Shipping.
    throw { _appCode: 400, message: "An order must have at least one line." };
  }

  // Before reading the maximum, not after: the point is that nobody else is between the
  // read and the write.
  await db.$executeRaw`SELECT pg_advisory_xact_lock(${ORDER_NUMBER_LOCK_NAMESPACE}, 0)`;

  for (let attempt = 0; attempt < 5; attempt++) {
    const lastOrder = await db.order.findFirst({ orderBy: { orderNumber: "desc" } });
    const nextNumber = (lastOrder?.orderNumber || 0) + 1;
    try {
      return await db.order.create({
        data: {
          customerId: header.customerId,
          quotationNumber: header.quotationNumber ?? null,
          quotationSentDate: header.quotationSentDate ?? null,
          notes: header.notes ?? null,
          orderNumber: nextNumber,
          // Routine approval is not part of the normal path any more, so a new order goes
          // straight to the state Commit Allocation runs from. Written explicitly rather
          // than left to the column default, because the default still describes the
          // legacy workflow and existing rows in it must keep their meaning.
          status: "Waiting Preparation Review",
          items: { create: lines },
        },
        include: { customer: true, items: true },
      });
    } catch (e: unknown) {
      const code = e && typeof e === "object" && "code" in e ? (e as { code: string }).code : null;
      if (code === "P2002" && attempt < 4) continue;
      throw e;
    }
  }

  throw new Error("Order creation failed after retries.");
}
