import { requireAuth } from "@/lib/auth-server";
import { requireAccessManager } from "@/lib/users/gate";
import { changeAccess } from "@/lib/users/server";
import { body, usersErrorResponse } from "@/lib/users/http";

// PUT — change one account's role and permission cells (Figma UR-02b → UR-10 «حفظ صلاحيات …؟»):
// the administrator role or a power user (owner decision 19 Oct; guardrails in src/lib/users/power.ts),
// after a recent step-up, never one's own account (P-4). Every cell
// set now that differs from the role becomes an exception with the reason (and the expiry, required
// for a temporary sensitive grant — O-2); the change runs through the shared account path, so the
// payroll-duty, second-person, verified-individual and last-administrator rules all apply.
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const refused = await requireAccessManager(user, "users.access", "Only the administrator or a power user changes permissions.");
  if (refused) return refused;
  const { id } = await params;
  try {
    return await changeAccess(request, user, id, await body(request));
  } catch (e) {
    return usersErrorResponse(e);
  }
}
