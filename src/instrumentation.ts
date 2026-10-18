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
}
