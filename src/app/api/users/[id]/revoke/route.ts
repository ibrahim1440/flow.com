import { NextResponse } from "@/lib/api-response";
import { requireAuth, requireModule, requireAdminAction } from "@/lib/auth-server";
import { isUsersAdmin, revokeAccess, revokeCheck } from "@/lib/users/server";
import { ADMIN_READ_ONLY, body, noStore, usersErrorResponse } from "@/lib/users/http";

// GET — what the revoke dialog shows (Figma UR-11): whether the account may be deleted (a dry run
// that always rolls back: refused when it has linked records, O-4) and its claimed station tasks.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireModule("employees");
  if (error) return error;
  if (!isUsersAdmin(user)) return ADMIN_READ_ONLY();
  const { id } = await params;
  try {
    return NextResponse.json(await revokeCheck(id), noStore);
  } catch (e) {
    return usersErrorResponse(e);
  }
}

// POST — «إيقاف الوصول» (UR-11): deactivate, with the reason; every session ends and the claimed
// station tasks are released to the team (or kept for the supervisor). Deleting stays on
// DELETE /api/employees/[id] (refused when records exist). The administrator role only, after a
// recent step-up, never one's own account, never the last active administrator.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const refused = await requireAdminAction(user, "users.revoke", { stepUp: true, message: "Only the administrator revokes access." });
  if (refused) return refused;
  const { id } = await params;
  try {
    return await revokeAccess(request, user, id, await body(request));
  } catch (e) {
    return usersErrorResponse(e);
  }
}
