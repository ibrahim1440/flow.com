import { NextResponse } from "@/lib/api-response";
import { requireAuth, requireAdminAction } from "@/lib/auth-server";
import { body, noStore, usersErrorResponse } from "@/lib/users/http";
import { revokeDevice } from "@/lib/services/station/admin";

// POST {reason} — «إلغاء الجهاز» (UR-14): the device is refused from its next request and every
// session on it ends now (DS-15). The administrator role, step-up.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const refused = await requireAdminAction(user, "stations.revoke_device", { stepUp: true });
  if (refused) return refused;
  const { id } = await params;
  try {
    return NextResponse.json(await revokeDevice(request, user, id, await body(request)), noStore);
  } catch (e) {
    return usersErrorResponse(e);
  }
}
