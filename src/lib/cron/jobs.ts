// R1-d: the scheduled jobs' names, windows and small pure helpers — no database import (unit-tested on their own).
export const CRON_JOBS = [
  "dispatch", "zatca-reporting", "marketing", "commission-credit-clawback", "watchdog",
  "hr-document-expiry", "contract-notices", "workspace", "recurring", "message-archive",
] as const;
export type CronJob = (typeof CRON_JOBS)[number];

export type CronTrigger = "github" | "vercel" | "manual";

/** Who started the run: the GitHub schedule says so in a header; Vercel Cron by its user agent; anything else is a person. */
export function cronTriggerOf(headers: Headers): CronTrigger {
  if ((headers.get("x-cron-source") ?? "").toLowerCase() === "github" || /^[0-9]{1,20}$/.test((headers.get("x-cron-run-id") ?? "").trim())) return "github";
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

// ── R1-e (owner decision 25 = أ): one run per job per period ─────────────────────────────────────────────────────────
// The hourly trigger now comes from outside (cron-job.org → workflow_dispatch) and GitHub's own schedule is the
// fallback, Vercel's daily crons the backup of that: the same job can arrive two or three times in its period, minutes
// apart. Whether a second arrival may run again is decided per job, by what the job does, not by a time distance:
//   · "none" — it drains a queue and every item is done once by its own key, so running again only finds less to do:
//     dispatch (each message has its dedupe key), zatca-reporting (each document is reported once), watchdog (its
//     alerts carry per-day / per-hour keys; the purge removes what is already expired);
//   · "hour" — marketing: its publisher, journeys and sender act on what is due at the moment of the run (campaign
//     posts and messages), so it runs at most once per UTC hour;
//   · "riyadh-day" — the daily jobs (notices, the workspace's daily items, recurring postings, the archive, the
//     year-end clawback that writes pay): at most once per Riyadh calendar day.
// A run that FAILED does not count: the next arrival in the same period tries again.
export type CronSlot = "none" | "hour" | "riyadh-day";
export const CRON_SLOT: Record<CronJob, CronSlot> = {
  dispatch: "none", "zatca-reporting": "none", watchdog: "none",
  marketing: "hour",
  "commission-credit-clawback": "riyadh-day", "hr-document-expiry": "riyadh-day", "contract-notices": "riyadh-day",
  workspace: "riyadh-day", recurring: "riyadh-day", "message-archive": "riyadh-day",
};

/**
 * A daily job runs on the first call at or after this Riyadh hour — its usual time (the Vercel daily cron's, so that
 * backup is never «not due»): the hourly workflow calls every daily job on every run, and the first call past the hour
 * does the day's work even when the usual one was missed.
 */
export const DUE_FROM_RIYADH_HOUR: Partial<Record<CronJob, number>> = {
  "message-archive": 3, recurring: 4, "hr-document-expiry": 6, "contract-notices": 6, "commission-credit-clawback": 6, workspace: 7,
};
/** The daily jobs .github/workflows/cron.yml calls on every run (the server decides whether one is due). */
export const WORKFLOW_DAILY_JOBS: CronJob[] = ["message-archive", "recurring", "hr-document-expiry", "contract-notices", "commission-credit-clawback", "workspace"];
/** The jobs the workflow calls every hour (the others above are daily). */
export const WORKFLOW_HOURLY_JOBS: CronJob[] = ["dispatch", "zatca-reporting", "marketing", "watchdog"];

const RIYADH_OFFSET_MS = 3 * HOUR; // Asia/Riyadh is UTC+3 all year (no daylight saving)

/** The period `now` falls in for `job` — [from, to) — or null when the job has none. */
export function cronSlotOf(job: CronJob, now: Date): { from: Date; to: Date } | null {
  const slot = CRON_SLOT[job];
  if (slot === "hour") {
    const from = new Date(Math.floor(now.getTime() / HOUR) * HOUR);
    return { from, to: new Date(from.getTime() + HOUR) };
  }
  if (slot === "riyadh-day") {
    const local = now.getTime() + RIYADH_OFFSET_MS;
    const from = new Date(Math.floor(local / (24 * HOUR)) * 24 * HOUR - RIYADH_OFFSET_MS);
    return { from, to: new Date(from.getTime() + 24 * HOUR) };
  }
  return null;
}

/** The period's key stored on the run (CronRun.slotKey): "2030-03-10T10" (UTC hour) or "2030-03-10" (Riyadh day). */
export function cronSlotKey(job: CronJob, now: Date): string | null {
  const slot = CRON_SLOT[job];
  if (slot === "hour") return new Date(Math.floor(now.getTime() / HOUR) * HOUR).toISOString().slice(0, 13);
  if (slot === "riyadh-day") return new Date(now.getTime() + RIYADH_OFFSET_MS).toISOString().slice(0, 10);
  return null;
}

/** Where a run came from, as the GitHub workflow states it (x-cron-run-id / -attempt / -source); junk is dropped. */
export type CronOrigin = { externalRunId: string | null; externalRunAttempt: number | null; source: string | null };
export function cronOriginOf(headers: Headers, trigger: CronTrigger): CronOrigin {
  const id = (headers.get("x-cron-run-id") ?? "").trim();
  const attempt = Number((headers.get("x-cron-run-attempt") ?? "").trim());
  const src = (headers.get("x-cron-source") ?? "").trim().toLowerCase();
  return {
    externalRunId: /^[0-9]{1,20}$/.test(id) ? id : null,
    externalRunAttempt: Number.isInteger(attempt) && attempt >= 1 && attempt <= 9999 ? attempt : null,
    source: /^[a-z0-9][a-z0-9._-]{0,39}$/.test(src) ? src : trigger === "github" ? null : trigger,
  };
}

/** The hour of `now` in Riyadh (0–23). */
export function riyadhHour(now: Date): number {
  return new Date(now.getTime() + RIYADH_OFFSET_MS).getUTCHours();
}

/** Whether a daily job with a due hour is not due yet at `now` (before that hour, Riyadh time). */
export function cronNotDue(job: CronJob, now: Date): boolean {
  const h = DUE_FROM_RIYADH_HOUR[job];
  return h !== undefined && riyadhHour(now) < h;
}

// ── R1-e: the GitHub fallback runs only when needed ──────────────────────────────────────────────────────────────────
/** The external hourly trigger is on time while watchdog and dispatch both succeeded within this. */
export const NEEDED_AFTER_MS = 70 * MIN;

// ── R1-e: the dispatch token's expiry (CRON_DISPATCH_TOKEN_EXPIRES_AT, an ISO date) ──────────────────────────────────
export type TokenExpiry = { state: "unset" | "ok" | "soon" | "expired"; expiresAt: string | null; daysLeft: number | null };
/** «soon» from 14 days before the expiry; the watchdog alerts once a day from then on (and once a day when unset). */
export const TOKEN_WARN_DAYS = 14;
export function tokenExpiryOf(raw: string | undefined, now: Date): TokenExpiry {
  const v = (raw ?? "").trim();
  const t = /^\d{4}-\d{2}-\d{2}/.test(v) ? Date.parse(v) : NaN;
  if (!Number.isFinite(t)) return { state: "unset", expiresAt: null, daysLeft: null };
  const daysLeft = Math.ceil((t - now.getTime()) / (24 * HOUR));
  const expiresAt = new Date(t).toISOString().slice(0, 10);
  if (daysLeft <= 0) return { state: "expired", expiresAt, daysLeft };
  return { state: daysLeft <= TOKEN_WARN_DAYS ? "soon" : "ok", expiresAt, daysLeft };
}
