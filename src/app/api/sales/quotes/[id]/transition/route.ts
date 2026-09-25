import { NextResponse } from "next/server";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { seesAllSales, NOT_FOUND_MESSAGE } from "@/lib/services/sales/scope";
import { advanceToQuotationStage, winOnAcceptedQuote } from "@/lib/services/sales/lifecycle";
import { issueQuote, decideQuote } from "@/lib/services/sales/quotes";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/sales/quotes/[id]/transition — issue, accept, reject or expire a quotation.
 *
 * One endpoint for the whole lifecycle, because the interesting rules are about which move
 * follows which, and splitting them across four routes would put that table in four places.
 * The service owns the table; this handler owns authorisation and the shape of the request.
 *
 * The discount authorisation is passed in rather than read inside the service, so the
 * domain stays free of the permission model and the check stays where the session is.
 */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireSub("sales", "quote_write");
  if (error) return error;
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const to = typeof b.to === "string" ? b.to.toUpperCase() : "";
  if (!["ISSUED", "ACCEPTED", "REJECTED", "EXPIRED"].includes(to)) {
    return NextResponse.json(
      { error: "to must be one of: ISSUED, ACCEPTED, REJECTED, EXPIRED." },
      { status: 400 },
    );
  }

  try {
    // Scoped before anything else. Reaching another rep's quotation by editing the id in the
    // URL is the first thing anybody tries, and this is where it stops.
    const visible = await prisma.quote.findFirst({
      where: { id, ...(seesAllSales(user.permissions) ? {} : { opportunity: { ownerId: user.id } }) },
      select: { id: true, opportunityId: true },
    });
    if (!visible) return NextResponse.json({ error: NOT_FOUND_MESSAGE }, { status: 404 });

    const canApproveDiscount = hasSubPrivilege(user.permissions, "sales", "quote_approve_discount");

    const result = await prisma.$transaction(async (tx) => {
      if (to === "ISSUED") {
        const issued = await issueQuote(tx, { quoteId: id, actorId: user.id, canApproveDiscount });
        // Issuing a quotation IS the deal reaching the quotation stage. Leaving the board to
        // be updated by hand is how a pipeline stops describing the work.
        const advanced = await advanceToQuotationStage(tx, visible.opportunityId, user.id);
        return {
          status: "ISSUED",
          quoteNumber: issued.quoteNumber,
          grandTotal: issued.grandTotal.toFixed(2),
          discountApproved: issued.discountApproved,
          stageAdvanced: advanced,
        };
      }

      const decided = await decideQuote(tx, {
        quoteId: id,
        to: to as "ACCEPTED" | "REJECTED" | "EXPIRED",
        note: typeof b.note === "string" ? b.note : null,
        actorId: user.id,
      });

      // Accepting a quotation is what unlocks winning the deal, so the moment is recorded on
      // the deal's own timeline. Without it the pipeline history shows a deal that jumped to
      // Won with nothing in between.
      //
      // And then the deal IS won — in the same transaction, because a quotation the customer
      // accepted and a deal still sitting open is a state nobody can act on and everybody
      // has to reconcile by hand. The stage it was won ON is preserved: "lost at
      // negotiation" and "lost at qualification" are different facts, and so are the wins.
      //
      // A REJECTED quotation deliberately does NOT close the deal. A revision may still be
      // issued, and closing Lost stays an explicit act with a required reason.
      let wonNow = false;
      if (to === "ACCEPTED") {
        await tx.opportunityStageEvent.create({
          data: {
            opportunityId: visible.opportunityId,
            reason: "Quotation accepted by the customer",
            actorId: user.id,
          },
        });
        wonNow = await winOnAcceptedQuote(tx, visible.opportunityId, user.id);
      }

      return { status: decided.status, dealWon: wonNow };
    }, TX_OPTS);

    return NextResponse.json(result);
  } catch (err) {
    return handleDomainError(err);
  }
}
