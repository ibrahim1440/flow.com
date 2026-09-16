#!/usr/bin/env node
/**
 * The explicit migration command.
 *
 * `npm run build` used to be `prisma generate && prisma migrate deploy && next build`, which
 * meant every deployment mutated the production database as a side effect of compiling
 * TypeScript. Nobody approved the migration, nothing was snapshotted first, and a migration
 * that failed halfway left the schema ahead of the code that was still being built. Schema
 * changes are an operational act with a backup behind them, not a build step.
 *
 * So migrations now live here, are run by a person who means to run them, and refuse to
 * start without the direct connection they should be using:
 *
 *   DIRECT_URL is the non-pooled endpoint. DDL through a transaction pooler is the kind of
 *   thing that works until the day it does not, and a missing DIRECT_URL previously just
 *   sent the migration down DATABASE_URL — the pooled runtime URL — without comment.
 *
 * Usage:  DATABASE_URL=… DIRECT_URL=… npm run db:migrate:deploy
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { requireDatabaseUrl, requireDirectUrl } from "../src/lib/db-config.ts";

// Both throw a message naming the problem and never the URL.
requireDatabaseUrl(process.env);
const direct = requireDirectUrl(process.env);

// Host only — the confirmation an operator needs before answering "yes, that one", with no
// credential in it.
console.log(`Applying migrations to ${new URL(direct).hostname}`);

// Prisma's own JS entrypoint, run under this Node, rather than the shim in .bin.
//
// The first version of this script spawned "prisma.cmd" with shell: false, which fails on
// Windows with EINVAL: since the fix for CVE-2024-27980, Node refuses to spawn .cmd and
// .bat files without a shell. Reaching for shell: true would work and would also hand a
// command line to cmd.exe for no reason. Resolving the package's bin entry and running it
// with process.execPath spawns no shell at all, and behaves identically on every platform.
const require_ = createRequire(import.meta.url);
const prismaCli = require_.resolve("prisma/build/index.js");

const result = spawnSync(process.execPath, [prismaCli, "migrate", "deploy"], {
  stdio: "inherit",
  shell: false,
});

if (result.error) {
  console.error(`Could not run the Prisma CLI: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
