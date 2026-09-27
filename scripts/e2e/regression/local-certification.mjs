#!/usr/bin/env node
/**
 * Reproducible, clean-checkout certification run of the backend regression suite against the
 * LOCAL disposable PostgreSQL server — the setup under which the 11 "baseline failures" of
 * 2026-09-27 disappear for the right reasons, not by loosening any check:
 *
 *   • harness-selftest   — runs from a clean `git worktree` of the commit under test, which has no
 *                          `.env`, so the environment validator really sees an unconfigured env.
 *   • reset-safety       — the reset boundary is configured explicitly for THIS local target only
 *                          (ERP_TRAINING_RESET_ENABLED=true, ERP_RESET_ALLOWED_HOST=127.0.0.1,
 *                          ERP_RESET_ALLOWED_DATABASE=erp_e2e). The guard itself is untouched and
 *                          the script refuses any non-local database.
 *   • h2a-hardening      — the seed now links every order/roast to a green bean (prisma/seed.ts
 *                          BEAN_ALIASES), so the GLOBAL provenance invariant holds as written.
 *
 *   node scripts/e2e/regression/local-certification.mjs [<git-ref>=HEAD] [suite ...]
 *
 * Needs: the local server from scripts/finance/local-postgres.mjs (127.0.0.1:54329) and its
 * superuser URL in `.env` as DATABASE_URL (the script only reuses its credentials, with the
 * database name replaced). Secrets for the run (JWT, PIN lookup, seed PINs) are generated fresh
 * and never printed. Output: log path printed at the end.
 */
import { spawnSync, spawn } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes, randomInt } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ref = process.argv[2] ?? "HEAD";
const suites = process.argv.slice(3);
const DB = "erp_e2e";
const PORT = 3010;

const envFile = readFileSync(path.join(ROOT, ".env"), "utf8");
const base = new URL(/^DATABASE_URL="?([^"\n]+)/m.exec(envFile)?.[1] ?? "");
if (!["127.0.0.1", "localhost"].includes(base.hostname)) { console.error("Refusing: .env DATABASE_URL is not the local server."); process.exit(64); }
const admin = new URL(base); admin.pathname = "/postgres";
const target = new URL(base); target.pathname = `/${DB}`;

const run = (cmd, args, opts = {}) => { const r = spawnSync(cmd, args, { stdio: opts.quiet ? "pipe" : "inherit", encoding: "utf8", ...opts }); if (r.status !== 0) { console.error(`failed: ${cmd} ${args[0] ?? ""}`); process.exit(r.status ?? 1); } return r; };
const psql = (url, sql) => run("psql", [url.toString(), "-qAt", "-v", "ON_ERROR_STOP=1", "-c", sql], { quiet: true });

// 1. clean worktree of the commit under test (tracked files only: no .env, no local state)
const wt = mkdtempSync(path.join(tmpdir(), "cert-"));
run("git", ["-C", ROOT, "worktree", "add", "--detach", wt, ref], { quiet: true });
const sha = run("git", ["-C", wt, "rev-parse", "HEAD"], { quiet: true }).stdout.trim();
run("cp", ["-al", path.join(ROOT, "node_modules"), path.join(wt, "node_modules")], { quiet: true }); // hard links: fast, no copy
if (existsSync(path.join(wt, ".env"))) { console.error("Refusing: the clean worktree contains a .env"); process.exit(1); }

// 2. fresh disposable database, migrated and seeded by the commit under test
psql(admin, `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
psql(admin, `CREATE DATABASE ${DB} ENCODING 'UTF8'`);
psql(admin, `COMMENT ON DATABASE ${DB} IS 'hiqbah-finance-disposable'`); // local database created just above
const pins = new Set(); while (pins.size < 5) { const p = String(randomInt(100000, 999999)); if (!/(\d)\1\1/.test(p)) pins.add(p); }
const [pAdmin, pInv, pRoast, pQc, pDisp] = [...pins];
const env = {
  PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "production",
  DATABASE_URL: target.toString(), DIRECT_URL: target.toString(),
  JWT_SECRET: randomBytes(32).toString("base64"), PIN_LOOKUP_SECRET: randomBytes(32).toString("base64"),
  RATE_LIMIT_SECRET: randomBytes(32).toString("base64"),
};
const cwd = wt;
run("npx", ["prisma", "migrate", "deploy"], { cwd, env, quiet: true });
run("npx", ["tsx", "prisma/seed.ts"], { cwd, env: { ...env, ERP_SEED_ENABLED: "true", SEED_PIN_ADMIN: pAdmin, SEED_PIN_INVENTORY: pInv, SEED_PIN_ROASTING: pRoast, SEED_PIN_QC: pQc, SEED_PIN_DISPATCH: pDisp }, quiet: true });
const orphans = psql(target, `SELECT count(*) FROM "RoastingBatch" WHERE "greenBeanId" IS NULL`).stdout.trim();
console.log(`seeded ${DB} at ${sha.slice(0, 7)} · roasting batches without a green bean: ${orphans}`);

// 3. build and serve the commit under test, with the reset boundary naming only this target
run("npm", ["run", "-s", "build"], { cwd, env, quiet: true });
const serverEnv = { ...env, ERP_TRAINING_RESET_ENABLED: "true", ERP_RESET_ALLOWED_HOST: target.hostname, ERP_RESET_ALLOWED_DATABASE: DB };
const log = path.join(tmpdir(), `certification-${sha.slice(0, 7)}.log`);
const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(PORT)], { cwd, env: serverEnv, stdio: "ignore" });
let up = false; for (let i = 0; i < 60 && !up; i++) { await new Promise((r) => setTimeout(r, 1000)); up = await fetch(`http://127.0.0.1:${PORT}/login`).then(() => true, () => false); }
if (!up) { server.kill(); console.error("server did not start"); process.exit(1); }

// 4. the suite, from the clean worktree
const r = spawnSync(process.execPath, ["scripts/e2e/regression/run-all.mjs", ...suites], {
  cwd, encoding: "utf8",
  env: { PATH: process.env.PATH, HOME: process.env.HOME, ERP_TEST_DATABASE_URL: target.toString(), ERP_TEST_BASE_URL: `http://127.0.0.1:${PORT}`, ERP_TEST_ADMIN_PIN: pAdmin, PIN_LOOKUP_SECRET: env.PIN_LOOKUP_SECRET },
});
writeFileSync(log, (r.stdout ?? "") + (r.stderr ?? ""));
server.kill();
run("git", ["-C", ROOT, "worktree", "remove", "--force", wt], { quiet: true });
rmSync(wt, { recursive: true, force: true });
const summary = (r.stdout ?? "").split("\n").filter((l) => /passed|failed|GREEN|RED|assertions/i.test(l)).slice(-40).join("\n");
console.log(summary);
console.log(`commit ${sha} · exit ${r.status} · log ${log}`);
process.exit(r.status ?? 1);
