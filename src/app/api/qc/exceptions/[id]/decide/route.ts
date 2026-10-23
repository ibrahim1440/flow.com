import { NextResponse } from "@/lib/api-response";
import { handleDomainError } from "@/lib/api-error";
import { requireSub } from "@/lib/auth-server";
import { readRoastRequestKey } from "@/lib/services/roast-idempotency";
import { decideException } from "@/lib/services/qc/exceptions";

/**
 * POST /api/qc/exceptions/[id]/decide {decision: APPROVE | REJECT, reason} — QX-03: qc ›
 * approve_exception (privileged: requireSub runs the central gate — a verified individual and a
 * fresh step-up with the password). Never the requester, never the inspector (server and CHECK).
 * Idempotent: the same Idempotency-Key replays the stored decision; another decider's earlier
 * decision is a 409 that names it. Approval releases through the QC workflow; rejection keeps the hold.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireSub("qc", "approve_exception");
  if (error) return error;
  const k = readRoastRequestKey(request);
  if (!k.ok) return NextResponse.json({ error: k.message, errorEn: k.en }, { status: 400 });
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    return NextResponse.json(await decideException({ id: user.id, name: user.name }, id, body, k.key));
  } catch (err) {
    return handleDomainError(err);
  }
}
