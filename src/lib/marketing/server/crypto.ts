import "server-only";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Platform tokens at rest: AES-256-GCM under MARKETING_TOKEN_KEY (32 bytes, base64 or hex).
 * Stored as "v1.<iv>.<tag>.<ciphertext>" (base64url). Without the key nothing is stored — the
 * connection screen says so — rather than keeping a token in clear.
 */
function key(env: Record<string, string | undefined> = process.env): Buffer | null {
  const raw = env.MARKETING_TOKEN_KEY?.trim();
  if (!raw) return null;
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  return buf.length === 32 ? buf : null;
}

export function tokenKeyConfigured(env?: Record<string, string | undefined>): boolean {
  return key(env) !== null;
}

export function encryptToken(plain: string, env?: Record<string, string | undefined>): string {
  const k = key(env);
  if (!k) throw new Error("MARKETING_TOKEN_KEY is not configured");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", k, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

export function decryptToken(stored: string, env?: Record<string, string | undefined>): string {
  const k = key(env);
  if (!k) throw new Error("MARKETING_TOKEN_KEY is not configured");
  const [v, iv, tag, ct] = stored.split(".");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("unknown token format");
  const d = createDecipheriv("aes-256-gcm", k, Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}

/** HMAC-SHA256 of the RAW body, compared in constant time. `header` may carry a "sha256=" prefix. */
export function verifyHmacSha256(rawBody: string | Buffer, secret: string, header: string | null, encoding: "hex" | "base64" = "hex"): boolean {
  if (!header || !secret) return false;
  const given = header.replace(/^sha256=/i, "").trim();
  const expected = createHmac("sha256", secret).update(rawBody).digest(encoding);
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
