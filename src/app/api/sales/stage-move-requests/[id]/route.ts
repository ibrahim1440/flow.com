import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { decideStageMove, staleRefusal, withdrawStageMove } from "@/lib/services/sales/stage-move";
import { emitDealMoved } from "@/lib/services/sales/deal-events";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/sales/stage-move-requests/[id] — the supervisor's decision on a rep's manual stage move (pipeline v2, owner
 * decision 3). Body: { decision: "APPROVE" | "REJECT", note? } — a rejection needs the note (the rep reads it). The
 * duty, the scope, four eyes and the deal's state are re-checked in the service, under the request's and the deal's
 * locks; approving applies the move through the ordinary transition rules (stage event «يدوي — باعتماد …»).
 * The workspace's «بانتظار اعتمادي» lists the request and posts here.
 */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireModule("sales");
  if (error) return error;
  const { id } = await params;
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "طلب غير صالح.", errorEn: "Invalid JSON body." }, { status: 400 }); }
  const b = (body ?? {}) as Record<string, unknown>;
  const decision = b.decision === "APPROVE" ? "APPROVE" : b.decision === "REJECT" || b.decision === "DECLINE" ? "REJECT" : null;
  if (!decision) return NextResponse.json({ error: "اختر اعتماد الطلب أو رفضه.", errorEn: "decision must be APPROVE or REJECT.", code: "DECISION_INVALID" }, { status: 400 });
  try {
    const out = await prisma.$transaction(async (tx) => {
      const r = await decideStageMove(tx, { requestId: id, decision, note: typeof b.note === "string" ? b.note : null, actor: { id: user.id, name: user.name ?? null, permissions: user.permissions } });
      if (r.moved) {
        await emitDealMoved(tx, { opportunityId: r.request.opportunityId, fromStageId: r.moved.fromStageId, toStageId: r.moved.stageId, fromOutcome: r.moved.fromOutcome, toOutcome: r.moved.outcome, actorId: user.id });
      }
      return { status: r.status, opportunityId: r.request.opportunityId, stageId: r.moved?.stageId ?? null, stale: r.stale };
    }, TX_OPTS);
    // A stale request was cancelled (committed above); only now is it refused.
    if (out.stale) return handleDomainError(staleRefusal(out.stale));
    return NextResponse.json({ status: out.status, opportunityId: out.opportunityId, stageId: out.stageId });
  } catch (err) {
    return handleDomainError(err);
  }
}

/** DELETE — the requester withdraws their own pending request. */
export async function DELETE(_request: Request, { params }: Params) {
  const { user, error } = await requireModule("sales");
  if (error) return error;
  const { id } = await params;
  try {
    const out = await prisma.$transaction((tx) => withdrawStageMove(tx, { requestId: id, actorId: user.id }), TX_OPTS);
    return NextResponse.json(out);
  } catch (err) {
    return handleDomainError(err);
  }
}
