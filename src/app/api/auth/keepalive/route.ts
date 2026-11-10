import { NextResponse } from "@/lib/api-response";
import { requireAuth } from "@/lib/auth-server";
import { prisma } from "@/lib/db";
import { sessionRef } from "@/lib/auth/device";
import { SESSION_IDLE_MS } from "@/lib/auth/session-policy";

/**
 * POST /api/auth/keepalive — «كمّل» on the inactivity warning, and the dashboard's ping (about once a minute while the
 * person works). User-driven: it ALWAYS sets the session's last use to now (not throttled like other requests — gate
 * M1), so the server's idle clock and the page's never drift apart. Answers the server's own view: `deadline` (when the
 * session would end without more activity) and `now`, so the page counts down to the server's deadline, and `ref` (this
 * session, not its id) so an old tab never ends a newer sign-in (DELETE /api/auth/me?reason=idle&ref=…).
 */
export async function POST() {
  const { user, error } = await requireAuth({ allowMfaEnrollment: true, allowPasswordChange: true });
  if (error) return error;
  const now = new Date();
  await prisma.authSession.updateMany({ where: { id: user.sessionId, revokedAt: null }, data: { lastSeenAt: now } });
  return NextResponse.json({ now: now.toISOString(), deadline: new Date(now.getTime() + SESSION_IDLE_MS).toISOString(), ref: sessionRef(user.sessionId) },
    { headers: { "Cache-Control": "no-store" } });
}
