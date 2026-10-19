import { requireAuth, requireAdminAction } from "@/lib/auth-server";
import { reactivate } from "@/lib/users/server";
import { body, usersErrorResponse } from "@/lib/users/http";

// POST — reactivate a deactivated account (UR-11 «قابل للتراجع»), with the reason. The shared
// account path holds the reactivation of a duty-holding account for a second account editor
// (QA2 P1-B; SIMPLE MODE applies it at once). The administrator role only, after a recent step-up.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const refused = await requireAdminAction(user, "users.reactivate", { stepUp: true, message: "Only the administrator reactivates users." });
  if (refused) return refused;
  const { id } = await params;
  try {
    return await reactivate(request, user, id, await body(request));
  } catch (e) {
    return usersErrorResponse(e);
  }
}
