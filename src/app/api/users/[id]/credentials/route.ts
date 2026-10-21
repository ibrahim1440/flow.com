import { NextResponse } from "@/lib/api-response";
import { requireAuth, requireAdminAction } from "@/lib/auth-server";
import { credentialsAction } from "@/lib/users/server";
import { body, noStore, usersErrorResponse } from "@/lib/users/http";

// POST — credentials (Figma UR-04): { action: "unlock" | "reset_password" | "reset_pin", reason }.
// Unlock clears the failed sign-ins that lock the username; a password reset issues a temporary
// password shown ONCE (changed at first sign-in, every session ended); a PIN reset clears the PIN,
// which the person sets again after confirming their identity — the administrator never sees or
// issues one (J-6). The administrator role only, after a recent step-up, never on one's own account.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const refused = await requireAdminAction(user, "users.credentials", { stepUp: true, message: "Only the administrator resets credentials." });
  if (refused) return refused;
  const { id } = await params;
  try {
    const r = await credentialsAction(request, user, id, await body(request));
    return r instanceof Response ? r : NextResponse.json(r, noStore);
  } catch (e) {
    return usersErrorResponse(e);
  }
}
