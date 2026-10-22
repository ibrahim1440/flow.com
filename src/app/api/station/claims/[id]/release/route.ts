import { NextResponse } from "@/lib/api-response";
import { handleDomainError } from "@/lib/api-error";
import { requireStation, requiredKey } from "@/lib/services/station/http";
import { releaseClaim } from "@/lib/services/station/claims";

/** POST /api/station/claims/[id]/release + Idempotency-Key (roasting station, W1). Logged; moves no stock. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireStation();
  if (error) return error;
  const k = requiredKey(request);
  if (k.error) return k.error;
  const { id } = await params;
  try {
    const out = await releaseClaim({ user, claimId: id, key: k.key });
    return NextResponse.json({ id: out.log.id, toState: out.log.toState, createdAt: out.log.createdAt, replayed: out.replayed }, { status: out.replayed ? 200 : 201 });
  } catch (err) {
    return handleDomainError(err);
  }
}
