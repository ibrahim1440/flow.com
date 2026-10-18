// Session lifetime policy (owner security decision, 16 Oct). Pure: no database, no Next.js —
// importable by the services and the unit tests.
//
//   · idle:     a session unused for SESSION_IDLE_MS (4 h) is revoked on its next request;
//   · absolute: a session ends SESSION_ABSOLUTE_MS (12 h) after sign-in, whatever the activity;
//   · step-up:  STEP_UP_MS (10 min, ./step-up.ts) for the sensitive actions.
//
// The server-side AuthSession row is the authority for all three. The signed token and the
// cookie only carry the session id, and both are bounded by the row's absolute deadline: the
// token's `exp` IS that deadline (tokenExpSeconds), so the token can neither end an active
// session early nor outlive it. (Before impl/session-expiry the token carried a fixed 8 h `exp`,
// which ended every active session at 8 h instead of 12 h.)
export const SESSION_IDLE_MS = 4 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1000;

/** The JWT `exp` (seconds since the epoch) of a token for a session with this absolute deadline. */
export function tokenExpSeconds(sessionExpiresAt: Date): number {
  const t = sessionExpiresAt.getTime();
  if (!Number.isFinite(t)) throw new Error("tokenExpSeconds: invalid session deadline");
  return Math.floor(t / 1000);
}
