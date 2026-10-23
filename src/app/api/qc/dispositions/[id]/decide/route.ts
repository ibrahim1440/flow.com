import { NextResponse } from "@/lib/api-response";
import { handleDomainError } from "@/lib/api-error";
import { requireSub } from "@/lib/auth-server";
import { decideDisposition } from "@/lib/services/qc/dispositions";

/**
 * POST /api/qc/dispositions/[id]/decide {decision: APPROVE | REJECT, reason} — qc › dispose (UR-S19:
 * privileged — a verified individual and a fresh step-up, through requireSub). Never the requester
 * nor the inspector of the hold. DESTROY writes the LOSS movement; CONVERT re-checks the target spec
 * and releases the batch as that product; BLEND is approved for production to record by the recipe.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireSub("qc", "dispose");
  if (error) return error;
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    return NextResponse.json(await decideDisposition({ id: user.id, name: user.name }, id, body));
  } catch (err) {
    return handleDomainError(err);
  }
}
