// Who may call a scheduled job route. R1-d (owner 5-ب): CRON_SECRET only — `Authorization: Bearer <CRON_SECRET>`,
// compared in constant time. Vercel Cron sends exactly that header when the project has the variable; the GitHub
// Actions schedule (.github/workflows/cron.yml) sends it from its repository secret.
//
// The old fallback — a request whose user agent said «vercel-cron/…» on an app running on Vercel — is gone: anyone who
// knew a URL could imitate that header. The secret is mandatory in Production (lib/server-env.ts refuses to start
// without one of at least 32 characters); without it, or off Vercel without it (local, tests), every call is refused.
import { timingSafeEqual } from "node:crypto";

/** The minimum length of CRON_SECRET (lib/server-env.ts enforces it at start in Production). */
export const CRON_SECRET_MIN = 32;

export type CronAuth = { ok: true; via: "secret" } | { ok: false };

export function cronAuthorized(headers: Headers, env: Record<string, string | undefined> = process.env): CronAuth {
  const secret = env.CRON_SECRET;
  if (!secret || secret.length < CRON_SECRET_MIN) return { ok: false };
  const expected = Buffer.from(`Bearer ${secret}`);
  const given = Buffer.from(headers.get("authorization") ?? "");
  return given.length === expected.length && timingSafeEqual(given, expected) ? { ok: true, via: "secret" } : { ok: false };
}

/** Whether a usable scheduler secret is set (never its value) — for the settings screens. */
export function cronSecretConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return (env.CRON_SECRET?.length ?? 0) >= CRON_SECRET_MIN;
}
