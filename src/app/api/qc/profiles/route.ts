import { NextResponse } from "@/lib/api-response";
import { handleDomainError } from "@/lib/api-error";
import { requireAuth, requireSub, forbidden } from "@/lib/auth-server";
import { hasModuleAccess, hasSubPrivilege } from "@/lib/auth-shared";
import { createProfile, listProfiles } from "@/lib/services/qc/profiles";

/** GET /api/qc/profiles — «ملفات التحميص»: profiles, versions, trials (the QC or production module). POST — a new profile with version 1 in development (qc › manage_profiles). */
export async function GET() {
  const { user, error } = await requireAuth();
  if (error) return error;
  if (!hasModuleAccess(user.permissions, "qc") && !hasModuleAccess(user.permissions, "production")) return forbidden();
  try {
    return NextResponse.json({ ...(await listProfiles()), canManage: hasSubPrivilege(user.permissions, "qc", "manage_profiles") }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return handleDomainError(err);
  }
}

export async function POST(request: Request) {
  const { user, error } = await requireSub("qc", "manage_profiles");
  if (error) return error;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    return NextResponse.json(await createProfile({ id: user.id, name: user.name }, body), { status: 201 });
  } catch (err) {
    return handleDomainError(err);
  }
}
