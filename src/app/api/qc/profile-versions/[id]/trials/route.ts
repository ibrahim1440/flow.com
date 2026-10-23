import { NextResponse } from "@/lib/api-response";
import { handleDomainError } from "@/lib/api-error";
import { requireSub } from "@/lib/auth-server";
import { addTrial } from "@/lib/services/qc/profiles";

/** POST /api/qc/profile-versions/[id]/trials — a TRIAL reading during development (whole, ground, device, scale, sensory). qc › manage_profiles. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireSub("qc", "manage_profiles");
  if (error) return error;
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    return NextResponse.json(await addTrial({ id: user.id, name: user.name }, id, body), { status: 201 });
  } catch (err) {
    return handleDomainError(err);
  }
}
