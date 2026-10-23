import { NextResponse } from "@/lib/api-response";
import { handleDomainError } from "@/lib/api-error";
import { requireSub } from "@/lib/auth-server";
import { updateDraft } from "@/lib/services/qc/profiles";

/** PATCH /api/qc/profile-versions/[id] — a DRAFT's whole / ground target ± tolerance, device, scale, sensory requirements. An approved spec is frozen. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireSub("qc", "manage_profiles");
  if (error) return error;
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    return NextResponse.json(await updateDraft({ id: user.id, name: user.name }, id, body));
  } catch (err) {
    return handleDomainError(err);
  }
}
