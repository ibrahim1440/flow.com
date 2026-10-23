import { NextResponse } from "@/lib/api-response";
import { handleDomainError } from "@/lib/api-error";
import { requireSub } from "@/lib/auth-server";
import { createVersion } from "@/lib/services/qc/profiles";

/** POST /api/qc/profiles/[id]/versions — a new version in development (the newest spec copied as a start). qc › manage_profiles. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireSub("qc", "manage_profiles");
  if (error) return error;
  const { id } = await params;
  try {
    return NextResponse.json(await createVersion({ id: user.id, name: user.name }, id), { status: 201 });
  } catch (err) {
    return handleDomainError(err);
  }
}
