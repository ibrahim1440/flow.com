import type { Prisma as PrismaNS } from "@/generated/prisma/client";
import { resolveOrderLines, createOrderWithNumber } from "@/lib/services/orders/create-order";

type Tx = PrismaNS.TransactionClient;

/**
 * Turning an accepted quotation into a real order.
 *
 * This is the join between the CRM and the operational ERP, and it is deliberately thin:
 * it decides WHETHER an order may be raised and WHAT the lines are, then hands both to the
 * order service. It does not write Order rows itself. A CRM that grew its own order writer
 * would be a second way into the same inventory, differing from the first in ways nobody
 * would notice until a warehouse count disagreed.
 *
 * ── Idempotency ──
 * `OpportunityOrder.requestKey` is unique, and the default key is derived from the quote.
 * A double-clicked "Create order" therefore produces one order and a second response that
 * reports the first, rather than two orders for one agreement. The unique index is the
 * arbiter; the row lock in front of it only decides who waits.
 */

export type ConversionResult = {
  orderId: string;
  orderNumber: number;
  linkId: string;
  isFirstOrder: boolean;
  /** True when this call found an existing order instead of creating one. */
  replayed: boolean;
};

/** The default idempotency key: one accepted quotation, one order. */
export function quoteRequestKey(quoteId: string): string {
  return `quote:${quoteId}`;
}

/**
 * Create the order an accepted quotation entitles the customer to.
 *
 * Refusals, and why each one is a refusal rather than a best guess:
 *
 *  - **Not accepted.** An order committed against a draft or issued quote is an order for
 *    a price nobody agreed to.
 *  - **No customer.** The order system is keyed on Customer; a deal still at "some café in
 *    Jeddah" has nobody to invoice.
 *  - **A line with no SKU.** Quotations may carry free-text lines — a bespoke blend, a
 *    delivery charge — and the ERP has no way to pick, roast or ship one. Refused with the
 *    line named, rather than silently dropped, because silently dropping a line ships an
 *    order the customer did not agree to.
 *  - **A fractional pack count.** The quantity that reaches an order line is whole units.
 *    A 2.5 on a retail bag would round somewhere, and rounding somebody's order is not a
 *    decision this code gets to make.
 */
export async function createOrderFromQuote(
  tx: Tx,
  input: {
    quoteId: string;
    actorId: string;
    requestKey?: string | null;
    notes?: string | null;
  },
): Promise<ConversionResult> {
  const requestKey = input.requestKey?.trim() || quoteRequestKey(input.quoteId);

  // Serialise on the quote, so two clicks queue instead of racing towards the unique index.
  const locked = await tx.$queryRaw<{ id: string; status: string }[]>`
    SELECT "id", "status"::text AS status FROM "Quote" WHERE "id" = ${input.quoteId} FOR UPDATE
  `;
  if (!locked[0]) throw { _appCode: 404, message: "Quotation not found." };

  // Behind the lock, with nothing cheaper in front of it.
  const existing = await tx.opportunityOrder.findUnique({
    where: { requestKey },
    select: {
      id: true,
      isFirstOrder: true,
      order: { select: { id: true, orderNumber: true } },
    },
  });
  if (existing) {
    return {
      orderId: existing.order.id,
      orderNumber: existing.order.orderNumber,
      linkId: existing.id,
      isFirstOrder: existing.isFirstOrder,
      replayed: true,
    };
  }

  if (locked[0].status !== "ACCEPTED") {
    throw {
      _appCode: 409,
      message:
        `An order is raised from an accepted quotation. This one is ${locked[0].status.toLowerCase()}.`,
    };
  }

  const quote = await tx.quote.findUniqueOrThrow({
    where: { id: input.quoteId },
    select: {
      id: true, quoteNumber: true, customerId: true, opportunityId: true, issuedAt: true,
      opportunity: { select: { id: true, customerId: true } },
      lines: {
        orderBy: { position: "asc" },
        select: {
          productSkuId: true, description: true, quantity: true, position: true,
          productSku: { select: { skuCode: true, unitOfMeasure: true } },
        },
      },
    },
  });

  const customerId = quote.customerId ?? quote.opportunity.customerId;
  if (!customerId) {
    throw {
      _appCode: 409,
      message: "This deal has no customer, so there is nobody to raise an order for. Link a customer first.",
    };
  }

  const items: { productSkuId: string; quantityUnits: number }[] = [];
  for (const line of quote.lines) {
    if (!line.productSkuId) {
      throw {
        _appCode: 409,
        message:
          `Line ${line.position + 1} ("${line.description ?? "no description"}") has no catalogue product, ` +
          "so it cannot be ordered. Replace it with a product, or raise the order for the remaining lines " +
          "from a revised quotation.",
      };
    }
    const qty = line.quantity;
    if (!qty.equals(qty.trunc())) {
      throw {
        _appCode: 409,
        message:
          `Line ${line.position + 1} (${line.productSku?.skuCode ?? "product"}) is for ${qty.toString()} packs. ` +
          "An order is placed in whole packs; revise the quotation before ordering.",
      };
    }
    items.push({ productSkuId: line.productSkuId, quantityUnits: qty.toNumber() });
  }

  // The order service's own validation runs on top of this: active SKU, whole positive
  // units, derived kilograms. Nothing here duplicates it, and nothing here bypasses it.
  const resolved = await resolveOrderLines(tx, items);
  const order = await createOrderWithNumber(
    tx,
    {
      customerId,
      // The quotation reference the operational screens already show, now actually true.
      quotationNumber: quote.quoteNumber,
      quotationSentDate: quote.issuedAt,
      notes: input.notes?.trim() || null,
    },
    resolved,
  );

  // First order on the deal, or repeat business? The attribution policy may treat them
  // differently, so it is recorded rather than re-derived later from dates.
  const priorOrders = await tx.opportunityOrder.count({
    where: { opportunityId: quote.opportunityId },
  });

  const link = await tx.opportunityOrder.create({
    data: {
      opportunityId: quote.opportunityId,
      quoteId: quote.id,
      orderId: order.id,
      isFirstOrder: priorOrders === 0,
      requestKey,
      createdById: input.actorId,
    },
    select: { id: true, isFirstOrder: true },
  });

  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    linkId: link.id,
    isFirstOrder: link.isFirstOrder,
    replayed: false,
  };
}
