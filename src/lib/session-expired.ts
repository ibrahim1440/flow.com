// An ended session (idle 4 h, absolute 12 h, logout elsewhere, revocation) seen from an open
// dashboard page. Pure and client-safe: no server import.
//
// The server answers every request of an ended session with exactly 401 {"error":"Not
// authenticated"} (auth-server.ts unauthorized()) — no data. The page then leaves for the
// sign-in screen with ?reason=session_expired, which shows a bilingual notice. A full navigation
// (not a client-side route change) so nothing the page had loaded stays in memory.
//
// NOT an ended session: 401 REAUTH_REQUIRED (the step-up dialog handles it) and 401 "Invalid
// credentials" (a wrong current PIN / password in a form) — the session is still live.
export const SESSION_EXPIRED_REASON = "session_expired";
export const SESSION_EXPIRED_LOGIN = `/login?reason=${SESSION_EXPIRED_REASON}`;
export const SESSION_EXPIRED_AR = "انتهت جلستك — سجّل الدخول مرة أخرى.";
export const SESSION_EXPIRED_EN = "Your session has ended — please sign in again.";

/** Is this response our own API saying the session no longer exists? */
export function isEndedSession(status: number, url: string, body: unknown, origin?: string): boolean {
  if (status !== 401) return false;
  let path: string;
  try {
    const u = new URL(url, origin ?? "http://localhost");
    if (origin && u.origin !== new URL(origin).origin) return false;
    path = u.pathname;
  } catch {
    return false;
  }
  if (!path.startsWith("/api/") || path.startsWith("/api/auth/login") || path.startsWith("/api/auth/reauth") || path.startsWith("/api/auth/mfa/login")) return false;
  const b = body as { error?: unknown; code?: unknown } | null;
  return !!b && b.error === "Not authenticated" && (b.code === undefined || b.code === "SESSION_ENDED");
}

/** Whether the sign-in page was reached because a session ended. */
export const cameForExpiredSession = (search: string) => new URLSearchParams(search).get("reason") === SESSION_EXPIRED_REASON;
