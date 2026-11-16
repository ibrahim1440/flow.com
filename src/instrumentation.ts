/**
 * Server startup.
 *
 * Next.js calls `register()` exactly once when a server instance is initiated, and it must
 * complete before that instance handles its first request. That makes it the one place where
 * "this deployment is not configured" can be said at startup instead of discovered by a
 * member of staff at a PIN pad.
 *
 * PIN_LOOKUP_SECRET was the specific gap. DATABASE_URL already fails at module load and in
 * prisma.config.ts, and JWT_SECRET already fails while `next build` compiles the routes
 * that import src/lib/auth.ts — but the PIN lookup secret was only ever read inside request
 * handlers, so a deployment missing it installed, built, started, and answered /api/health
 * with 200 while every PIN login was going to return 500.
 *
 * ── Node runtime only ───────────────────────────────────────────────────────
 * `instrumentation` runs in both the Node.js and Edge runtimes, and NEXT_RUNTIME is the
 * documented way to tell them apart. The validators reach through to node:crypto and the
 * PostgreSQL URL parser, neither of which belongs on the Edge runtime, so the assertion is
 * scoped to Node and the import is dynamic — an Edge instance never loads it at all.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { assertServerEnv } = await import("./lib/server-env");
  assertServerEnv(process.env);

  // R1-d (owner 2-أ): error tracking — Sentry's free plan, only when SENTRY_DSN is set (none locally, in CI or tests),
  // every event and breadcrumb scrubbed of personal data first (lib/observability/scrub.ts). No tracing, no source-map
  // upload (no build plugin, no auth token).
  if (process.env.SENTRY_DSN) {
    const Sentry = await import("@sentry/nextjs");
    const { sentryOptions } = await import("./lib/observability/scrub");
    Sentry.init(sentryOptions(process.env.SENTRY_DSN, process.env.VERCEL_ENV) as Parameters<typeof Sentry.init>[0]);
  }
}

/** R1-d: errors thrown while rendering or in a route reach Sentry (when it is on). */
export async function onRequestError(...args: unknown[]) {
  if (!process.env.SENTRY_DSN || process.env.NEXT_RUNTIME !== "nodejs") return;
  const Sentry = await import("@sentry/nextjs");
  (Sentry.captureRequestError as (...a: unknown[]) => void)(...args);
}
