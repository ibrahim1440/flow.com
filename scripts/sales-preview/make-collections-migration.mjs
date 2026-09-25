#!/usr/bin/env node
/**
 * Generate the additive migration for the collections workflow.
 *
 * Read-only against the database: `migrate diff` introspects the current schema and prints
 * the SQL that would reconcile it with the datamodel. Nothing is applied here — applying is
 * `npm run db:migrate:deploy`, which is a separate, deliberate act.
 *
 * The env file is loaded from outside the repository so no credential is ever written into
 * it, and the target is asserted before the diff runs: this refuses to look at anything that
 * is not the isolated `sales_preview` database.
 *
 * Usage:  node scripts/sales-preview/make-collections-migration.mjs <name>
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ENV_FILE = path.join(os.homedir(), ".beanflow", "sales-preview", ".env.preview-migrate");
const NAME = process.argv[2] ?? "add_sales_collections";

/** The only database this script is allowed to look at. */
const ALLOWED_DB = "sales_preview";
const ALLOWED_HOST_PREFIX = "ep-wandering-leaf-";
/** Endpoints that must never be reached from here, named so the refusal is legible. */
const FORBIDDEN_HOSTS = ["ep-dawn-dust", "ep-jolly-feather"];

if (!fs.existsSync(ENV_FILE)) {
  console.error(`No preview migration credential at ${ENV_FILE}.`);
  process.exit(2);
}

const env = {};
for (const line of fs.readFileSync(ENV_FILE, "utf8").split("\n")) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const direct = env.DIRECT_URL;
if (!direct) {
  console.error("DIRECT_URL is not in the preview migration env file.");
  process.exit(2);
}

// Assert the target before touching it. Host and database name both, because either one
// alone can be right while the other is not.
const url = new URL(direct);
const db = url.pathname.replace(/^\//, "");
if (FORBIDDEN_HOSTS.some((h) => url.hostname.startsWith(h))) {
  console.error(`REFUSED: ${url.hostname} is a protected endpoint.`);
  process.exit(3);
}
if (!url.hostname.startsWith(ALLOWED_HOST_PREFIX) || db !== ALLOWED_DB) {
  console.error(`REFUSED: expected ${ALLOWED_HOST_PREFIX}* / ${ALLOWED_DB}, got ${url.hostname} / ${db}.`);
  process.exit(3);
}
console.log(`Diffing against ${url.hostname} / ${db} (read-only).`);

const require_ = createRequire(import.meta.url);
const prismaCli = require_.resolve("prisma/build/index.js");

// Prisma 7 renamed these: the datasource comes from prisma.config.ts (which reads the env
// handed to the child), and the target is `--to-schema`, not `--to-schema-datamodel`.
const res = spawnSync(
  process.execPath,
  [
    prismaCli, "migrate", "diff",
    "--from-config-datasource",
    "--to-schema", "prisma/schema.prisma",
    "--script",
  ],
  { encoding: "utf8", env: { ...process.env, ...env }, shell: false },
);

if (res.status !== 0) {
  console.error(res.stderr || res.stdout);
  process.exit(res.status ?? 1);
}

const sql = res.stdout.trim();
if (!sql || /^-- This is an empty migration/.test(sql)) {
  console.log("No difference — the database already matches the datamodel.");
  process.exit(0);
}

// A destructive statement in something billed as additive is a stop, not a warning.
const destructive = /\b(DROP\s+(TABLE|COLUMN|SCHEMA|DATABASE)|TRUNCATE|DELETE\s+FROM)\b/i.exec(sql);
if (destructive) {
  console.error(`REFUSED: the diff contains "${destructive[0]}". Additive migrations only.`);
  console.error(sql);
  process.exit(4);
}

const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const dir = path.join("prisma", "migrations", `${stamp}_${NAME}`);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "migration.sql"), sql + "\n");
console.log(`Wrote ${path.join(dir, "migration.sql")} (${sql.split("\n").length} lines).`);
