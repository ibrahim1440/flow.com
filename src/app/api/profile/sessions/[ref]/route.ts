import { NextResponse } from "@/lib/api-response";
import { requireAuth, requireFreshAuth } from "@/lib/auth-server";
import { endMySession } from "@/lib/auth/my-security";
import { authAudit } from "@/lib/auth/sign-in";

// DELETE — end ONE live session of the signed-in user («إنهاء الجلسة», Figma UR-02d). The ref is
// the one GET /api/profile/security listed; it is looked up among the CALLER's own live sessions
// only, so another account's session (or an unknown ref) answers 404 and nothing changes. The
// current session is ended by signing out (409). Step-up within 10 minutes, audited.
export async function DELETE(request: Request, { params }: { params: Promise<{ ref: string }> }) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const { ref } = await params;
  if (!/^[A-Za-z0-9_-]{22}$/.test(ref)) return NextResponse.json({ error: "الجلسة غير موجودة.", errorEn: "Session not found." }, { status: 404 });
  const stale = requireFreshAuth(user);
  if (stale) return stale;
  const r = await endMySession({ id: user.id, sessionId: user.sessionId }, ref);
  if (r === "NOT_FOUND") return NextResponse.json({ error: "الجلسة غير موجودة أو انتهت.", errorEn: "Session not found or already ended." }, { status: 404 });
  if (r === "CURRENT") return NextResponse.json({ error: "هذه جلستك الحالية: استخدم تسجيل الخروج.", errorEn: "This is your current session: sign out instead.", code: "CURRENT_SESSION" }, { status: 409 });
  await authAudit(request, { userId: user.id, action: "SESSION_ENDED_SELF", result: "SUCCESS" });
  return NextResponse.json({ ended: 1 });
}
