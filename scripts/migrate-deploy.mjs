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
import { requireDatabaseUrl, requireDirectUrl } from "../src/lib/db-config.ts";

// Both throw a message naming the problem and never the URL.
requireDatabaseUrl(process.env);
const direct = requireDirectUrl(process.env);

// Host only — the confirmation an operator needs before answering "yes, that one", with no
// credential in it.
console.log(`Applying migrations to ${new URL(direct).hostname}`);

const prisma = process.platform === "win32" ? "prisma.cmd" : "prisma";
const result = spawnSync(prisma, ["migrate", "deploy"], { stdio: "inherit", shell: false });

if (result.error) {
  console.error(`Could not run ${prisma}: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
