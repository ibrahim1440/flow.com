import { NextResponse } from "@/lib/api-response";
import { requireAuth, requireModule, requireAdminAction } from "@/lib/auth-server";
import { accountSessions, endAccountSessions, isUsersAdmin } from "@/lib/users/server";
import { auditContext } from "@/lib/users/account-update";
import { ADMIN_READ_ONLY, body, noStore, usersErrorResponse } from "@/lib/users/http";
import { UsersError } from "@/lib/users/errors";

// GET — another account's devices and live sessions (Figma UR-02d): the administrator role only.
// Sessions and devices are named by one-way refs; no id, address hash or credential is returned.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireModule("employees");
  if (error) return error;
  if (!isUsersAdmin(user)) return ADMIN_READ_ONLY();
  const { id } = await params;
  try {
    return NextResponse.json(await accountSessions(id), noStore);
  } catch (e) {
    return usersErrorResponse(e);
  }
}

// DELETE — «إنهاء كل الجلسات», or one device's sessions with { device: ref } («إلغاء الثقة»):
// ended on the server at once (D-6), audited. The administrator role only, after a recent step-up;
// one's own sessions are ended from «ملفي والأمان».
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const refused = await requireAdminAction(user, "users.sessions_end", { stepUp: true, message: "Only the administrator ends another user's sessions." });
  if (refused) return refused;
  const { id } = await params;
  try {
    if (id === user.id) throw new UsersError(403, "SELF_SESSIONS", "جلساتك من «ملفي والأمان».", "End your own sessions from your profile.");
    const b = await body(request);
    const ended = await endAccountSessions(auditContext(request, user.id), id, { device: typeof b.device === "string" ? b.device : undefined, reason: typeof b.reason === "string" ? b.reason.slice(0, 300) : null });
    return NextResponse.json({ ended });
  } catch (e) {
    return usersErrorResponse(e);
  }
}
