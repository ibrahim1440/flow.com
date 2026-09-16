import { createHmac } from "node:crypto";

/**
 * The PIN login selector and the PIN verifier input — Secure Version B.
 *
 * Two keyed derivations of the PIN, both under the same application secret the database does
 * not contain, each with its own domain so one can never be substituted for the other.
 *
 * ── pinLookup — the selector ────────────────────────────────────────────────
 * `Employee.pinHash` was an unsalted SHA-256 of the PIN, unique-indexed so that login could
 * find a row in one query. Against a six-digit space that is not a hash, it is the PIN: the
 * whole candidate space can be hashed in a single pass and, because there is no salt, the
 * resulting table matches every row at once. `pinLookup` is the same idea under a key.
 * HMAC-SHA256 with a secret the database does not contain cannot be precomputed, cannot be
 * reversed, and cannot be searched: an attacker holding the dump must attack the key rather
 * than a 10^6 PIN space.
 *
 * ── pinVerifierInput — what bcrypt actually hashes ──────────────────────────
 * `Employee.pin` no longer holds bcrypt(PIN). It holds bcrypt(pinVerifierInput(PIN)) — bcrypt
 * over a keyed HMAC-SHA384 of the PIN, not over the PIN itself. This is the offline-verifier
 * protection: an attacker who steals the whole database, `Employee.pin` included, can still
 * run bcrypt against the 10^6 PIN space at leisure. Hashing the raw PIN, that recovers the
 * PIN. Hashing a keyed derivation, brute-forcing bcrypt recovers only the HMAC output, and
 * without the secret there is no way to turn a candidate PIN into the value bcrypt accepts —
 * so the dump yields nothing testable offline. bcrypt keeps its role as the slow proof; the
 * HMAC removes the raw PIN from what bcrypt guards.
 *
 * ── The raw PIN never verifies directly ─────────────────────────────────────
 * Because the stored bcrypt is over the derived input, bcrypt.compare(PIN, Employee.pin) is
 * always false. Every verification path derives pinVerifierInput(PIN) first and compares
 * THAT. A path that bcrypt-compared the raw PIN would silently authenticate nobody, or — far
 * worse, on a legacy row still holding bcrypt(PIN) — reintroduce the raw-PIN verifier this
 * design exists to retire. The legacy `pinHash` column is written by nothing and read by
 * nothing under Version B; it stays inert until migration #19 removes it.
 *
 * ── It is a selector, not a proof ──────────────────────────────────────────
 * Finding the row is not authenticating the person. Login still ends in
 * bcrypt.compare(pinVerifierInput(pin), employee.pin), and lookup equality alone is never
 * accepted as authentication. Two independent failures would be needed to admit the wrong
 * operator.
 *
 * ── The secret is its own ──────────────────────────────────────────────────
 * Not JWT_SECRET and not the rate-limit pepper: sharing one value would mean a single leak
 * compromised session forgery and credential recovery together. The lookup and the verifier
 * input share it deliberately — one secret, two domains — because both are recovered together
 * or neither is. Validated at startup the way auth.ts validates JWT_SECRET, because a lookup
 * secret that quietly defaults to something weak is the original defect wearing a different
 * hat.
 *
 * ── Rotation is a maintenance procedure, not a feature ─────────────────────
 * There is deliberately no second secret and no version column. A stored HMAC does not say
 * which key produced it, so "how many rows are still on the old secret?" is a question the
 * database cannot answer without every plaintext PIN — which means a gradual dual-secret
 * migration could never be proven complete. Rotation is therefore a window: disable PIN
 * login, configure the new secret, reissue every PIN, verify, reopen. Honest downtime beats
 * unverifiable state.
 */

const BLOCKED_SECRETS = new Set([
  "hiqbah-fallback-secret",
  "replace-this-with-a-strong-random-secret-min-32-chars",
  "secret",
  "password",
  "changeme",
  "development",
  "test",
]);

const MIN_SECRET_LENGTH = 32;

// Domain-separated so the two derivations under this one key can never collide with each
// other or with any other use of the key. The selector is SHA-256; the verifier input is
// SHA-384, a different construction as well as a different domain, so that even a mistake
// that crossed the domains could not make one equal the other.
const LOOKUP_DOMAIN = "pin:lookup:v1:";
const VERIFY_DOMAIN = "pin:verify:v1:";

export type SecretDecision =
  | { ok: true; secret: string }
  | { ok: false; reason: string };

/**
 * Pure, so every permutation is exercisable with no server, no database and no real secret.
 * Reasons name the problem and never any part of the value.
 */
export function evaluatePinLookupSecret(
  env: Record<string, string | undefined>,
): SecretDecision {
  const raw = env.PIN_LOOKUP_SECRET;

  if (!raw || raw.trim() === "") {
    return { ok: false, reason: "PIN_LOOKUP_SECRET is not set." };
  }
  const secret = raw.trim();
  if (secret.length < MIN_SECRET_LENGTH) {
    return {
      ok: false,
      reason: `PIN_LOOKUP_SECRET is too short (${secret.length} characters). Minimum is ${MIN_SECRET_LENGTH}.`,
    };
  }
  if (BLOCKED_SECRETS.has(secret.toLowerCase())) {
    return { ok: false, reason: "PIN_LOOKUP_SECRET is set to a known weak or placeholder value." };
  }
  return { ok: true, secret };
}

export function requirePinLookupSecret(
  env: Record<string, string | undefined> = process.env,
): string {
  const decision = evaluatePinLookupSecret(env);
  if (!decision.ok) {
    throw new Error(
      `${decision.reason} PIN login cannot operate without it — generate a strong random ` +
        "value (openssl rand -base64 32) and set it in this environment.",
    );
  }
  return decision.secret;
}

/**
 * The lookup value for an already-validated PIN — the keyed selector login searches on.
 *
 * No normalization happens here, and none is needed: the caller has already required
 * ^[0-9]{6}$, so there is no whitespace to trim and no case to fold. One input string maps
 * to exactly one lookup.
 */
export function pinLookup(pin: string, secret: string): string {
  return createHmac("sha256", secret).update(LOOKUP_DOMAIN + pin).digest("base64");
}

/**
 * The bcrypt input for an already-validated PIN — the value `Employee.pin` is bcrypt(this).
 *
 * SHA-384 rather than SHA-256, under its own domain, so the verifier input is a distinct
 * derivation from the selector even though both are keyed by the same secret. Every path
 * that sets a credential stores bcrypt(pinVerifierInput(pin)); every path that checks one
 * compares pinVerifierInput(pin) against the stored bcrypt. The raw PIN is never the thing
 * bcrypt sees, so it can never verify directly and a stolen `Employee.pin` cannot be attacked
 * offline without the secret.
 */
export function pinVerifierInput(pin: string, secret: string): string {
  return createHmac("sha384", secret).update(VERIFY_DOMAIN + pin).digest("base64");
}
