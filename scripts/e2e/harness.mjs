// ─────────────────────────────────────────────────────────────────────────────
//  E2E harness — HTTP client with a cookie jar + direct SQL access for fixtures.
//
//  Deliberately dependency-free: the project has no test framework, so these
//  scripts run under plain `node`. SQL goes through psql rather than Prisma so
//  the harness never has to replicate the runtime adapter selection in db.ts.
//
//  Requires: dev server on :3000 and DATABASE_URL pointing at a disposable DB.
// ─────────────────────────────────────────────────────────────────────────────
import { execFileSync } from "node:child_process";

export const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";

const PSQL = process.env.PSQL_BIN || "C:/Program Files/PostgreSQL/17/bin/psql.exe";
const PGURL = process.env.DATABASE_URL;
if (!PGURL) throw new Error("DATABASE_URL must be set");

let cookie = "";

// ── HTTP ─────────────────────────────────────────────────────────────────────
export async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    if (c.startsWith("token=")) cookie = c.split(";")[0];
  }
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

export async function login(pin = "1234") {
  const r = await api("/api/auth/login", { method: "POST", body: { method: "pin", pin } });
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}

export function clearCookie() { cookie = ""; }

// ── SQL ──────────────────────────────────────────────────────────────────────
export function sql(query) {
  const out = execFileSync(PSQL, [PGURL, "-tAF", "\u0001", "-c", query], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return out
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.length > 0)
    .map((l) => l.split("\u0001"));
}

export function sqlOne(query) {
  const rows = sql(query);
  return rows.length ? rows[0][0] : null;
}

export function sqlExec(query) {
  execFileSync(PSQL, [PGURL, "-q", "-c", query], { encoding: "utf8" });
}

// ── assertions ───────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures = [];

export function check(name, condition, detail = "") {
  if (condition) { passed++; console.log(`  \u2713 ${name}`); }
  else { failed++; failures.push(name + (detail ? ` :: ${detail}` : "")); console.log(`  \u2717 ${name}${detail ? `  << ${detail}` : ""}`); }
  return !!condition;
}

export function note(msg) { console.log(`    · ${msg}`); }

export function section(title) {
  console.log("\n" + "\u2550".repeat(78));
  console.log(title);
  console.log("\u2550".repeat(78));
}

export function summary() {
  console.log("\n" + "\u2500".repeat(78));
  console.log(`TOTAL: ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log("FAILURES:");
    failures.forEach((f) => console.log("  - " + f));
  }
  console.log("\u2500".repeat(78));
  return failed;
}

export const round = (n) => Math.round(n * 1000) / 1000;
export const esc = (s) => String(s).replace(/'/g, "''");
