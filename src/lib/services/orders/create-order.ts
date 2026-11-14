import type { OrderChannel } from "@/lib/station/board";
import type { Prisma as PrismaNS } from "@/generated/prisma/client";
import { kgForUnits } from "@/lib/services/finished-products";
import { CUSTOMER_NAME_SELECT } from "@/lib/auth/customer-detail";
import { assertSalesAllowed } from "@/lib/services/customers/credit-db";
import { defaultBranchForActor } from "@/lib/accounting/locations";
import type { OrderFacts } from "@/lib/notifications/from-automation";

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

  // R1-c: every line's SKU in ONE read (it was a findUnique + product read per line). The checks below still run line
  // by line in the order given, so the first offending line is the one reported, exactly as before.
  const ids = [...new Set(items.map((i) => i.productSkuId).filter((v): v is string => typeof v === "string" && v.length > 0))];
  const skus = ids.length === 0 ? [] : await db.productSKU.findMany({
    where: { id: { in: ids } },
    include: { product: { select: { id: true, productNameEn: true, defaultGreenBeanId: true } } },
  });
  const skuById = new Map(skus.map((k) => [k.id, k]));

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

    const sku = skuById.get(item.productSkuId);
    if (!sku) throw { _appCode: 400, message: "Product SKU not found." };
    if (!sku.isActive) {
      throw { _appCode: 400, message: `"${sku.skuCode}" is inactive and cannot be sold.` };
    }

    const line: ResolvedOrderLine = {
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
    };
    // R1-c: the catalogue price travels beside the line (never into the row) so the credit check does not re-read it.
    linePrice.set(line, sku.price);
    resolved.push(line);
  }

  return resolved;
}

/** R1-c: the SKU's catalogue price of a line resolveOrderLines produced (absent for lines built elsewhere). */
const linePrice = new WeakMap<ResolvedOrderLine, number>();

/**
 * R1-c: what the order-created notification needs about an order createOrderWithNumber just wrote, so the caller can
 * hand it to emitAutomationEvent instead of the notification re-reading the order inside the order-number lock.
 * The new order has no deal link yet in that transaction; a caller that links one before emitting must not use it.
 */
const creationFacts = new WeakMap<object, OrderFacts>();
export function orderCreationFacts(created: object): OrderFacts | undefined {
  return creationFacts.get(created);
}

export type NewOrderHeader = {
  customerId: string;
  quotationNumber?: string | null;
  quotationSentDate?: Date | null;
  notes?: string | null;
  /**
   * The order's owner from the moment it exists (fix/order-owner): the creating user for a
   * manual order, the quotation's owner for a converted one (services/orders/owner-access.ts).
   * Every caller passes one; absent means an unowned order, which only legacy data has.
   */
  ownerId?: string | null;
  /** «الموقع» (WP-B): the selling location (an active FinBranch id, validated by the caller); absent = the owner's default. */
  branchId?: string | null;
  /** «القناة» (20261224090000): where the order came from, set by the flow that creates it; absent = not recorded (derived). */
  channel?: OrderChannel | null;
  /**
   * P1 ERR-02: the credit-limit check (customers/credit-limit.ts) — the order's value with VAT and who asks (an approved
   * override of theirs is consumed by this order). Absent: the lines at the catalogue price, the owner asking. "SKIP": the
   * caller has checked already in this transaction (a direct sale completing at once).
   */
  credit?: { amount?: import("@/lib/accounting/money").Decimal | null; actorId?: string | null; kind: import("@/lib/services/customers/credit-limit").CreditKind; quoteId?: string | null } | "SKIP";
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
 * EVERY caller must therefore run this inside a transaction, and both now do. Taken on a
 * plain client the lock is acquired and released before the next statement runs, which
 * serialises nothing — so a caller outside a transaction would silently fall back to
 * colliding on the unique index and retrying, which is the behaviour this lock exists to
 * replace. The retry below is kept only as a second line of defence.
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
  // Review D-1: whether the caller holds the customer contact right (canSeeCustomerContact).
  // Defaults to no, so a caller that does not say gets the name-only customer, never the record.
  customerContact = false,
) {
  if (lines.length === 0) {
    // An order with no lines is not a smaller order, it is a stuck one: it consumes an
    // order number, can be approved and reviewed, aggregates to "Waiting Preparation
    // Review" forever and can never reach Ready for Shipping.
    throw { _appCode: 400, message: "An order must have at least one line." };
  }

  // «إيقاف البيع» (feat/credit-hold): no new order for a customer whose sales are on hold — 409
  // CUSTOMER_SALES_HOLD. Here, in the one order writer, so POST /api/orders and an accepted
  // quotation's conversion are both covered (a replayed conversion returns before reaching it).
  await assertSalesAllowed(db, header.customerId);
  // P1 ERR-02 (owner 1أ): the credit limit blocks — 409 CREDIT_LIMIT unless an approved override covers the order.
  let creditOverride: { overrideId: string } | null = null;
  let creditActor: string | null = null;
  if (header.credit !== "SKIP") {
    const { assertCreditLimit } = await import("@/lib/services/customers/credit-limit");
    const { linesValue } = await import("@/lib/services/customers/exposure");
    let amount = header.credit?.amount ?? null;
    if (amount == null) {
      // R1-c: the prices resolveOrderLines already read; the SKUs are read again only for lines built elsewhere.
      const known = lines.every((l) => linePrice.has(l));
      const skus = known
        ? lines.map((l) => ({ id: l.productSkuId, price: linePrice.get(l)! }))
        : await db.productSKU.findMany({ where: { id: { in: lines.map((l) => l.productSkuId) } }, select: { id: true, price: true } });
      amount = linesValue(lines.map((l) => ({ quantityUnits: l.quantityUnits, productSku: skus.find((k: { id: string; price: number }) => k.id === l.productSkuId) ?? null })));
    }
    creditActor = header.credit?.actorId ?? header.ownerId ?? null;
    creditOverride = await assertCreditLimit(db as never, { customerId: header.customerId, amount, actorId: creditActor, kind: header.credit?.kind ?? "ORDER", quoteId: header.credit?.quoteId ?? null });
  }

  // R1-c (owner 3-أ): everything that does not need the new order is read BEFORE the order-number lock — the selling
  // location and the customer the response carries — so the lock covers only: the maximum, the two inserts, (an
  // override's consumption) and whatever the caller writes about the order before it commits.
  const branchId = header.branchId !== undefined ? header.branchId : await defaultBranchForActor(db, header.ownerId ?? null);
  const customer = await db.customer.findUnique({
    where: { id: header.customerId },
    select: customerContact ? undefined : { ...CUSTOMER_NAME_SELECT, accountOwnerId: true },
  }) as ({ id: string; name: string; nameAr: string | null; accountOwnerId: string | null } & Record<string, unknown>) | null;
  if (!customer) throw { _appCode: 404, message: "Customer not found." };
  const responseCustomer = customerContact
    ? customer
    : { id: customer.id, name: customer.name, nameAr: customer.nameAr };

  // Before reading the maximum, not after: the point is that nobody else is between the
  // read and the write.
  await db.$executeRaw`SELECT pg_advisory_xact_lock(${ORDER_NUMBER_LOCK_NAMESPACE}, 0)`;

  for (let attempt = 0; attempt < 5; attempt++) {
    const lastOrder = await db.order.findFirst({ orderBy: { orderNumber: "desc" }, select: { orderNumber: true } });
    const nextNumber = (lastOrder?.orderNumber || 0) + 1;
    try {
      const order = await db.order.create({
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
          // Ownership at creation. Preparation is automatic since Phase B, so nothing downstream
          // would ever claim this order; the person who created it is who holds, resumes or
          // cancels it (the manager and the administrator may as well).
          ownerId: header.ownerId ?? null,
          branchId,
          ...(header.channel ? { channel: header.channel } : {}),
        },
      });
      // R1-c: the lines in one INSERT … RETURNING (a nested create followed by three reads for the include before).
      const items = await db.orderItem.createManyAndReturn({ data: lines.map((l) => ({ ...l, orderId: order.id })) });
      const created = { ...order, customer: responseCustomer, items };
      if (creditOverride) {
        const { consumeCreditOverride } = await import("@/lib/services/customers/credit-limit");
        await consumeCreditOverride(db as never, creditOverride.overrideId, created.id, creditActor!);
      }
      creationFacts.set(created, {
        id: order.id, orderNumber: order.orderNumber, ownerId: order.ownerId,
        customer: { id: customer.id, name: customer.name, nameAr: customer.nameAr, accountOwnerId: customer.accountOwnerId },
        opportunityLinks: [],
      });
      return created;
    } catch (e: unknown) {
      const code = e && typeof e === "object" && "code" in e ? (e as { code: string }).code : null;
      if (code === "P2002" && attempt < 4) continue;
      throw e;
    }
  }

  throw new Error("Order creation failed after retries.");
}
