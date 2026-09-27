import { NextResponse } from "next/server";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { seesAllSales, NOT_FOUND_MESSAGE } from "@/lib/services/sales/scope";
import { reviseQuote } from "@/lib/services/sales/quotes";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/sales/quotes/[id]/revise — raise the next revision of a quotation.
 *
 * This is the only way to change a price that has already been shown to a customer. The
 * original becomes SUPERSEDED and stays readable, the new draft carries revision n+1 and a
 * link back, and both sides of the chain are walkable — so "what did we offer them in
 * March" has an answer that is not "whatever the row says today".
 */
export async function POST(_request: Request, { params }: Params) {
  const { user, error } = await requireSub("sales", "quote_write");
  if (error) return error;
  const { id } = await params;

  try {
    const visible = await prisma.quote.findFirst({
      where: { id, ...(seesAllSales(user.permissions) ? {} : { opportunity: { ownerId: user.id } }) },
      select: { id: true },
    });
    if (!visible) return NextResponse.json({ error: NOT_FOUND_MESSAGE }, { status: 404 });

    const created = await prisma.$transaction(
      (tx) => reviseQuote(tx, { quoteId: id, actorId: user.id }),
      TX_OPTS,
    );

    return NextResponse.json({ quote: created }, { status: 201 });
  } catch (err) {
    return handleDomainError(err);
  }
}
