import { NextResponse } from "@/lib/api-response";
import { requireAuth, requireFreshAuth } from "@/lib/auth-server";
import { endMyOtherSessions } from "@/lib/auth/my-security";
import { authAudit } from "@/lib/auth/sign-in";

// DELETE — end every OTHER live session of the signed-in user («إنهاء كل الجلسات الأخرى», Figma
// UR-02d / TD-11). The session this request is made in stays. Like every end or revoke in the
// approved frames it needs the caller's password again (a step-up within 10 minutes: 401
// REAUTH_REQUIRED, which the dashboard's step-up dialog answers and retries), and it is audited.
export async function DELETE(request: Request) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const stale = requireFreshAuth(user);
  if (stale) return stale;
  const ended = await endMyOtherSessions({ id: user.id, sessionId: user.sessionId });
  await authAudit(request, { userId: user.id, action: "OTHER_SESSIONS_ENDED_SELF", result: "SUCCESS", metadata: { ended } });
  return NextResponse.json({ ended });
}
