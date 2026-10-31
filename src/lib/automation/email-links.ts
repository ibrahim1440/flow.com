/**
 * Signed links in customer e-mails (batch 25): «إيقاف الإيميلات» (unsubscribe) and «وصلتني» (the test e-mail reached
 * the test address). HMAC-SHA256 over a typed payload; the key is EMAIL_LINK_SECRET when set, else derived from
 * JWT_SECRET (batch 25b: EMAIL_LINK_SECRET is REQUIRED for LIVE — email-mode.ts — and EMAIL_LINK_SECRET_PREVIOUS keeps the
 * links signed before a rotation working). The payload is base64url, NOT encrypted, so it carries no customer id: the
 * unsubscribe link carries Customer.emailLinkId — a random, opaque id made for this purpose — and any change to the
 * payload breaks the signature (compared in constant time).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

function key(env: Record<string, string | undefined> = process.env): Buffer {
  const own = env.EMAIL_LINK_SECRET?.trim();
  if (own && own.length >= 32) return Buffer.from(own);
  const base = env.JWT_SECRET?.trim();
  if (!base || base.length < 32) throw new Error("No signing key for e-mail links (JWT_SECRET or EMAIL_LINK_SECRET).");
  return createHmac("sha256", base).update("hiqbah/email-links/v1").digest();
}

/**
 * Batch 25b (seat 6 N2), key rotation: links are always SIGNED with the current key; a link is ACCEPTED when it was signed
 * with the current key or with EMAIL_LINK_SECRET_PREVIOUS (the key before the last rotation), so the unsubscribe links in
 * e-mails already sent keep working. Rotate: move the old value to EMAIL_LINK_SECRET_PREVIOUS, set a new EMAIL_LINK_SECRET.
 */
function verifyKeys(env: Record<string, string | undefined> = process.env): Buffer[] {
  const keys = [key(env)];
  const prev = env.EMAIL_LINK_SECRET_PREVIOUS?.trim();
  if (prev && prev.length >= 32) keys.push(Buffer.from(prev));
  return keys;
}

function sign(payload: string, env?: Record<string, string | undefined>, k?: Buffer): string {
  return createHmac("sha256", k ?? key(env)).update(payload).digest("base64url");
}

export function makeToken(kind: "u" | "tv", fields: string[], env?: Record<string, string | undefined>): string {
  const payload = `${kind}1|${fields.join("|")}`;
  return `${b64u(payload)}.${sign(payload, env)}`;
}

/** The fields of a valid token of that kind, or null (tampered, truncated, other kind, bad encoding). */
export function readToken(kind: "u" | "tv", token: unknown, env?: Record<string, string | undefined>): string[] | null {
  if (typeof token !== "string" || token.length > 600) return null;
  const [p, sig, extra] = token.split(".");
  if (!p || !sig || extra !== undefined) return null;
  let payload: string;
  try { payload = Buffer.from(p, "base64url").toString("utf8"); } catch { return null; }
  if (b64u(payload) !== p) return null;
  const got = Buffer.from(sig);
  const ok = verifyKeys(env).some((k) => {
    const want = Buffer.from(sign(payload, env, k));
    return want.length === got.length && timingSafeEqual(want, got);
  });
  if (!ok) return null;
  const parts = payload.split("|");
  if (parts[0] !== `${kind}1`) return null;
  return parts.slice(1);
}

/** The unsubscribe token for a customer's opaque link id (Customer.emailLinkId). No expiry: old links keep working. */
export const unsubscribeToken = (linkId: string, env?: Record<string, string | undefined>) => makeToken("u", [linkId], env);
/** The opaque link id a valid unsubscribe token carries, or null. */
export function readUnsubscribeToken(token: unknown, env?: Record<string, string | undefined>): string | null {
  const f = readToken("u", token, env);
  return f && f.length === 1 && /^[A-Za-z0-9_-]{16,64}$/.test(f[0]) ? f[0] : null;
}

/** A new opaque link id (22 url-safe characters, 128 random bits). */
export const newEmailLinkId = () => randomBytes(16).toString("base64url");

/** «وصلتني»: binds the test address and the moment the test e-mail was sent; valid 7 days. */
export const TEST_CONFIRM_TTL_MS = 7 * 86_400_000;
export const testConfirmToken = (email: string, sentAt: Date, env?: Record<string, string | undefined>) => makeToken("tv", [email, String(sentAt.getTime())], env);
export function readTestConfirmToken(token: unknown, now: Date = new Date(), env?: Record<string, string | undefined>): { email: string; sentAt: Date } | null {
  const f = readToken("tv", token, env);
  if (!f || f.length !== 2) return null;
  const at = Number(f[1]);
  if (!Number.isFinite(at) || at > now.getTime() + 60_000 || now.getTime() - at > TEST_CONFIRM_TTL_MS) return null;
  return { email: f[0], sentAt: new Date(at) };
}

/** The public origin links are built on: APP_BASE_URL, else the production URL Vercel gives; null when neither is set. */
export function appBaseUrl(env: Record<string, string | undefined> = process.env): string | null {
  const own = env.APP_BASE_URL?.trim().replace(/\/+$/, "");
  if (own) return own;
  return env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : null;
}
