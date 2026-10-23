import { NextResponse } from "@/lib/api-response";
import { cookies } from "next/headers";
import { getUser, getUserWithPermissions } from "@/lib/auth-server";
import { revokeSession } from "@/lib/auth/session";
import { authAudit } from "@/lib/auth/sign-in";
import { refreshSessionCookie } from "@/lib/session-cookie";

export async function GET() {
  const user = await getUserWithPermissions();
  if (!user) {
    // A token cookie that no longer names a live session (idle, absolute deadline, logout,
    // revocation) says SESSION_ENDED, so the page can tell the user; still no data at all.
    const hadToken = !!(await cookies()).get("token")?.value;
    return NextResponse.json(hadToken ? { error: "Not authenticated", code: "SESSION_ENDED" } : { error: "Not authenticated" }, { status: 401 });
  }
  // The session id stays in the httpOnly cookie; the page only needs what the session allows.
  const { sessionId, cv, sid, ...rest } = user as typeof user & { cv?: string; sid?: string };
  void cv; void sid;
  const response = NextResponse.json({ user: rest });
  // A legacy (pre-v2) token — issued before the slim session cookie, carrying the whole
  // permission map — is accepted until it expires, and re-issued here in the slim form: the same
  // session row, so the same deadlines, MFA state and step-up time; nothing about the session
  // changes but the size of its cookie. The dashboard and the station screens call this route on
  // every load, so a signed-in browser is converted on its next page load without signing out.
  if ((await getUser())?.legacy) return refreshSessionCookie(response, user.id, sessionId);
  return response;
}

/** Logout revokes the session server-side: the same token replayed afterwards gets 401. */
export async function DELETE(request: Request) {
  const token = await getUser();
  if (token?.sid) {
    await revokeSession(token.sid, "LOGOUT");
    await authAudit(request, { userId: token.id, action: "SIGN_OUT", result: "SUCCESS" });
  }
  const response = NextResponse.json({ success: true });
  response.cookies.set("token", "", { maxAge: 0, path: "/" });
  return response;
}
