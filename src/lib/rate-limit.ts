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

// ─── The PIN-space bucket ────────────────────────────────────────────────────
//
// Per-IP and per-(IP, candidate) counting bounds one address and one guessed value. It
// bounds nothing about a DISTRIBUTED walk of the PIN space, because on PIN-only login the
// identifier IS the candidate: 000000, 000001, 000002 each hash differently, so no
// per-identifier threshold ever accumulates. There is also no account to key a limit on —
// a wrong PIN identifies nobody.
//
// So each PIN failure also writes one row under this fixed synthetic identifier, giving a
// countable system-wide view of PIN guessing. It is a constant, not a credential, and it
// goes through the same peppered hash as every other identifier so the table holds no
// distinguishable plaintext.
export const PIN_GLOBAL = hashRateLimitKey("bucket:pin-login");

/** How quickly a system-wide burst is judged, and how long the response lasts. */
const BURST_WINDOW_MS = 60_000;
const GLOBAL_BURST = 30;

// Counts failed attempts from this IP in the window, EXCLUDING the PIN_GLOBAL marker.
//
// The exclusion is what keeps the accounting honest. A failed PIN writes two rows — the
// candidate row and the marker — and without this predicate each failure would count
// twice here, silently halving every per-IP limit in the application: login, both
// destructive resets and the self-service PIN change all read this one function. With it,
// one failure contributes exactly one row, exactly as before this bucket existed.
//
// Note what this deliberately does NOT do: PIN candidate rows still count toward the same
// per-IP budget password login reads. That cross-method behaviour predates this change and
// is kept — an address misbehaving on one method is throttled on both.
// Uses @@index([ipHash, createdAt]).
export async function isIpRateLimited(
  ipHash: string,
  maxAttempts: number
): Promise<boolean> {
  const windowStart = new Date(Date.now() - WINDOW_MS);
  const count = await prisma.loginAttempt.count({
    where: { ipHash, identifierHash: { not: PIN_GLOBAL }, createdAt: { gte: windowStart } },
  });
  return count >= maxAttempts;
}

/**
 * Is the system as a whole being walked right now?
 *
 * Counts marker rows across every address and every candidate in the last minute. No index
 * leads with identifierHash, so this scans — of a table that holds only unpruned failures,
 * which at this scale is a scan of almost nothing. An index would be a schema change made
 * on speculation; measure first.
 */
export async function isPinSpaceConstrained(): Promise<boolean> {
  const windowStart = new Date(Date.now() - BURST_WINDOW_MS);
  const count = await prisma.loginAttempt.count({
    where: { identifierHash: PIN_GLOBAL, createdAt: { gte: windowStart } },
  });
  return count >= GLOBAL_BURST;
}

/** Has this address avoided failing a PIN in the last minute? Uses the composite index. */
export async function isIpQuietForPin(ipHash: string): Promise<boolean> {
  const windowStart = new Date(Date.now() - BURST_WINDOW_MS);
  const count = await prisma.loginAttempt.count({
    where: { ipHash, identifierHash: PIN_GLOBAL, createdAt: { gte: windowStart } },
  });
  return count === 0;
}

/** This address's PIN failures over the normal window — the tightened allowance. */
export async function isIpPinRateLimited(ipHash: string, maxAttempts: number): Promise<boolean> {
  const windowStart = new Date(Date.now() - WINDOW_MS);
  const count = await prisma.loginAttempt.count({
    where: { ipHash, identifierHash: PIN_GLOBAL, createdAt: { gte: windowStart } },
  });
  return count >= maxAttempts;
}

/** A failed PIN: the candidate row every limiter already counted, plus the marker. */
export async function recordPinFailure(ipHash: string, identifierHash: string): Promise<void> {
  await prisma.loginAttempt.createMany({
    data: [{ ipHash, identifierHash }, { ipHash, identifierHash: PIN_GLOBAL }],
  });
}

/** A success clears both: this address has just proved it belongs to somebody. */
export async function clearPinAttempts(ipHash: string, identifierHash: string): Promise<void> {
  await prisma.loginAttempt.deleteMany({
    where: { ipHash, identifierHash: { in: [identifierHash, PIN_GLOBAL] } },
  });
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
