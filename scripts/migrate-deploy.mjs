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
 * Usage:  DIRECT_URL=… npm run db:migrate:deploy
 *
 * P-4 retest P1-1: Prisma 7.8 IGNORES `directUrl` in prisma.config.ts — the CLI migrates whatever
 * DATABASE_URL names. This script used to validate DIRECT_URL and print its host while Prisma
 * migrated DATABASE_URL: in the retest, the database named by DATABASE_URL got the 152 tables
 * and the one named by DIRECT_URL (the one printed) got none. So the Prisma child process now
 * receives DIRECT_URL AS its DATABASE_URL, and the host printed is the host it is given. Every
 * other Prisma CLI command (status, resolve, diff) needs the same prefix: RUNBOOK §6 / §10.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { requireDatabaseUrl, requireDirectUrl } from "../src/lib/db-config.ts";

// Throws a message naming the problem and never the URL: DIRECT_URL is required.
const direct = requireDirectUrl(process.env);
// The child migrates exactly this database (dotenv in prisma.config.ts never overrides a set variable).
const childEnv = { ...process.env, DATABASE_URL: direct };
requireDatabaseUrl(childEnv);

// Host and database only — the confirmation an operator needs before answering "yes, that one",
// with no credential in it. It is the database the child is given, and nothing else.
const target = new URL(direct);
console.log(`Applying migrations to ${target.hostname}${target.port ? `:${target.port}` : ""} database ${target.pathname.replace(/^\//, "") || "(default)"} (from DIRECT_URL)`);

// R1-a (owner decision 4-أ): a database with NO applied migration yet (a new cluster, CI, an empty Neon branch) first
// gets the roles the chain GRANTs to — scripts/db/bootstrap-roles.sql (idempotent, NOLOGIN, no password). A database
// that already has migrations is never touched by it: production keeps exactly the roles an operator made.
//
// R1-a gate L1: "empty" is decided from the catalog, never through search_path. The migrations table Prisma uses
// lives in the URL's schema (`?schema=`, default public); every _prisma_migrations table in the database is
// listed from pg_catalog, and the configured one is read schema-qualified. A misconfigured search_path or
// `?schema=` FAILS CLOSED (exit 1, nothing changed, Prisma not started): a connection whose current_schema() is not
// the configured schema is refused, and so are migrations recorded in another schema — never a bootstrap.
{
  const { default: pg } = await import("pg");
  const { readFileSync } = await import("node:fs");
  const schema = target.searchParams.get("schema") || "public";
  const client = new pg.Client({ connectionString: direct });
  let refuse = "";
  await client.connect();
  try {
    const found = (await client.query(
      `SELECT n.nspname AS schema FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = '_prisma_migrations' AND c.relkind IN ('r', 'p') ORDER BY 1`,
    )).rows.map((r) => r.schema);
    const current = (await client.query(`SELECT pg_catalog.current_schema() AS s`)).rows[0].s;
    let applied = 0;
    if (current !== schema) {
      refuse = `Refusing: this connection resolves to schema ${current ?? "(none — search_path names no existing schema)"}, ` +
        `but the target schema is ${schema}. Check the role's / database's search_path — nothing was changed.`;
    } else if (found.includes(schema)) {
      const q = `SELECT count(*)::int AS n FROM ${client.escapeIdentifier(schema)}."_prisma_migrations" WHERE finished_at IS NOT NULL`;
      applied = Number((await client.query(q)).rows[0].n);
    } else if (found.length > 0) {
      refuse = `Refusing: this database records migrations in schema ${found.join(", ")}, but the target schema is ${schema}. ` +
        "Check ?schema= in DIRECT_URL and the role's search_path — nothing was changed.";
    }
    if (!refuse && applied === 0) {
      console.log(`No migration applied yet in schema ${schema} — creating the roles the chain grants to (scripts/db/bootstrap-roles.sql).`);
      await client.query(readFileSync(new URL("./db/bootstrap-roles.sql", import.meta.url), "utf8"));
    }
  } finally {
    await client.end();
  }
  if (refuse) {
    console.error(refuse);
    process.exit(1);
  }
}

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
  env: childEnv,
});

if (result.error) {
  console.error(`Could not run the Prisma CLI: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
