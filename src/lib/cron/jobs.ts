// R1-d: the scheduled jobs' names, windows and small pure helpers — no database import (unit-tested on their own).
export const CRON_JOBS = [
  "dispatch", "zatca-reporting", "marketing", "commission-credit-clawback", "watchdog",
  "hr-document-expiry", "contract-notices", "workspace", "recurring", "message-archive",
] as const;
export type CronJob = (typeof CRON_JOBS)[number];

export type CronTrigger = "github" | "vercel" | "manual";

/** Who started the run: the GitHub schedule says so in a header; Vercel Cron by its user agent; anything else is a person. */
export function cronTriggerOf(headers: Headers): CronTrigger {
  if ((headers.get("x-cron-source") ?? "").toLowerCase() === "github") return "github";
  if (/^vercel-cron\//i.test(headers.get("user-agent") ?? "")) return "vercel";
  return "manual";
}

/** A short, PII-free error for the log: the error's name and its message with any long digit run (an ID, a phone,
 *  an IBAN's numbers) masked, clipped. */
export function cronErrorText(err: unknown): string {
  const e = err as { name?: unknown; message?: unknown; _appCode?: unknown };
  const name = typeof e?.name === "string" ? e.name : typeof e?._appCode === "number" ? `app ${e._appCode}` : "Error";
  const msg = typeof e?.message === "string" ? e.message : "";
  return `${name}: ${msg}`.replace(/\d{6,}/g, "######").slice(0, 300);
}

export const MIN = 60_000, HOUR = 60 * MIN;
/** How long after its last successful run a job counts as late: two missed 30-minute slots and some slack for the
 *  GitHub delay; a daily job a day and two hours. */
export const LATE_AFTER_MS: Partial<Record<CronJob, number>> = {
  dispatch: 150 * MIN, "zatca-reporting": 150 * MIN, marketing: 150 * MIN,
  "commission-credit-clawback": 26 * HOUR, "hr-document-expiry": 26 * HOUR, "contract-notices": 26 * HOUR,
  workspace: 26 * HOUR, recurring: 26 * HOUR, "message-archive": 26 * HOUR,
};
/** Owner 2-ج: more than 50 messages waiting, or the oldest waiting more than 2 hours. */
export const BACKLOG_MAX = 50;
export const BACKLOG_AGE_MS = 2 * HOUR;

// R1-d gate L3 (lib/cron/health.ts): the watchdog's freshness, in one public word.
/** Hourly watchdog: three hours = two missed runs and the slack GitHub's best-effort schedule needs. */
export const WATCHDOG_STALE_MS = 3 * 60 * 60_000;

export type CronHealth = "ok" | "stale" | "unknown";

export function cronHealthOf(lastOk: Date | null, now = new Date()): CronHealth {
  return lastOk && now.getTime() - lastOk.getTime() <= WATCHDOG_STALE_MS ? "ok" : "stale";
}
