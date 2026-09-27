import { NextResponse } from "next/server";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { transitionOpportunity } from "@/lib/services/sales/leads";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/sales/opportunities/[id]/transition — move a deal, or close it.
 *
 * The rules live on the server, in transitionOpportunity. Dragging a card is a request, not a
 * decision: this route is what the Kanban calls, and it is refused on exactly the same terms
 * as any other caller. A client that "already moved" the card optimistically has to put it
 * back when this says no.
 */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireModule("sales");
  if (error) return error;

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const OUTCOMES = ["OPEN", "WON", "LOST"] as const;
  const toOutcome =
    typeof b.toOutcome === "string" && (OUTCOMES as readonly string[]).includes(b.toOutcome)
      ? (b.toOutcome as "OPEN" | "WON" | "LOST")
      : null;
  const toStageId = typeof b.toStageId === "string" ? b.toStageId : null;

  if (!toOutcome && !toStageId) {
    return NextResponse.json({ error: "Nothing to change: give a stage or an outcome." }, { status: 400 });
  }

  // Closing a deal is its own privilege, separate from editing one. Moving a card through the
  // funnel is everyday work; declaring the business won or lost is a commitment.
  if (toOutcome === "WON" || toOutcome === "LOST") {
    if (!hasSubPrivilege(user.permissions, "sales", "deal_close")) {
      return NextResponse.json({ error: "Closing a deal needs the deal-close permission." }, { status: 403 });
    }
  }

  try {
    const opp = await prisma.opportunity.findUnique({
      where: { id },
      select: { id: true, ownerId: true },
    });
    if (!opp) return NextResponse.json({ error: "Deal not found." }, { status: 404 });

    // Ownership before anything else, and a 404 rather than a 403 so the refusal does not
    // confirm that a deal with this id belongs to a colleague.
    const seesAll = hasSubPrivilege(user.permissions, "sales", "lead_assign");
    if (!seesAll && opp.ownerId !== user.id) {
      return NextResponse.json({ error: "Deal not found." }, { status: 404 });
    }

    if (toStageId) {
      const stage = await prisma.pipelineStage.findFirst({
        where: { id: toStageId, isActive: true },
        select: { id: true },
      });
      if (!stage) return NextResponse.json({ error: "That stage is not available." }, { status: 400 });
    }

    const result = await prisma.$transaction(
      (tx) =>
        transitionOpportunity(tx, {
          opportunityId: id,
          toStageId,
          toOutcome,
          lostReason: typeof b.lostReason === "string" ? b.lostReason : null,
          actorId: user.id,
          canReopen: hasSubPrivilege(user.permissions, "sales", "deal_reopen"),
        }),
      TX_OPTS,
    );

    return NextResponse.json(result);
  } catch (err) {
    if (err && typeof err === "object" && "_appCode" in err) {
      const e = err as { _appCode: number; message: string };
      return NextResponse.json({ error: e.message }, { status: e._appCode });
    }
    return handlePrismaError(err);
  }
}
