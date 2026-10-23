import "server-only";
import { tokenExpSeconds } from "./auth/session-policy";
import { signSessionToken, verifySessionToken, type SessionClaims, type VerifiedSession } from "./auth/session-token";

export * from "./auth-shared";
export type { SessionClaims, VerifiedSession } from "./auth/session-token";

const BLOCKED_SECRETS = new Set([
  "hiqbah-fallback-secret",
  "replace-this-with-a-strong-random-secret-min-32-chars",
  "secret",
  "password",
  "changeme",
  "development",
  "test",
]);

const rawSecret = process.env.JWT_SECRET;
if (!rawSecret) {
  throw new Error(
    "JWT_SECRET environment variable is not set. " +
    "Add a strong random value (minimum 32 characters) to your .env file or deployment environment."
  );
}
if (rawSecret.length < 32) {
  throw new Error(
    `JWT_SECRET is too short (${rawSecret.length} characters). Minimum length is 32 characters.`
  );
}
if (BLOCKED_SECRETS.has(rawSecret.toLowerCase().trim())) {
  throw new Error(
    "JWT_SECRET is set to a known weak or placeholder value. " +
    "Generate a strong random secret before starting the server."
  );
}

const secret = new TextEncoder().encode(rawSecret);

/**
 * The token of a server-side session. Its `exp` is the session's absolute deadline
 * (auth/session-policy.ts), never a fixed lifetime: a fixed "8h" ended every active session
 * before the 12-hour limit, and a longer one would let the token outlive it.
 *
 * It carries only the slim claims (auth/session-token.ts): no permissions, name or role, so its
 * size does not depend on the account. Signing refuses a cookie over 2 KB.
 */
export async function signToken(claims: SessionClaims, sessionExpiresAt: Date): Promise<string> {
  return signSessionToken(claims, tokenExpSeconds(sessionExpiresAt), secret);
}

/** A valid token's claims (a legacy pre-v2 token too, flagged `legacy`), or null. */
export async function verifyToken(token: string): Promise<VerifiedSession | null> {
  return verifySessionToken(token, secret);
}
