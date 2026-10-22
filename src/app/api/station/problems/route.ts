import { NextResponse } from "@/lib/api-response";
import { handleDomainError } from "@/lib/api-error";
import { requireStation, requiredKey } from "@/lib/services/station/http";
import { reportProblem } from "@/lib/services/station/claims";

/**
 * POST /api/station/problems {claimId, kind, reason, note?} + Idempotency-Key — R7 «إبلاغ عن مشكلة».
 * Records who, when, what and the resulting state. The task stays claimed, no stock moves and the
 * roaster status is not changed (owner decision D13: that stays an administrator's action).
 */
export async function POST(request: Request) {
  const { user, error } = await requireStation();
  if (error) return error;
  const k = requiredKey(request);
  if (k.error) return k.error;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof body.claimId !== "string" || !body.claimId) return NextResponse.json({ error: "المهمة مطلوبة.", errorEn: "claimId is required." }, { status: 400 });
  try {
    const out = await reportProblem({ user, claimId: body.claimId, kind: body.kind, reason: body.reason, note: body.note, key: k.key });
    return NextResponse.json({ id: out.log.id, toState: out.log.toState, createdAt: out.log.createdAt, replayed: out.replayed }, { status: out.replayed ? 200 : 201 });
  } catch (err) {
    return handleDomainError(err);
  }
}
