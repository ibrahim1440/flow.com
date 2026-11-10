// Sign-out after inactivity (owner, 9 Nov): the dashboard's side of SESSION_IDLE_MS. Pure and client-safe — the
// tracker (components/auth/IdleGuard.tsx) and the unit tests use it; the server enforces the same limit on its own
// (lib/auth/session.ts checkSession), so a closed laptop or a killed tab ends the session all the same.
import { IDLE_WARN_MS, SESSION_IDLE_MS } from "./session-policy";

export { IDLE_WARN_MS, SESSION_IDLE_MS };
/**
 * While the person works, a keep-alive at most this often — and only when there was activity since the last one (gate
 * M1). The keep-alive always sets the server's last use to now, so the server's clock trails the page's by at most this.
 */
export const KEEPALIVE_EVERY_MS = 60 * 1000;
export const IDLE_REASON = "idle";
export const SESSION_IDLE_AR = "انتهت الجلسة لعدم النشاط — سجّل دخولك من جديد.";
export const SESSION_IDLE_EN = "You were signed out after 10 minutes without activity — please sign in again.";
const WARN_BEFORE_MS = SESSION_IDLE_MS - IDLE_WARN_MS;

export type IdleState = { state: "active" } | { state: "warn"; secondsLeft: number } | { state: "expired" };

/**
 * When the session ends without more activity, on this browser's clock: the EARLIER of the page's own count (last
 * activity of any tab + the limit) and the server's (the deadline its last keep-alive confirmed). The server's is the
 * one that actually ends the session; counting to the earlier of the two means the warning always comes first — never
 * a silent sign-out by a poll (gate M1, probe B) — and «كمّل» is always sent before the server's deadline (probe A).
 */
export function deadlineOf(lastActivity: number, serverDeadline: number | null): number {
  const local = lastActivity + SESSION_IDLE_MS;
  return serverDeadline === null ? local : Math.min(local, serverDeadline);
}

/** Where the page stands `now` against `deadline`: the warning in the last minute, then expired. */
export function stateAt(deadline: number, now: number): IdleState {
  if (now >= deadline) return { state: "expired" };
  if (now >= deadline - WARN_BEFORE_MS) return { state: "warn", secondsLeft: Math.max(1, Math.ceil((deadline - now) / 1000)) };
  return { state: "active" };
}

/** The page's own count only (no server deadline yet). */
export const idleState = (lastActivity: number, now: number): IdleState => stateAt(deadlineOf(lastActivity, null), now);

/** A keep-alive is due: activity since the last one, and at least KEEPALIVE_EVERY_MS since it. */
export const shouldPing = (lastPing: number, now: number, activitySince = true) => activitySince && now - lastPing >= KEEPALIVE_EVERY_MS;

/** The server's deadline on THIS browser's clock: its answer is relative to its own `now` (no clock-skew assumption). */
export function serverDeadlineLocal(answer: { now: string; deadline: string }, clientNow: number): number | null {
  const d = Date.parse(answer.deadline) - Date.parse(answer.now);
  return Number.isFinite(d) ? clientNow + d : null;
}

/**
 * The sign-in return (`next`) after an idle sign-out: an ERP page of this site only — a path under /dashboard, never
 * another origin («//host», «/\host»), a scheme, or a control character. Anything else: null (the usual landing).
 */
export function safeNext(next: string | null | undefined): string | null {
  if (!next || next.length > 1000) return null;
  if (!/^\/dashboard(?:[/?#]|$)/.test(next)) return null;
  if (next.includes("\\") || next.includes("//") || /[\u0000-\u001f\u007f]/.test(next)) return null;
  return next;
}

/** /login?reason=idle&next=<the page> — `path` is the page's own pathname + search. */
export const idleLoginUrl = (path: string) => `/login?reason=${IDLE_REASON}${safeNext(path) ? `&next=${encodeURIComponent(path)}` : ""}`;
