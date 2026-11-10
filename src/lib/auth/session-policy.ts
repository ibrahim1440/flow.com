// Session lifetime policy (owner security decision, 16 Oct). Pure: no database, no Next.js —
// importable by the services and the unit tests.
//
//   · idle:     an ERP session unused for SESSION_IDLE_MS (10 min, owner 9 Nov — was 4 h) is revoked on its next
//               request (401 SESSION_IDLE). A background request (BACKGROUND_HEADER: the bell, the badges, a poller)
//               is checked but never counts as use. The dashboard warns at IDLE_WARN_MS and signs out at the limit
//               (components/auth/IdleGuard.tsx). Station sessions keep their own idle rule (lib/station).
//   · absolute: a session ends SESSION_ABSOLUTE_MS (12 h) after sign-in, whatever the activity;
//   · step-up:  STEP_UP_MS (10 min, ./step-up.ts) for the sensitive actions.
//
// The server-side AuthSession row is the authority for all three. The signed token and the
// cookie only carry the session id, and both are bounded by the row's absolute deadline: the
// token's `exp` IS that deadline (tokenExpSeconds), so the token can neither end an active
// session early nor outlive it. (Before impl/session-expiry the token carried a fixed 8 h `exp`,
// which ended every active session at 8 h instead of 12 h.)
export const SESSION_IDLE_MS = 10 * 60 * 1000;
/** The dashboard's «بتطلع خلال دقيقة» warning: one minute before the limit. */
export const IDLE_WARN_MS = SESSION_IDLE_MS - 60 * 1000;
/** A request the browser makes by itself (polling, auto-refresh): `x-bf-background: 1` — never extends the session. */
export const BACKGROUND_HEADER = "x-bf-background";
export const BACKGROUND_HEADERS: Record<string, string> = { [BACKGROUND_HEADER]: "1" };
export const SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1000;

/** The JWT `exp` (seconds since the epoch) of a token for a session with this absolute deadline. */
export function tokenExpSeconds(sessionExpiresAt: Date): number {
  const t = sessionExpiresAt.getTime();
  if (!Number.isFinite(t)) throw new Error("tokenExpSeconds: invalid session deadline");
  return Math.floor(t / 1000);
}
