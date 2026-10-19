import { NextResponse } from "next/server";
import { requireAuth, requireAdminAction } from "@/lib/auth-server";
import { endAccountSessions } from "@/lib/users/server";
import { auditContext } from "@/lib/users/account-update";
import { usersErrorResponse } from "@/lib/users/http";
import { UsersError } from "@/lib/users/errors";

// DELETE — «إنهاء الجلسة» (Figma UR-02d): one live session of another account, ended on the server at
// once and audited. The administrator role only, after a recent step-up.
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string; ref: string }> }) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const refused = await requireAdminAction(user, "users.session_end", { stepUp: true, message: "Only the administrator ends another user's sessions." });
  if (refused) return refused;
  const { id, ref } = await params;
  try {
    if (id === user.id) throw new UsersError(403, "SELF_SESSIONS", "جلساتك من «ملفي والأمان».", "End your own sessions from your profile.");
    return NextResponse.json({ ended: await endAccountSessions(auditContext(request, user.id), id, { session: ref }) });
  } catch (e) {
    return usersErrorResponse(e);
  }
}
