// The session token: a signed POINTER to a server-side AuthSession row, and nothing else.
//
// Go-live blocker (23 Oct): the token used to carry the account's whole permission map, its name
// and its role. Nothing read them — every request re-reads role, permissions, active state and
// the session row from the database (src/lib/auth-server.ts getUserWithPermissions) — but they
// made the cookie grow with every sub-privilege a batch added. An admin-role account in SIMPLE
// MODE (every module, every sub) reached ~4.06 KB with the name "Admin" and 4.10 KB with a
// 36-byte Arabic name; browsers drop a cookie over 4096 bytes without a word, so sign-in answered
// 200 and the person landed back on /login.
//
// So the token now carries a fixed set of short claims, none of which grows with the account:
//   v      the token format (2). A token without it is a legacy (pre-v2) token — see below;
//   id     the employee id (the subject);
//   sid    the AuthSession row (no row, no access: logout, idle, absolute expiry, revocation,
//          MFA state, step-up time and sign-in method all live on the row);
//   cv     the credential digest (a credential change ends every earlier session);
//   preferredLanguage  "ar" | "en" — the root layout sets <html lang/dir> from it without a query;
//   scope  "STATION" on a workstation session (hq_station_session); absent on an ERP session;
//   iat / exp  set by the signer (exp = the session's absolute deadline).
// No permission, no name, no role: they are resolved from the database on every request.
//
// Legacy tokens (issued before this change, carrying name/role/permissions): still accepted until
// they expire — the extra claims are ignored, exactly as they already were — and re-issued in the
// slim form, same session row and deadline, the next time the dashboard loads /api/auth/me.
//
// Pure (jose only): no database, no Next.js, no "server-only" — the unit tests sign and read
// tokens with it directly.
import { SignJWT, jwtVerify } from "jose";

export const SESSION_TOKEN_VERSION = 2 as const;
/** The cookie (name=value) must stay at or below this many bytes — half the browser's 4096 limit. */
export const SESSION_COOKIE_MAX_BYTES = 2048;

export type SessionScope = "STATION";
/** What a session token carries (before iat/exp). */
export type SessionClaims = {
  id: string;
  sid: string;
  cv: string;
  preferredLanguage: "ar" | "en";
  scope?: SessionScope;
};
/** What a verified token tells the server. `legacy`: a pre-v2 token (to be re-issued slim). */
export type VerifiedSession = {
  id: string;
  sid?: string;
  cv?: string;
  preferredLanguage: "ar" | "en";
  scope?: string;
  iat?: number;
  exp?: number;
  legacy: boolean;
};

/** Exactly the slim claims, in a fixed order — never anything the caller happened to pass. */
export function slimClaims(c: SessionClaims): Record<string, unknown> {
  return {
    v: SESSION_TOKEN_VERSION,
    id: c.id,
    sid: c.sid,
    cv: c.cv,
    preferredLanguage: c.preferredLanguage === "en" ? "en" : "ar",
    ...(c.scope ? { scope: c.scope } : {}),
  };
}

/** Bytes of `name=value` as the browser counts it (the token is ASCII; measured as UTF-8 anyway). */
export function cookieBytes(name: string, value: string): number {
  return Buffer.byteLength(`${name}=${value}`, "utf8");
}

/** Throws when a session cookie would exceed SESSION_COOKIE_MAX_BYTES (a loud 500, never a silent drop). */
export function assertSessionCookieSize(name: string, token: string): void {
  const n = cookieBytes(name, token);
  if (n > SESSION_COOKIE_MAX_BYTES) throw new Error(`session cookie ${name} is ${n} bytes (limit ${SESSION_COOKIE_MAX_BYTES})`);
}

export async function signSessionToken(claims: SessionClaims, expSeconds: number, key: Uint8Array): Promise<string> {
  const token = await new SignJWT(slimClaims(claims)).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime(expSeconds).sign(key);
  // Both cookie names that carry a session token are short ("token", "hq_station_session").
  assertSessionCookieSize("hq_station_session", token);
  return token;
}

/** Verifies the signature and expiry, then reads only the claims the server uses. */
export async function verifySessionToken(token: string, key: Uint8Array): Promise<VerifiedSession | null> {
  try {
    const { payload } = await jwtVerify(token, key);
    if (typeof payload.id !== "string" || !payload.id) return null;
    return {
      id: payload.id,
      sid: typeof payload.sid === "string" ? payload.sid : undefined,
      cv: typeof payload.cv === "string" ? payload.cv : undefined,
      preferredLanguage: payload.preferredLanguage === "en" ? "en" : "ar",
      scope: typeof payload.scope === "string" ? payload.scope : undefined,
      iat: typeof payload.iat === "number" ? payload.iat : undefined,
      exp: typeof payload.exp === "number" ? payload.exp : undefined,
      legacy: payload.v !== SESSION_TOKEN_VERSION,
    };
  } catch {
    return null;
  }
}
