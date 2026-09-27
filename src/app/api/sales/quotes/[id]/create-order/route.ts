import { NextResponse } from "next/server";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { seesAllSales, NOT_FOUND_MESSAGE } from "@/lib/services/sales/scope";
import { createOrderFromQuote } from "@/lib/services/sales/quote-to-order";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/sales/quotes/[id]/create-order — raise the order an accepted quotation entitles
 * the customer to.
 *
 * ── Two privileges, not one ──
 * `orders:create` is the gate, because this creates a real order in the operational system
 * and a CRM privilege must not be a way around the order module's own permissions. The
 * caller must also be able to see the quotation, which the sales scope decides. Someone who
 * may raise orders but may not see this deal gets the same 404 as anybody else.
 *
 * ── Idempotent ──
 * The service keys the link row on the quotation, so the second click returns the first
 * order. The response says which happened; a rep who clicks twice should be told "that
 * order already exists" rather than left wondering whether they have made two.
 */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireSub("orders", "create");
  if (error) return error;
  const { id } = await params;

  // Read access to the sales module as well, so this endpoint cannot be used to reach a
  // quotation the caller could not otherwise open.
  if (!hasSubPrivilege(user.permissions, "sales", "quote_write") && !seesAllSales(user.permissions)) {
    const readable = await prisma.quote.findFirst({
      where: { id, opportunity: { ownerId: user.id } },
      select: { id: true },
    });
    if (!readable) return NextResponse.json({ error: NOT_FOUND_MESSAGE }, { status: 404 });
  }

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    // An empty body is the ordinary case: the quotation already says everything needed.
  }
  const b = (body ?? {}) as Record<string, unknown>;

  try {
    const visible = await prisma.quote.findFirst({
      where: { id, ...(seesAllSales(user.permissions) ? {} : { opportunity: { ownerId: user.id } }) },
      select: { id: true },
    });
    if (!visible) return NextResponse.json({ error: NOT_FOUND_MESSAGE }, { status: 404 });

    const result = await prisma.$transaction(
      (tx) =>
        createOrderFromQuote(tx, {
          quoteId: id,
          actorId: user.id,
          requestKey: typeof b.requestKey === "string" ? b.requestKey : null,
          notes: typeof b.notes === "string" ? b.notes : null,
        }),
      TX_OPTS,
    );

    return NextResponse.json(
      {
        ...result,
        message: result.replayed
          ? `Order #${result.orderNumber} was already raised from this quotation.`
          : `Order #${result.orderNumber} created.`,
      },
      { status: result.replayed ? 200 : 201 },
    );
  } catch (err) {
    return handleDomainError(err);
  }
}
