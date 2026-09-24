import { NextResponse } from "next/server";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireAnyModule, requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
// One implementation of "make an order", shared with the quotation-to-order path. A
// second copy here is exactly the shape of defect the packaging rework was spent closing.
import { resolveOrderLines, createOrderWithNumber } from "@/lib/services/orders/create-order";

export async function GET(request: Request) {
  // Production and Dispatch workers need to read orders to see what to roast / deliver
  const { error } = await requireAnyModule("orders", "production", "dispatch");
  if (error) return error;

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const customerId = searchParams.get("customerId");

  const where: Record<string, unknown> = {};
  if (customerId) where.customerId = customerId;
  if (status) {
    const statusList = status.split(",");
    where.items = { some: { productionStatus: statusList.length === 1 ? status : { in: statusList } } };
  }

  const orders = await prisma.order.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 500,
    include: {
      customer: { include: { roastPreferences: true } },
      items: {
        include: {
          // Batches without their QC records. This list is loaded by four screens —
          // Orders, Order Preparation, Production and Dispatch — and none of them reads
          // a batch's QC records; the QC screen and the history page fetch those from
          // their own endpoints. Nesting them here meant every order carried every QC
          // record of every batch of every line, which is what made this response grow to
          // 905 KB at 293 orders.
          roastingBatches: true,
          deliveries: true,
          greenBean: true,
          // Without this the dispatch screen cannot tell a SKU line from a legacy
          // kilogram one: it decides by whether productSku is present, and the relation
          // was never sent. Every unit order therefore rendered as kilograms with
          // "Available: 0kg" and an unusable delivery form, even with stock reserved to it.
          productSku: true,
          // Which production plans this line has open. The production screen needs it to
          // attribute a roast to the plan it is being made for; without it every roast
          // started from a plan was stored with no link back to it. productionNumber is the
          // operator-facing reference: the queue prints it on the same task card, and the
          // roast-form picker listed opaque cuids without it. Three scalars only — this
          // response is loaded by four screens and has been trimmed before for size.
          productionOrders: { select: { id: true, productionNumber: true, status: true } },
        },
      },
      // Order Operations S0: minimal owner projection — no permissions/pin/credential fields.
      owner: { select: { id: true, name: true, role: true } },
      activities: { orderBy: { createdAt: "asc" } },
    },
  });
  return NextResponse.json(orders);
}

export async function POST(request: Request) {
  const { error } = await requireSub("orders", "create");
  if (error) return error;

  try {
    const body = await request.json();
    const { items } = body;

    if (!body.customerId || typeof body.customerId !== "string") {
      return NextResponse.json({ error: "customerId is required" }, { status: 400 });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: "An order must have at least one line." }, { status: 400 });
    }

    // No stock gate here, deliberately (section 7).
    //
    // Order creation used to refuse the order when green coffee was short. That belongs
    // to a different stage now: a sales order reserves FINISHED GOODS and nothing else,
    // and whatever the shelf cannot cover becomes a production requirement rather than a
    // rejection. Production is what consumes green coffee, against the SKU's BOM, and it
    // does its own raw-material check at that point.
    //
    // The fulfilment split is computed after creation — see
    // POST /api/orders/fulfillment-preview for the pre-submit view and the preparation
    // review for the binding reservation.
    const resolvedItems = await resolveOrderLines(prisma, items);

    // In a transaction, so the advisory lock inside createOrderWithNumber actually holds.
    //
    // pg_advisory_xact_lock lives for the length of the transaction that took it. Called on
    // the plain client every statement is its own implicit transaction, so the lock was
    // released before the next statement read the maximum order number — it serialised
    // nothing, and this path was relying entirely on the unique index and the retry while
    // the quotation-to-order path held the lock properly. Two writers, two different
    // schemes, and a lock that only looked like it covered both.
    const order = await prisma.$transaction(
      (tx) =>
        createOrderWithNumber(
          tx,
          {
            customerId: body.customerId as string,
            quotationNumber: typeof body.quotationNumber === "string" ? body.quotationNumber.trim() || null : null,
            quotationSentDate: body.quotationSentDate ? new Date(body.quotationSentDate) : null,
            notes: typeof body.notes === "string" ? body.notes.trim() || null : null,
          },
          resolvedItems,
        ),
      TX_OPTS,
    );

    return NextResponse.json(order, { status: 201 });
  } catch (err) {
    return handleDomainError(err);
  }
}
