#!/usr/bin/env tsx
/**
 * The deployment-time half of the environment gate.
 *
 * src/instrumentation.ts refuses to start a server whose environment cannot work. That is the
 * right guarantee at runtime, but it is discovered when the first server instance boots —
 * which on a serverless platform can be minutes or hours after the deploy is reported green,
 * and in front of whoever is trying to log in.
 *
 * This runs first in `npm run build`, so the same refusal happens while the build is still on
 * screen and the deployment never becomes live at all.
 *
 * ── Why this is TypeScript run through tsx, and not a .mjs ──────────────────
 * An earlier version was a plain .mjs that imported src/lib/server-env.ts directly. That
 * worked only because Node happened to strip TypeScript natively, which made the production
 * build depend on an unpinned Node capability — this repository declares no `engines.node`
 * and no Vercel runtime version, so that dependency was invisible and unproven. `tsx` is
 * already a direct devDependency and already runs prisma/seed.ts, so executing this file
 * through the locally installed `tsx` binary removes the native-TypeScript assumption without
 * adding a dependency and without duplicating a single validation rule.
 *
 * ── What it does not do ─────────────────────────────────────────────────────
 * It never prints a value. It never contacts a database — a URL is parsed and judged, not
 * connected to. And it runs no migration: `npm run build` remains environment validation,
 * client generation and an application build, while schema changes stay an explicit operator
 * action (`npm run db:migrate:deploy`).
 */
import "dotenv/config";
import { evaluateServerEnv } from "../src/lib/server-env";

const problems = evaluateServerEnv(process.env);

if (problems.length > 0) {
  console.error(
    `\nRefusing to build: this environment is not configured to run ` +
      `(${problems.length} problem${problems.length === 1 ? "" : "s"}):\n` +
      problems.map((p) => `  - ${p}`).join("\n") +
      "\n\nSet these in the build/deployment environment. No value is printed here.\n",
  );
  process.exit(1);
}

console.log("Environment gate: required server configuration is present.");
