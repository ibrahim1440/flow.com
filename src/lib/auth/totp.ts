// TOTP (RFC 6238, HMAC-SHA1, 30-second steps, 6 digits) and the at-rest encryption of its
// secret (AES-256-GCM with a key from AUTH_MFA_KEY, never stored with the data). Pure and
// dependency-free; tested against the RFC 6238 vectors.
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const c of clean) {
    const i = B32.indexOf(c);
    if (i < 0) throw new Error("Invalid base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const STEP_SECONDS = 30;
export const DIGITS = 6;

export function newSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(secret: Buffer, counter: bigint, digits = DIGITS, algo: "sha1" | "sha256" | "sha512" = "sha1"): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(counter);
  const h = createHmac(algo, secret).update(msg).digest();
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export const stepAt = (ms: number) => BigInt(Math.floor(ms / 1000 / STEP_SECONDS));

/**
 * The step a code matches (±1 step of clock drift), or null. A code for a step at or before
 * `lastStep` is refused — each code works once (replay).
 */
export function verifyTotp(secretB32: string, code: string, now: number, lastStep: bigint | null): bigint | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretB32);
  const cur = stepAt(now);
  for (const d of [BigInt(0), BigInt(-1), BigInt(1)]) {
    const step = cur + d;
    if (lastStep !== null && step <= lastStep) continue;
    const expect = Buffer.from(hotp(secret, step));
    if (timingSafeEqual(expect, Buffer.from(code))) return step;
  }
  return null;
}

export function otpauthUri(secretB32: string, account: string, issuer = "Hiqbah ERP"): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

// ── At-rest encryption ───────────────────────────────────────────────────────────

const MFA_KEY_BYTES = 32;

/**
 * Decode an AUTH_MFA_KEY value: exactly 64 hex characters, otherwise base64 (standard or URL-safe,
 * padded or not — Node's decoder accepts all four). Surrounding whitespace is ignored. Null unless it
 * decodes to exactly 32 bytes. The single decoder for both the running app and the environment gate.
 */
export function decodeMfaKey(value: string | undefined): Buffer | null {
  const raw = value?.trim();
  if (!raw) return null;
  const k = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  return k.length === MFA_KEY_BYTES ? k : null;
}

/** The 32-byte key from AUTH_MFA_KEY (base64 or hex), or null when MFA is not configured here. */
export function mfaKey(): Buffer | null {
  return decodeMfaKey(process.env.AUTH_MFA_KEY);
}

/**
 * The environment gate's rule for AUTH_MFA_KEY (src/lib/server-env.ts). Unset is allowed: MFA is then
 * "not configured" (enrollment answers 503 MFA_NOT_CONFIGURED). Set but undecodable is refused, because
 * the app would otherwise treat a mistyped key as "not configured" without a word — and an enrolled
 * account cannot sign in without it. The reason names the problem and never any part of the value.
 */
export function evaluateMfaKey(
  env: Record<string, string | undefined>,
): { ok: true } | { ok: false; reason: string } {
  const raw = env.AUTH_MFA_KEY;
  if (raw === undefined || raw === "") return { ok: true };
  if (decodeMfaKey(raw)) return { ok: true };
  return {
    ok: false,
    reason:
      `AUTH_MFA_KEY is set but does not decode to exactly ${MFA_KEY_BYTES} bytes ` +
      "(expected 64 hex characters, or base64 of 32 bytes such as the output of `openssl rand -base64 32`).",
  };
}

export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1.${iv.toString("base64")}.${c.getAuthTag().toString("base64")}.${enc.toString("base64")}`;
}

export function decryptSecret(blob: string, key: Buffer): string {
  const [v, iv, tag, enc] = blob.split(".");
  if (v !== "v1" || !iv || !tag || !enc) throw new Error("Unknown secret format");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(enc, "base64")), d.final()]).toString("utf8");
}

// ── Recovery codes ───────────────────────────────────────────────────────────────

/** Ten one-time codes, shown once: 10 characters from an unambiguous alphabet, grouped 5-5. */
export function newRecoveryCodes(n = 10): string[] {
  const alpha = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: n }, () => {
    const b = randomBytes(10);
    const s = Array.from(b, (x) => alpha[x % alpha.length]).join("");
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}

/** Keyed hash of a recovery code (normalized: upper case, no separators). */
export function recoveryHash(code: string, key: Buffer): string {
  return createHmac("sha256", key).update(`recovery:v1:${code.toUpperCase().replace(/[^A-Z0-9]/g, "")}`).digest("hex");
}
