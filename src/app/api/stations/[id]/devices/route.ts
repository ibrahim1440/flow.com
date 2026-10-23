import { NextResponse } from "@/lib/api-response";
import { requireAuth, requireAdminAction } from "@/lib/auth-server";
import { body, noStore, usersErrorResponse } from "@/lib/users/http";
import { registerDevice } from "@/lib/services/station/admin";

// POST {deviceCode, name?} — «تسجيل جهاز» (UR-14): a pending device of this station and its one-time
// activation code (UR-14b), returned ONCE and stored only as a keyed hash. The administrator role, step-up.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const refused = await requireAdminAction(user, "stations.register_device", { stepUp: true });
  if (refused) return refused;
  const { id } = await params;
  try {
    return NextResponse.json(await registerDevice(request, user, id, await body(request)), { status: 201, ...noStore });
  } catch (e) {
    return usersErrorResponse(e);
  }
}
