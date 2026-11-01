import { NextResponse } from "@/lib/api-response";
import { requireAuth } from "@/lib/auth-server";
import { mySecurity } from "@/lib/auth/my-security";
import { isAdminRole } from "@/lib/station/access";

// GET — the signed-in user's OWN account security («ملفي الشخصي»): account facts, the previous
// sign-in, live sessions, devices (sessions grouped by browser) and recent sign-in activity.
// Scoped to the caller by the session; no parameter names another account. ?activity=N (1–100).
export async function GET(request: Request) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const n = Number(new URL(request.url).searchParams.get("activity") ?? "8");
  const data = await mySecurity({ id: user.id, sessionId: user.sessionId }, { activityLimit: Number.isFinite(n) ? n : 8 });
  // Owner decision (1 Nov 2026): the sign-in log is the administrator's to read (on «المستخدمون»); an employee's own
  // profile no longer lists it. Read-only, the caller's own data: no step-up.
  const canSeeLog = isAdminRole(user.role);
  return NextResponse.json({ ...data, activity: canSeeLog ? data.activity : [], activityMore: canSeeLog ? data.activityMore : false, canSeeLog }, { headers: { "Cache-Control": "no-store" } });
}
