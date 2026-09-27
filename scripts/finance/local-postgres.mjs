#!/usr/bin/env node
/**
 * Disposable local PostgreSQL 17 for finance development and tests. Loopback only.
 *
 *   node scripts/finance/local-postgres.mjs setup      # install the pinned portable PostgreSQL into .local-postgres/
 *   node scripts/finance/local-postgres.mjs start      # init (first time), start, create + mark the disposable DBs
 *   node scripts/finance/local-postgres.mjs grant-app  # after migrations: least-privilege runtime role finance_app
 *   node scripts/finance/local-postgres.mjs status | stop
 *
 * Distribution: npm `@embedded-postgres/windows-x64@17.10.0-beta.17` (PostgreSQL 17.10, MIT,
 * https://github.com/leinelissen/embedded-postgres), pinned with its sha512 integrity in
 * scripts/finance/local-postgres.lock.json and installed with `npm ci` into .local-postgres/
 * (gitignored). Data directory: .local-postgres/data (gitignored). The distribution ships the
 * server tools (initdb, pg_ctl, postgres) but no psql, so SQL runs through the project's `pg`.
 *
 * Passwords come from the worktree's gitignored .env (FIN_LOCAL_PG_SUPERUSER_PASSWORD,
 * FIN_LOCAL_PG_APP_PASSWORD); nothing is printed. Each disposable database is marked with
 * COMMENT ON DATABASE … IS 'hiqbah-finance-disposable' — the marker that the fixture, reset
 * and integration tests require before they write (scripts/finance/local-db-guard.mjs).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DIR = path.join(ROOT, ".local-postgres");
const DATA = path.join(DIR, "data");
const BIN = path.join(DIR, "node_modules", "@embedded-postgres", "windows-x64", "native", "bin");
const PORT = 54329;
const SUPERUSER = "finance_local";
const DATABASES = ["erp_finance_dev", "erp_finance_test"];
const MARKER = "hiqbah-finance-disposable";
const requireFromRoot = createRequire(path.join(ROOT, "package.json"));

function env() {
  const out = {};
  const f = path.join(ROOT, ".env");
  if (existsSync(f)) {
    for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)="?(.*?)"?$/.exec(line.trim());
      if (m) out[m[1]] = m[2];
    }
  }
  return { ...out, ...process.env };
}
const exe = (name) => path.join(BIN, process.platform === "win32" ? `${name}.exe` : name);

function run(cmd, args, opts = {}) {
  // `detach`: pg_ctl start hands inherited handles to the detached server on Windows, so it
  // must run with stdio ignored, or this process would wait on the server forever.
  const r = spawnSync(cmd, args, {
    stdio: opts.detach ? "ignore" : opts.capture ? "pipe" : "inherit",
    encoding: "utf8", cwd: opts.cwd, shell: !!opts.shell,
  });
  if (r.status !== 0 && !opts.allowFail) {
    console.error(`${path.basename(cmd)} failed (${r.status}).`);
    process.exit(r.status ?? 1);
  }
  return r;
}

async function sql(db, text, e) {
  const { Client } = requireFromRoot("pg");
  const c = new Client({ host: "127.0.0.1", port: PORT, user: SUPERUSER, password: e.FIN_LOCAL_PG_SUPERUSER_PASSWORD, database: db });
  await c.connect();
  try {
    const r = await c.query(text);
    const last = Array.isArray(r) ? r[r.length - 1] : r;
    return last.rows ?? [];
  } finally {
    await c.end();
  }
}

const cmd = process.argv[2];
const e = env();
switch (cmd) {
  case "setup": {
    mkdirSync(DIR, { recursive: true });
    copyFileSync(path.join(ROOT, "scripts/finance/local-postgres.package.json"), path.join(DIR, "package.json"));
    copyFileSync(path.join(ROOT, "scripts/finance/local-postgres.lock.json"), path.join(DIR, "package-lock.json"));
    // npm is a .cmd on Windows, which Node only spawns through a shell (CVE-2024-27980).
    run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: DIR, shell: process.platform === "win32" });
    break;
  }
  case "start": {
    if (!e.FIN_LOCAL_PG_SUPERUSER_PASSWORD) { console.error("Set FIN_LOCAL_PG_SUPERUSER_PASSWORD in .env first."); process.exit(1); }
    if (!existsSync(exe("pg_ctl"))) { console.error("Run `setup` first."); process.exit(1); }
    if (!existsSync(path.join(DATA, "PG_VERSION"))) {
      const pw = path.join(DIR, ".pwfile");
      writeFileSync(pw, e.FIN_LOCAL_PG_SUPERUSER_PASSWORD);
      run(exe("initdb"), ["-D", DATA, "-U", SUPERUSER, "--pwfile", pw, "--auth=scram-sha-256", "--encoding=UTF8", "--locale=C"]);
      rmSync(pw);
    }
    const st = run(exe("pg_ctl"), ["-D", DATA, "status"], { capture: true, allowFail: true });
    if (st.status !== 0) {
      run(exe("pg_ctl"), ["-D", DATA, "-l", path.join(DIR, "postgres.log"), "-w", "-o", `-p ${PORT} -c listen_addresses=127.0.0.1 -c max_connections=60`, "start"], { detach: true });
    }
    for (const db of DATABASES) {
      const exists = await sql("postgres", `SELECT 1 FROM pg_database WHERE datname = '${db}'`, e);
      if (exists.length === 0) await sql("postgres", `CREATE DATABASE ${db} ENCODING 'UTF8'`, e);
      await sql("postgres", `COMMENT ON DATABASE ${db} IS '${MARKER}'`, e);
    }
    const [v] = await sql("postgres", "SHOW server_version", e);
    console.log(`PostgreSQL ${v.server_version} on 127.0.0.1:${PORT}; disposable DBs (marked): ${DATABASES.join(", ")}`);
    break;
  }
  case "grant-app": {
    if (!e.FIN_LOCAL_PG_APP_PASSWORD) { console.error("Set FIN_LOCAL_PG_APP_PASSWORD in .env first."); process.exit(1); }
    const pw = e.FIN_LOCAL_PG_APP_PASSWORD.replace(/'/g, "''");
    const has = await sql("postgres", "SELECT 1 FROM pg_roles WHERE rolname = 'finance_app'", e);
    await sql("postgres", `${has.length ? "ALTER" : "CREATE"} ROLE finance_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${pw}'`, e);
    for (const db of DATABASES) {
      await sql(db, `GRANT CONNECT ON DATABASE ${db} TO finance_app;
        GRANT USAGE ON SCHEMA public TO finance_app;
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO finance_app;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO finance_app;
        REVOKE TRUNCATE, TRIGGER, REFERENCES ON ALL TABLES IN SCHEMA public FROM finance_app;`, e);
    }
    console.log("finance_app: DML only (no TRUNCATE, no DDL, owns nothing, cannot disable triggers).");
    break;
  }
  case "status": run(exe("pg_ctl"), ["-D", DATA, "status"], { allowFail: true }); break;
  case "stop": run(exe("pg_ctl"), ["-D", DATA, "-m", "fast", "stop"], { allowFail: true }); break;
  default:
    console.error("usage: node scripts/finance/local-postgres.mjs setup|start|grant-app|status|stop");
    process.exit(2);
}
