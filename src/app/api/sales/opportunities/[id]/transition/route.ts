import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { transitionOpportunity } from "@/lib/services/sales/leads";
import { emitDealMoved } from "@/lib/services/sales/deal-events";
import { isGeneralManager, movesDirectly, requestStageMove } from "@/lib/services/sales/stage-move";

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
  let toOutcome =
    typeof b.toOutcome === "string" && (OUTCOMES as readonly string[]).includes(b.toOutcome)
      ? (b.toOutcome as "OPEN" | "WON" | "LOST")
      : null;
  let toStageId = typeof b.toStageId === "string" ? b.toStageId : null;
  // «العميل ما يحتاج عينات» (pipeline v2 §2.4): the server resolves the target itself (the quotation stage).
  const skipSamples = b.skipSamples === true
    ? { code: typeof b.skipReasonCode === "string" ? b.skipReasonCode : null, text: typeof b.skipReason === "string" ? b.skipReason : null }
    : null;
  if (skipSamples) toStageId = null;

  if (!toOutcome && !toStageId && !skipSamples) {
    return NextResponse.json({ error: "Nothing to change: give a stage or an outcome." }, { status: 400 });
  }

  // Pipeline v2 §2.7: moving a deal through the stages by hand (or skipping its samples) is editing the deal, so it
  // needs «تعديل العملاء المحتملين والصفقات» (sales › lead_write) — before v2 the sales module alone was enough, so a
  // view-only sales user who owned a deal could move it. Closing and reopening keep their own privileges below.
  if ((toStageId || skipSamples) && !hasSubPrivilege(user.permissions, "sales", "lead_write")) {
    return NextResponse.json(
      { error: "نقل الصفقة بين المراحل يحتاج صلاحية تعديل الصفقات.", errorEn: "Moving a deal between stages needs the lead-write permission.", code: "LEAD_WRITE_REQUIRED" },
      { status: 403 },
    );
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
      select: { id: true, ownerId: true, outcome: true, stageId: true, stage: { select: { isActive: true } } },
    });
    if (!opp) return NextResponse.json({ error: "Deal not found." }, { status: 404 });

    // Ownership before anything else, and a 404 rather than a 403 so the refusal does not
    // confirm that a deal with this id belongs to a colleague.
    const seesAll = hasSubPrivilege(user.permissions, "sales", "lead_assign");
    if (!seesAll && opp.ownerId !== user.id) {
      return NextResponse.json({ error: "Deal not found." }, { status: 404 });
    }

    // A won or lost deal may sit in a stage that was hidden after it closed (only OPEN deals
    // block hiding). Reopening it there would put an open card in a column the board no
    // longer draws, so a reopen without a chosen stage lands in the first active stage; the
    // move is recorded in the deal's stage history like any other.
    if (toOutcome === "OPEN" && !toStageId && opp.outcome !== "OPEN" && !opp.stage.isActive) {
      const first = await prisma.pipelineStage.findFirst({ where: { isActive: true }, orderBy: [{ position: "asc" }, { code: "asc" }], select: { id: true } });
      if (!first) return NextResponse.json({ error: "No active stage to reopen the deal into." }, { status: 409 });
      toStageId = first.id;
    }

    // Decided on the REAL effect, never on the body's shape (gate fix HIGH-1): `toOutcome:"OPEN"` on a deal that is
    // already open reopens nothing, so it is dropped — it cannot turn a request into a direct move.
    const reopening = toOutcome === "OPEN" && opp.outcome !== "OPEN";
    if (toOutcome === "OPEN" && !reopening) toOutcome = null;
    const stageChange = !!toStageId && toStageId !== opp.stageId;
    // Closing and moving are two acts: a stage change rides on no WON/LOST (a deal_close holder cannot move by closing).
    if (stageChange && (toOutcome === "WON" || toOutcome === "LOST")) {
      return NextResponse.json({
        error: "أغلق الصفقة أو انقلها، كلٌّ على حدة.", errorEn: "Close the deal or move it, in two steps.", code: "MOVE_AND_CLOSE",
      }, { status: 400 });
    }
    if (!toOutcome && !stageChange && !skipSamples) {
      return NextResponse.json({ error: "لا شيء لتغييره.", errorEn: "Nothing to change: give a stage or an outcome.", code: "NOTHING_TO_CHANGE" }, { status: 400 });
    }

    // Owner decision 3 (pipeline v2): a manual stage move (drag, «نقل إلى…») by somebody without sales ›
    // deal_stage_move (or lead_assign) is a REQUEST a supervisor approves — nothing moves yet. 202, and the screen
    // shows «طلب نقل بانتظار اعتماد المشرف». A permitted reopen (deal_reopen, checked in the service) and the
    // documented sample skip are not manual moves; every other real stage change without the duty is a request.
    if (stageChange && !reopening && !skipSamples && !movesDirectly(user.permissions, user.role, await isGeneralManager(prisma, user.id))) {
      const made = await prisma.$transaction((tx) => requestStageMove(tx, {
        opportunityId: id, toStageId: toStageId!, reason: typeof b.reason === "string" ? b.reason : typeof b.skipReason === "string" ? b.skipReason : null, requestedById: user.id,
      }), TX_OPTS);
      return NextResponse.json({
        pending: true, request: { id: made.request.id, toStageId: made.request.toStageId, status: made.request.status }, replaced: made.replaced,
        notice: "أُرسل طلب النقل إلى المشرف؛ تبقى الصفقة في مرحلتها حتى يعتمده.", noticeEn: "Move request sent to the supervisor; the deal stays where it is until it is approved.",
      }, { status: 202 });
    }

    if (toStageId) {
      const stage = await prisma.pipelineStage.findFirst({
        where: { id: toStageId, isActive: true },
        select: { id: true },
      });
      if (!stage) return NextResponse.json({ error: "That stage is not available." }, { status: 400 });
    }

    const result = await prisma.$transaction(async (tx) => {
      const moved = await transitionOpportunity(tx, {
        opportunityId: id,
        toStageId,
        toOutcome,
        lostReason: typeof b.lostReason === "string" ? b.lostReason : null,
        // Optional coded reason (PRICE, QUALITY, COMPETITOR, NO_NEED, NO_RESPONSE, OTHER).
        lostReasonCode: typeof b.lostReasonCode === "string" ? b.lostReasonCode : null,
        // Why the samples are skipped — required only past Sample Evaluation with no sample.
        skipReason: !skipSamples && typeof b.skipReason === "string" ? b.skipReason : null,
        skipSamples,
        // A direct manual move (deal_stage_move / lead_assign) says so in the history: «يدوي — <reason>».
        manualNote: stageChange && !reopening
          ? (typeof b.reason === "string" && b.reason.trim() ? `يدوي — ${b.reason.trim().slice(0, 300)}` : "يدوي")
          : null,
        actorId: user.id,
        canReopen: hasSubPrivilege(user.permissions, "sales", "deal_reopen"),
      });
      // «إشعارات الحالات»: the move, in its own transaction (no-op when no rule listens).
      await emitDealMoved(tx, { opportunityId: id, fromStageId: moved.fromStageId, toStageId: moved.stageId, fromOutcome: moved.fromOutcome, toOutcome: moved.outcome, actorId: user.id });
      return { stageId: moved.stageId, outcome: moved.outcome, samplesSkipped: moved.samplesSkipped };
    }, TX_OPTS);

    return NextResponse.json(result);
  } catch (err) {
    // The shared mapper keeps a refusal's `code` (SAMPLE_SKIP_REASON_REQUIRED opens the skip
    // dialog on the deal page) and its Arabic; plain refusals read exactly as before.
    return handleDomainError(err);
  }
}
