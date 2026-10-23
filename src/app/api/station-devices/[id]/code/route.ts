import { NextResponse } from "@/lib/api-response";
import { requireAuth, requireAdminAction } from "@/lib/auth-server";
import { body, noStore, usersErrorResponse } from "@/lib/users/http";
import { cancelCode, reissueCode } from "@/lib/services/station/admin";

// POST {deviceCode?} — «رمز جديد» (UR-14 / UR-14b): a new one-time activation code for a pending
// device (the earlier code stops working). DELETE — «إلغاء الرمز»: the live code stops working now.
// The administrator role, step-up.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const refused = await requireAdminAction(user, "stations.issue_code", { stepUp: true });
  if (refused) return refused;
  const { id } = await params;
  try {
    return NextResponse.json(await reissueCode(request, user, id, await body(request)), { status: 201, ...noStore });
  } catch (e) {
    return usersErrorResponse(e);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const refused = await requireAdminAction(user, "stations.cancel_code", { stepUp: true });
  if (refused) return refused;
  const { id } = await params;
  try {
    return NextResponse.json(await cancelCode(request, user, id), noStore);
  } catch (e) {
    return usersErrorResponse(e);
  }
}
