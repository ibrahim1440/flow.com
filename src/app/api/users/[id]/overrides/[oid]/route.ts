import { requireAuth } from "@/lib/auth-server";
import { requireAccessManager } from "@/lib/users/gate";
import { removeOverride } from "@/lib/users/server";
import { body, usersErrorResponse } from "@/lib/users/http";

// DELETE — remove one exception (Figma UR-09 «إزالة»): the cell returns to the role's value, the
// exception ends REMOVED, with the reason. The administrator role, or a power user within its guardrails (owner decision 19 Oct; src/lib/users/power.ts), after a recent step-up.
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string; oid: string }> }) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const refused = await requireAccessManager(user, "users.override_remove", "Only the administrator or a power user removes exceptions.");
  if (refused) return refused;
  const { id, oid } = await params;
  try {
    return await removeOverride(request, user, id, oid, await body(request));
  } catch (e) {
    return usersErrorResponse(e);
  }
}
