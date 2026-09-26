#!/usr/bin/env node
/**
 * Report the effective database settings of this worktree without printing credentials.
 *
 *   node scripts/finance/check-env.mjs
 *
 * For each env file and variable: scheme, host, port, database, user (masked), whether a
 * password is present, and a classification. Local disposable URLs are connected to (read
 * only) to confirm current_database(), current_user, server version and the disposable marker.
 * Hosted URLs are never connected to. The main checkout's .env is classified by host only.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { SHARED_ENDPOINTS, MARKER } from "./local-db-guard.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const req = createRequire(path.join(ROOT, "package.json"));
const parse = (f) => {
  const out = {};
  if (!existsSync(f)) return null;
  for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)="?(.*?)"?$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
};
const mask = (s) => (s ? `${s[0]}…(${s.length})` : "—");
function classify(u) {
  const h = u.hostname;
  const ep = SHARED_ENDPOINTS.find((e) => h.includes(e));
  if (ep === "ep-dawn-dust-aqn1u1uf") return "SHARED NEON — POTENTIALLY PRODUCTION (do not use)";
  if (ep) return `SHARED NEON (${ep}) — do not use`;
  if (/neon\.tech/.test(h)) return "HOSTED NEON (unknown branch) — do not use";
  if ((h === "127.0.0.1" || h === "localhost") && u.port === "54329") return "LOCAL DISPOSABLE (portable PostgreSQL)";
  if (h === "127.0.0.1" || h === "localhost") return "LOCAL (other server)";
  return "OTHER HOST — review";
}

const files = [
  [".env", path.join(ROOT, ".env")],
  [".env.test", path.join(ROOT, ".env.test")],
];
const rows = [];
for (const [label, f] of files) {
  const e = parse(f);
  if (!e) { rows.push({ file: label, var: "—", note: "missing" }); continue; }
  for (const v of ["DATABASE_URL", "DIRECT_URL"]) {
    if (!e[v]) { rows.push({ file: label, var: v, note: "not set" }); continue; }
    const u = new URL(e[v]);
    rows.push({ file: label, var: v, scheme: u.protocol.replace(":", ""), host: u.hostname, port: u.port || "(default)", database: u.pathname.slice(1), user: mask(decodeURIComponent(u.username)), password: u.password ? "present" : "absent", params: [...u.searchParams.keys()].join(",") || "—", class: classify(u), declared: e.FIN_DISPOSABLE_DB ?? "—", _url: e[v] });
  }
}
const main = parse(path.resolve(ROOT, "../ERP/.env"));
if (main?.DATABASE_URL) {
  const u = new URL(main.DATABASE_URL);
  rows.push({ file: "../ERP/.env (main checkout, host only)", var: "DATABASE_URL", host: u.hostname.split(".")[0] + ".…", class: classify(u), note: "not connected" });
}

const { Client } = req("pg");
for (const r of rows) {
  if (!r._url || !r.class?.startsWith("LOCAL DISPOSABLE")) continue;
  const c = new Client({ connectionString: r._url });
  try {
    await c.connect();
    const q = await c.query("SELECT current_database() AS db, current_user AS usr, split_part(version(), ' ', 2) AS ver, shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname = current_database()");
    const x = q.rows[0];
    r.connected = `db=${x.db} user=${mask(x.usr)} pg=${x.ver} marker=${x.marker === MARKER ? "ok" : "MISSING"}`;
  } catch (err) {
    r.connected = `connect failed: ${err.code ?? "error"}`;
  } finally {
    await c.end().catch(() => {});
  }
}
for (const r of rows) delete r._url;
for (const r of rows) console.log(Object.entries(r).map(([k, v]) => `${k}=${v}`).join(" | "));
