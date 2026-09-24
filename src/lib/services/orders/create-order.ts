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
 * Write the order and its lines, taking the next order number.
 *
 * The retry loop is not decoration: `orderNumber` is unique and derived from the current
 * maximum, so two orders raised in the same second race for it. Five attempts on P2002 is
 * what the route has always done and is preserved exactly.
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
