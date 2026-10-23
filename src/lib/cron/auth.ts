// Who may call a scheduled job route (feat/hr-expiry-email). Vercel Cron calls the path with GET and,
// when the project has a CRON_SECRET environment variable, sends `Authorization: Bearer <CRON_SECRET>`.
//
//   * CRON_SECRET set (≥ 16 characters): that exact header, compared in constant time — nothing else.
//   * CRON_SECRET not set: only a request that says it comes from Vercel Cron (user agent
//     «vercel-cron/…») to an app running ON Vercel (VERCEL=1). That header can be imitated by anyone
//     who knows the URL, so this fallback is acceptable only for jobs that are idempotent and reveal
//     nothing (the document-expiry check answers counts only and never notifies twice). Set CRON_SECRET
//     in the Vercel project (Production) to close it.
//   * Off Vercel without a secret (local, tests): refused.
import { timingSafeEqual } from "node:crypto";

export type CronAuth = { ok: true; via: "secret" | "vercel-cron-agent" } | { ok: false };

export function cronAuthorized(headers: Headers, env: Record<string, string | undefined> = process.env): CronAuth {
  const secret = env.CRON_SECRET;
  if (secret && secret.length >= 16) {
    const expected = Buffer.from(`Bearer ${secret}`);
    const given = Buffer.from(headers.get("authorization") ?? "");
    return given.length === expected.length && timingSafeEqual(given, expected) ? { ok: true, via: "secret" } : { ok: false };
  }
  if (env.VERCEL === "1" && /^vercel-cron\//i.test(headers.get("user-agent") ?? "")) return { ok: true, via: "vercel-cron-agent" };
  return { ok: false };
}

/** Whether a scheduler secret is set (never its value) — for the HR settings screen. */
export function cronSecretConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return (env.CRON_SECRET?.length ?? 0) >= 16;
}
