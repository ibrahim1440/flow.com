import "server-only";
import { SignJWT, jwtVerify } from "jose";
import type { UserPayload } from "./auth-shared";
import { tokenExpSeconds } from "./auth/session-policy";

export * from "./auth-shared";

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
 */
export async function signToken(payload: UserPayload, sessionExpiresAt: Date): Promise<string> {
  return new SignJWT(payload as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(tokenExpSeconds(sessionExpiresAt))
    .sign(secret);
}

export async function verifyToken(token: string): Promise<UserPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secret);
    return payload as unknown as UserPayload;
  } catch {
    return null;
  }
}
