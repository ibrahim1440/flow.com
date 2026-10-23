import { NextResponse } from "@/lib/api-response";
import { handleDomainError } from "@/lib/api-error";
import { requireSub } from "@/lib/auth-server";
import { approveVersion } from "@/lib/services/qc/profiles";

/**
 * POST /api/qc/profile-versions/[id]/approve {sensoryResult: CONFORMING, sensoryNotes} — the version
 * becomes the reference (spec frozen); the previous approved version is retired; production is
 * notified. Requires the sensory evaluation and at least one trial. qc › manage_profiles.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireSub("qc", "manage_profiles");
  if (error) return error;
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    return NextResponse.json(await approveVersion({ id: user.id, name: user.name }, id, body));
  } catch (err) {
    return handleDomainError(err);
  }
}
