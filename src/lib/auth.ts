import "server-only";
import { SignJWT, jwtVerify } from "jose";
import type { UserPayload } from "./auth-shared";

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

export async function signToken(payload: UserPayload): Promise<string> {
  return new SignJWT(payload as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("8h")
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
