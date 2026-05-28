import { createHmac } from "crypto";
import { prisma } from "@/lib/db";

// ─── Startup validation ────────────────────────────────────────────────────────
// Self-contained: does not rely on auth.ts being loaded first.

const BLOCKED_PEPPER_VALUES = new Set([
  "hiqbah-fallback-secret",
  "replace-this-with-a-strong-random-secret-min-32-chars",
  "secret",
  "password",
  "changeme",
  "development",
  "test",
]);

const rawPepper = process.env.RATE_LIMIT_SECRET ?? process.env.JWT_SECRET;

if (!rawPepper) {
  throw new Error(
    "Rate limiting requires RATE_LIMIT_SECRET or JWT_SECRET. " +
    "Set at least one to a strong random value (minimum 32 characters) before starting the server."
  );
}
if (rawPepper.length < 32) {
  throw new Error(
    `Rate limit pepper is too short (${rawPepper.length} chars). Minimum is 32 characters.`
  );
}
if (BLOCKED_PEPPER_VALUES.has(rawPepper.toLowerCase().trim())) {
  throw new Error(
    "Rate limit pepper is set to a known weak or placeholder value. " +
    "Set RATE_LIMIT_SECRET or JWT_SECRET to a strong random value before starting the server."
  );
}

const pepper = rawPepper;

// ─── Constants ────────────────────────────────────────────────────────────────

const WINDOW_MS = 15 * 60 * 1000;  // 15-minute sliding window for rate limit checks
const PRUNE_MS  = 60 * 60 * 1000;  // rows older than 1 hour are pruned for table hygiene

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function hashRateLimitKey(value: string): string {
  return createHmac("sha256", pepper).update(value).digest("hex");
}

export function extractIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  // x-real-ip is set by Vercel and most reverse proxies.
  // Falls back to 0.0.0.0 when neither header is present (e.g. direct local calls).
  return request.headers.get("x-real-ip") ?? "0.0.0.0";
}

// Removes rows older than 1 hour globally (table hygiene, not per-IP).
export async function pruneExpired(): Promise<void> {
  await prisma.loginAttempt.deleteMany({
    where: { createdAt: { lt: new Date(Date.now() - PRUNE_MS) } },
  });
}

// Counts all failed attempts from this IP in the window, regardless of identifier.
// Catches broad enumeration: many different PINs or usernames tried from one source.
// Uses @@index([ipHash, createdAt]).
export async function isIpRateLimited(
  ipHash: string,
  maxAttempts: number
): Promise<boolean> {
  const windowStart = new Date(Date.now() - WINDOW_MS);
  const count = await prisma.loginAttempt.count({
    where: { ipHash, createdAt: { gte: windowStart } },
  });
  return count >= maxAttempts;
}

// Counts failed attempts for this exact IP + identifier pair in the window.
// Catches targeted credential stuffing against one account from one source.
// Uses @@index([ipHash, identifierHash, createdAt]).
export async function isPairRateLimited(
  ipHash: string,
  identifierHash: string,
  maxAttempts: number
): Promise<boolean> {
  const windowStart = new Date(Date.now() - WINDOW_MS);
  const count = await prisma.loginAttempt.count({
    where: { ipHash, identifierHash, createdAt: { gte: windowStart } },
  });
  return count >= maxAttempts;
}

export async function recordFailedAttempt(
  ipHash: string,
  identifierHash: string
): Promise<void> {
  await prisma.loginAttempt.create({ data: { ipHash, identifierHash } });
}

// Clears only the specific pair on success — does not reset the IP-wide count.
// Failed attempts for other identifiers from the same IP remain intact.
export async function clearAttempts(
  ipHash: string,
  identifierHash: string
): Promise<void> {
  await prisma.loginAttempt.deleteMany({ where: { ipHash, identifierHash } });
}
