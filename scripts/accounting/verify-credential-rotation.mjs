#!/usr/bin/env node
/**
 * Post-rotation check for the neondb_owner credential of Neon project dark-lab-61530722.
 * Needs raw PostgreSQL (TCP 5432) access, so it runs on the owner's machine, not in the
 * sandbox. Reads URLs from env files so nothing is typed on a command line; prints only
 * endpoint ids, PASS/FAIL and SQLSTATE codes — never a URL, user or password.
 *
 *   OLD_OWNER_URL_FILE=~/secure/old.url NEW_OWNER_URL_FILE=~/secure/new-live.url \
 *     node scripts/accounting/verify-credential-rotation.mjs
 *
 * OLD_OWNER_URL_FILE: one line, the exposed URL (any branch). It is replayed against every
 *   endpoint below; each must now refuse it with SQLSTATE 28P01 (invalid_password).
 * NEW_OWNER_URL_FILE: optional; the new live-branch URL. Must connect, and report
 *   current_user = neondb_owner and current_database() = neondb.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENDPOINTS } from "./classify-db-urls.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { Client } = createRequire(path.join(ROOT, "package.json"))("pg");
const read = (v) => (process.env[v] ? readFileSync(process.env[v], "utf8").trim() : null);

const oldUrl = read("OLD_OWNER_URL_FILE");
const newUrl = read("NEW_OWNER_URL_FILE");
if (!oldUrl) { console.error("OLD_OWNER_URL_FILE is required"); process.exit(64); }

async function attempt(url) {
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 20000 });
  try {
    await c.connect();
    const r = await c.query("select current_user as u, current_database() as d");
    return { ok: true, user: r.rows[0].u, db: r.rows[0].d };
  } catch (e) {
    return { ok: false, code: e.code ?? e.errno ?? "network" };
  } finally {
    await c.end().catch(() => {});
  }
}

let failed = false;
const rows = [];
for (const [ep, meta] of Object.entries(ENDPOINTS)) {
  if (meta.project !== "dark-lab-61530722") continue;
  const u = new URL(oldUrl);
  u.hostname = u.hostname.replace(/^ep-[a-z]+-[a-z]+-[a-z0-9]+(-pooler)?/, ep);
  const r = await attempt(u.toString());
  const pass = !r.ok && r.code === "28P01";
  if (!pass) failed = true;
  rows.push({ check: "old credential refused", endpoint: ep, branch: meta.branch, result: pass ? "PASS" : "FAIL", detail: r.ok ? "CONNECTED — old password still valid" : `sqlstate ${r.code}` });
}
if (newUrl) {
  const r = await attempt(newUrl);
  const pass = r.ok && r.user === "neondb_owner" && r.db === "neondb";
  if (!pass) failed = true;
  rows.push({ check: "new credential works (live)", endpoint: new URL(newUrl).hostname.split(".")[0], branch: "br-weathered-bread-aqais7hp", result: pass ? "PASS" : "FAIL", detail: r.ok ? `user ok=${r.user === "neondb_owner"} db ok=${r.db === "neondb"}` : `sqlstate ${r.code}` });
}
console.table(rows);
console.log("Branches without a compute endpoint (br-cold-wave, br-fancy-unit, br-quiet-sky, br-crimson-glitter) cannot be probed by connection; verify them by role metadata (updated_at after the rotation).");
process.exit(failed ? 1 : 0);
